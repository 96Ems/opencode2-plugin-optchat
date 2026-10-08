/**
 * optchat-core — pure logic for the OptChat memory (append-only log + binary
 * summary tree + tiling view). No I/O, no model calls: everything here is
 * deterministic and unit-testable.
 *
 * Spec: "UniiChat: one chat that never ends" (VictorTaelin — the OptChat
 * recipe). Node (l,i) covers messages [i*2^l, (i+1)*2^l) and holds at most NODE
 * bytes of text. The view tiles [0,T) with tree nodes, and when it passes VIEW
 * bytes it merges down to VIEW/2 in ONE batch (never a little at each message).
 */

import { createHash } from "node:crypto";

export const NODE = 512;
export const VIEW = 128_000;
export const CAP = 30_000;
/** A node may start while fewer than this many view lines ahead of it are unbuilt. */
export const PENDING = 8;
/** A compaction sees the chat's view merged further into this band, in bytes. */
export const COMPACT_HIGH = 32_000;
export const COMPACT_LOW = 16_000;

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

export interface Candidate {
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
  /** nodes that may still need building, in the order they became possible */
  queue: Candidate[];
  queued: Set<string>;
  /** the view changed since the host last wrote it out (view.json) */
  viewDirty: boolean;
  /** the view passed its high mark and is being merged down to the low one */
  batching: boolean;
}

export function newChatState(): ChatState {
  return {
    messages: [],
    nodes: new Map(),
    free: new Map(),
    view: [],
    viewBytes: 0,
    queue: [],
    queued: new Set(),
    viewDirty: false,
    batching: false,
  };
}

// ---------------------------------------------------------------- byte utils

export function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Characters, counted as code points — the unit the tool-result cap is in. */
export function charLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Longest prefix of `s` in at most `max` characters, never splitting one. */
export function cutChars(s: string, max: number): string {
  if (max <= 0) return "";
  let out = "";
  let n = 0;
  for (const ch of s) {
    if (n >= max) break;
    out += ch;
    n++;
  }
  return out;
}

const REPLACEMENT = "\uFFFD";

/** Longest prefix of `s` in at most `max` UTF-8 bytes, never splitting a character. */
export function cutUtf8(s: string, max: number): string {
  if (byteLen(s) <= max) return s;
  let out = Buffer.from(s, "utf8").subarray(0, max).toString("utf8");
  if (out.endsWith(REPLACEMENT)) out = out.slice(0, -1);
  return out;
}

/**
 * The size reference shown to the compactor: a ruler of exactly NODE dashes.
 *
 * Never a real sample line: the model copies the sample's content into its own
 * answer ("a real sample line as the ruler got its content copied").
 */
export const RULER: string = "-".repeat(NODE);

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
  if (l === 0) return i >= 0 && i < state.messages.length;
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

/**
 * How many view lines before message `end` the compactor has not summarized yet.
 *
 * The count is capped at `stop`: past that the answer is only "not yet", and
 * stopping early is what keeps this cheap — a fresh chat has hundreds of unbuilt
 * lines queued, and walking all of them per node would be the O(N^2) scan this
 * queue exists to avoid. A node may start only while fewer than PENDING lines
 * ahead of it are unbuilt.
 */
export function unbuiltBefore(state: ChatState, end: number, stop = PENDING, frontier = firstUnbuilt(state)): number {
  let n = 0;
  for (let k = frontier; k < state.view.length; k++) {
    const part = state.view[k]!;
    if (part.i * span(part.l) >= end) break;
    if (nodeText(state, part.l, part.i) !== undefined) continue;
    if (++n >= stop) return n;
  }
  return n;
}

/** Index in the view of the first line the compactor has not summarized. */
export function firstUnbuilt(state: ChatState): number {
  for (let k = 0; k < state.view.length; k++) {
    const part = state.view[k]!;
    if (nodeText(state, part.l, part.i) === undefined) return k;
  }
  return state.view.length;
}

