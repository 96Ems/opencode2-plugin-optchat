#!/usr/bin/env bun
/**
 * optchat inspector — browse a chat's memory: the view, ROOT (every message)
 * and each level of the tree.
 *
 *   bun bin/optchat.ts [chat-dir|sessionID] [--root] [--tree] [--raw] [--pump]
 *   (no argument: the chat touched last, i.e. the session you are in)
 *
 * A sessionID is resolved under <XDG_DATA_HOME>/opencode/optchat/<sessionID>.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as C from "../core.ts";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const dataDir = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "optchat");

let target = args.find((a) => !a.startsWith("--"));
if (!target) {
  // no argument: the chat that was touched last (the session you are in)
  const entries = await fs.readdir(dataDir, { withFileTypes: true }).catch(() => []);
  let newest: { name: string; mtime: number } | undefined;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const info = await fs.stat(join(dataDir, entry.name, "optchat.log")).catch(() => undefined);
    if (!info) continue;
    if (!newest || info.mtimeMs > newest.mtime) newest = { name: entry.name, mtime: info.mtimeMs };
  }
  if (!newest) {
    console.error(`no chat found under ${dataDir} — run a session with the plugin loaded first`);
    process.exit(2);
  }
  target = newest.name;
  console.error(`(no session given: showing the most recently touched chat)`);
}

const dir = target.includes("/") ? target : join(dataDir, target.replace(/[^\w.-]/g, "_"));

const read = async (sub: string): Promise<string[]> => {
  try {
    const files = (await fs.readdir(join(dir, sub))).filter((f) => f.endsWith(".jsonl")).sort();
    const out: string[] = [];
    for (const f of files) out.push(...(await fs.readFile(join(dir, sub, f), "utf8")).split("\n").filter((l) => l.trim()));
    return out;
  } catch {
    return [];
  }
};

const state = C.newChatState();
const rows: any[] = [];
for (const line of await read("main")) {
  const row = JSON.parse(line);
  state.messages.push({ i: state.messages.length, kind: row.kind, text: row.text, size: row.size ?? C.byteLen(`${row.kind}: ${row.text}`), date: row.date });
  rows.push(row);
}
for (const line of await read("tree")) {
  const row = JSON.parse(line);
  state.nodes.set(C.nodeKey(row.l, row.i), row.text);
}
for (const m of state.messages) {
  const part: C.Part = { l: 0, i: m.i };
  state.view.push(part);
  state.viewBytes += C.partBytes(state, part);
  C.fit(state);
}

console.log(`session        ${target.includes("/") ? dir : target}`);
console.log(`dir            ${dir}`);
console.log(`messages       ${state.messages.length}  (${state.messages.reduce((a, m) => a + m.size, 0)} bytes)`);
console.log(`tree nodes     ${state.nodes.size}`);
console.log(`view           ${state.view.length} lines, ${state.viewBytes} bytes (budget ${C.VIEW})`);
console.log(`settled        ${C.settled(state)}${C.settled(state) ? "" : `  (${C.unsettled(state)} line(s) waiting for the compactor, first at ${C.first(state)})`}`);
console.log(`lines as sent  ${C.byteLen(C.renderView(state, "line"))} bytes  (--raw to see them)  ·  transcript ${state.messages.reduce((a, m) => a + m.size, 0)} bytes`);
console.log("");

if (flags.has("--pump")) {
  console.log("──── NEXT COMPACTOR WORK");
  const busy = new Set<string>();
  for (let k = 0; k < 12; k++) {
    const next = C.candidates(state, busy, 1, undefined, Date.now(), 0);
    if (!next.length) break;
    const { l, i } = next[0]!;
    busy.add(C.nodeKey(l, i));
    const step = C.stepFor(state, l, i);
    console.log(`  ${C.nodeKey(l, i)}	${step ? C.byteLen(step.source.join("\n")) : -1} bytes	${step?.kind ?? "?"}`);
  }
  console.log("");
}

console.log("──── VIEW");
console.log(C.renderView(state, flags.has("--raw") ? "line" : "placeholder"));

if (flags.has("--root")) {
  console.log("\n──── ROOT");
  for (const m of state.messages) {
    console.log(`${m.i}\t${m.kind}\t${m.size}B\t${m.date}\t${C.oneLine(m.text).slice(0, 160)}`);
  }
}

if (flags.has("--tree")) {
  console.log("\n──── TREE");
  const keys = [...state.nodes.keys()].sort((a, b) => {
    const [la, ia] = a.split(":").map(Number);
    const [lb, ib] = b.split(":").map(Number);
    return la - lb || ia! - ib!;
  });
  for (const key of keys) {
    const [l, i] = key.split(":").map(Number);
    const [start, stop] = C.covers(l!, i!);
    console.log(`L${l} ${key}\tmsgs ${start}-${stop - 1}\t${C.byteLen(state.nodes.get(key)!)}B\t${C.oneLine(state.nodes.get(key)!).slice(0, 140)}`);
  }
}
