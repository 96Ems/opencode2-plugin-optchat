/**
 * optchat-core — pure logic for the OptChat memory (append-only log + binary
 * summary tree + tiling view). No I/O, no model calls: everything here is
 * deterministic and unit-testable.
 *
 * Spec: "OptChat: an endless chat where the AI remembers everything"
 * (VictorTaelin). Node (l,i) covers messages [i*2^l, (i+1)*2^l); a node's text
 * is at most NODE bytes; the view tiles [0,T) with tree nodes and holds at most
 * VIEW bytes.
 */

import { createHash } from "node:crypto";

export const NODE = 512;
export const VIEW = 128_000;
export const CAP = 30_000;

/**
 * Messages covered by one frozen prefix line.
 *
 * The head of every payload is what a provider's prompt cache can reuse, so it
 * is written once and never rewritten: whole aligned nodes of this level are
 * appended to it, never edited. A smaller level would make the head grow faster
 * (more cache-miss-free appends but a bigger head); a larger one would grow
 * slower but cover less of the history with cached bytes.
 */
export const FREEZE_LEVEL = 4;

export type Kind = "user" | "talk" | "tool" | "echo" | "note";

export interface LogMsg {
  i: number;
  kind: Kind;
  text: string;
  size: number;
  date: string;
}

export interface Part {
  l: number;
  i: number;
}

export interface ChatState {
  /** every message, verbatim, append-only */
  messages: LogMsg[];
  /** tree nodes built by the compactor, key "l:i" -> text */
  nodes: Map<string, string>;
  /** memoized "free" nodes (source already fits in NODE, no model call) */
  free: Map<string, string>;
  /** the view: adjacent parts tiling messages [0, T), oldest first */
  view: Part[];
  viewBytes: number;
  /** level of the frozen head, and how many of its aligned nodes are frozen */
  frozenLevel: number;
  frozenCount: number;
  /** bytes of the frozen head, recomputed when it grows */
  frozenBytes: number;
}

export function newChatState(): ChatState {
  return {
    messages: [],
    nodes: new Map(),
    free: new Map(),
    view: [],
    viewBytes: 0,
    frozenLevel: FREEZE_LEVEL,
    frozenCount: 0,
    frozenBytes: 0,
  };
}

// ---------------------------------------------------------------- byte utils

export function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

const REPLACEMENT = "\uFFFD";

/** Longest prefix of `s` in at most `max` UTF-8 bytes, never splitting a character. */
export function cutUtf8(s: string, max: number): string {
  if (byteLen(s) <= max) return s;
  let out = Buffer.from(s, "utf8").subarray(0, max).toString("utf8");
  if (out.endsWith(REPLACEMENT)) out = out.slice(0, -1);
  return out;
}

function padBytes(s: string, bytes: number): string {
  let out = s;
  while (byteLen(out) < bytes) out += " ";
  return cutUtf8(out, bytes);
}

/**
 * A realistic, dense summary line used as the size reference shown to the
 * compactor ("models can't count bytes"). Exactly NODE bytes.
 */
const SCALE_BASE =
  "user: keep the vite dev server on 5173 and never touch the prod compose file; " +
  "talk: moved token refresh into src/auth/refresh.ts, tests green; " +
  "tool: edit src/auth/refresh.ts; echo: ok, 412 bytes written; " +
  "user: correction, the fetch timeout is 5s, it lives in config/limits.ts; " +
  "work: api review done, 3 findings: no rate limit, no timeout, no retry on 429; " +
  "talk: added the retry with backoff in src/api/client.ts and documented it";
export const SCALE: string = padBytes(SCALE_BASE, NODE);

// ---------------------------------------------------------------- the tree

export function nodeKey(l: number, i: number): string {
  return `${l}:${i}`;
}

export function span(l: number): number {
  return 2 ** l;
}

export function covers(l: number, i: number): [number, number] {
  const n = span(l);
  return [i * n, (i + 1) * n];
}

export function msgLine(m: LogMsg): string {
  return `${m.kind}: ${m.text}`;
}

/**
 * Text of node (l,i), or undefined when it does not exist yet.
 *
 * Free node: if the source already fits in NODE bytes it IS the node, with no
 * model call (a short message stays word for word; two short children stay
 * concatenated).
 */
