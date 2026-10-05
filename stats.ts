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
  /** context tokens carried by every request, in order (without vs with optchat) */
  series: { full: number; ours: number }[];
}

export interface RealUsage {
  requests: number;
  last: { input: number; cache: number; output: number };
  totals: { input: number; cache: number; output: number };
  /** per request, in order — what the provider really billed */
  series: { input: number; cache: number; output: number }[];
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
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
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

  return {
    requests: perTurn.length,
    ratio,
    last,
    maxFull,
    cumulative: { full: cumulativeFull, ours: cumulativeOurs },
    samples,
    series: perTurn,
  };
}

/** Real usage as OpenCode reports it, summed over the session's assistant messages. */
export function realUsage(messages: UsageCarrier[]): RealUsage {
  const totals = { input: 0, cache: 0, output: 0 };
  let last = { input: 0, cache: 0, output: 0 };
  let requests = 0;
  const series: { input: number; cache: number; output: number }[] = [];
  for (const m of messages) {
    const t = m.tokens;
    if (!t || typeof t.input !== "number") continue;
    requests++;
    const row = { input: t.input, cache: t.cache?.read ?? 0, output: t.output ?? 0 };
    totals.input += row.input;
    totals.cache += row.cache;
    totals.output += row.output;
    series.push(row);
    last = row;
  }
  return { requests, last, totals, series };
}

// ------------------------------------------------------------------- pricing

/** USD per million tokens, as the model catalogue reports them. */
export interface Prices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** "provider/model" these prices belong to ("" for the built-in default) */
  model: string;
  source: "catalogue" | "default";
}

/** Used when the model catalogue cannot be read (offline runs, tests). */
export const DEFAULT_PRICES: Prices = {
  input: 0.27,
  output: 1.1,
  cacheRead: 0.027,
  cacheWrite: 0.27,
  model: "",
  source: "default",
};

/** Turn a catalogue `ModelInfo` into prices; falls back when cost is missing. */
export function pricesFromModel(model: any, fallback: Prices = DEFAULT_PRICES): Prices {
  const cost = Array.isArray(model?.cost) ? model.cost[0] : undefined;
  if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") return fallback;
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: typeof cost.cache?.read === "number" ? cost.cache.read : fallback.cacheRead,
    cacheWrite: typeof cost.cache?.write === "number" ? cost.cache.write : fallback.cacheWrite,
    model: `${model?.providerID ?? "?"}/${model?.modelID ?? model?.id ?? "?"}`,
    source: "catalogue",
  };
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export interface EffectivePrices extends Prices {
  /** true when the prices were inferred from what the session really cost */
  derived: boolean;
}

/**
 * Rescale every price by one factor so that the measured side adds up to what
 * the session really cost. The ratios between input, cache read and output are
 * kept, only the scale changes — which is what makes the counterfactual
 * comparable with the invoice.
 */
export function scalePrices(prices: Prices, usage: RealUsage, paidUsd: number): Prices {
  const cacheRatio = prices.input > 0 ? prices.cacheRead / prices.input : 0;
  const outputRatio = prices.input > 0 ? prices.output / prices.input : 0;
  const equivalents =
    (usage.totals.input + cacheRatio * usage.totals.cache + outputRatio * usage.totals.output) / 1e6;
  if (!(equivalents > 0) || !(prices.input > 0) || !(paidUsd > 0)) return prices;
  const scale = paidUsd / equivalents / prices.input;
  return {
    input: prices.input * scale,
    output: prices.output * scale,
    cacheRead: prices.cacheRead * scale,
    cacheWrite: prices.cacheWrite * scale,
    model: prices.model,
    source: prices.source,
  };
}

/**
 * Prices to bill with: the catalogue's when it has the model, otherwise inferred
 * from what the session actually cost.
 */
export function effectivePrices(prices: Prices, usage?: RealUsage, paidUsd?: number): EffectivePrices {
  const plain: EffectivePrices = { ...prices, derived: false };
  if (prices.source === "catalogue" || !usage || usage.requests === 0) return plain;
  if (typeof paidUsd !== "number" || !(paidUsd > 0)) return plain;
  return { ...scalePrices(prices, usage, paidUsd), derived: true };
}

/** Model prices are quoted in cents per million tokens — that is how cheap they are. */
export function fmtCentsPerMillion(usdPerMillion: number): string {
  const c = usdPerMillion * 100;
  return `${c < 10 ? c.toFixed(2) : c.toFixed(1)} ¢/M`;
}

