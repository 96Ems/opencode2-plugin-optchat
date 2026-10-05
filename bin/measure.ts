#!/usr/bin/env bun
/**
 * optchat-measure — full context vs per-turn context for one chat.
 *
 *   bun bin/measure.ts [sessionID|chat-dir]     (no argument: the chat touched last)
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import * as S from "../settings.ts";
import * as St from "../stats.ts";

const args = process.argv.slice(2);
let target = args.find((a) => !a.startsWith("--"))?.replace(/\/$/, "");

const settings = await S.readSettings();

if (!target) {
  const base = S.dataDir();
  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  let newest: { name: string; mtime: number } | undefined;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const info = await fs.stat(join(base, entry.name, "optchat.log")).catch(() => undefined);
    if (!info) continue;
    if (!newest || info.mtimeMs > newest.mtime) newest = { name: entry.name, mtime: info.mtimeMs };
  }
  if (!newest) {
    console.error(`no chat under ${base} — run a session with the plugin first`);
    process.exit(2);
  }
  target = newest.name;
  console.error("(no session given: the most recently touched one)");
}

const sessionID = target.includes("/") ? target.split("/").filter(Boolean).pop()! : target;
const loaded = target.includes("/") ? await St.loadChatFromDir(target, settings.view) : await St.loadChat(sessionID, settings.view);
const gains = St.gains(sessionID, loaded, loaded.rows, settings.ratio);
for (const line of St.reportLines(loaded.snapshot, gains, { ratio: settings.ratio, cacheRatio: settings.cacheRatio, budget: settings.view })) {
  console.log(line);
}
