/**
 * optchat-core tests — bun test
 *
 * Covers the parts the plugin relies on and that are easy to get subtly wrong:
 * byte handling, free nodes, the compactor's queue and in-order compaction, the
 * view fold (never split, merges in one batch past the mark, always a tiling of
 * [0,T)), the merge order against the reference push, the compaction prompt, and
 * message decomposition.
 */
import { describe, expect, test } from "bun:test";
import * as C from "../core.ts";

/** A deterministic stand-in for the compactor's model: a dense line, under NODE. */
function summarize(state: C.ChatState, l: number, i: number): string {
  const step = C.stepFor(state, l, i)!;
  return C.cutUtf8(`${l}/${i} ${step.source.join(" | ")}`.replace(/\s+/g, " "), 480);
}

/**
 * Build every node the pump would build, in pump order: take from the ready
 * queue, store the node, refit, and queue the parent (what index.ts does on a
 * finished build).
 */
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
    C.enqueue(state, l + 1, i >> 1);
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

// ------------------------------------------------- the reference merge order

/**
 * Taelin's rollback-style push: the list the view's merge order must follow. It
 * is a binary counter — a 0 absorbs, a 1 carries — so the newest entries change
 * at every push and old ones almost never.
 */
interface PushNode {
  keep: number;
  life: number;
  state: number;
  older: PushNode | null;
}

function push(newState: number, s: PushNode | null): PushNode {
  if (s === null) return { keep: 0, life: 0, state: newState, older: null };
  const { keep, life, state, older } = s;
  if (keep === 0) return { keep: 1, life, state, older };
  if (life > 0) return { keep: 0, life: 0, state: newState, older: { keep: 0, life: life - 1, state, older } };
  return { keep: 0, life, state: newState, older: push(state, older) };
}

/** The lines the push implies at T messages: one per state, each to the next state. */
function pushView(s: PushNode | null, T: number): string[] {
  const starts: number[] = [];
  for (let n = s; n; n = n.older) starts.push(n.state);
  starts.reverse();
  return starts.map((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1]! : T;
    const size = end - start;
    return `${Math.log2(size)}:${start / size}`;
  });
}

/** Fold [0,T) from scratch, merging the most due pair until the view fits `budget` lines. */
function foldPairs(T: number, budget: number, useLast: boolean): string[] {
  const view: C.Part[] = [];
  for (let now = 1; now <= T; now++) {
    view.push({ l: 0, i: now - 1 });
    while (view.length > budget) {
      let best: { at: number; due: number } | undefined;
      for (let k = 0; k + 1 < view.length; k++) {
        const a = view[k]!;
        const b = view[k + 1]!;
        if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1) continue;
        const due = useLast
          ? (now - ((a.i + 2) * C.span(a.l) - 1)) / C.span(a.l)
          : (now - a.i * C.span(a.l)) / C.span(a.l + 2);
        if (!best || due > best.due) best = { at: k, due };
      }
      if (!best) break;
      const a = view[best.at]!;
      view.splice(best.at, 2, { l: a.l + 1, i: a.i / 2 });
    }
  }
  return view.map((p) => `${p.l}:${p.i}`);
}

// ---------------------------------------------------------------------------