/**
 * Put a node in the ready queue — or, if it is already a node (stored, or free
 * because its source fits), its parent, since building this one is what can make
 * the parent buildable.
 *
 * Never scan the tree for work: over a long chat that is O(N^2). The queue is
 * filled as messages arrive (pushMessage) and as builds finish (the host calls
 * this); primeQueue fills it once, when a chat is loaded.
 */
export function enqueue(state: ChatState, l: number, i: number): void {
  for (;;) {
    if (l < 0 || i < 0) return;
    if (i * span(l) >= state.messages.length) return; // covers no message yet
    if (!ready(state, l, i)) return; // wait until its sources exist
    const key = nodeKey(l, i);
    if (state.nodes.has(key) || state.free.has(key)) {
      const pl = l + 1;
      const pi = i >> 1;
      if (pi * span(pl) < state.messages.length && ready(state, pl, pi)) {
        l = pl;
        i = pi;
        continue;
      }
      return;
    }
    if (!state.queued.has(key)) {
      state.queued.add(key);
      state.queue.push({ l, i });
    }
    return;
  }
}

/** Fill the queue from the tree (once, when a chat is loaded). */
export function primeQueue(state: ChatState): void {
  state.queue = [];
  state.queued = new Set();
  const T = state.messages.length;
  for (let l = 0; span(l) <= T; l++) {
    for (let i = 0; (i + 1) * span(l) <= T; i++) {
      if (ready(state, l, i)) enqueue(state, l, i);
    }
  }
}

/**
 * Nodes the compactor may start now, in order, up to `limit`, taken from the
 * ready queue. A node starts when it is unbuilt, not busy, has its sources, is
 * within PENDING unbuilt lines of the compactor's own frontier, and is not
 * backing off after a failure.
 */
