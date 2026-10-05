/**
 * optchat settings + stats tests — bun test
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as S from "../settings.ts";
import * as St from "../stats.ts";
import * as C from "../core.ts";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), "optchat-test-"));
  process.env.OPTCHAT_DATA_DIR = home;
  delete process.env.OPTCHAT_VIEW;
  delete process.env.OPTCHAT_COMPACTOR;
  delete process.env.OPTCHAT_DISABLED;
});

afterEach(async () => {
  delete process.env.OPTCHAT_DATA_DIR;
  await fs.rm(home, { recursive: true, force: true });
});

describe("settings", () => {
  test("defaults when there is no file", async () => {
    const settings = await S.readSettings();
    expect(settings.enabled).toBe(true);
    expect(settings.view).toBe(S.DEFAULTS.view);
    expect(settings.compactor).toBe("");
  });

  test("env vars fill keys the file does not carry", async () => {
    process.env.OPTCHAT_VIEW = "64000";
    process.env.OPTCHAT_COMPACTOR = "opencode-go/deepseek-v4-flash";
    process.env.OPTCHAT_DISABLED = "1";
    const settings = await S.readSettings();
    expect(settings.view).toBe(64000);
    expect(settings.compactor).toBe("opencode-go/deepseek-v4-flash");
    expect(settings.enabled).toBe(false);
  });

  test("write + read round-trips, and the file wins over env", async () => {
    process.env.OPTCHAT_VIEW = "64000";
    await S.writeSettings({ view: 96_000, compactor: "a/b", cacheRatio: 0.25 });
    const settings = await S.readSettings();
    expect(settings.view).toBe(96_000);
    expect(settings.compactor).toBe("a/b");
    expect(settings.cacheRatio).toBe(0.25);
    expect(JSON.parse(await fs.readFile(S.settingsPath(), "utf8")).view).toBe(96_000);
  });

  test("a broken file falls back to defaults instead of throwing", async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(S.settingsPath(), "{ not json", "utf8");
    const settings = await S.readSettings();
    expect(settings.view).toBe(S.DEFAULTS.view);
  });

  test("nonsense values are ignored", async () => {
    const settings = await S.writeSettings({ view: -5 as number, ratio: 0 as number, cap: 10 as number });
    expect(settings.view).toBe(S.DEFAULTS.view);
    expect(settings.ratio).toBe(S.DEFAULTS.ratio);
    expect(settings.cap).toBe(S.DEFAULTS.cap);
  });

  test("the hot-path reader picks up a change without a restart", async () => {
    const read = S.makeSettingsReader();
    expect((await read()).view).toBe(S.DEFAULTS.view);
    await S.writeSettings({ view: 32_000 });
    // mtime granularity: force a distinct timestamp
    const later = new Date(Date.now() + 2000);
    await fs.utimes(S.settingsPath(), later, later);
    expect((await read()).view).toBe(32_000);
  });

  test("model refs parse and display", () => {
    expect(S.parseModel("opencode-go/deepseek-v4-flash")).toEqual({ providerID: "opencode-go", id: "deepseek-v4-flash" });
    expect(S.parseModel("a/b/c")).toEqual({ providerID: "a", id: "b/c" });
    expect(S.parseModel("")).toBeUndefined();
    expect(S.parseModel("nope")).toBeUndefined();
    expect(S.formatModel("")).toContain("session");
  });
});

describe("stats formatting", () => {
  test("bytes and tokens", () => {
    expect(St.fmtBytes(512)).toBe("512 B");
    expect(St.fmtBytes(2048)).toBe("2.0 KB");
    expect(St.fmtBytes(1536 * 1024)).toBe("1.50 MB");
    expect(St.fmtTokens(950)).toBe("950");
    expect(St.fmtTokens(41_400)).toBe("41.4k");
    expect(St.fmtTokens(1_028_000)).toBe("1.03M");
  });

  test("real usage sums the session and keeps the last request", () => {
    const usage = St.realUsage([
      { tokens: { input: 100, output: 10, cache: { read: 8000, write: 0 } } },
      { tokens: { input: 220, output: 12, cache: { read: 85_000, write: 0 } } },
      { role: "user" } as never,
    ]);
    expect(usage.requests).toBe(2);
    expect(usage.last).toEqual({ input: 220, cache: 85_000, output: 12 });
    expect(usage.totals.input).toBe(320);
    expect(usage.totals.cache).toBe(93_000);
  });
});

describe("stats over a real chat directory", () => {
  const session = "ses_test";

  async function writeChat(messages: number, chars: number) {
    const dir = join(home, session);
    await fs.mkdir(join(dir, "main"), { recursive: true });
    await fs.mkdir(join(dir, "tree"), { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < messages; i++) {
      const kind = i % 3 === 0 ? "user" : i % 3 === 1 ? "talk" : "echo";
      const text = `${i}`.padEnd(chars, "x");
      lines.push(JSON.stringify({ kind, text, size: C.byteLen(`${kind}: ${text}`), date: "2026-01-01T00:00:00Z", src: `msg_${i}`, inst: "test" }));
    }
    await fs.writeFile(join(dir, "main", "2026-01-01.jsonl"), lines.join("\n") + "\n", "utf8");
    return dir;
  }

  test("reads a chat, counts requests, and the gain never goes the wrong way", async () => {
    await writeChat(60, 3000);
    const loaded = await St.loadChat(session, 128_000);
    expect(loaded.snapshot.messages).toBe(60);
    expect(loaded.snapshot.transcriptBytes).toBeGreaterThan(150_000);
    expect(loaded.snapshot.sentBytes).toBeLessThan(loaded.snapshot.transcriptBytes);

    const gains = St.gains(session, loaded, loaded.rows, 1.3);
    expect(gains.requests).toBe(20); // one request per assistant message (the talk rows)
    expect(gains.last.ours).toBeLessThan(gains.last.full);
    expect(gains.cumulative.ours).toBeLessThan(gains.cumulative.full);
    expect(gains.maxFull).toBeGreaterThan(100_000);
  });

  test("a tiny chat costs the same with and without the plugin", async () => {
    await writeChat(3, 10);
    const loaded = await St.loadChat(session, 128_000);
    const gains = St.gains(session, loaded, loaded.rows, 1.3);
    expect(gains.last.full).toBeCloseTo(gains.last.ours, 0);
  });

  test("report lines carry the headline numbers", async () => {
    await writeChat(30, 2000);
    const loaded = await St.loadChat(session, 64_000);
    const gains = St.gains(session, loaded, loaded.rows, 1.3);
    const lines = St.reportLines(loaded.snapshot, gains, { ratio: 1.3, budget: 64_000 }).join("\n");
    expect(lines).toContain("compression");
    expect(lines).toContain("Context carried per turn");
    expect(lines).toContain("×");
  });

  test("an unknown session is reported empty, not as an error", async () => {
    const loaded = await St.loadChat("ses_inconnue", 128_000);
    expect(loaded.snapshot.messages).toBe(0);
    expect(loaded.snapshot.exists).toBe(false);
    const lines = St.reportLines(loaded.snapshot, St.gains("x", loaded, [], 1.3), { ratio: 1.3, budget: 128_000 }).join("\n");
    expect(lines).toContain("no memory for this session yet");
  });
});

describe("recentChats", () => {
  /** write a chat directory the way the plugin does: main/*.jsonl + tree/*.jsonl */
  async function writeChat(id: string, kinds: string[], when: Date) {
    const dir = join(home, id, "main");
    await fs.mkdir(dir, { recursive: true });
    const rows = kinds.map((kind, i) => ({
      i,
      kind,
      text: `message ${i}`,
      size: C.byteLen(`${kind}: message ${i}`),
      date: "2026-10-05",
    }));
    const file = join(dir, "2026-10-05.jsonl");
    await fs.writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await fs.utimes(file, when, when);
    await fs.writeFile(join(home, id, "tree", "2026-10-05.jsonl"), "").catch(async () => {
      await fs.mkdir(join(home, id, "tree"), { recursive: true });
      await fs.writeFile(join(home, id, "tree", "2026-10-05.jsonl"), "");
    });
  }

  test("lists chats newest first, with counts and bytes", async () => {
    await writeChat("ses_old", ["user", "talk"], new Date("2026-10-05T10:00:00Z"));
    await writeChat("ses_new", ["user", "talk", "tool", "echo"], new Date("2026-10-05T18:00:00Z"));
    const list = await St.recentChats();
    expect(list.map((c) => c.sessionID)).toEqual(["ses_new", "ses_old"]);
    expect(list[0]!.messages).toBe(4);
    expect(list[1]!.messages).toBe(2);
    expect(list[0]!.bytes).toBeGreaterThan(0);
    expect(list[0]!.when).toContain("2026-10-05");
  });

  test("honours the limit and ignores directories without main rows", async () => {
    await writeChat("ses_a", ["user"], new Date("2026-10-05T11:00:00Z"));
    await writeChat("ses_b", ["user"], new Date("2026-10-05T12:00:00Z"));
    await fs.mkdir(join(home, "ses_empty", "main"), { recursive: true });
    const list = await St.recentChats(1);
    expect(list.length).toBe(1);
    expect(list[0]!.sessionID).toBe("ses_b");
  });
});