/** A cost as cents, for figures where dollars hide the scale. */
export function fmtCents(usd: number): string {
  return `${(usd * 100).toFixed(2)} ¢`;
}

/** Money the way these amounts are actually read: under a dime is cents. */
export function fmtMoney(usd: number): string {
  if (!Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0";
  return Math.abs(usd) < 0.1 ? fmtCents(usd) : formatUsd(usd);
}

export interface CostSide {
  /** tokens billed at the fresh input price */
  fresh: number;
  /** tokens served from the provider's cache */
  cached: number;
  output: number;
  usd: number;
}

export interface CostEstimate {
  requests: number;
  without: CostSide;
  with: CostSide;
  savedUsd: number;
  savedPct: number;
  perTurn: { withoutUsd: number; withUsd: number };
  /** true when the "with optchat" column uses the provider's own numbers */
  measuredWith: boolean;
  /** where the prices came from: the catalogue, inferred from the invoice, or rescaled because the two disagreed */
  priceSource: "catalogue" | "inferred" | "rescaled" | "default";
  prices: Prices;
  /** requests whose counterfactual context would not fit the model window */
  overWindow: number;
}

/**
 * Estimate what this session cost and what it would have cost carrying the whole
 * transcript on every request.
 *
 * Without optchat, the prompt of a turn is the whole transcript up to that point:
 * the unchanged prefix comes from the provider's cache (read price) and the new
 * tail is billed as fresh input. With optchat the provider's own per-request
 * numbers are used when the session carries them, otherwise the view sizes are
 * billed the same way. Output tokens are counted identically on both sides, so
 * the comparison isolates the effect of the context.
 */
export function costs(
  series: { full: number; ours: number }[],
  opts: { prices: Prices; usage?: RealUsage; paidUsd?: number; windowTokens?: number },
): CostEstimate {
  const usage = opts.usage && opts.usage.requests > 0 ? opts.usage : undefined;
  const measured = Boolean(usage);
  const bill = (prices: Prices, t: { input: number; cache: number; output: number }) =>
    (t.input / 1e6) * prices.input + (t.cache / 1e6) * prices.cacheRead + (t.output / 1e6) * prices.output;

  // Prices must describe what this session really cost, or the two columns are not
  // comparable: derive them when the catalogue has no entry, and rescale them when
  // the catalogue's numbers disagree with the invoice by more than a quarter.
  let priceSource: "catalogue" | "inferred" | "rescaled" | "default" =
    opts.prices.source === "catalogue" ? "catalogue" : "default";
  const payable = typeof opts.paidUsd === "number" && opts.paidUsd > 0;
  if (usage && payable) {
    const catalogueBill = bill(opts.prices, usage.totals);
    const off = catalogueBill > 0 ? Math.abs(catalogueBill - opts.paidUsd!) / opts.paidUsd! : 1;
    if (opts.prices.source !== "catalogue" || off > 0.25) {
      priceSource = opts.prices.source === "catalogue" ? "rescaled" : "inferred";
    }
  }
  const p = priceSource === "inferred" || priceSource === "rescaled" ? scalePrices(opts.prices, usage!, opts.paidUsd!) : opts.prices;
  const usd = (fresh: number, cached: number, output: number) =>
    (fresh / 1e6) * p.input + (cached / 1e6) * p.cacheRead + (output / 1e6) * p.output;

  // "without optchat": walk the series, the prefix of every request is cached
  const without: CostSide = { fresh: 0, cached: 0, output: 0, usd: 0 };
  const modelledWith: CostSide = { fresh: 0, cached: 0, output: 0, usd: 0 };
  let overWindow = 0;
  let lastFull = { fresh: 0, cached: 0 };
  let lastView = { fresh: 0, cached: 0 };

  for (let i = 0; i < series.length; i++) {
    const full = series[i]!.full;
    const prevFull = i > 0 ? series[i - 1]!.full : 0;
    const fresh = Math.max(0, full - prevFull);
    const cached = Math.min(prevFull, full);
    without.fresh += fresh;
    without.cached += cached;
    lastFull = { fresh, cached };
    if (opts.windowTokens && full > opts.windowTokens) overWindow++;

    const ours = series[i]!.ours;
    const prevOurs = i > 0 ? series[i - 1]!.ours : 0;
    lastView = { fresh: Math.max(0, ours - prevOurs), cached: Math.min(prevOurs, ours) };
    modelledWith.fresh += lastView.fresh;
    modelledWith.cached += lastView.cached;
  }

  // outputs are the same on both sides, so they never explain the gap
  const answers = usage ? usage.totals.output : 0;
  without.output = answers;
  modelledWith.output = answers;

  // "with optchat": the provider's own counts when the session carries them
  const withSide: CostSide = measured
    ? { fresh: usage!.totals.input, cached: usage!.totals.cache, output: answers, usd: 0 }
    : { fresh: modelledWith.fresh, cached: modelledWith.cached, output: answers, usd: 0 };

  without.usd = usd(without.fresh, without.cached, without.output);
  withSide.usd = usd(withSide.fresh, withSide.cached, withSide.output);

  const lastOut = usage ? usage.last.output : 0;
  const perTurn = measured
    ? { withoutUsd: usd(lastFull.fresh, lastFull.cached, lastOut), withUsd: usd(usage!.last.input, usage!.last.cache, usage!.last.output) }
    : {
        withoutUsd: usd(lastFull.fresh, lastFull.cached, lastOut),
        withUsd: usd(lastView.fresh, lastView.cached, lastOut),
      };

  const billedWith = typeof opts.paidUsd === "number" ? opts.paidUsd : withSide.usd;
  const savedUsd = without.usd - billedWith;

  return {
    requests: Math.max(series.length, usage?.requests ?? 0),
    without,
    with: withSide,
    savedUsd,
    savedPct: without.usd > 0 ? Math.max(0, Math.min(100, (savedUsd / without.usd) * 100)) : 0,
    perTurn,
    measuredWith: measured,
    priceSource,
    prices: p,
    overWindow,
  };
}

// ---------------------------------------------------------------------- bars

/** `████░░░░░░░░` — a bar scaled to `max`, no label (callers add the percentage). */
export function bar(value: number, max: number, width = 12): string {
  const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(frac * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

/** ` 42%` — the share of `max` a value takes, right-aligned. */
export function pct(value: number, max: number): string {
  return `${String(Math.round(max > 0 ? (value / max) * 100 : 0)).padStart(3)}%`;
}

// ----------------------------------------------------------------- view parts

export interface ViewPartInfo {
  key: string;
  level: number;
  index: number;
  /** original kind for level 0, "summary" once the part is compacted */
  kind: string;
  bytes: number;
  preview: string;
  /** first and last message index this part stands for */
  covers: [number, number];
  /** true when the view carries the whole text (short message or summary) */
  whole: boolean;
}

/** Everything the popup needs to draw the view, one entry per part. */
export function viewParts(loaded: LoadedChat): ViewPartInfo[] {
  const state = loaded.state;
  return state.view.map((part) => {
    const key = C.nodeKey(part.l, part.i);
    const node = C.nodeText(state, part.l, part.i);
    const exists = node !== undefined;
    const covers = C.covers(part.l, part.i);
    const msg = state.messages[part.i];
    const text = C.oneLine(node ?? C.partText(state, part, "line"));
    // verbatim original (short message, or a stored copy of it) vs summary
    const isOriginal = part.l === 0 && (!exists || (msg !== undefined && C.oneLine(C.msgLine(msg)) === text));
    const kind = isOriginal ? (msg?.kind ?? "?") : "summary";
    // no node at level 0 = the fail-safe line, cut with a zoom pointer
    const whole = exists;
    return {
      key: `${part.l}:${part.i}`,
      level: part.l,
      index: part.i,
      kind,
      bytes: C.partBytes(state, part),
      preview: C.oneLine(text).slice(0, 68),
      covers,
      whole,
    };
  });
}

// ------------------------------------------------------------------- reports

export interface StatsOptions {
  ratio: number;
  budget: number;
  prices: Prices;
  usage?: RealUsage;
  /** what the provider charged for this session, when OpenCode knows it */
  paidUsd?: number;
  /** model context window, to flag a counterfactual that would not have fit */
  windowTokens?: number;
}

const pad = (s: string, n: number) => s.padEnd(n);

function line(label: string, value: string, note = ""): string {
  return `  ${pad(label, 15)}${pad(value, 24)}${note}`.trimEnd();
}

/** The "Stats" screen: session, context per turn, cost — one string per line. */
export function statsLines(snapshot: ChatSnapshot, g: Gains, o: StatsOptions): string[] {
  const out: string[] = [];
  const compression = snapshot.transcriptBytes / Math.max(1, snapshot.sentBytes);

  out.push("## Session");
  out.push(line("session", snapshot.sessionID, snapshot.settled ? `${snapshot.nodes} summaries · up to date` : `${snapshot.nodes} summaries · ${snapshot.unsettled} lines waiting`));
  out.push(line("messages", String(snapshot.messages), `${snapshot.viewLines} parts in the view`));
  out.push(line("transcript", fmtBytes(snapshot.transcriptBytes), "kept in the log, never rewritten"));
  out.push(line("context sent", fmtBytes(snapshot.sentBytes), `budget ${fmtBytes(snapshot.budget)}`));
  out.push(line("budget used", `${bar(snapshot.viewBytes, snapshot.budget)} ${pct(snapshot.viewBytes, snapshot.budget)}`, ""));
  out.push(line("compression", `×${compression.toFixed(1)}`, `${fmtBytes(snapshot.transcriptBytes)} of log → ${fmtBytes(snapshot.sentBytes)} of context`));

  if (snapshot.messages === 0) {
    out.push("");
    out.push("⚠  no memory for this session yet — it started before the plugin was installed");
    return out;
  }

  out.push("");
  out.push("## Context carried per turn");
  const scale = Math.max(g.maxFull, 1);
  out.push(`  ${pad("", 10)}${pad("without optchat", 24)}${"with optchat"}`);
  if (g.requests > 1) {
    for (const s of g.samples) {
      const q = `${Math.round(s.at * 100)}%`.padStart(4);
      const left = `${bar(s.full, scale)} ${pct(s.full, scale)}  ${pad(`${fmtTokens(s.full)} tok`, 10)}`;
      const right = `${bar(s.ours, scale)} ${pct(s.ours, scale)}  ${fmtTokens(s.ours)} tok`;
      out.push(`  ${pad(q, 10)}${pad(left, 34)}${right}`);
    }
  }
  const shrink = g.last.full / Math.max(1, g.last.ours);
  const shrinkAll = g.cumulative.full / Math.max(1, g.cumulative.ours);
  out.push(`  ${pad("last turn", 14)}${pad(`${fmtTokens(g.last.full)} tok`, 26)}${pad(`${fmtTokens(g.last.ours)} tok`, 12)}×${shrink.toFixed(1)} smaller`);
  out.push(`  ${pad("whole session", 14)}${pad(`${fmtTokens(g.cumulative.full)} tok`, 26)}${pad(`${fmtTokens(g.cumulative.ours)} tok`, 12)}×${shrinkAll.toFixed(1)} smaller`);

  const c = costs(g.series, { prices: o.prices, usage: o.usage, paidUsd: o.paidUsd, windowTokens: o.windowTokens });
  out.push("");
  out.push("## Cost (estimate, USD)");
  out.push("  the same session with every turn carrying the whole log vs what it really cost");
  out.push(`  ${pad("", 20)}${pad("full transcript", 20)}optchat · paid`);
  out.push(`  ${pad("last turn", 20)}${pad(fmtMoney(c.perTurn.withoutUsd), 20)}${fmtMoney(c.perTurn.withUsd)}`);
  out.push(`  ${pad("whole session", 20)}${pad(fmtMoney(c.without.usd), 20)}${fmtMoney(c.with.usd)}`);
  const perReq = (usd: number) => fmtCents(usd / Math.max(1, c.requests));
  out.push(`  ${pad("per request", 20)}${pad(perReq(c.without.usd), 20)}${perReq(c.with.usd)}`);
  out.push(`  ${pad("saved", 20)}${fmtMoney(c.savedUsd)}  (${c.savedPct.toFixed(0)}% less)`);
  out.push(
    line(
      "prices",
      `${fmtCentsPerMillion(c.prices.input)} in · ${fmtCentsPerMillion(c.prices.cacheRead)} cache read · ${fmtCentsPerMillion(c.prices.output)} out`,
      "",
    ),
  );
  const catalogueBill =
    o.usage && o.usage.requests > 0
      ? (o.usage.totals.input / 1e6) * o.prices.input +
        (o.usage.totals.cache / 1e6) * o.prices.cacheRead +
        (o.usage.totals.output / 1e6) * o.prices.output
      : undefined;
  const paidText = formatUsd(o.paidUsd ?? 0);
  out.push(
    "        " +
      (c.priceSource === "inferred"
        ? `inferred from the ${paidText} this session cost, so the paid column lands on your invoice`
        : c.priceSource === "rescaled"
          ? `the catalogue bills ${formatUsd(catalogueBill ?? 0)} for these tokens but you paid ${paidText}: prices rescaled to your invoice`
          : c.priceSource === "catalogue"
            ? `from the model catalogue (${c.prices.model})`
            : "built-in defaults: no catalogue price and no invoice to derive from"),
  );
  if (c.prices.model) out.push(line("model", c.prices.model, ""));
  out.push(line("method", "unchanged prefix cached", ""));
  out.push("        every request bills the new tail fresh and serves the prefix from the cache;");
  out.push("        answers count the same on both sides, so the gap is the size of the context.");
  out.push("        the summaries themselves cost extra: one small call per summary node.");
  const biggest = g.maxFull;
  if (o.windowTokens && c.overWindow > 0) {
    out.push(
      `⚠  ${c.overWindow} of ${c.requests} requests would have exceeded the ${fmtTokens(o.windowTokens)} token window:`,
    );
    out.push(`   without optchat OpenCode would have had to compact, so the full-transcript column is an upper bound`);
  } else if (!o.windowTokens && biggest > 200_000) {
    out.push(`⚠  the fullest request carries ${fmtTokens(biggest)} tokens; past the model window compaction would run,`);
    out.push(`   so the full-transcript column is an upper bound (window unknown: model not in the catalogue)`);
  } else if (!o.windowTokens) {
    out.push(`  window unknown (model not in the catalogue) · fullest request ${fmtTokens(biggest)} tokens`);
  }

  if (o.usage && o.usage.requests > 0) {
    const u = o.usage;
    out.push("");
    out.push("## Real usage (billed by the provider)");
    out.push(line("requests", String(u.requests), ""));
    out.push(line("tokens", `in ${fmtTokens(u.totals.input)} · cache read ${fmtTokens(u.totals.cache)} · out ${fmtTokens(u.totals.output)}`, ""));
    out.push(line("last request", `in ${fmtTokens(u.last.input)} · cache ${fmtTokens(u.last.cache)} · out ${fmtTokens(u.last.output)}`, ""));
    if (typeof o.paidUsd === "number")
      out.push(
        line(
          "paid",
          `${fmtMoney(o.paidUsd)}  (${fmtCents(o.paidUsd / Math.max(1, u.requests))} a request)`,
          "counted by OpenCode for this session",
        ),
      );
  }
  return out;
}

/** The "Tree" screen: the summary levels and every node. */
export function treeLines(loaded: LoadedChat, maxNodes = 300): string[] {
  const keys = [...loaded.state.nodes.keys()].sort((a, b) => {
    const [la, ia] = a.split(":").map(Number);
    const [lb, ib] = b.split(":").map(Number);
    return la! - lb! || ia! - ib!;
  });
  const out: string[] = [];
  if (keys.length === 0) {
    out.push("No summaries yet — short messages are their own line.");
    out.push("A summary appears once a message needs more than one line.");
    return out;
  }
  const byLevel = new Map<number, number>();
  for (const k of keys) {
    const l = Number(k.split(":")[0]);
    byLevel.set(l, (byLevel.get(l) ?? 0) + 1);
  }
  out.push("## Levels");
  for (const [l, n] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
    out.push(line(`level ${l}`, n === 1 ? "1 node" : `${n} nodes`, `each stands for ${2 ** l} messages`));
  }
  out.push("");
  out.push(`## Nodes (${keys.length})`);
  for (const key of keys.slice(-maxNodes).reverse()) {
    const [l, i] = key.split(":").map(Number);
    const [start, stop] = C.covers(l!, i!);
    const text = loaded.state.nodes.get(key)!;
    const covers = stop - start === 1 ? `msg ${start}` : `msgs ${start}-${stop - 1}`;
    out.push(`  L${l}  ${key.padEnd(8)}${pad(covers, 14)}${pad(fmtBytes(C.byteLen(text)), 9)}${C.oneLine(text).slice(0, 60)}`);
  }
  return out;
}

/** Kept for bin/measure.ts: the same numbers, no UI. */
export function reportLines(snapshot: ChatSnapshot, g: Gains, opts: ReportOptions): string[] {
  return statsLines(snapshot, g, {
    ratio: opts.ratio,
    budget: opts.budget,
    prices: opts.prices ?? DEFAULT_PRICES,
    usage: opts.usage,
    paidUsd: opts.paidUsd,
    windowTokens: opts.windowTokens,
  });
}

export interface ReportOptions {
  ratio: number;
  budget: number;
  prices?: Prices;
  usage?: RealUsage;
  paidUsd?: number;
  windowTokens?: number;
}