export function nodeText(state: ChatState, l: number, i: number): string | undefined {
  const key = nodeKey(l, i);
  const stored = state.nodes.get(key);
  if (stored !== undefined) return stored;
  const cached = state.free.get(key);
  if (cached !== undefined) return cached;

  let text: string | undefined;
  if (l === 0) {
    const m = state.messages[i];
    if (m) {
      const line = msgLine(m);
      if (byteLen(line) <= NODE) text = line;
    }
  } else {
    const a = nodeText(state, l - 1, 2 * i);
    const b = nodeText(state, l - 1, 2 * i + 1);
    if (a !== undefined && b !== undefined) {
      const joined = `${a}\n${b}`;
      if (byteLen(joined) <= NODE) text = joined;
    }
  }
  if (text !== undefined) state.free.set(key, text);
  return text;
}

export function built(state: ChatState, l: number, i: number): boolean {
  return nodeText(state, l, i) !== undefined;
}

/** Both sources of the node exist. */
export function ready(state: ChatState, l: number, i: number): boolean {
  if (l === 0) return i < state.messages.length;
  return nodeText(state, l - 1, 2 * i) !== undefined && nodeText(state, l - 1, 2 * i + 1) !== undefined;
}

/** First message index whose view line is not a summary yet (T when all are). */
export function first(state: ChatState): number {
  for (const part of state.view) {
    if (nodeText(state, part.l, part.i) === undefined) return covers(part.l, part.i)[0];
  }
  return state.messages.length;
}

export function settled(state: ChatState): boolean {
  return first(state) >= state.messages.length;
}

export interface Candidate {
  l: number;
  i: number;
}

/**
 * Nodes the compactor may start now, in order, up to `limit`.
 *
 * A node is started when it is unbuilt, not busy, has its sources, and its
 * whole context is already summarized (`end <= first`). That last rule makes
 * messages compress one at a time, in order, while merges of finished parts run
 * alongside — the compactor never reads a line that is not a summary.
 */
export function candidates(state: ChatState, busy: Set<string>, limit: number, failed?: Map<string, number>, now = Date.now(), retryMs = 10_000): Candidate[] {
  const out: Candidate[] = [];
  if (limit <= 0) return out;
  const T = state.messages.length;
  const f = first(state);
  for (let l = 0; span(l) <= T; l++) {
    for (let i = 0; (i + 1) * span(l) <= T; i++) {
      if (out.length >= limit) return out;
      const key = nodeKey(l, i);
      if (state.nodes.has(key) || state.free.has(key) || busy.has(key)) continue;
      const ts = failed?.get(key);
      if (ts !== undefined && now - ts < retryMs) continue;
      const end = l === 0 ? i : (i + 1) * span(l);
      if (end > f) continue;
      if (!ready(state, l, i)) continue;
      out.push({ l, i });
    }
  }
  return out;
}

/** View lines lying entirely before message `end`, rendered bare (no ids). */
export function viewLinesUpTo(state: ChatState, end: number): string[] {
  const lines: string[] = [];
  for (const part of state.view) {
    const [start, stop] = covers(part.l, part.i);
    if (stop > end) continue;
    if (start >= end) break;
    const text = nodeText(state, part.l, part.i);
    if (text !== undefined) lines.push(oneLine(text));
  }
  return lines;
}

export function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ");
}

export const PLACEHOLDER = "(not summarized yet: zoom it)";

/** Tail of `s` in at most `max` bytes, never starting mid-character. */
function tailUtf8(s: string, max: number): string {
  let out = s.slice(-max);
  if (byteLen(out) > max) out = cutUtf8(out, max);
  return out.replace(/^\uFFFD+/, "");
}

/**
 * The line a model call gets for a message the compactor has not summarized yet.
 *
 * It must be bounded: the compactor can lag behind a busy session for minutes,
 * and a view that grows with the transcript defeats the whole point (measured:
 * unsummarized messages shown whole made a 6-turn session send 100k+ tokens and
 * keep growing). It is also never cut *silently* — the marker gives the size and
 * how to get the message whole, and nothing is ever deleted from the log.
 */
