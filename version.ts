/**
 * optchat version — the single runtime source of truth.
 *
 * The settings screen, the CLI and the session log all read the number from
 * here, so a running copy can always say which revision it is. `package.json`
 * carries the same number for tooling, and `test/version.test.ts` fails when the
 * two drift: bump BOTH in the same commit as the change they ship, never one
 * without the other. `bun bin/bump.ts patch|minor|major` does it in one step.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const VERSION = "0.4.0";

/** Directory the running copy of this file was loaded from, when the runtime says. */
export function pluginDir(): string {
  const url = (import.meta as any).url as string | undefined;
  if (!url) return "";
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/\/[^/]*$/, "");
  } catch {
    return "";
  }
}

/** When the deployed copy was last written, to the minute ("" when unknown). */
export function deployedAt(file = "version.ts"): string {
  const dir = pluginDir();
  if (!dir) return "";
  try {
    return statSync(join(dir, file)).mtime.toISOString().replace("T", " ").slice(0, 16);
  } catch {
    return "";
  }
}

/**
 * One line naming the version and the copy in use — what the settings screen and
 * the session log print, so "am I running the version I just changed?" has an
 * answer that does not depend on trusting the deploy.
 */
export function versionLine(): string {
  const dir = pluginDir();
  const where = dir ? dir.replace(homedir(), "~") : "unknown directory";
  const at = deployedAt();
  return at ? `v${VERSION} · ${where} · deployed ${at}` : `v${VERSION} · ${where}`;
}