describe("bytes", () => {
  test("RULER is exactly NODE bytes: a ruler, not a sample line", () => {
    expect(C.byteLen(C.RULER)).toBe(C.NODE);
    expect(C.RULER).toBe("-".repeat(C.NODE));
    expect(C.RULER).not.toContain("user:");
  });

  test("cutUtf8 never splits a character", () => {
    const s = "é".repeat(10); // 20 bytes
    expect(C.cutUtf8(s, 11)).toBe("é".repeat(5));
    expect(C.cutUtf8("abc", 99)).toBe("abc");
    expect(C.cutUtf8(s, 0)).toBe("");
    expect(C.cutUtf8("a😀b", 5)).toBe("a😀");
    expect(C.byteLen(C.cutUtf8("é".repeat(10), 11))).toBeLessThanOrEqual(11);
  });

  test("charLen counts characters, not bytes", () => {
    expect(C.charLen("é")).toBe(1);
    expect(C.byteLen("é")).toBe(2);
    expect(C.charLen("a😀b")).toBe(3);
    expect(C.cutChars("a😀b", 2)).toBe("a😀");
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

  test("work comes from the ready queue, never from a scan of the tree", () => {
    const state = fan(64, 600);
    expect(state.queue.length).toBe(64); // one per message, nothing built
    expect(state.queue.every((c) => c.l === 0)).toBe(true);

    const busy = new Set<string>();
    const first = C.candidates(state, busy, 1, undefined, Date.now(), 0);
    expect(first).toEqual([{ l: 0, i: 0 }]);
    // in flight: never handed out twice, and the next pump takes the next message
    busy.add(C.nodeKey(0, 0));
    expect(C.candidates(state, busy, 1, undefined, Date.now(), 0)).toEqual([{ l: 0, i: 1 }]);

    state.nodes.set(C.nodeKey(0, 0), summarize(state, 0, 0));
    C.enqueue(state, 1, 0);
    expect(state.queue.some((c) => c.l === 1)).toBe(false); // its other half is missing
    expect(C.candidates(state, new Set(), 10, undefined, Date.now(), 0).some((c) => C.nodeKey(c.l, c.i) === C.nodeKey(0, 0))).toBe(false); // built: dropped for good
    expect(state.queue.some((c) => C.nodeKey(c.l, c.i) === C.nodeKey(0, 0))).toBe(false);
  });

  test("a node starts only within PENDING unbuilt lines of the frontier, in order", () => {
    const state = fan(64, 600);
    const done = new Set<string>();
    let lastLevel0 = -1;
    for (let step = 0; step < 400; step++) {
      const next = C.candidates(state, done, C.PENDING, undefined, Date.now(), 0);
      if (!next.length) break;
      for (const cand of next) {
        const end = cand.l === 0 ? cand.i : (cand.i + 1) * C.span(cand.l);
        expect(C.unbuiltBefore(state, end)).toBeLessThan(C.PENDING);
        if (cand.l === 0) {
          expect(cand.i).toBeGreaterThan(lastLevel0); // messages still compress in order
          lastLevel0 = cand.i;
        }
      }
      for (const cand of next) {
        const key = C.nodeKey(cand.l, cand.i);
        done.add(key);
        state.nodes.set(key, summarize(state, cand.l, cand.i));
        C.fit(state);
        C.enqueue(state, cand.l + 1, cand.i >> 1);
      }
    }
    expect(C.settled(state)).toBe(true);
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

describe("the fold", () => {
  test("a pair's age is measured from its LAST message, not its first", () => {
    // the spec's own example: view 0+4, 4+4, 8+1, 9+1 at T=10
    const big = C.pairDue({ l: 2, i: 0 }, 10); // covers messages 0-7
    const tail = C.pairDue({ l: 0, i: 8 }, 10); // covers messages 8-9
    expect(tail).toBeGreaterThan(big);
  });

  test("the fold reproduces the reference push; the `first` rule does not", () => {
    const T = 256;
    let s: PushNode | null = null;
    let withLast = 0;
    let withFirst = 0;
    for (let t = 0; t < T; t++) {
      s = push(t, s);
      const reference = pushView(s, t + 1);
      if (foldPairs(t + 1, reference.length, true).join() === reference.join()) withLast++;
      if (foldPairs(t + 1, reference.length, false).join() === reference.join()) withFirst++;
    }
    expect(withLast).toBe(T);
    // the spec's own numbers, at a much larger T: 481 of 20,001 steps (2.4 %).
    // Here, on a short chat, the wrong rule still fails most of the time.
    expect(withFirst).toBeLessThan(T / 2);
  }, 60_000);

  test("stays under budget and tiles [0,T)", () => {
    const state = fan(600, 300); // ~185 KB of messages
    compactAll(state);
    expect(state.viewBytes).toBeLessThanOrEqual(C.VIEW);
    assertTiling(state);
  });

  // heavy fixture (600 messages x 700 B + a full merge pass): give it room on slow hosts
  test(
    "past the mark it merges down to half in one batch, not a little at each message",
    () => {
      const state = fan(600, 700); // ~426 KB of log
      compactAll(state);
      expect(state.batching).toBe(false); // the batch reached the low mark
      expect(state.viewBytes).toBeLessThanOrEqual(C.VIEW / 2);
      assertTiling(state);
    },
    60_000,
  );

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

  // heavy fixture (600 messages x 700 B + a full merge pass): give it room on slow hosts
  test(
    "detail fades with age: old lines cover many messages, the view stays short",
    () => {
      const state = fan(600, 700);
      compactAll(state);
      expect(state.view[0]!.l).toBeGreaterThan(0);
      expect(state.messages.length / state.view.length).toBeGreaterThan(2);
    },
    60_000,
  );

  test("a saved view is adopted only while it still tiles the log", () => {
    const state = fan(40, 600);
    compactAll(state);
    const pairs = C.viewPairs(state);
    const fresh = C.newChatState();
    for (const m of state.messages) fresh.messages.push(m);
    for (const [k, v] of state.nodes) fresh.nodes.set(k, v);

    expect(C.adoptView(fresh, pairs)).toBe(true);
    expect(fresh.view.length).toBe(state.view.length);
    expect(fresh.viewBytes).toBeGreaterThan(0);

    const holey = C.newChatState();
    for (const m of state.messages) holey.messages.push(m);
    for (const [k, v] of state.nodes) holey.nodes.set(k, v);
    expect(C.adoptView(holey, pairs.slice(1))).toBe(false); // no longer starts at 0
    expect(C.adoptView(holey, [[0, 99999]])).toBe(false); // covers more than the log
    expect(C.adoptView(holey, "nope")).toBe(false);
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

describe("compactions", () => {
  // heavy fixture, same as the fold's
  test(
    "a compaction's view is merged further, into the 16-32 KB band",
    () => {
      const state = fan(600, 700);
      compactAll(state);
      const lines = C.compactionLines(state, state.messages.length);
      const bytes = lines.reduce((a, l) => a + C.byteLen(`${l}\n`), 0);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.length).toBeLessThan(state.view.length);
      expect(bytes).toBeLessThanOrEqual(C.COMPACT_HIGH);
    },
    60_000,
  );

  test("a compaction's view stops at the first unsummarized line", () => {
    const state = C.newChatState();
    for (let i = 0; i < 4; i++) C.pushMessage(state, "user", `m${i}`.padEnd(600, "x"), "2026-01-01T00:00:00Z");
    state.nodes.set(C.nodeKey(0, 0), "user: first");
    expect(C.compactionLines(state, 4)).toEqual(["0+1|user: first"]); // not 3 placeholders
  });

  test("carries the same prompt as a turn, the ruler and the ids", () => {
    const state = fan(12, 700);
    compactAll(state);
    C.pushMessage(state, "user", "q".repeat(900), "2026-01-01T00:00:00Z");
    const last = state.messages.length - 1;
    const prompt = C.compactionPrompt("MASTER", state, 0, last)!;
    expect(prompt.startsWith("MASTER")).toBe(true);
    expect(prompt).toContain("<chat>");
    expect(prompt).toContain(C.byteLen(C.RULER) === C.NODE ? C.RULER : "never");
    expect(prompt).toContain(`Compaction: compress message ${last}`);
    expect(prompt).toContain("<input>");
  });

  test("a merge step names the two lines and re-writes both children whole", () => {
    const state = fan(8, 400);
    compactAll(state);
    const prompt = C.compactionPrompt("C", state, 1, 0)!;
    expect(prompt).toContain("Compaction: merge lines 0+1 and 1+1");
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

  test("a huge tool result is capped in characters, with a note of what was cut", () => {
    const big = "x".repeat(C.CAP + 5000);
    const out = C.decompose({ role: "tool", content: [{ type: "tool-result", name: "read", result: { type: "text", value: big } }] }, date, 0);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toContain("characters cut");
    expect(C.charLen(out[0]!.text)).toBeLessThan(C.CAP + 200);
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
