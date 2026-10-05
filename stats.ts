/**
 * optchat stats — what a chat costs and what the plugin saves.
 *
 * Pure computation over the chat directory (no model calls, no network): fold
 * the view exactly like the plugin does, then compare, for every model request
 * of the session, the history the transcript would have carried against what the
 * plugin actually sends. Shared by the TUI popup and by `bin/measure.ts`.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import * as C from "./core.ts";
import { dataDir } from "./settings.ts";

/** tokens the system prompt + tool definitions occupy on every request (measured). */
export const OVERHEAD_TOKENS = 8_832;

export interface ChatSnapshot {
  sessionID: string;
  dir: string;
  exists: boolean;
  messages: number;
  transcriptBytes: number;
  nodes: number;
  viewLines: number;
  viewBytes: number;
  /** bytes actually sent for the view (unsummarized lines bounded, not whole) */
  sentBytes: number;
  unsettled: number;
  settled: boolean;
  budget: number;
}

export interface Gains {
  requests: number;
  ratio: number;
  last: { full: number; ours: number };
  maxFull: number;
  cumulative: { full: number; ours: number };
  /** samples at 0/25/50/75/100% of the session */
  samples: { at: number; full: number; ours: number }[];
}

export interface RealUsage {
  requests: number;
  last: { input: number; cache: number; output: number };
  totals: { input: number; cache: number; output: number };
}

/** OpenCode session messages carry this; we accept anything shaped like it. */
export interface UsageCarrier {
  tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
  role?: string;
  type?: string;
}

export function chatDir(sessionID: string): string {
  return join(dataDir(), sessionID.replace(/[^\w.-]/g, "_"));
}

export interface RecentChat {
  sessionID: string;
  messages: number;
  bytes: number;
  /** ISO date of the last write, for display */
  when: string;
}

/**
 * Chats known to the plugin, most recently written first. Cheap: counts lines
 * and bytes, never folds the view — so a menu can open instantly.
 */
