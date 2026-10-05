/** @jsxImportSource @opentui/solid */
/**
 * optchat TUI — navigable popup and sidebar widget.
 *
 * `/optchat`           opens the menu (↑/↓ then Enter, type to filter)
 *   ├ Stats            session, context carried per turn, cost with/without optchat
 *   ├ View             exactly what the model receives, one line per part
 *   ├ Summaries        the summary tree, level by level
 *   └ Settings         on/off, compactor model, context budget, tool result cap
 *
 * It reads the same chat directory as the server plugin (they never call each
 * other): settings live in settings.json, which the server re-reads every turn.
 * Every string here is English — the plugin is meant to be shared.
 */
import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { homedir } from "node:os";
import { join } from "node:path";
import * as S from "./settings.ts";
import * as St from "./stats.ts";
import * as C from "./core.ts";

type AnyRec = Record<string, any>;

/** theme token lookup tolerant to the v2 renames (text.base vs text.default). */
function pick(theme: AnyRec | undefined, path: string, fallback = "#cccccc"): any {
  let node: any = theme;
  for (const key of path.split(".")) {
    if (node && typeof node === "object" && key in node) node = node[key];
    else return fallback;
  }
  if (node && typeof node === "object") return node.base ?? node.default ?? fallback;
  return node ?? fallback;
}

const ink = (theme: AnyRec | undefined, kind: "ok" | "warn" | "err" | "info" | "muted" | "text"): any => {
  switch (kind) {
    case "ok":
      return pick(theme, "text.feedback.success");
    case "warn":
      return pick(theme, "text.feedback.warning");
    case "err":
      return pick(theme, "text.feedback.error");
    case "info":
      return pick(theme, "text.feedback.info");
    case "muted":
      return pick(theme, "text.subdued", pick(theme, "text.muted"));
    default:
      return pick(theme, "text.base", pick(theme, "text.default"));
  }
};

/** Grey ramp for summary levels: originals bright, deep summaries dim. */
const RAMP = ["#e6e6e6", "#c9c9c9", "#a9a9a9", "#8b8b8b", "#6f6f6f", "#565656"];
const rampColor = (level: number) => RAMP[Math.min(level, RAMP.length - 1)]!;

const kindInk = (theme: AnyRec | undefined, kind: string): any => {
  switch (kind) {
    case "user":
      return ink(theme, "info");
    case "talk":
      return ink(theme, "ok");
    case "tool":
      return ink(theme, "warn");
    case "echo":
      return ink(theme, "muted");
    default:
      return ink(theme, "text");
  }
};

interface Entry {
  at: number;
  snapshot: St.ChatSnapshot;
  gains: St.Gains;
  usage?: St.RealUsage;
  prices: St.Prices;
  paidUsd?: number;
  windowTokens?: number;
}

const HEAD_LABELS =
  /^\s+(session|messages|transcript|context sent|budget used|compression|requests|tokens|paid|prices|model|method|last request)\b/;

