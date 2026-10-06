/**
 * optchat-orchestrator tests — bun test
 *
 * The orchestration machinery is mostly glue around the session API, which can
 * only be exercised on a live harness. What is tested here is everything that
 * decides bytes and permissions: the append-only ledger, how runs collapse, the
 * gating of tools on the calling agent, and the bounded renderings that keep a
 * subagent's noise out of the orchestrator's context.
 */
import { describe, expect, test } from "bun:test";
import * as O from "../orchestrator.ts";

describe("orchestrator ledger", () => {
  const at = Date.parse("2026-10-06T12:00:00Z");
  const ev = (over: Partial<O.RunEvent>): O.RunEvent => ({
    id: "ses_a",
    task: "refactor the parser",
    event: "spawned",
    at,
    ...over,
  });

  test("the same event always renders the same line, on one line", () => {
    const e = ev({});
    expect(O.ledgerLine(e)).toBe(O.ledgerLine({ ...e }));
    expect(O.ledgerLine(e)).toContain("spawned");
    expect(O.ledgerLine(e)).not.toContain("\n");
    expect(O.ledgerLine(e).split("|")).toHaveLength(4);
  });

  test("the block only ever grows: the earlier block is a byte-prefix of the later", () => {
    const one = O.ledgerBlock([ev({})]);
    const two = O.ledgerBlock([ev({}), ev({ event: "done", result: "done: 3 files", at: at + 1000 })]);
    const head = one.replace(/\n<\/ledger>$/, "");
    expect(two.startsWith(head)).toBe(true);
  });

  test("runs collapse to their last state, a terminal event wins over spawned", () => {
    const runs = O.runsOf([ev({}), ev({ event: "done", result: "ok", at: at + 1 })]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.state).toBe("done");
    expect(runs[0]!.result).toBe("ok");
  });

  test("resuming a finished run puts it back to running", () => {
    const runs = O.runsOf([ev({}), ev({ event: "done", at: at + 1 }), ev({ event: "resumed", at: at + 2 })]);
    expect(runs[0]!.state).toBe("running");
  });

  test("stopped and failed are states of their own, and a task keeps its subject", () => {
    const runs = O.runsOf([ev({}), ev({ event: "stopped", at: at + 1 })]);
    expect(runs[0]!.state).toBe("stopped");
    expect(runs[0]!.task).toBe("refactor the parser");
    expect(O.runsOf([ev({}), ev({ event: "failed", at: at + 1 })])[0]!.state).toBe("failed");
  });

  test("status is scoped to the conversation that spawned the run", () => {
    const events = [ev({ parent: "ses_p1" }), ev({ id: "ses_b", parent: "ses_p2", at: at + 1 })];
    expect(O.runsOfParent(events, "ses_p1").map((r) => r.id)).toEqual(["ses_a"]);
    expect(O.runsOfParent(events, "ses_p2").map((r) => r.id)).toEqual(["ses_b"]);
    expect(O.runsOfParent(events, "ses_other")).toHaveLength(0);
  });

  test("spawnedIds lists every subagent once (those must run as plain sessions)", () => {
    const events = [ev({}), ev({ event: "done", at: at + 1 }), ev({ id: "ses_b", at: at + 2 })];
    expect(O.spawnedIds(events).sort()).toEqual(["ses_a", "ses_b"]);
  });
});

describe("orchestrator gating", () => {
  test("only the orchestrator agent may drive subagents", () => {
    expect(O.allowed("orchestrator")).toBe(true);
    expect(O.allowed("Orchestrator")).toBe(true);
    expect(O.allowed("build")).toBe(false);
    expect(O.allowed(undefined)).toBe(false);
    expect(O.allowed(42)).toBe(false);
  });

  test("the refusal names the caller, so an agent that tried knows why", () => {
    expect(O.refused("build")).toContain("build");
    expect(O.refused("build")).toContain("orchestrator");
  });

  test("the tool set offered to the orchestrator is its own and nothing else", () => {
    const tools: Record<string, unknown> = {
      spawn: {},
      collect: {},
      status: {},
      stop: {},
      note: {},
      find: {},
      zoom: {},
      date: {},
      edit: {},
      bash: {},
      read: {},
      write: {},
      webfetch: {},
    };
    const kept = Object.keys(O.filterTools(tools)).sort();
    expect(kept).toEqual([...O.TOOL_NAMES].sort());
    for (const forbidden of ["bash", "edit", "read", "write", "webfetch"]) {
      expect(kept).not.toContain(forbidden);
    }
  });

  test("filtering an empty or missing set stays empty instead of throwing", () => {
    expect(Object.keys(O.filterTools({}))).toHaveLength(0);
  });
});

describe("orchestrator renderings stay bounded", () => {
  test("oneLine flattens whitespace and honours the cap", () => {
    expect(O.oneLine("a\nb   c")).toBe("a b c");
    expect(O.oneLine("x".repeat(50), 10)).toHaveLength(10);
    expect(O.oneLine("   ")).toBe("");
  });

  test("a result line carries the subject and a bounded result", () => {
    const events: O.RunEvent[] = [
      { id: "ses_a", task: "fix the keymap", event: "spawned", at: 1 },
    ];
    const line = O.resultLine(events, "ses_a", "y".repeat(1000));
    expect(line.event).toBe("done");
    expect(line.task).toBe("fix the keymap");
    expect(line.result!.length).toBeLessThanOrEqual(300);
  });

  test("find returns id-prefixed lines, respects the limit and ignores blank queries", () => {
    const rows = [
      { i: 0, text: "user: the port is 8787 for VieOS" },
      { i: 1, text: "tool: reading the README" },
      { i: 2, text: "talk: and the port stays 8787" },
    ];
    const hits = O.findLines(rows, "8787");
    expect(hits).toHaveLength(2);
    expect(hits[0]!.startsWith("0 |")).toBe(true);
    expect(hits[1]!.startsWith("2 |")).toBe(true);
    expect(O.findLines(rows, "8787", 1)).toHaveLength(1);
    expect(O.findLines(rows, "   ")).toHaveLength(0);
    expect(O.findLines(rows, "PORT")).toHaveLength(2);
  });

  test("note normalises a run reported by hand, and refuses a bad event or a missing id", () => {
    const ok = O.noteEvent("ses_a", "add the retry logic", "DONE", "3 files, tests green", 42);
    expect(typeof ok).not.toBe("string");
    const event = ok as O.RunEvent;
    expect(event.event).toBe("done");
    expect(event.id).toBe("ses_a");
    expect(event.result).toContain("tests green");
    expect(event.at).toBe(42);

    // the ledger must stay a ledger: anything else is answered, not appended
    expect(O.noteEvent("ses_a", "x", "finished")).toContain("spawned, resumed, done, failed, stopped");
    expect(O.noteEvent("  ", "x", "done")).toContain("id");
    // a missing event means "done", and a missing subject is labelled, never empty
    const bare = O.noteEvent("ses_b", "", undefined) as O.RunEvent;
    expect(bare.event).toBe("done");
    expect(bare.task).toBe("(unknown)");
  });
});

describe("orchestrator workflow", () => {
  test("the workflow states the rules that make the mode work", () => {
    for (const rule of [
      "self-contained",
      "resume",
      "ledger",
      "append-only",
      "self-report",
      "last resort",
    ]) {
      expect(O.WORKFLOW.toLowerCase()).toContain(rule);
    }
  });

  test("the addendum is marked so it is never pushed twice", () => {
    expect(O.MARK.length).toBeGreaterThan(0);
    expect(O.AGENT).toBe("orchestrator");
  });
});