describe("money", () => {
  const prices: St.Prices = { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1, model: "p/m", source: "catalogue" };

  test("prices come from a catalogue record, with a fallback", () => {
    const model = { providerID: "acme", modelID: "fast", cost: [{ input: 0.5, output: 2, cache: { read: 0.05, write: 0.6 } }] };
    const p = St.pricesFromModel(model);
    expect(p.input).toBe(0.5);
    expect(p.cacheRead).toBe(0.05);
    expect(p.model).toBe("acme/fast");
    expect(p.source).toBe("catalogue");
    // a model without cost data falls back instead of lying
    expect(St.pricesFromModel({ providerID: "x", modelID: "y" }).source).toBe("default");
  });

  test("the first request pays everything fresh, the next ones only the tail", () => {
    const series = [
      { full: 1_000_000, ours: 100_000 },
      { full: 2_000_000, ours: 100_000 },
    ];
    const c = St.costs(series, { prices });
    expect(c.without.fresh).toBe(2_000_000);
    expect(c.without.cached).toBe(1_000_000);
    expect(c.without.usd).toBeCloseTo(2 * 1 + 1 * 0.1, 6);
    expect(c.with.usd).toBeCloseTo(0.1 * 1 + 0.1 * 0.1, 6);
    expect(c.measuredWith).toBe(false);
    expect(c.savedUsd).toBeGreaterThan(0);
    expect(c.perTurn.withoutUsd).toBeCloseTo(1 * 1 + 1 * 0.1, 6);
  });

  test("the provider's own token counts win when the session carries them", () => {
    const usage: St.RealUsage = {
      requests: 1,
      last: { input: 5, cache: 100, output: 7 },
      totals: { input: 5, cache: 100, output: 7 },
      series: [{ input: 5, cache: 100, output: 7 }],
    };
    const c = St.costs([{ full: 900_000, ours: 900_000 }], { prices, usage, paidUsd: 0.001 });
    expect(c.measuredWith).toBe(true);
    expect(c.with.usd).toBeCloseTo((5 / 1e6) * 1 + (100 / 1e6) * 0.1 + (7 / 1e6) * 10, 9);
    expect(c.savedUsd).toBeCloseTo(c.without.usd - 0.001, 9);
  });

  test("counts the requests that would not have fitted the window", () => {
    const c = St.costs([{ full: 300_000, ours: 1_000 }, { full: 400_000, ours: 1_000 }], { prices, windowTokens: 200_000 });
    expect(c.overWindow).toBe(2);
  });

  test("realUsage keeps a per-request series", () => {
    const u = St.realUsage([
      { tokens: { input: 10, output: 2, cache: { read: 100 } } },
      { tokens: { input: 20, output: 4, cache: { read: 200 } } },
    ]);
    expect(u.requests).toBe(2);
    expect(u.series.length).toBe(2);
    expect(u.totals.cache).toBe(300);
    expect(u.last.input).toBe(20);
  });

  test("formatUsd keeps small numbers readable", () => {
    expect(St.formatUsd(0)).toBe("$0");
    expect(St.formatUsd(0.0042)).toBe("$0.0042");
    expect(St.formatUsd(0.42)).toBe("$0.420");
    expect(St.formatUsd(3.5)).toBe("$3.50");
  });
});

