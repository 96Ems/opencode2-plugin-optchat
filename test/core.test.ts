/**
 * optchat-core tests — bun test
 *
 * Covers the parts the plugin relies on and that are easy to get subtly wrong:
 * byte handling, free nodes, in-order compaction, the view fold (never split,
 * always a tiling of [0,T)), zoom, and message decomposition.
 */
import { describe, expect, test } from "bun:test";
import * as C from "../core.ts";

/** A deterministic stand-in for the compactor's model: a dense line, under NODE. */
function summarize(state: C.ChatState, l: number, i: number): string {
  const step = C.stepFor(state, l, i)!;
  return C.cutUtf8(`${l}/${i} ${step.source.join(" | ")}`.replace(/\s+/g, " "), 480);
}

/** Build every node the pump would build, in pump order. */
function compactAll(state: C.ChatState, limit = 100_000) {
  const done = new Set<string>();
  for (let step = 0; step < limit; step++) {
    const next = C.candidates(state, done, 1, undefined, Date.now(), 0);
    if (!next.length) return;
    const { l, i } = next[0]!;
    const key = C.nodeKey(l, i);
    done.add(key);
    state.nodes.set(key, summarize(state, l, i));
    C.fit(state);
  }
}

function fan(n: number, chars: number): C.ChatState {
  const state = C.newChatState();
  for (let i = 0; i < n; i++) {
    const kind = i % 3 === 0 ? "user" : i % 3 === 1 ? "talk" : "echo";
    C.pushMessage(state, kind, `${i}`.padEnd(chars, "x"), new Date(2026, 0, 1, 0, i).toISOString());
  }
  return state;
}

/** The view must tile messages [0,T) exactly, in order. */
function assertTiling(state: C.ChatState) {
  let at = 0;
  for (const part of state.view) {
    const [start, stop] = C.covers(part.l, part.i);
    expect(start).toBe(at);
    at = stop;
  }
  expect(at).toBe(state.messages.length);
}

describe("bytes", () => {
  test("SCALE is exactly 512 bytes and is a dense, tagged line", () => {
    expect(C.byteLen(C.SCALE)).toBe(512);
    expect(C.SCALE).toContain("user:");
    expect(C.SCALE).toContain("tool:");
  });

  test("cutUtf8 never splits a character", () => {
    const s = "é".repeat(10); // 20 bytes
    expect(C.cutUtf8(s, 11)).toBe("é".repeat(5));
    expect(C.cutUtf8("abc", 99)).toBe("abc");
    expect(C.cutUtf8(s, 0)).toBe("");
    expect(C.cutUtf8("a😀b", 5)).toBe("a😀");
    expect(C.byteLen(C.cutUtf8("é".repeat(10), 11))).toBeLessThanOrEqual(11);
  });
});

describe("tree", () => {
  test("a short message is its own node, word for word (no model call)", () => {
    const state = C.newChatState();
    C.pushMessage(state, "user", "keep the port at 5173", "2026-01-01T00:00:00Z");
    expect(C.nodeText(state, 0, 0)).toBe("user: keep the port at 5173");
    expect(C.built(state, 0, 0)).toBe(true);
    expect(state.nodes.size).toBe(0); // free nodes are memoized, never stored
  });

  test("two short children merge for free", () => {
    const state = fan(2, 4);
    const a = C.nodeText(state, 0, 0)!;
    const b = C.nodeText(state, 0, 1)!;
    expect(C.byteLen(`${a}\n${b}`)).toBeLessThanOrEqual(C.NODE);
    expect(C.nodeText(state, 1, 0)).toBe(`${a}\n${b}`);
  });

  test("a node needs both children before it can exist or start", () => {
    const state = fan(3, 600); // 607 bytes each: too big to be a free node
    expect(C.ready(state, 1, 0)).toBe(false);
    expect(C.candidates(state, new Set(), 10).some((c) => c.l === 1)).toBe(false);
    compactAll(state);
    expect(C.ready(state, 1, 0)).toBe(true);
    expect(C.nodeText(state, 1, 0)).toBeDefined();
  });

  test("a node never starts before its whole context is summarized", () => {
    const state = fan(64, 600);
    const done = new Set<string>();
    let level0Order = 0;
    for (let step = 0; step < 200; step++) {
      const next = C.candidates(state, done, 64, undefined, Date.now(), 0);
      if (!next.length) break;
      const f = C.first(state);
      for (const cand of next) {
        const end = cand.l === 0 ? cand.i : (cand.i + 1) * C.span(cand.l);
        expect(end).toBeLessThanOrEqual(f); // rule 3
        if (cand.l === 0) expect(cand.i).toBe(level0Order++); // one at a time, in order
      }
      for (const cand of next) {
        const key = C.nodeKey(cand.l, cand.i);
        done.add(key);
        state.nodes.set(key, summarize(state, cand.l, cand.i));
        C.fit(state);
      }
    }
    expect(level0Order).toBe(64);
    assertTiling(state);
  });

  test("a failed node is retried only after RETRY", () => {
    const state = fan(4, 600);
    const key = C.nodeKey(0, 0);
    const failed = new Map([[key, 1000]]);
    expect(C.candidates(state, new Set(), 10, failed, 1000, 10_000).some((c) => C.nodeKey(c.l, c.i) === key)).toBe(false);
    expect(C.candidates(state, new Set(), 10, failed, 12_000, 10_000).some((c) => C.nodeKey(c.l, c.i) === key)).toBe(true);
  });

  test("zoom walks down; n=1 gives the message whole", () => {
    const state = fan(8, 600);
    compactAll(state);
    expect(C.zoomText(state, 3, 1)).toContain("user: 3");
    const two = C.zoomText(state, 2, 2).split("\n");
    expect(two).toEqual([`2+1|${C.nodeText(state, 0, 2)}`, `3+1|${C.nodeText(state, 0, 3)}`]);
    const four = C.zoomText(state, 0, 4).split("\n");
    expect(four[0]!.startsWith("0+2|")).toBe(true);
    expect(four[1]!.startsWith("2+2|")).toBe(true);
    expect(C.zoomText(state, 1, 2)).toBe("No line 1+2.");
    expect(C.zoomText(state, 0, 3)).toBe("No line 0+3.");
    expect(C.zoomText(state, 999, 1)).toContain("No line");
  });
});