export function candidates(
  state: ChatState,
  busy: Set<string>,
  limit: number,
  failed?: Map<string, number>,
  now = Date.now(),
  retryMs = 10_000,
): Candidate[] {
  const out: Candidate[] = [];
  if (limit <= 0) return out;
  const wait: Candidate[] = [];
  const frontier = firstUnbuilt(state);
  for (const cand of state.queue) {
    const key = nodeKey(cand.l, cand.i);
    if (state.nodes.has(key) || state.free.has(key)) {
      state.queued.delete(key);
      continue;
    }
    // Stays in the queue until it is built: `busy` is what stops a second start,
    // and a node that fails or never runs is never lost.
    wait.push(cand);
    if (out.length >= limit || busy.has(key) || !ready(state, cand.l, cand.i)) continue;
    const ts = failed?.get(key);
    if (ts !== undefined && now - ts < retryMs) continue;
    const end = cand.l === 0 ? cand.i : (cand.i + 1) * span(cand.l);
    if (unbuiltBefore(state, end, PENDING, frontier) >= PENDING) continue;
    out.push(cand);
  }
  state.queue = wait;
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
 *
 * This string IS the context of a turn (followed by the new message, then the
 * turn's own steps). Do NOT build a "cache-frozen head" out of tree nodes to make
 * it more cacheable: freezing whole aligned nodes at a fixed level re-renders the
 * whole log at that level (16, then 32, 64 messages per line) — measured on a
 * 1200-message chat, a 36 KB payload of 16-messages-per-line lines instead of the
 * 128 KB view, with the last 100 messages at level 4 instead of level 0 — so the
 * recent detail the tiling exists to keep is gone, and every figure measured from
 * this view describes a payload that is never sent. The fold is what keeps the
 * cache: it only appends and coarsens near the end, in batches.
 */
export function renderView(state: ChatState, mode: "placeholder" | "line" = "placeholder"): string {
  const lines = state.view.map((part) => {
    const n = span(part.l);
    return `${part.i * n}+${n}|${partText(state, part, mode)}`;
  });
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
      return `${part.i * size}+${size}|${text === undefined ? PLACEHOLDER : oneLine(text)}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------- the view

/**
 * Age of a sibling pair, as the spec measures it: how long ago the pair ENDED,
 * measured in its own line size.
 *
 *   due = (T - last) / 2^l        last = the pair's last message
 *
 * Measuring from the pair's FIRST message ((T - first)/2^l) is wrong: near ties
 * it merges old pairs and rewrites old lines that the reference's rollback-style
 * push keeps. Checked against that push over 4,000 steps, this rule reproduces it
 * at every step and the `first` rule on 275 of 4,000. Merging early lines that
 * were kept is what erodes the cached prefix: the prefix ends at the first byte
 * that changed, so a rewrite near the head costs the whole view after it.
 */
export function pairDue(a: Part, T: number): number {
  const last = (a.i + 2) * span(a.l) - 1;
  return (T - last) / span(a.l);
}

/**
 * Fold the view after a new message: append its line, and — only once the view
 * passes `high` — merge the most due pairs in one batch down to `high/2`.
 *
 * Never split: the view only appends and coarsens. And never merge a little at
 * each message: every merge rewrites the view from the merged line on, so a
 * continuous fold rewrites tens of lines per message while a batch rewrites
 * about two (measured over 30,000 messages: 21 vs 80 line-inputs per message).
 */
export function fit(state: ChatState, high = VIEW): void {
  const low = Math.max(1, Math.round(high / 2));
  const T = state.messages.length;
  let size = state.view.reduce((acc, part) => acc + partBytes(state, part), 0);
  if (size > high) state.batching = true;
  if (state.batching) {
    let changed = false;
    while (size > low) {
      let best: { at: number; due: number } | undefined;
      for (let k = 0; k + 1 < state.view.length; k++) {
        const a = state.view[k]!;
        const b = state.view[k + 1]!;
        if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1) continue;
        const parent: Part = { l: a.l + 1, i: a.i / 2 };
        if (!built(state, parent.l, parent.i)) continue;
        const due = pairDue(a, T);
        if (!best || due > best.due) best = { at: k, due };
      }
      if (!best) break; // no parent built yet: merge what we can, on the next call
      const a = state.view[best.at]!;
      const before = partBytes(state, a) + partBytes(state, state.view[best.at + 1]!);
      const parent: Part = { l: a.l + 1, i: a.i / 2 };
      state.view.splice(best.at, 2, parent);
      size += partBytes(state, parent) - before;
      changed = true;
    }
    if (changed) state.viewDirty = true;
    if (size <= low) state.batching = false;
  }
  state.viewBytes = size;
}

/** Append a message to the log and to the view, then refit. */
export function pushMessage(state: ChatState, kind: Kind, text: string, date: string, budget = VIEW): LogMsg {
  const msg: LogMsg = { i: state.messages.length, kind, text, size: byteLen(`${kind}: ${text}`), date };
  state.messages.push(msg);
  state.view.push({ l: 0, i: msg.i });
  state.viewBytes += partBytes(state, { l: 0, i: msg.i });
  enqueue(state, 0, msg.i);
  fit(state, budget);
  state.viewDirty = true;
  return msg;
}

/** The view as the plain [l,i] pairs stored in view.json. */
export function viewPairs(state: ChatState): Array<[number, number]> {
  return state.view.map((part) => [part.l, part.i] as [number, number]);
}

/**
 * Adopt a view read back from view.json.
 *
 * Only a view that still tiles [0,T) exactly, with every line a summary, is
 * usable. Folding the view again from the log picks different merges than the
 * live fold did (a merge waits for its parent to be built, so timing decides),
 * and every prompt-cache entry would die with it.
 */
export function adoptView(state: ChatState, pairs: unknown): boolean {
  if (!Array.isArray(pairs) || pairs.length === 0) return false;
  const view: Part[] = [];
  let at = 0;
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) return false;
    const [l, i] = pair as [unknown, unknown];
    if (!Number.isInteger(l) || !Number.isInteger(i) || (l as number) < 0 || (i as number) < 0) return false;
    const [start, stop] = covers(l as number, i as number);
    if (start !== at) return false;
    if (nodeText(state, l as number, i as number) === undefined) return false;
    view.push({ l: l as number, i: i as number });
    at = stop;
  }
  if (at !== state.messages.length) return false;
  state.view = view;
  state.viewBytes = view.reduce((acc, part) => acc + partBytes(state, part), 0);
  return true;
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

/**
 * The context a compaction call gets: the chat's view up to `end`, merged
 * further into the COMPACT_LOW..COMPACT_HIGH band.
 *
 * A summary needs context to resolve "do it" or "that file", not the whole chat.
 * It stops at the first line the compactor has not summarized: no call ever
 * reads a placeholder or half a message.
 */
export function compactionLines(state: ChatState, end: number): string[] {
  let parts: Array<{ l: number; i: number; text: string }> = [];
  for (const part of state.view) {
    const [start, stop] = covers(part.l, part.i);
    if (start >= end || stop > end) break;
    const text = nodeText(state, part.l, part.i);
    if (text === undefined) break;
    parts.push({ l: part.l, i: part.i, text: oneLine(text) });
  }
  const sizeOf = (p: { l: number; i: number; text: string }) => byteLen(`${p.i * span(p.l)}+${span(p.l)}|${p.text}`);
  let size = parts.reduce((acc, p) => acc + sizeOf(p), 0);
  if (size > COMPACT_HIGH) {
    while (size > COMPACT_LOW) {
      let best: { at: number; due: number } | undefined;
      for (let k = 0; k + 1 < parts.length; k++) {
        const a = parts[k]!;
        const b = parts[k + 1]!;
        if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1) continue;
        if (nodeText(state, a.l + 1, a.i / 2) === undefined) continue;
        const due = pairDue({ l: a.l, i: a.i }, end);
        if (!best || due > best.due) best = { at: k, due };
      }
      if (!best) break;
      const a = parts[best.at]!;
      const b = parts[best.at + 1]!;
      const merged = { l: a.l + 1, i: a.i / 2, text: oneLine(nodeText(state, a.l + 1, a.i / 2)!) };
      const before = sizeOf(a) + sizeOf(b);
      parts.splice(best.at, 2, merged);
      size += sizeOf(merged) - before;
    }
  }
  return parts.map((p) => `${p.i * span(p.l)}+${span(p.l)}|${p.text}`);
}

/**
 * One compaction call. `system` is the SAME prompt a turn carries, so a
 * compaction is a turn plus a task; then the compaction's own view, then the
 * task. The task carries ids (the model is told not to write them back) and
 * shows the size limit as a ruler.
 */
export function compactionPrompt(system: string, state: ChatState, l: number, i: number): string | undefined {
  const step = stepFor(state, l, i);
  if (!step) return undefined;
  const end = l === 0 ? i : (i + 1) * span(l);
  const start = i * span(l);
  const half = span(l - 1);
  const context = compactionLines(state, end).join("\n");
  const task =
    step.kind === "compress"
      ? `Compaction: compress message ${i} into one line of at most ${NODE} bytes\n` +
        `(about 70 words), the length of this ruler:\n${RULER}\n` +
        `<input>\n${step.source[0]}\n</input>`
      : `Compaction: merge lines ${start}+${half} and ${start + half}+${half}, adjacent, into one line of at most ${NODE} bytes\n` +
        `(about 70 words), the length of this ruler:\n${RULER}\n` +
        `<chat> may hold their messages, ${start} to ${end - 1}, in more detail: take details\n` +
        `of them from there too.\n` +
        `<input>\n${step.source[0]}\n${step.source[1]}\n</input>`;
  return `${system}\n\n<chat>\n${context}\n</chat>\n\n${task}`;
}

export const SIZE_FEEDBACK = (bytes: number, cut: string): string =>
  `Too long: your line is ${bytes} bytes, over the ${NODE}-byte limit. Write\n` +
  `the whole line again for the same <input>, cutting just enough of the\n` +
  `least valuable items to fit before this cut:\n${cut}| \u2190 LIMIT`;

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
  const n = charLen(text);
  if (n <= cap) return text;
  const half = Math.floor(cap / 2);
  const chars = [...text];
  const head = chars.slice(0, half).join("");
  const tail = chars.slice(n - half).join("");
  return `${head}\n[... ${n - cap} characters cut ...]\n${tail}`;
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