describe("bars and parts", () => {
  test("a bar fills proportionally to its max", () => {
    expect(St.bar(0, 100, 10)).toBe("░░░░░░░░░░");
    expect(St.bar(50, 100, 10)).toBe("█████░░░░░");
    expect(St.bar(100, 100, 10)).toBe("██████████");
    expect(St.bar(500, 100, 4)).toBe("████");
    expect(St.bar(5, 0, 4)).toBe("░░░░");
    expect(St.pct(50, 100)).toBe(" 50%");
    expect(St.pct(4, 0)).toBe("  0%");
  });

  test("viewParts marks originals, summaries and cut text", async () => {
    const dir = join(home, "ses_v");
    await fs.mkdir(join(dir, "main"), { recursive: true });
    const rows = [
      { i: 0, kind: "user", text: "short" },
      { i: 1, kind: "talk", text: "y".repeat(3000) },
    ].map((r) => ({ ...r, size: C.byteLen(`${r.kind}: ${r.text}`), date: "2026-10-05" }));
    await fs.writeFile(join(dir, "main", "2026-10-05.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const loaded = await St.loadChatDir(dir, 100_000);
    const parts = St.viewParts(loaded);
    expect(parts.length).toBe(2);
    expect(parts[0]!.kind).toBe("user");
    expect(parts[0]!.whole).toBe(true);
    expect(parts[0]!.covers).toEqual([0, 1]);
    expect(parts[1]!.whole).toBe(false);
    expect(parts[1]!.bytes).toBeGreaterThan(0);

    loaded.state.nodes.set(C.nodeKey(0, 1), "talk: summarized");
    const after = St.viewParts(loaded).find((p) => p.index === 1)!;
    expect(after.kind).toBe("summary");
    expect(after.whole).toBe(true);
    expect(after.preview).toContain("summarized");
  });
});

describe("report lines", () => {
  const prices: St.Prices = { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1, model: "acme/fast", source: "catalogue" };

  async function sampleChat() {
    const dir = join(home, "ses_r");
    await fs.mkdir(join(dir, "main"), { recursive: true });
    const rows = Array.from({ length: 6 }, (_, i) => {
      const kind = i % 3 === 0 ? "user" : "talk";
      const text = `${i} ` + "z".repeat(4000);
      return { i, kind, text, size: C.byteLen(`${kind}: ${text}`), date: "2026-10-05" };
    });
    await fs.writeFile(join(dir, "main", "2026-10-05.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await fs.mkdir(join(dir, "tree"), { recursive: true });
    await fs.writeFile(join(dir, "tree", "2026-10-05.jsonl"), JSON.stringify({ l: 1, i: 0, text: "user: 0 summarized" }) + "\n");
    const loaded = await St.loadChatDir(dir, 5_000);
    return { loaded, g: St.gains("ses_r", loaded, loaded.rows, 1.3) };
  }

  test("statsLines has a session, a per-turn and a cost section", async () => {
    const { loaded, g } = await sampleChat();
    const lines = St.statsLines(loaded.snapshot, g, { ratio: 1.3, budget: 5_000, prices });
    const text = lines.join("\n");
    expect(text).toContain("## Session");
    expect(text).toContain("## Context carried per turn");
    expect(text).toContain("## Cost (estimate, USD)");
    expect(text).toContain("█");
    expect(text).toContain("saved");
    expect(text).toContain("acme/fast");
    expect(text).not.toMatch(/[éèêàçùôîûœ]/); // the whole report is English
  });

  test("statsLines says so when the session predates the plugin", () => {
    const empty = {
      sessionID: "ses_none", dir: "/nope", exists: false, messages: 0, transcriptBytes: 0, nodes: 0,
      viewLines: 0, viewBytes: 0, sentBytes: 0, unsettled: 0, settled: true, budget: 128_000,
    };
    const g = St.gains("ses_none", { snapshot: empty, state: C.newChatState(), rows: [], transcriptAt: [], viewAt: [] }, [], 1.3);
    const lines = St.statsLines(empty, g, { ratio: 1.3, budget: 128_000, prices });
    expect(lines.join("\n")).toContain("no memory for this session yet");
  });

  test("treeLines lists the levels and the nodes", async () => {
    const { loaded } = await sampleChat();
    const lines = St.treeLines(loaded);
    expect(lines.join("\n")).toContain("## Levels");
    expect(lines.join("\n")).toContain("level 1");
    expect(lines.join("\n")).toContain("1:0");
    const empty = St.treeLines({ ...loaded, state: C.newChatState() });
    expect(empty.join("\n")).toContain("No summaries yet");
  });
});

describe("inferred prices", () => {
  test("the catalogue wins when the model is known", () => {
    const eff = St.effectivePrices({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1, model: "a/b", source: "catalogue" }, undefined, 5);
    expect(eff.derived).toBe(false);
    expect(eff.input).toBe(1);
  });

  test("without a catalogue entry the invoice sets the scale", () => {
    const usage: St.RealUsage = {
      requests: 2,
      last: { input: 500_000, cache: 5_000_000, output: 50_000 },
      totals: { input: 1_000_000, cache: 10_000_000, output: 100_000 },
      series: [
        { input: 500_000, cache: 5_000_000, output: 50_000 },
        { input: 500_000, cache: 5_000_000, output: 50_000 },
      ],
    };
    const eff = St.effectivePrices(St.DEFAULT_PRICES, usage, 0.5);
    expect(eff.derived).toBe(true);
    expect(eff.input).toBeLessThan(St.DEFAULT_PRICES.input);
    // the ratios are preserved, only the scale changes
    expect(eff.cacheRead / eff.input).toBeCloseTo(St.DEFAULT_PRICES.cacheRead / St.DEFAULT_PRICES.input, 9);

    const c = St.costs(
      [
        { full: 5_000_000, ours: 1_000_000 },
        { full: 5_000_000, ours: 1_000_000 },
      ],
      { prices: St.DEFAULT_PRICES, usage, paidUsd: 0.5 },
    );
    // the "with optchat" column now adds up to what was really paid
    expect(c.with.usd).toBeCloseTo(0.5, 6);
    expect(c.savedUsd).toBeCloseTo(c.without.usd - 0.5, 6);
    expect(c.prices.input).toBeCloseTo(eff.input, 9);
  });

  test("no invoice, no derivation", () => {
    expect(St.effectivePrices(St.DEFAULT_PRICES, undefined, 3).derived).toBe(false);
    expect(St.effectivePrices(St.DEFAULT_PRICES, { requests: 0, last: { input: 0, cache: 0, output: 0 }, totals: { input: 0, cache: 0, output: 0 }, series: [] }, 3).derived).toBe(false);
  });
});
