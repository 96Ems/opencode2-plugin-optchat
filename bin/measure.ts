/**
 * optchat-measure — full-context vs per-turn-context for one chat.
 *
 * Replays the log exactly like the plugin does (fold + fit) and, for every
 * model request (one per OpenCode assistant message), records how much history
 * the transcript would have carried versus what the plugin actually sends.
 *
 *   bun bin/measure.ts <chat-dir>
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import * as C from "../core.ts";

const dir = process.argv[2]!;
const read = async (sub: string) => {
  const out: string[] = [];
  for (const f of (await fs.readdir(join(dir, sub))).filter((f) => f.endsWith(".jsonl")).sort()) {
    out.push(...(await fs.readFile(join(dir, sub, f), "utf8")).split("\n").filter((l) => l.trim()));
  }
  return out;
};

const mainRows = (await read("main")).map((l) => JSON.parse(l));
const treeRows = (await read("tree")).map((l) => JSON.parse(l));

const state = C.newChatState();
for (const row of mainRows) {
  state.messages.push({
    i: state.messages.length,
    kind: row.kind,
    text: row.text,
    size: typeof row.size === "number" ? row.size : C.byteLen(`${row.kind}: ${row.text}`),
    date: row.date ?? "",
  });
}
for (const row of treeRows) state.nodes.set(C.nodeKey(row.l, row.i), row.text);

// one sample per message, exactly the fold the plugin does at load
const transcriptAt: number[] = [];
const viewAt: number[] = [];
let transcript = 0;
for (const m of state.messages) {
  transcript += m.size;
  const part: C.Part = { l: 0, i: m.i };
  state.view.push(part);
  state.viewBytes += C.partBytes(state, part);
  C.fit(state);
  transcriptAt[m.i] = transcript;
  viewAt[m.i] = state.viewBytes;
}

// one model request per assistant message (its talk/tool rows share a src)
const firstIndexForSrc = new Map<string, number>();
state.messages.forEach((m, i) => {
  if (m.kind !== "talk" && m.kind !== "tool") return;
  const src = mainRows[i]?.src;
  if (src && !firstIndexForSrc.has(src)) firstIndexForSrc.set(src, i);
});
const requests = [...firstIndexForSrc.values()].sort((a, b) => a - b);

const OVERHEAD = 8832; // measured: system prompt + tools, tokens
const RATIO = 1.2; // measured bytes per token on this chat (dense FR + paths + JSON)

let sumFull = 0;
let sumOurs = 0;
let maxFull = 0;
for (const i of requests) {
  const full = transcriptAt[i]! / RATIO + OVERHEAD;
  const ours = viewAt[i]! / RATIO + OVERHEAD;
  sumFull += full;
  sumOurs += ours;
  maxFull = Math.max(maxFull, full);
}

const last = requests.length - 1;
const table = [0, 0.25, 0.5, 0.75, 1].map((q) => {
  const r = requests[Math.min(requests.length - 1, Math.round(q * last))]!;
  const full = transcriptAt[r]! / RATIO + OVERHEAD;
  const ours = viewAt[r]! / RATIO + OVERHEAD;
  return `${(q * 100).toFixed(0).padStart(3)}%  tour #${String(requests.indexOf(r) + 1).padStart(4)}  full ${Math.round(full / 1000).toString().padStart(5)}k tok   optchat ${Math.round(ours / 1000).toString().padStart(4)}k tok   x${(full / ours).toFixed(1)}`;
});

console.log(`chat            ${dir}`);
console.log(`messages        ${state.messages.length}  (${transcript} bytes, ${treeRows.length} tree nodes)`);
console.log(`requests        ${requests.length} (one per assistant message)`);
console.log(`ratio utilisée  ${RATIO} octets/token, +${OVERHEAD} tok système+outils (mesurés)`);
console.log("");
console.log("historique porté à chaque tour :");
for (const line of table) console.log("  " + line);
console.log("");
console.log(`cumul (somme sur tous les tours)  full ${(sumFull / 1e6).toFixed(2)} M tok   optchat ${(sumOurs / 1e6).toFixed(3)} M tok   -> x${(sumFull / sumOurs).toFixed(1)}`);
console.log(`dernier tour                      full ~${Math.round(maxFull / 1000)}k tok   optchat ~${Math.round((viewAt[requests[last]!]! / RATIO + OVERHEAD) / 1000)}k tok`);
console.log(`pic du full                       ~${Math.round(maxFull / 1000)}k tok (fenêtre du modèle : à vérifier)`);