describe("view", () => {
  test("stays under budget and tiles [0,T)", () => {
    const state = fan(600, 300); // ~185 KB of messages
    compactAll(state);
    expect(state.viewBytes).toBeLessThanOrEqual(C.VIEW);
    assertTiling(state);
  });

  test("never split: the head of the view is stable across new messages", () => {
    const state = fan(300, 300);
    compactAll(state);
    const before = state.view.map((p) => `${p.l}:${p.i}`);
    C.pushMessage(state, "user", "one more message", "2026-02-01T00:00:00Z");
    const after = state.view.map((p) => `${p.l}:${p.i}`);
    let shared = 0;
    while (shared < before.length && shared < after.length && before[shared] === after[shared]) shared++;
    expect(shared).toBeGreaterThan(before.length / 2);
    assertTiling(state);
  });

  test("detail fades with age: old lines cover many messages, the view stays short", () => {
    const state = fan(600, 700);
    compactAll(state);
    expect(state.view[0]!.l).toBeGreaterThan(0);
    expect(state.messages.length / state.view.length).toBeGreaterThan(2);
  });

  test("an unsummarized message shows as a placeholder and blocks settle", () => {
    const state = C.newChatState();
    C.pushMessage(state, "user", "y".repeat(2000), "2026-01-01T00:00:00Z");
    expect(C.settled(state)).toBe(false);
    expect(C.unsettled(state)).toBe(1);
    expect(C.renderView(state)).toContain("(not summarized yet: zoom it)");
    expect(C.first(state)).toBe(0);
    state.nodes.set(C.nodeKey(0, 0), "user: a long message, summarized");
    expect(C.settled(state)).toBe(true);
    expect(C.unsettled(state)).toBe(0);
    expect(C.renderView(state)).toContain("0+1|user: a long message, summarized");
  });

  test("what a model call gets for an unsummarized message is bounded, not cut silently", () => {
    const state = C.newChatState();
    const text = "HEAD-" + "z".repeat(5000) + "-TAIL";
    C.pushMessage(state, "user", text, "2026-01-01T00:00:00Z");
    const sent = C.renderView(state, "line");
    // bounded: one NODE-ish line, plus the id+n| prefix and the <chat> wrapper
    expect(C.byteLen(sent)).toBeLessThan(C.NODE + 200);
    expect(sent).toContain("zoom(0,1) for the whole message");
    expect(sent).toContain("HEAD-");
    expect(sent).toContain("-TAIL");
    expect(sent).not.toContain("(not summarized yet");
    // the message itself is untouched in the log
    expect(state.messages[0]!.text).toBe(text);
    expect(C.zoomText(state, 0, 1)).toContain("-TAIL");
  });

  test("a view full of unsummarized messages stays bounded while the compactor lags", () => {
    const state = fan(120, 4000); // ~480 KB of messages, nothing summarized
    const sent = C.renderView(state, "line");
    const transcript = state.messages.reduce((a, m) => a + m.size, 0);
    expect(C.unsettled(state)).toBe(120);
    expect(C.byteLen(sent)).toBeLessThan(120 * (C.NODE + 200));
    expect(C.byteLen(sent)).toBeLessThan(transcript / 4); // bounded, unlike showing them whole
    expect(sent).not.toContain("z".repeat(2000));
  });

  test("a bounded line never splits a character", () => {
    const state = C.newChatState();
    C.pushMessage(state, "user", "é".repeat(2000), "2026-01-01T00:00:00Z");
    const line = C.unsummarizedLine(state, 0);
    expect(line).not.toContain("\uFFFD");
    expect(C.byteLen(line)).toBeLessThanOrEqual(C.NODE);
  });
});

