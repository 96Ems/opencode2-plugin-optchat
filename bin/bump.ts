#!/usr/bin/env bun
/**
 * bump.ts — set the next version, in the two files that carry it.
 *
 *   bun bin/bump.ts patch     0.4.0 -> 0.4.1
 *   bun bin/bump.ts minor     0.4.0 -> 0.5.0
 *   bun bin/bump.ts major     0.4.0 -> 1.0.0
 *   bun bin/bump.ts 0.9.2     set it outright
 *
 * Bump in the SAME commit as the change it ships: the settings screen, the CLI
 * and the session log all print this number, so "am I running the version I just
 * changed?" is answerable from the screen instead of from a file listing. The two
 * files are written together because `test/version.test.ts` fails when they drift.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pkgPath = join(root, "package.json");
const verPath = join(root, "version.ts");

const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
const current = pkg.version;
const arg = (process.argv[2] ?? "patch").toLowerCase();

function nextVersion(kind: string, from: string): string {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
  const [major, minor, patch] = from.split(".").map((n) => Number(n) || 0);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  console.error(`usage: bun bin/bump.ts patch|minor|major|<x.y.z>   (current ${from})`);
  process.exit(2);
}

const to = nextVersion(arg, current);

pkg.version = to;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const versionTs = readFileSync(verPath, "utf8");
const pattern = /export const VERSION = "[^"]*";/;
if (!pattern.test(versionTs)) {
  console.error(`could not find the VERSION constant in ${verPath}`);
  process.exit(1);
}
writeFileSync(verPath, versionTs.replace(pattern, `export const VERSION = "${to}";`));

console.log(`optchat ${current} -> ${to}`);
console.log("commit it with the change it ships (CI runs `bun test`), then deploy:");
console.log("  cp version.ts index.ts core.ts settings.ts stats.ts orchestrator.ts tui.ts tui-view.tsx ~/.config/opencode/plugins/optchat/");