export function unsummarizedLine(state: ChatState, i: number, cap = NODE): string {
  const m = state.messages[i];
  if (!m) return PLACEHOLDER;
  const line = msgLine(m);
  if (byteLen(line) <= cap) return oneLine(line);
  const marker = ` [${byteLen(line)}B cut: zoom(${i},1) for the whole message] `;
  const room = Math.max(64, cap - byteLen(marker));
  const head = cutUtf8(line, Math.ceil(room * 0.6));
  const tail = tailUtf8(line, Math.floor(room * 0.4));
  return `${oneLine(head)}${marker}${oneLine(tail)}`;
}

export function partText(state: ChatState, part: Part, mode: "placeholder" | "line"): string {
  const text = nodeText(state, part.l, part.i);
  if (text !== undefined) return oneLine(text);
  if (mode === "line" && part.l === 0) return unsummarizedLine(state, part.i);
  return PLACEHOLDER;
}

/** Size a part contributes to the view budget: what we would really send for it. */
export function partBytes(state: ChatState, part: Part): number {
  return byteLen(partText(state, part, "line"));
}

/** How many view lines are still waiting for the compactor. */
export function unsettled(state: ChatState): number {
  return state.view.filter((part) => nodeText(state, part.l, part.i) === undefined).length;
}

/**
 * Render the view. `mode` decides how an unsummarized line is shown:
 * "placeholder" for display/browsing, "line" for a model call (bounded line with
 * a zoom pointer — the placeholder is never sent to a model).
 */
export function renderView(state: ChatState, mode: "placeholder" | "line" = "placeholder"): string {
  const lines = state.view.map((part) => {
    const n = span(part.l);
    return `${part.i * n}+${n}|${partText(state, part, mode)}`;
  });
  return `<chat>\n${lines.join("\n")}\n</chat>`;
}

// -------------------------------------------------------------- the frozen head

/** Messages covered by the frozen head: [0, frozenCovered). */
export function frozenCovered(state: ChatState): number {
  return state.frozenCount * span(state.frozenLevel);
}

/** The frozen head. Its lines are written once and never rewritten. */
export function frozenLines(state: ChatState): string[] {
  const l = state.frozenLevel;
  const n = span(l);
  const out: string[] = [];
  for (let i = 0; i < state.frozenCount; i++) {
    const text = nodeText(state, l, i);
    if (text === undefined) break;
    out.push(`${i * n}+${n}|${oneLine(text)}`);
  }
  return out;
}

function frozenBytesOf(state: ChatState): number {
  return byteLen(frozenLines(state).join("\n"));
}

/**
 * Extend the frozen head by every aligned node the compactor has finished, then
 * checkpoint if the head outgrew its half of the budget.
 *
 * Appending is the whole point: an already-frozen line keeps the same bytes, so
 * the new payload *starts* with the previous payload's head and a provider's
 * prefix cache keeps hitting (measured effect: cache reads instead of a fresh
 * prompt every turn). A checkpoint — moving one level up, halving the head — is
 * the only operation that rewrites it, so it is paid once, rarely, and only when
 * the new level's nodes already exist (otherwise the head would vanish).
 */
export function refreshFrozen(state: ChatState, budget = VIEW): void {
  for (let guard = 0; guard < 24; guard++) {
    const l = state.frozenLevel;
    let n = state.frozenCount;
    while (built(state, l, n) && (n + 1) * span(l) <= state.messages.length) n++;
    state.frozenCount = n;
    state.frozenBytes = frozenBytesOf(state);
    if (state.frozenBytes <= budget / 2) return;
    if (!built(state, l + 1, 0)) return;
    state.frozenLevel = l + 1;
    state.frozenCount = 0;
  }
}

/** The live tail: `state.view` clipped to [from, T), splitting parts that straddle. */
export function tailParts(state: ChatState, from: number): Part[] {
  const out: Part[] = [];
  const walk = (part: Part): void => {
    const [start, stop] = covers(part.l, part.i);
    if (stop <= from) return;
    if (start >= from) {
      out.push(part);
      return;
    }
    if (part.l === 0) return;
    walk({ l: part.l - 1, i: 2 * part.i });
    walk({ l: part.l - 1, i: 2 * part.i + 1 });
  };
  for (const part of state.view) walk(part);
  return out;
}

export function tailLines(state: ChatState, from = frozenCovered(state)): string[] {
  return tailParts(state, from).map((part) => {
    const n = span(part.l);
    return `${part.i * n}+${n}|${partText(state, part, "line")}`;
  });
}

