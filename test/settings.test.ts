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
    expect(St.fmtBytes(512)).toBe("512 o");
    expect(St.fmtBytes(2048)).toBe("2.0 Ko");
    expect(St.fmtBytes(1536 * 1024)).toBe("1.50 Mo");
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
    const lines = St.reportLines(loaded.snapshot, gains, { ratio: 1.3, cacheRatio: 0.1, budget: 64_000 }).join("\n");
    expect(lines).toContain("compression");
    expect(lines).toContain("historique porté à chaque tour");
    expect(lines).toContain("×");
  });

  test("an unknown session is reported empty, not as an error", async () => {
    const loaded = await St.loadChat("ses_inconnue", 128_000);
    expect(loaded.snapshot.messages).toBe(0);
    expect(loaded.snapshot.exists).toBe(false);
    const lines = St.reportLines(loaded.snapshot, St.gains("x", loaded, [], 1.3), { ratio: 1.3, cacheRatio: 0.1, budget: 128_000 }).join("\n");
    expect(lines).toContain("aucune mémoire");
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
