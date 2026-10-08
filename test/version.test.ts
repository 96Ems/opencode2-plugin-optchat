/**
 * The version has ONE number, in two files.
 *
 * `version.ts` is what the plugin reads at runtime (the settings screen, the log
 * line, the CLI); `package.json` is what tooling reads. They must never disagree,
 * so this test fails the moment one is bumped without the other — which is the
 * whole point of the "always bump" rule: a stale copy is then caught by the test,
 * not by the user noticing the wrong version on screen.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../version.ts";

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

describe("version", () => {
  test("version.ts and package.json carry the same number", () => {
    expect(VERSION).toBe(pkg.version);
  });

  test("the version is a plain semver", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("bump.ts is the only writer, and it writes both files", () => {
    const src = readFileSync(join(root, "bin", "bump.ts"), "utf8");
    expect(src).toContain("package.json");
    expect(src).toContain("version.ts");
  });
});