export async function recentChats(limit = 12): Promise<RecentChat[]> {
  const root = dataDir();
  let dirs: string[] = [];
  try {
    dirs = (await fs.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out: RecentChat[] = [];
  for (const name of dirs) {
    const main = join(root, name, "main");
    try {
      const files = (await fs.readdir(main)).filter((f) => f.endsWith(".jsonl")).sort();
      if (!files.length) continue;
      let bytes = 0;
      let lines = 0;
      let at = 0;
      for (const f of files) {
        const stat = await fs.stat(join(main, f));
        bytes += stat.size;
        at = Math.max(at, stat.mtimeMs);
        lines += (await fs.readFile(join(main, f), "utf8")).split("\n").filter((l) => l.trim()).length;
      }
      out.push({ sessionID: name, messages: lines, bytes, when: new Date(at).toISOString().slice(0, 16).replace("T", " ") });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => (a.when < b.when ? 1 : -1)).slice(0, limit);
}

async function readJsonl(dir: string, sub: string): Promise<string[]> {
  try {
    const files = (await fs.readdir(join(dir, sub))).filter((f) => f.endsWith(".jsonl")).sort();
    const out: string[] = [];
    for (const f of files) {
      out.push(...(await fs.readFile(join(dir, sub, f), "utf8")).split("\n").filter((l) => l.trim()));
    }
    return out;
  } catch {
    return [];
  }
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} Ko`;
  return `${(n / 1024 / 1024).toFixed(2)} Mo`;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}

export interface LoadedChat {
  snapshot: ChatSnapshot;
  state: C.ChatState;
  rows: Record<string, unknown>[];
  /** transcript bytes / view bytes as they stood at each message index */
  transcriptAt: number[];
  viewAt: number[];
}

/** Read one chat directory and fold its view the way the plugin does. */
export async function loadChatDir(dir: string, budget = 128_000): Promise<LoadedChat> {
  const sessionID = dir.split("/").filter(Boolean).pop() ?? dir;
  const mainRows = (await readJsonl(dir, "main")).map((l) => {
    try {
      return JSON.parse(l) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }).filter((r): r is Record<string, unknown> => r !== undefined);
  const treeRows = (await readJsonl(dir, "tree")).map((l) => {
    try {
      return JSON.parse(l) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }).filter((r): r is Record<string, unknown> => r !== undefined);

  const state = C.newChatState();
  for (const row of mainRows) {
    if (typeof row.text !== "string") continue;
    const kind = row.kind as C.Kind;
    state.messages.push({
      i: state.messages.length,
      kind,
      text: row.text,
      size: typeof row.size === "number" ? row.size : C.byteLen(`${kind}: ${row.text}`),
      date: typeof row.date === "string" ? row.date : "",
    });
  }
  for (const row of treeRows) {
    if (typeof row.text !== "string" || !Number.isInteger(row.l) || !Number.isInteger(row.i)) continue;
    state.nodes.set(C.nodeKey(row.l as number, row.i as number), row.text);
  }
  const transcriptAt: number[] = [];
  const viewAt: number[] = [];
  let transcript = 0;
  for (const m of state.messages) {
    transcript += m.size;
    const part: C.Part = { l: 0, i: m.i };
    state.view.push(part);
    state.viewBytes += C.partBytes(state, part);
    C.fit(state, budget);
    transcriptAt[m.i] = transcript;
    viewAt[m.i] = state.viewBytes;
  }

  const transcriptBytes = transcript;
  return {
    state,
    rows: mainRows,
    transcriptAt,
    viewAt,
    snapshot: {
      sessionID,
      dir,
      exists: state.messages.length > 0,
      messages: state.messages.length,
      transcriptBytes,
      nodes: state.nodes.size,
      viewLines: state.view.length,
      viewBytes: state.viewBytes,
      sentBytes: C.byteLen(C.renderView(state, "line")),
      unsettled: C.unsettled(state),
      settled: C.settled(state),
      budget,
    },
  };
}

/**
 * One model request per assistant message; for each, the history carried is the
 * whole transcript (no plugin) vs the view (plugin).
 */
/** Same, addressed by OpenCode session id. */
export async function loadChat(sessionID: string, budget = 128_000): Promise<LoadedChat> {
  return loadChatDir(chatDir(sessionID), budget);
}

export function gains(sessionID: string, loaded: LoadedChat, rows: Record<string, unknown>[], ratio: number): Gains {
  const { state } = loaded;
  const srcAt: (string | undefined)[] = rows.map((r) => (typeof r.src === "string" ? r.src : undefined));

  const seen = new Set<string>();
  const requests: number[] = [];
  for (let i = 0; i < state.messages.length; i++) {
    const kind = state.messages[i]!.kind;
    if (kind !== "talk" && kind !== "tool") continue;
    const src = srcAt[i] ?? `#${i}`;
    if (seen.has(src)) continue;
    seen.add(src);
    requests.push(i);
  }
  void sessionID;

  const transcriptAt = loaded.transcriptAt;
  const viewAt = loaded.viewAt;
  void state;

  const perTurn = requests.map((i) => {
    const full = transcriptAt[i]! / ratio + OVERHEAD_TOKENS;
    const ours = viewAt[i]! / ratio + OVERHEAD_TOKENS;
    return { full, ours };
  });

  let cumulativeFull = 0;
  let cumulativeOurs = 0;
  let maxFull = 0;
  for (const t of perTurn) {
    cumulativeFull += t.full;
    cumulativeOurs += t.ours;
    maxFull = Math.max(maxFull, t.full);
  }
  const last = perTurn[perTurn.length - 1] ?? { full: OVERHEAD_TOKENS, ours: OVERHEAD_TOKENS };
  const samples = [0, 0.25, 0.5, 0.75, 1].map((q) => {
    const at = perTurn[Math.min(perTurn.length - 1, Math.round(q * (perTurn.length - 1)))] ?? last;
    return { at: q, full: at.full, ours: at.ours };
  });

  return { requests: perTurn.length, ratio, last, maxFull, cumulative: { full: cumulativeFull, ours: cumulativeOurs }, samples };
}

/** Real usage as OpenCode reports it, summed over the session's assistant messages. */
export function realUsage(messages: UsageCarrier[]): RealUsage {
  const totals = { input: 0, cache: 0, output: 0 };
  let last = { input: 0, cache: 0, output: 0 };
  let requests = 0;
  for (const m of messages) {
    const t = m.tokens;
    if (!t || typeof t.input !== "number") continue;
    requests++;
    const row = { input: t.input, cache: t.cache?.read ?? 0, output: t.output ?? 0 };
    totals.input += row.input;
    totals.cache += row.cache;
    totals.output += row.output;
    last = row;
  }
  return { requests, last, totals };
}

export interface ReportOptions {
  ratio: number;
  cacheRatio: number;
  budget: number;
  usage?: RealUsage;
}

/** The lines shown in the popup and printed by bin/measure.ts. */
export function reportLines(snapshot: ChatSnapshot, g: Gains, opts: ReportOptions): string[] {
  const lines: string[] = [];
  const pct = Math.round((snapshot.viewBytes / snapshot.budget) * 100);
  lines.push(`session      ${snapshot.sessionID}`);
  lines.push(`messages     ${snapshot.messages}   arbre ${snapshot.nodes} nœuds   ${snapshot.settled ? "à jour" : `${snapshot.unsettled} lignes en attente du compacteur`}`);
  lines.push(`transcript   ${fmtBytes(snapshot.transcriptBytes)}`);
  lines.push(`vue envoyée  ${fmtBytes(snapshot.sentBytes)}   (${snapshot.viewLines} lignes, ${pct}% du budget de ${fmtBytes(snapshot.budget)})`);
  const compression = snapshot.transcriptBytes / Math.max(1, snapshot.sentBytes);
  lines.push(`compression  ×${compression.toFixed(1)}  (transcript / vue)`);
  lines.push(`ratio utilisé ${opts.ratio} octets/token  ·  cache à ${Math.round(opts.cacheRatio * 100)}% du prix`);
  lines.push("");
  lines.push("historique porté à chaque tour           full        optchat");
  for (const s of g.samples) {
    const p = `${Math.round(s.at * 100)}%`.padStart(4);
    if (g.requests <= 1) break;
    lines.push(`  ${p}                 ${fmtTokens(s.full).padStart(8)} tok  ${fmtTokens(s.ours).padStart(8)} tok   ×${(s.full / Math.max(1, s.ours)).toFixed(1)}`);
  }
  lines.push("");
  lines.push(`dernier tour   full ${fmtTokens(g.last.full)} tok   →   optchat ${fmtTokens(g.last.ours)} tok`);
  lines.push(`cumul session  full ${fmtTokens(g.cumulative.full)} tok   →   optchat ${fmtTokens(g.cumulative.ours)} tok   (×${(g.cumulative.full / Math.max(1, g.cumulative.ours)).toFixed(1)})`);
  if (opts.usage && opts.usage.requests > 0) {
    const u = opts.usage;
    const billed = u.totals.input + u.totals.cache * opts.cacheRatio;
    lines.push("");
    lines.push(`réel (${u.requests} requêtes)   in ${fmtTokens(u.totals.input)} · cache ${fmtTokens(u.totals.cache)} · out ${fmtTokens(u.totals.output)}`);
    lines.push(`dernier appel        in ${fmtTokens(u.last.input)} · cache ${fmtTokens(u.last.cache)} · out ${fmtTokens(u.last.output)}`);
    lines.push(`facturé estimé       ${fmtTokens(billed)} tok équivalents (cache à ${Math.round(opts.cacheRatio * 100)}%)`);
  }
  if (snapshot.messages === 0) {
    lines.push("");
    lines.push("(aucune mémoire pour cette session : elle a démarré avant l'installation du plugin)");
  }
  return lines;
}
