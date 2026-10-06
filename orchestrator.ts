/**
 * optchat — orchestrator mode
 *
 * One conversation, many subagents.
 *
 * In memory mode the plugin rewrites the context of one long chat so it stays
 * bounded. That is the right trade for a conversation you keep, and the wrong
 * one for a conversation that drives many parallel sessions: every turn pays for
 * a rebuilt view.
 *
 * Orchestrator mode takes the other side of the trade. The orchestrator's own
 * context holds a mission, an append-only ledger of finished runs, and the turn
 * at hand — nothing else. All the noise (diffs, logs, file dumps, dead ends)
 * lives in subagent sessions, which the orchestrator starts, follows, resumes and
 * collects. Because the ledger only ever grows, the head of every payload is
 * byte-identical to the previous one: the prompt cache keeps hitting.
 *
 * The tools here are gated on the calling agent: `ToolContext` carries
 * `agent: Agent.ID`, so a model that is not the orchestrator cannot drive
 * subagents even if it knows their names.
 */

export const AGENT = "orchestrator";

/** Marker put in the system prompt so the addendum is never pushed twice. */
export const MARK = "optchat-orchestrator";

/** One line of the ledger, appended once and never rewritten. */
export interface RunEvent {
  /** the subagent's session id */
  id: string;
  /** the orchestrator session that started it */
  parent?: string;
  /** one-line subject, as given to spawn */
  task: string;
  /** append-only event name */
  event: "spawned" | "done" | "failed" | "stopped" | "resumed";
  /** one-line return, only on a terminal event */
  result?: string;
  /** epoch ms */
  at: number;
}

/**
 * The orchestrator's instructions. This is the whole behaviour: the tools only
 * give it the means, this says how to use them and how to talk to its subagents.
 */
export const WORKFLOW = `You orchestrate. You do not do the work yourself.

Your tools are only the ones that drive subagents: spawn, collect, status, stop,
find, zoom, date. You cannot edit files, run commands, or read the repository. If
something needs doing, a subagent does it.

Running a subagent
- One subagent per independent subject. Several subjects? Spawn several in the
  same turn: they run in parallel, and their context is not charged to yours —
  only their return is.
- Every brief must be self-contained. The subagent sees nothing of this
  conversation and nothing of your other subagents. Give it: the goal, the exact
  paths, the constraints, what must not break, and the shape of the report you
  want back.
- Ask for evidence, not conclusions: files changed, commands run, output of the
  tests. A subagent's summary is a self-report. Collect the artefacts, or spawn a
  second subagent whose only job is to check the first one.

Keeping this conversation
- After a spawn, one ledger line: id, subject, state. The ledger is append-only
  and it is the only memory you keep. Never paste a subagent's output into it —
  one line per run.
- To continue a subject, resume the same subagent (collect with say:...). Do not
  start a new one: it would lose everything it learned. Restate the one or two
  facts it needs, because a resumed subagent only remembers its own session.
- Prefer poll over block: keep several runs in flight and collect the ones that
  are done. status lists them; stop interrupts one.
- Before asking a subagent for something you already have, look for it yourself
  with find (your own log, word for word) and zoom.
- read and search over the repository are a last resort: they are for verifying
  one precise claim, never for exploring. Exploring is a subagent's job, and
  anything you read stays in this context and is paid for on every later turn.

Answering the user
Report what actually happened: the ledger, what each subagent returned, what is
still running, what is blocked. Never present a result you did not collect.`;

/** A run as the orchestrator sees it: the last event wins. */
export interface Run {
  id: string;
  task: string;
  state: "running" | "done" | "failed" | "stopped";
  result?: string;
  at: number;
}

/** Render one event as one ledger line. Pure, so the same event always renders the same bytes. */
export function ledgerLine(e: RunEvent): string {
  const when = new Date(e.at).toISOString().slice(11, 19);
  const tail = e.result ? ` | ${oneLine(e.result)}` : "";
  return `${e.id.slice(0, 22)} | ${oneLine(e.task)} | ${e.event}${tail} | ${when}`;
}

export function ledgerLines(events: readonly RunEvent[]): string[] {
  return events.map(ledgerLine);
}

/** The renderable block. Append-only: it is the frozen part of the orchestrator's context. */
export function ledgerBlock(events: readonly RunEvent[]): string {
  return `<ledger>\n${ledgerLines(events).join("\n")}\n</ledger>`;
}

/** Collapse a run's events into its current state. */
export function runsOf(events: readonly RunEvent[]): Run[] {
  const byId = new Map<string, Run>();
  for (const e of events) {
    const run = byId.get(e.id);
    if (!run) {
      byId.set(e.id, { id: e.id, task: e.task, state: stateOf(e.event), result: e.result, at: e.at });
      continue;
    }
    run.task = e.task || run.task;
    run.state = stateOf(e.event) === "running" ? run.state : stateOf(e.event);
    if (e.event === "spawned" || e.event === "resumed") run.state = "running";
    if (e.result) run.result = e.result;
    run.at = e.at;
  }
  return [...byId.values()].sort((a, b) => a.at - b.at);
}

function stateOf(event: RunEvent["event"]): Run["state"] {
  switch (event) {
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    default:
      return "running";
  }
}

/** A one-line, bounded rendering of anything a subagent said. */
export function oneLine(s: string, max = 400): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Only the orchestrator drives subagents. Everything else gets a refusal that
 * says so, rather than a silent no-op: an agent that tried deserves to know why.
 */
export function allowed(agent: unknown, expected = AGENT): boolean {
  return typeof agent === "string" && agent.toLowerCase() === expected;
}

export function refused(agent: unknown): string {
  return `Refused: driving subagents is reserved to the "${AGENT}" agent (called by ${String(agent ?? "unknown")}).`;
}

/** One result line for the ledger, from a subagent's own last message. */
export function resultLine(events: readonly RunEvent[], id: string, text: string): RunEvent {
  const run = runsOf(events).find((r) => r.id === id);
  return { id, task: run?.task ?? "(unknown)", event: "done", result: oneLine(text, 300), at: Date.now() };
}

/** Find lines of our own log matching a query, case-insensitively. */
export function findLines(rows: ReadonlyArray<{ i: number; text: string }>, query: string, limit = 12): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const out: string[] = [];
  for (const row of rows) {
    if (row.text.toLowerCase().includes(needle)) {
      out.push(`${row.i} | ${oneLine(row.text, 220)}`);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** The runs started by one orchestrator session. */
export function runsOfParent(events: readonly RunEvent[], parent: string): Run[] {
  return runsOf(events.filter((e) => e.parent === parent));
}

/** Every session id we ever spawned: those must run as plain sessions. */
export function spawnedIds(events: readonly RunEvent[]): string[] {
  return [...new Set(events.map((e) => e.id))];
}

/** The tools the orchestrator is allowed to see. Everything else is hidden from it. */
export const TOOL_NAMES = ["spawn", "collect", "status", "stop", "find", "zoom", "date"] as const;

/** Keep only the orchestrator's tools in the set offered to the model. */
export function filterTools<T extends Record<string, unknown>>(tools: T): T {
  const keep = new Set<string>(TOOL_NAMES as readonly string[]);
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(tools ?? {})) {
    if (keep.has(name)) out[name] = value;
  }
  return out as T;
}