export default Plugin.define({
  id: "optchat.cli",

  setup(ctx: AnyRec) {
    const cache = new Map<string, Entry>();
    const log = (text: string) => {
      void import("node:fs/promises")
        .then(({ appendFile }) => appendFile(join(S.dataDir(), "tui.log"), `${new Date().toISOString()} ${text}\n`, "utf8"))
        .catch(() => {});
    };

    const routeNow = (): AnyRec | undefined => {
      try {
        return ctx.ui?.router?.current?.() as AnyRec | undefined;
      } catch (err) {
        log(`router error: ${String(err)}`);
        return undefined;
      }
    };

    const currentSession = (): string | undefined => {
      const route = routeNow();
      return route?.type === "session" ? (route.sessionID as string) : undefined;
    };

    /** Current session, or a picker over the chats the plugin knows about. */
    async function resolveSession(why: string): Promise<string | undefined> {
      const open = currentSession();
      if (open) return open;
      const recent = await St.recentChats(12);
      if (!recent.length) {
        await ctx.ui.dialog.alert({
          title: "optchat — no session",
          message:
            "optchat measures the session you are in, and no chat has been recorded yet.\n\nOpen a session, send one message, then run /optchat again.",
        });
        return undefined;
      }
      return await ctx.ui.dialog.select<string>({
        title: `optchat — which session? (${why})`,
        placeholder: "type to filter",
        options: recent.map((c) => ({
          title: c.sessionID,
          value: c.sessionID,
          description: `${c.messages} lines · ${St.fmtBytes(c.bytes)} · ${c.when}`,
        })),
      });
    }

    /** Model catalogue entries, raw records included so prices can be read. */
    async function catalogue(): Promise<AnyRec[]> {
      try {
        const collection = ctx.data?.location?.model;
        await collection?.sync?.();
        return (collection?.list?.() ?? []) as AnyRec[];
      } catch {
        return [];
      }
    }

    /** Prices of the model a session runs on, from the catalogue when possible. */
    async function pricesFor(sessionID: string, settings: S.Settings): Promise<{ prices: St.Prices; windowTokens?: number }> {
      // cacheRead defaults to the settings ratio × input price when the catalogue is silent
      const fallback: St.Prices = { ...St.DEFAULT_PRICES, cacheRead: settings.cacheRatio * St.DEFAULT_PRICES.input };
      try {
        const info = ctx.data?.session?.get?.(sessionID) as AnyRec | undefined;
        const ref = info?.model as AnyRec | undefined;
        const list = await catalogue();
        const match = ref
          ? list.find((m) => (m.modelID ?? m.id) === ref.id && m.providerID === ref.providerID) ??
            list.find((m) => (m.modelID ?? m.id) === ref.id)
          : undefined;
        if (!match) return { prices: fallback };
        const prices = St.pricesFromModel(match, fallback);
        const windowTokens = typeof match.limit?.context === "number" ? match.limit.context : undefined;
        return { prices, windowTokens };
      } catch {
        return { prices: fallback };
      }
    }

    async function compute(sessionID: string, budget: number): Promise<Entry> {
      const started = Date.now();
      const settings = await S.readSettings();
      const loaded = await St.loadChat(sessionID, budget);
      const g = St.gains(sessionID, loaded, loaded.rows, settings.ratio);
      let usage: St.RealUsage | undefined;
      let paidUsd: number | undefined;
      try {
        const info = ctx.data?.session?.get?.(sessionID) as AnyRec | undefined;
        if (typeof info?.cost === "number") paidUsd = info.cost;
        const messages: AnyRec[] = ctx.data?.session?.message?.list?.(sessionID) ?? [];
        if (messages.length) usage = St.realUsage(messages);
      } catch {
        usage = undefined;
      }
      const { prices, windowTokens } = await pricesFor(sessionID, settings);
      const entry: Entry = { at: Date.now(), snapshot: loaded.snapshot, gains: g, usage, prices, paidUsd, windowTokens };
      cache.set(sessionID, entry);
      log(`stats ${sessionID}: ${loaded.snapshot.messages} msgs, view ${loaded.snapshot.sentBytes} B, ${Date.now() - started}ms`);
      return entry;
    }

    async function entryFor(sessionID: string, force = false): Promise<Entry> {
      const settings = await S.readSettings();
      const hit = cache.get(sessionID);
      if (!force && hit && Date.now() - hit.at < 4000) return hit;
      return compute(sessionID, settings.view);
    }

    // ---------------------------------------------------------------- screens

    function Dialog(props: { title: string; children: any; footer?: string }) {
      let off: (() => void) | undefined;
      onMount(() => {
        ctx.ui.dialog.set({ size: "xlarge" });
        off = ctx.keymap.layer(() => ({
          mode: "modal",
          commands: [
            { id: "optchat.popup.close", title: "Close", bind: "escape", run: () => ctx.ui.dialog.clear() },
            { id: "optchat.popup.back", title: "Back", bind: "backspace", run: () => ctx.ui.dialog.clear() },
          ],
        }));
      });
      onCleanup(() => off?.());
      return (
        <box paddingLeft={2} paddingRight={2} flexDirection="column" height="100%">
          <text fg={ink(ctx.theme, "ok")}>
            <b>{props.title}</b>
          </text>
          <scrollbox scrollY flexGrow={1} gap={0}>
            {props.children}
          </scrollbox>
          <text fg={ink(ctx.theme, "muted")}>{props.footer ?? "esc close"}</text>
        </box>
      );
    }

    /** One report line, styled by role: headers, warnings, the saving line. */
    function reportLine(line: string, i: number) {
      if (line.startsWith("## "))
        return (
          <text fg={ink(ctx.theme, "info")} key={i}>
            <b>{line.slice(3)}</b>
          </text>
        );
      if (line.startsWith("⚠"))
        return (
          <text fg={ink(ctx.theme, "warn")} key={i}>
            {line}
          </text>
        );
      if (/^\s+saved\b/.test(line))
        return (
          <text fg={ink(ctx.theme, "ok")} key={i}>
            {line}
          </text>
        );
      if (line.includes("█"))
        return (
          <text fg={ink(ctx.theme, "text")} key={i}>
            {line}
          </text>
        );
      if (HEAD_LABELS.test(line))
        return (
          <text fg={ink(ctx.theme, "text")} key={i}>
            {line}
          </text>
        );
      return (
        <text fg={ink(ctx.theme, "muted")} key={i}>
          {line || " "}
        </text>
      );
    }

    function showReport(title: string, lines: string[], footer?: string) {
      ctx.ui.dialog.show(() => (
        <Dialog title={title} footer={footer}>
          <box flexDirection="column">
            <For each={lines}>{(line, i) => reportLine(line, i())}</For>
          </box>
        </Dialog>
      ));
    }

    async function showStats(sessionID: string) {
      const settings = await S.readSettings();
      const entry = await entryFor(sessionID, true);
      const lines = St.statsLines(entry.snapshot, entry.gains, {
        ratio: settings.ratio,
        budget: settings.view,
        prices: entry.prices,
        usage: entry.usage,
        paidUsd: entry.paidUsd,
        windowTokens: entry.windowTokens,
      });
      const compression = entry.snapshot.transcriptBytes / Math.max(1, entry.snapshot.sentBytes);
      showReport(
        `optchat — stats · ${entry.snapshot.messages} messages · ×${compression.toFixed(1)} compression`,
        lines,
        "esc close",
      );
    }

    async function showTree(sessionID: string) {
      const loaded = await St.loadChat(sessionID);
      showReport(`optchat — summaries · ${loaded.state.nodes.size} nodes`, St.treeLines(loaded), "esc close · ↑/↓ scroll");
    }

    /** The view, one line per part: originals bright, summaries on a grey ramp. */
    async function showView(sessionID: string) {
      const settings = await S.readSettings();
      const loaded = await St.loadChat(sessionID, settings.view);
      const parts = St.viewParts(loaded);
      const snap = loaded.snapshot;
      const compression = snap.transcriptBytes / Math.max(1, snap.sentBytes);
      const maxLevel = parts.reduce((a, p) => Math.max(a, p.level), 0);
      ctx.ui.dialog.show(() => (
        <Dialog
          title={`optchat — view sent to the model · ${parts.length} parts · ${St.fmtBytes(snap.sentBytes)} of the ${St.fmtBytes(snap.budget)} budget`}
          footer="esc close · ↑/↓ scroll"
        >
          <box flexDirection="column">
            <text fg={ink(ctx.theme, "muted")}>{`originals bright · summaries on a grey ramp (L1 light → L${maxLevel} dark)`}</text>
            <text fg={ink(ctx.theme, "muted")}>{`${St.fmtBytes(snap.transcriptBytes)} of log → ${St.fmtBytes(snap.sentBytes)} sent (×${compression.toFixed(1)}) · zoom(start, count) recovers an original`}</text>
            <text> </text>
            <For each={parts}>
              {(p) => (
                <text>
                  <span fg={rampColor(p.level)}>{`L${p.level}·${String(p.index).padStart(4)} `}</span>
                  <span fg={p.kind === "summary" ? rampColor(p.level) : kindInk(ctx.theme, p.kind)}>{p.kind.padEnd(7)}</span>
                  <span fg={ink(ctx.theme, "muted")}>{St.fmtBytes(p.bytes).padStart(7)} </span>
                  <span fg={p.whole ? ink(ctx.theme, "muted") : ink(ctx.theme, "warn")}>
                    {(p.kind === "summary" ? `${p.covers[1] - p.covers[0]} msg` : p.whole ? "whole" : "cut").padEnd(6)}
                  </span>
                  <span fg={p.kind === "summary" ? rampColor(p.level) : ink(ctx.theme, "text")}>{p.preview.slice(0, 48).padEnd(48)}</span>
                  {p.whole ? null : <span fg={ink(ctx.theme, "warn")}>{` [z(${p.covers[0]},${p.covers[1] - p.covers[0]})]`}</span>}
                </text>
              )}
            </For>
          </box>
        </Dialog>
      ));
    }

    /** The exact string the model receives, for whoever wants the raw text. */
    async function showRaw(sessionID: string) {
      const loaded = await St.loadChat(sessionID);
      const lines = C.renderView(loaded.state, "line").split("\n");
      showReport(`optchat — raw context string · ${Math.max(0, lines.length - 2)} parts`, lines, "esc close · ↑/↓ scroll");
    }

    async function showSettings(): Promise<void> {
      const settings = await S.readSettings();
      const path = S.settingsPath();
      const choice = await ctx.ui.dialog.select<string>({
        title: "optchat — settings",
        placeholder: "type to filter",
        options: [
          {
            title: settings.enabled ? "Memory: on — turn it off" : "Memory: off — turn it on",
            value: "toggle",
            description: settings.enabled
              ? "the next turn would carry the whole transcript again"
              : "the view becomes the context of every turn again",
          },
          {
            title: `Compactor model — ${S.formatModel(settings.compactor)}`,
            value: "compactor",
            description: "the model that writes summaries; applies from the next turn",
          },
          {
            title: `Context budget — ${St.fmtBytes(settings.view)}`,
            value: "view",
            description: `cap on the context sent per turn (≈ ${St.fmtTokens(settings.view / settings.ratio)} tokens)`,
          },
          {
            title: `Tool result cap — ${St.fmtBytes(settings.cap)}`,
            value: "cap",
            description: "how much of a tool result is written to the log",
          },
          {
            title: `Bytes per token — ${settings.ratio}`,
            value: "ratio",
            description: "used for every size and token estimate shown here",
          },
          { title: "Where do these live?", value: "path", description: path },
        ],
      });
      if (choice === undefined) return;

      if (choice === "path") {
        await ctx.ui.dialog.alert({
          title: "optchat — settings.json",
          message: `${path}\n\nThe server re-reads this file on every turn: no restart needed.\nPrices come from the model catalogue (USD per million tokens), not from here.`,
        });
        return showSettings();
      }
      if (choice === "toggle") {
        const next = await S.writeSettings({ enabled: !settings.enabled });
        ctx.ui.toast.show({
          title: "optchat",
          message: next.enabled ? "memory on" : "memory off",
          variant: next.enabled ? "success" : "warning",
        });
        return showSettings();
      }
      if (choice === "compactor") {
        const list = await catalogue();
        const picked = await ctx.ui.dialog.select<string>({
          title: "optchat — compactor model",
          placeholder: "type to filter",
          current: settings.compactor,
          options: [
            { title: "(the session's model)", value: "", description: "default: whatever the conversation runs on" },
            ...list.map((m) => ({
              title: String(m.name ?? m.modelID ?? m.id),
              value: `${m.providerID}/${m.modelID ?? m.id}`,
              description: String(m.providerID ?? ""),
              category: String(m.providerID ?? ""),
            })),
          ],
        });
        if (picked !== undefined) {
          await S.writeSettings({ compactor: picked });
          ctx.ui.toast.show({ title: "optchat", message: `compactor: ${S.formatModel(picked)}`, variant: "success" });
        }
        return showSettings();
      }
      if (choice === "view") {
        const picked = await ctx.ui.dialog.select<number>({
          title: "optchat — context budget",
          current: settings.view,
          options: S.VIEW_CHOICES.map((v) => ({
            title: St.fmtBytes(v),
            value: v,
            description: `≈ ${St.fmtTokens(v / settings.ratio)} tokens carried on every turn`,
          })),
        });
        if (picked !== undefined) {
          await S.writeSettings({ view: picked });
          ctx.ui.toast.show({ title: "optchat", message: `context budget: ${St.fmtBytes(picked)}`, variant: "success" });
        }
        return showSettings();
      }
      if (choice === "cap") {
        const picked = await ctx.ui.dialog.select<number>({
          title: "optchat — tool result cap",
          current: settings.cap,
          options: [10_000, 20_000, 30_000, 50_000, 80_000].map((v) => ({ title: St.fmtBytes(v), value: v })),
        });
        if (picked !== undefined) await S.writeSettings({ cap: picked });
        return showSettings();
      }
      if (choice === "ratio") {
        const picked = await ctx.ui.dialog.select<number>({
          title: "optchat — bytes per token",
          current: settings.ratio,
          options: S.RATIO_CHOICES.map((v) => ({ title: `${v} bytes/token`, value: v })),
        });
        if (picked !== undefined) await S.writeSettings({ ratio: picked });
        return showSettings();
      }
    }

    async function menu(sessionID: string) {
      const entry = await entryFor(sessionID, true);
      const snap = entry.snapshot;
      const settings = await S.readSettings();
      const compression = snap.transcriptBytes / Math.max(1, snap.sentBytes);
      log(`popup ${sessionID}: ${snap.messages} msgs, view ${snap.sentBytes} B, ${snap.viewLines} parts, ${entry.gains.requests} requests`);

      const choice = await ctx.ui.dialog.select<string>({
        title: `optchat — ${snap.messages} messages · view ${St.fmtBytes(snap.sentBytes)} · ×${compression.toFixed(1)} compression`,
        placeholder: "type to filter",
        options: [
          {
            title: "Stats",
            value: "stats",
            description: entry.gains.requests
              ? `context per turn and cost with/without optchat (${St.fmtTokens(entry.gains.last.ours)} tok/turn now)`
              : "context per turn and cost with/without optchat",
          },
          {
            title: "View",
            value: "view",
            description: `${snap.viewLines} parts, ${St.fmtBytes(snap.sentBytes)} — one readable line per part`,
          },
          {
            title: "Summaries",
            value: "tree",
            description: `${snap.nodes} nodes — ${snap.settled ? "up to date" : `${snap.unsettled} lines waiting for the compactor`}`,
          },
          {
            title: `Settings${settings.enabled ? "" : "  (memory off)"}`,
            value: "settings",
            description: `compactor ${S.formatModel(settings.compactor)} · budget ${St.fmtBytes(settings.view)}`,
          },
          { title: "Raw context string", value: "raw", description: "the exact text sent, as the model sees it" },
          { title: "Close", value: "close" },
        ],
      });
      if (choice === "stats") return showStats(sessionID);
      if (choice === "view") return showView(sessionID);
      if (choice === "tree") return showTree(sessionID);
      if (choice === "settings") return showSettings();
      if (choice === "raw") return showRaw(sessionID);
    }

    // -------------------------------------------------------------- commands

    const guard = async (what: (sessionID: string) => Promise<void>, why: string) => {
      try {
        const sessionID = await resolveSession(why);
        if (!sessionID) return;
        await what(sessionID);
      } catch (err) {
        log(`error in ${why}: ${String(err)} ${(err as Error)?.stack?.split("\n")[1] ?? ""}`);
        try {
          ctx.ui.toast.show({ title: "optchat", message: String(err).slice(0, 200), variant: "error" });
        } catch {
          /* nothing left to show with */
        }
      }
    };

    const toggle = async (on: boolean) => {
      const next = await S.writeSettings({ enabled: on });
      ctx.ui.toast.show({
        title: "optchat",
        message: next.enabled ? "memory on" : "memory off",
        variant: next.enabled ? "success" : "warning",
      });
    };

    const off = ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "optchat.menu",
          title: "optchat: memory, stats, settings",
          group: "optchat",
          palette: true,
          suggested: true,
          slash: { name: "optchat", aliases: ["oc"] },
          run: () => {
            log(`cmd /optchat (route ${routeNow()?.type ?? "?"})`);
            return void guard((id) => menu(id), "menu");
          },
        },
        { id: "optchat.stats", title: "optchat: session stats", group: "optchat", slash: { name: "optchat_stats" }, run: () => void guard((id) => showStats(id), "stats") },
        { id: "optchat.view", title: "optchat: view sent to the model", group: "optchat", slash: { name: "optchat_view" }, run: () => void guard((id) => showView(id), "view") },
        { id: "optchat.tree", title: "optchat: summary tree", group: "optchat", slash: { name: "optchat_tree" }, run: () => void guard((id) => showTree(id), "tree") },
        { id: "optchat.raw", title: "optchat: raw context string", group: "optchat", slash: { name: "optchat_raw" }, run: () => void guard((id) => showRaw(id), "raw") },
        { id: "optchat.settings", title: "optchat: settings", group: "optchat", slash: { name: "optchat_settings" }, run: () => void showSettings().catch((err) => log(`error settings: ${String(err)}`)) },
        { id: "optchat.on", title: "optchat: turn memory on", group: "optchat", slash: { name: "optchat_on" }, run: () => void toggle(true) },
        { id: "optchat.off", title: "optchat: turn memory off", group: "optchat", slash: { name: "optchat_off" }, run: () => void toggle(false) },
      ],
    }));

    // ---------------------------------------------------------------- widget

    function Widget(props: { sessionID: string }) {
      const [line, setLine] = createSignal<string | undefined>();
      const [tone, setTone] = createSignal<"ok" | "warn" | "muted">("muted");

      const refresh = async () => {
        try {
          const settings = await S.readSettings();
          if (!settings.enabled) {
            setLine("optchat · off");
            setTone("muted");
            return;
          }
          const entry = await entryFor(props.sessionID);
          const snap = entry.snapshot;
          if (snap.messages === 0) {
            setLine("optchat · no memory yet");
            setTone("muted");
            return;
          }
          const compression = snap.transcriptBytes / Math.max(1, snap.sentBytes);
          setLine(
            `optchat · ${snap.messages} msgs · view ${St.fmtBytes(snap.sentBytes)} · ×${compression.toFixed(1)}` +
              (snap.settled ? "" : ` · ${snap.unsettled} waiting`),
          );
          setTone(snap.settled ? "ok" : "warn");
        } catch {
          setLine("optchat · ?");
        }
      };

      void refresh();
      const timer = setInterval(() => void refresh(), 30_000);
      let unlisten: (() => void) | undefined;
      try {
        unlisten = ctx.data?.on?.("session.idle", () => void refresh());
      } catch {
        unlisten = undefined;
      }
      onCleanup(() => {
        clearInterval(timer);
        unlisten?.();
      });

      return (
        <box flexDirection="row" gap={1}>
          <text fg={ink(ctx.theme, tone())}>{line() ?? "optchat · …"}</text>
        </box>
      );
    }

    try {
      ctx.ui.slot({ append: "sidebar.content", render: (input: AnyRec) => <Show when={input?.sessionID}>{(id: any) => <Widget sessionID={id()} />}</Show> });
    } catch (err) {
      log(`sidebar slot refused: ${String(err)}`);
    }

    log(`loaded (settings ${S.settingsPath()}, home ${homedir()})`);
    return () => off?.();
  },
});