describe("compactor prompt", () => {
  test("carries the context, the SCALE line and the step, and no ids", () => {
    const state = fan(12, 700);
    compactAll(state);
    C.pushMessage(state, "user", "q".repeat(900), "2026-01-01T00:00:00Z");
    const prompt = C.compactionPrompt("COMPACT", state, 0, state.messages.length - 1)!;
    expect(prompt.startsWith("COMPACT")).toBe(true);
    expect(prompt).toContain("<chat>");
    expect(prompt).toContain(`exactly ${C.NODE} bytes`);
    expect(prompt).toContain("Compress this message into one line");
    expect(prompt).not.toMatch(/^\d+\+\d+\|/m);
  });

  test("a merge step re-writes both children whole", () => {
    const state = fan(8, 400);
    compactAll(state);
    const prompt = C.compactionPrompt("C", state, 1, 0)!;
    expect(prompt).toContain("Merge these two lines into one");
    expect(prompt).toContain(C.nodeText(state, 0, 0)!);
    expect(prompt).toContain(C.nodeText(state, 0, 1)!);
  });
});

describe("decompose", () => {
  const date = "2026-01-01T00:00:00Z";

  test("user words, replies, tool calls and results", () => {
    expect(C.decompose({ role: "user", content: [{ type: "text", text: "do the thing" }] }, date, 0)).toEqual([
      { kind: "user", text: "do the thing", size: C.byteLen("user: do the thing"), date },
    ]);
    expect(
      C.decompose(
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "hmm" },
            { type: "text", text: "on it" },
            { type: "tool-call", name: "shell", input: { command: "ls" } },
          ],
        },
        date,
        1,
      ).map((e) => e.kind),
    ).toEqual(["talk", "tool"]);
    expect(
      C.decompose({ role: "tool", content: [{ type: "tool-result", name: "shell", result: { type: "text", value: "ok" } }] }, date, 2),
    ).toEqual([{ kind: "echo", text: "ok", size: C.byteLen("echo: ok"), date }]);
  });

  test("thoughts are never logged, compaction markers are skipped", () => {
    expect(C.decompose({ role: "assistant", content: [{ type: "reasoning", text: "secret" }] }, date, 0)).toEqual([]);
    expect(C.isCompaction({ content: [{ type: "compaction", provider: "anthropic" }] })).toBe(true);
    expect(C.isCompaction({ content: [{ type: "text", text: "hi" }] })).toBe(false);
  });

  test("a huge tool result is capped with a note of what was cut", () => {
    const big = "x".repeat(C.CAP + 5000);
    const out = C.decompose({ role: "tool", content: [{ type: "tool-result", name: "read", result: { type: "text", value: big } }] }, date, 0);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toContain("bytes cut");
    expect(C.byteLen(out[0]!.text)).toBeLessThan(C.CAP + 200);
  });

  test("message identity depends on content, not on size (tool results carry no id)", () => {
    const a = C.signature({ role: "tool", content: [{ type: "tool-result", id: "c1", name: "shell", result: { type: "text", value: "aaaa" } }] });
    const b = C.signature({ role: "tool", content: [{ type: "tool-result", id: "c2", name: "shell", result: { type: "text", value: "bbbb" } }] });
    const c = C.signature({ role: "tool", content: [{ type: "tool-result", id: "c1", name: "shell", result: { type: "text", value: "aaaa" } }] });
    expect(a).not.toBe(b);
    expect(a).toBe(c);
  });

  test("result rendering keeps the shape of json, errors and content lists", () => {
    expect(C.resultText({ type: "json", value: { a: 1 } })).toBe('{"a":1}');
    expect(C.resultText({ type: "error", value: "boom" })).toBe("error: boom");
    expect(C.resultText({ type: "content", value: [{ type: "text", text: "hi" }, { type: "file", uri: "file:///x" }] })).toBe("hi\n[file file:///x]");
    expect(C.resultText(undefined)).toBe("(no result)");
  });
});