/**
 * The context a model call gets: a frozen head (identical bytes from one turn to
 * the next) followed by the live tail. Same coverage as `renderView(state,
 * "line")` — this is only a different *order* of the same lines.
 */
export function renderCached(state: ChatState): string {
  const lines = [...frozenLines(state), ...tailLines(state)];
  return `<chat>\n${lines.join("\n")}\n</chat>`;
}

/** Zoom one view line into the two lines under it; n === 1 gives the message whole. */
export function zoomText(state: ChatState, id: number, n: number): string {
  const T = state.messages.length;
  if (!Number.isFinite(id) || !Number.isFinite(n) || n < 1 || (n & (n - 1)) !== 0 || id % n !== 0) {
    return `No line ${id}+${n}.`;
  }
  if (id + n > T) return `No line ${id}+${n}.`;
  if (n === 1) {
    const m = state.messages[id];
    if (!m) return `No line ${id}+0.`;
    return `${id}+0|${msgLine(m)}`;
  }
  const l = Math.log2(n) - 1;
  const a: Part = { l, i: (2 * id) / n };
  const b: Part = { l, i: (2 * id) / n + 1 };
  return [a, b]
    .map((part) => {
      const text = nodeText(state, part.l, part.i);
      const size = span(part.l);
      return `${part.i * size}+${size}|${text === undefined ? "(not summarized yet: zoom it)" : oneLine(text)}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------- the view

/**
 * Fold the view after a new message: append its own line, then merge the most
 * due pair while over budget. Never split: the view only appends and coarsens.
 */
export function fit(state: ChatState, budget = VIEW): void {
  const T = state.messages.length;
  let size = state.view.reduce((acc, part) => acc + partBytes(state, part), 0);
  while (size > budget) {
    let best: { at: number; due: number } | undefined;
    for (let k = 0; k + 1 < state.view.length; k++) {
      const a = state.view[k]!;
      const b = state.view[k + 1]!;
      if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1) continue;
      const parent: Part = { l: a.l + 1, i: a.i / 2 };
      if (!built(state, parent.l, parent.i)) continue;
      const start = a.i * span(a.l);
      const due = (T - start) / span(a.l + 2);
      if (!best || due > best.due) best = { at: k, due };
    }
    if (!best) break;
    const a = state.view[best.at]!;
    const before = partBytes(state, a) + partBytes(state, state.view[best.at + 1]!);
    const parent: Part = { l: a.l + 1, i: a.i / 2 };
    state.view.splice(best.at, 2, parent);
    size += partBytes(state, parent) - before;
  }
  state.viewBytes = size;
}

/** Append a message to the log and to the view, then refit. */
export function pushMessage(state: ChatState, kind: Kind, text: string, date: string, budget = VIEW): LogMsg {
  const msg: LogMsg = { i: state.messages.length, kind, text, size: byteLen(`${kind}: ${text}`), date };
  state.messages.push(msg);
  state.view.push({ l: 0, i: msg.i });
  state.viewBytes += partBytes(state, { l: 0, i: msg.i });
  fit(state, budget);
  return msg;
}

// ------------------------------------------------- the compactor's inputs

export interface Step {
  kind: "compress" | "merge";
  /** "<kind>: <text>" for a compress, the two child lines for a merge */
  source: [string] | [string, string];
}

export function stepFor(state: ChatState, l: number, i: number): Step | undefined {
  if (l === 0) {
    const m = state.messages[i];
    if (!m) return undefined;
    return { kind: "compress", source: [msgLine(m)] };
  }
  const a = nodeText(state, l - 1, 2 * i);
  const b = nodeText(state, l - 1, 2 * i + 1);
  if (a === undefined || b === undefined) return undefined;
  return { kind: "merge", source: [oneLine(a), oneLine(b)] };
}

export function compactionPrompt(compactPrompt: string, state: ChatState, l: number, i: number): string | undefined {
  const step = stepFor(state, l, i);
  if (!step) return undefined;
  const end = l === 0 ? i : (i + 1) * span(l);
  const context = viewLinesUpTo(state, end).join("\n");
  const body =
    step.kind === "compress"
      ? `Compress this message into one line, in at most ${NODE} bytes:\n${step.source[0]}`
      : `Merge these two lines into one, in at most ${NODE} bytes:\n${step.source[0]}\n${step.source[1]}`;
  return (
    `${compactPrompt}\n\n` +
    `<chat>\n${context}\n</chat>\n\n` +
    `For scale, this line is exactly ${NODE} bytes:\n${SCALE}\n\n` +
    body
  );
}

export const SIZE_FEEDBACK = (bytes: number, cut: string): string =>
  `That line is ${bytes} bytes; the limit is ${NODE}. It must end where it is cut here:\n${cut}| \u2190 LIMIT`;

export function shortest(tries: string[]): string | undefined {
  let best: string | undefined;
  for (const t of tries) if (best === undefined || byteLen(t) < byteLen(best)) best = t;
  return best;
}

// ---------------------------------------------------------------- ingestion

export interface IncomingPart {
  type?: string;
  text?: unknown;
  name?: unknown;
  input?: unknown;
  result?: unknown;
  [k: string]: unknown;
}

export type AnyPart = IncomingPart & { id?: unknown };

export interface IncomingMessage {
  id?: string;
  role?: string;
  content?: IncomingPart[];
  metadata?: unknown;
}

/**
 * Identity of a message OpenCode gave us no id for (tool results carry none on
 * the message itself). Must depend on the content, not just its length: two
 * results of equal size are different messages.
 */
export function signature(msg: IncomingMessage): string {
  const hash = createHash("sha1");
  hash.update(String(msg.role));
  for (const part of msg.content ?? []) {
    hash.update(`\u0000${String(part.type)}\u0000${String((part as AnyPart).id ?? "")}\u0000`);
    hash.update(typeof part.text === "string" ? part.text : JSON.stringify(part.result ?? null));
  }
  return `${msg.role}#${hash.digest("hex").slice(0, 16)}`;
}

function cap(text: string, cap = CAP): string {
  if (byteLen(text) <= cap) return text;
  const head = cutUtf8(text, Math.floor(cap / 2));
  const tail = text.slice(-Math.floor(cap / 2));
  return `${head}\n[... ${byteLen(text) - cap} bytes cut ...]\n${tail}`;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function resultText(result: unknown): string {
  const r = result as { type?: string; value?: unknown } | undefined;
  if (!r) return "(no result)";
  if (r.type === "content" && Array.isArray(r.value)) {
    return (r.value as IncomingPart[])
      .map((c) => (c.type === "text" ? String(c.text ?? "") : `[file ${String(c.uri ?? "")}]`))
      .join("\n");
  }
  if (r.type === "error") return `error: ${stringify(r.value)}`;
  return stringify(r.value);
}

const SKIP_KINDS = new Set(["reasoning", "compaction", "effort"]);

/** Decompose one OpenCode message into log entries (0..n). */
export function decompose(msg: IncomingMessage, date: string, startIndex: number, cap0 = CAP): Omit<LogMsg, "i">[] {
  const out: Omit<LogMsg, "i">[] = [];
  const add = (kind: Kind, text: string) => {
    const t = cap(text, cap0);
    if (!t.trim()) return;
    out.push({ kind, text: t, size: byteLen(`${kind}: ${t}`), date });
  };
  void startIndex;
  const parts = msg.content ?? [];
  if (msg.role === "user") {
    const texts = parts.filter((p) => p.type === "text").map((p) => String(p.text ?? ""));
    const media = parts.filter((p) => p.type === "media").length;
    const joined = texts.join("\n").trim();
    if (joined) add("user", joined + (media ? `\n[${media} attachment(s)]` : ""));
    return out;
  }
  if (msg.role === "assistant") {
    for (const p of parts) {
      if (SKIP_KINDS.has(String(p.type))) continue;
      if (p.type === "text") add("talk", String(p.text ?? ""));
      else if (p.type === "tool-call") add("tool", `${String(p.name ?? "?")} ${stringify(p.input)}`);
    }
    return out;
  }
  if (msg.role === "tool") {
    for (const p of parts) {
      if (p.type === "tool-result") add("echo", resultText(p.result));
      else if (p.type === "text") add("echo", String(p.text ?? ""));
    }
  }
  return out;
}

/** True when the message carries a compaction marker (never part of the log). */
export function isCompaction(msg: IncomingMessage): boolean {
  return (msg.content ?? []).some((p) => p.type === "compaction");
}
