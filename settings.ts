/**
 * optchat settings — one JSON file both sides read.
 *
 * The server plugin (index.ts) runs in the OpenCode server process and the CLI
 * plugin (tui-view.tsx) runs in the TUI process: they cannot call each other, so
 * the settings live in a file under the chat data directory. The server plugin
 * re-reads it on every turn (mtime-cached), so a change made from the TUI — or by
 * hand — applies to the next message, with no restart.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_DATA_DIR = join(
  process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
  "opencode",
  "optchat",
);

export interface Settings {
  /** false: the plugin does nothing for new turns (the view stops being sent) */
  enabled: boolean;
  /** "provider/model" for the summaries; "" = the model of the session itself */
  compactor: string;
  /** view budget in bytes */
  view: number;
  /** cap applied to one tool result, in bytes */
  cap: number;
  /** bytes per token, used for the gain estimates in the UI */
  ratio: number;
  /** price of a cached input token as a fraction of a fresh one (estimate) */
  cacheRatio: number;
}

export const DEFAULTS: Settings = {
  enabled: true,
  compactor: "",
  view: 128_000,
  cap: 30_000,
  ratio: 1.3,
  cacheRatio: 0.1,
};

/** View budgets offered in the UI, in bytes (≈ tokens at ~1.3 B/token). */
export const VIEW_CHOICES = [32_000, 48_000, 64_000, 96_000, 128_000, 192_000, 256_000];
export const RATIO_CHOICES = [1.0, 1.2, 1.3, 1.4, 1.6, 2.0];

export function dataDir(): string {
  return process.env.OPTCHAT_DATA_DIR || DEFAULT_DATA_DIR;
}

export function settingsPath(): string {
  return join(dataDir(), "settings.json");
}

/** Env fallbacks, used for keys the file does not carry (and on first run). */
export function settingsFromEnv(): Partial<Settings> {
  const env: Partial<Settings> = {};
  const view = Number(process.env.OPTCHAT_VIEW);
  if (Number.isFinite(view) && view > 2000) env.view = view;
  const cap = Number(process.env.OPTCHAT_CAP);
  if (Number.isFinite(cap) && cap > 1000) env.cap = cap;
  const ratio = Number(process.env.OPTCHAT_RATIO);
  if (Number.isFinite(ratio) && ratio > 0.5) env.ratio = ratio;
  if (process.env.OPTCHAT_COMPACTOR) env.compactor = process.env.OPTCHAT_COMPACTOR;
  if (process.env.OPTCHAT_DISABLED === "1") env.enabled = false;
  return env;
}

export function normalize(raw: unknown): Settings {
  const settings: Settings = { ...DEFAULTS, ...settingsFromEnv() };
  if (raw && typeof raw === "object") {
    const input = raw as Partial<Settings>;
    if (typeof input.enabled === "boolean") settings.enabled = input.enabled;
    if (typeof input.compactor === "string") settings.compactor = input.compactor;
    if (Number.isFinite(input.view) && (input.view as number) > 2000) settings.view = Math.round(input.view as number);
    if (Number.isFinite(input.cap) && (input.cap as number) > 1000) settings.cap = Math.round(input.cap as number);
    if (Number.isFinite(input.ratio) && (input.ratio as number) > 0.5) settings.ratio = input.ratio as number;
    if (Number.isFinite(input.cacheRatio) && (input.cacheRatio as number) >= 0) settings.cacheRatio = input.cacheRatio as number;
  }
  return settings;
}

export async function readSettings(): Promise<Settings> {
  try {
    const raw = await fs.readFile(settingsPath(), "utf8");
    return normalize(JSON.parse(raw));
  } catch {
    return normalize(undefined);
  }
}

/** Merge a patch into the file (atomic write: tmp + rename). Returns the result. */
export async function writeSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = normalize({ ...(await readSettings()), ...patch });
  const path = settingsPath();
  await fs.mkdir(dataDir(), { recursive: true });
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await fs.rename(tmp, path);
  return next;
}

/**
 * Hot-path reader: keeps the settings for a given mtime, so the server plugin can
 * call it on every turn for the price of one stat().
 */
export function makeSettingsReader(): () => Promise<Settings> {
  let cached: Settings | undefined;
  let stamp = -1;
  return async () => {
    let mtime = -1;
    try {
      mtime = (await fs.stat(settingsPath())).mtimeMs;
    } catch {
      mtime = 0; // no file: defaults
    }
    if (cached && mtime === stamp) return cached;
    cached = await readSettings();
    stamp = mtime;
    return cached;
  };
}

export function parseModel(ref: string | undefined): { providerID: string; id: string } | undefined {
  if (!ref || !ref.includes("/")) return undefined;
  const [providerID, ...rest] = ref.split("/");
  if (!providerID || rest.length === 0) return undefined;
  return { providerID, id: rest.join("/") };
}

export function formatModel(ref: string): string {
  return ref || "(the session's model)";
}
