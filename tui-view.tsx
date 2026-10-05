/** @jsxImportSource @opentui/solid */
/**
 * optchat TUI — popup navigable + widget de barre latérale.
 *
 * `/optchat`            ouvre le menu (↑/↓ puis Entrée ; taper filtre)
 *   ├ Stats de la session   gain réel vs transcript complet, cache, tokens
 *   ├ Vue                   exactement ce que le modèle reçoit
 *   ├ Arbre                 les résumés, par niveau
 *   └ Réglages              activer/désactiver, modèle de compaction, budget
 *                           de vue, ratio, prix du cache
 *
 * Il lit le même dossier de chat que le plugin serveur (aucun appel à lui) :
 * les réglages vivent dans settings.json, que le serveur relit à chaque tour.
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

const ratio = (theme: AnyRec | undefined, kind: "ok" | "warn" | "err" | "info" | "muted" | "text"): any => {
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

interface Entry {
  at: number;
  snapshot: St.ChatSnapshot;
  gains: St.Gains;
  usage?: St.RealUsage;
}

export default Plugin.define({
  id: "optchat.cli",

  setup(ctx: AnyRec) {
    const cache = new Map<string, Entry>();
    const log = (line: string) => {
      void import("node:fs/promises")
        .then(({ appendFile }) => appendFile(join(S.dataDir(), "tui.log"), `${new Date().toISOString()} ${line}\n`, "utf8"))
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
          title: "optchat — aucune session",
          message: "optchat mesure la session courante et il n'y a encore aucun chat enregistré.\n\nOuvre une session et laisse passer un tour de conversation, puis relance /optchat.",
        });
        return undefined;
      }
      const picked = await ctx.ui.dialog.select<string>({
        title: `optchat — quelle session ? (${why})`,
        placeholder: "taper pour filtrer",
        options: recent.map((c) => ({
          title: c.sessionID,
          value: c.sessionID,
          description: `${c.messages} lignes · ${St.fmtBytes(c.bytes)} · ${c.when}`,
        })),
      });
      return picked;
    }

    async function models() {
      try {
        const collection = ctx.data?.location?.model;
        await collection?.sync?.();
        const list: AnyRec[] = collection?.list?.() ?? [];
        return list
          .map((m) => ({
            ref: `${m.providerID ?? m.provider?.id}/${m.id ?? m.modelID}`,
            name: m.name ?? m.id ?? m.modelID,
            provider: m.providerID ?? m.provider?.id ?? "?",
          }))
          .filter((m) => m.ref.includes("/") && !m.ref.includes("undefined"));
      } catch {
        return [];
      }
    }

    async function compute(sessionID: string, budget: number): Promise<Entry> {
      const started = Date.now();
      const loaded = await St.loadChat(sessionID, budget);
      const rows = loaded.rows;
      const settings = await S.readSettings();
      const g = St.gains(sessionID, loaded, rows, settings.ratio);
      let usage: St.RealUsage | undefined;
      try {
        const messages: AnyRec[] = ctx.data?.session?.message?.list?.(sessionID) ?? [];
        if (messages.length) usage = St.realUsage(messages);
      } catch {
        usage = undefined;
      }
      const entry: Entry = { at: Date.now(), snapshot: loaded.snapshot, gains: g, usage };
      cache.set(sessionID, entry);
      log(`stats ${sessionID}: ${loaded.snapshot.messages} msgs, vue ${loaded.snapshot.sentBytes} o, ${Date.now() - started}ms`);
      return entry;
    }

    async function entryFor(sessionID: string, force = false): Promise<Entry> {
      const settings = await S.readSettings();
      const hit = cache.get(sessionID);
      if (!force && hit && Date.now() - hit.at < 4000) return hit;
      return compute(sessionID, settings.view);
    }

    // ---------------------------------------------------------------- popup

    function Dialog(props: { title: string; children: any; footer?: string }) {
      let off: (() => void) | undefined;
      onMount(() => {
        ctx.ui.dialog.set({ size: "large" });
        off = ctx.keymap.layer(() => ({
          mode: "modal",
          commands: [
            { id: "optchat.popup.close", title: "Fermer", bind: "escape", run: () => ctx.ui.dialog.clear() },
            { id: "optchat.popup.back", title: "Retour", bind: "backspace", run: () => ctx.ui.dialog.clear() },
          ],
        }));
      });
      onCleanup(() => off?.());
      return (
        <box paddingLeft={2} paddingRight={2} flexDirection="column" height="100%">
          <text fg={ratio(ctx.theme, "ok")}>
            <b>{props.title}</b>
          </text>
          <scrollbox scrollY flexGrow={1} gap={0}>
            {props.children}
          </scrollbox>
          <text fg={ratio(ctx.theme, "muted")}>{props.footer ?? "esc fermer"}</text>
        </box>
      );
    }

    function showLines(title: string, lines: string[], footer?: string) {
      ctx.ui.dialog.show(() => (
        <Dialog title={title} footer={footer}>
          <box flexDirection="column">
            <For each={lines}>{(line) => <text fg={ratio(ctx.theme, line.includes("→") || line.includes("×") ? "ok" : "text")}>{line || " "}</text>}</For>
          </box>
        </Dialog>
      ));
    }

    async function showStats(sessionID: string) {
      const settings = await S.readSettings();
      const entry = await entryFor(sessionID, true);
      const lines = St.reportLines(entry.snapshot, entry.gains, {
        ratio: settings.ratio,
        cacheRatio: settings.cacheRatio,
        budget: settings.view,
        usage: entry.usage,
      });
      showLines(`optchat — stats de ${sessionID}`, lines, "esc fermer  ·  r rafraîchir");
    }

    async function showView(sessionID: string, mode: "line" | "placeholder", title: string) {
      const loaded = await St.loadChat(sessionID);
      const text = C.renderView(loaded.state, mode);
      const lines = text.split("\n");
      showLines(`${title} — ${lines.length - 2} lignes`, lines, "esc fermer  ·  ↑/↓ défiler");
    }

    async function showTree(sessionID: string) {
      const loaded = await St.loadChat(sessionID);
      const keys = [...loaded.state.nodes.keys()].sort((a, b) => {
        const [la, ia] = a.split(":").map(Number);
        const [lb, ib] = b.split(":").map(Number);
        return la! - lb! || ia! - ib!;
      });
      if (keys.length === 0) return showLines("optchat — arbre", ["Aucun résumé construit pour l'instant (les messages courts sont leur propre ligne)."]);
      const lines = keys.map((key) => {
        const [l, i] = key.split(":").map(Number);
        const [start, stop] = C.covers(l!, i!);
        const text = loaded.state.nodes.get(key)!;
        return `L${l} ${key}  msgs ${start}-${stop - 1}  ${C.byteLen(text)} o  ${C.oneLine(text).slice(0, 72)}`;
      });
      showLines(`optchat — arbre de ${sessionID}`, lines, "esc fermer  ·  ↑/↓ défiler");
    }

    async function settingsMenu(): Promise<void> {
      const settings = await S.readSettings();
      const path = S.settingsPath();
      const choice = await ctx.ui.dialog.select<string>({
        title: "optchat — réglages",
        placeholder: "taper pour filtrer",
        current: "enabled",
        options: [
          {
            title: settings.enabled ? "Désactiver la mémoire" : "Activer la mémoire",
            value: "toggle",
            description: settings.enabled ? "le prochain tour repartira du transcript complet" : "la vue redevient le contexte de chaque tour",
          },
          { title: `Modèle de compaction : ${S.formatModel(settings.compactor)}`, value: "compactor", description: "modèle qui écrit les résumés — prend effet au tour suivant" },
          { title: `Budget de la vue : ${St.fmtBytes(settings.view)}`, value: "view", description: `plafond du contexte envoyé (~${St.fmtTokens(settings.view / settings.ratio)} tokens)` },
          { title: `Ratio d'estimation : ${settings.ratio} octets/token`, value: "ratio", description: "sert aux calculs de gain affichés" },
          { title: `Prix du cache : ${Math.round(settings.cacheRatio * 100)}%`, value: "cache", description: "part du prix d'entrée payée pour un token relu du cache" },
          { title: `Cap par résultat d'outil : ${St.fmtBytes(settings.cap)}`, value: "cap" },
          { title: "Où sont ces réglages ?", value: "path", description: path },
        ],
      });
      if (choice === undefined) return;

      if (choice === "path") {
        await ctx.ui.dialog.alert({ title: "optchat — settings.json", message: `${path}\n\nLe serveur relit ce fichier à chaque tour : aucune redémarrage nécessaire.` });
        return settingsMenu();
      }
      if (choice === "toggle") {
        const next = await S.writeSettings({ enabled: !settings.enabled });
        ctx.ui.toast.show({ title: "optchat", message: next.enabled ? "mémoire activée" : "mémoire désactivée", variant: next.enabled ? "success" : "warning" });
        return settingsMenu();
      }
      if (choice === "compactor") {
        const list = await models();
        const picked = await ctx.ui.dialog.select<string>({
          title: "optchat — modèle de compaction",
          placeholder: "taper pour filtrer",
          current: settings.compactor,
          options: [
            { title: "(modèle de la session)", value: "", description: "par défaut : le modèle utilisé dans la conversation" },
            ...list.map((m) => ({ title: m.name, value: m.ref, description: m.provider, category: m.provider })),
          ],
        });
        if (picked !== undefined) {
          await S.writeSettings({ compactor: picked });
          ctx.ui.toast.show({ title: "optchat", message: `compacteur : ${S.formatModel(picked)}`, variant: "success" });
        }
        return settingsMenu();
      }
      if (choice === "view") {
        const picked = await ctx.ui.dialog.select<number>({
          title: "optchat — budget de la vue",
          current: settings.view,
          options: S.VIEW_CHOICES.map((v) => ({
            title: St.fmtBytes(v),
            value: v,
            description: `≈ ${St.fmtTokens(v / settings.ratio)} tokens de contexte porté à chaque tour`,
          })),
        });
        if (picked !== undefined) {
          await S.writeSettings({ view: picked });
          ctx.ui.toast.show({ title: "optchat", message: `budget de vue : ${St.fmtBytes(picked)}`, variant: "success" });
        }
        return settingsMenu();
      }
      if (choice === "cap") {
        const picked = await ctx.ui.dialog.select<number>({
          title: "optchat — cap par résultat d'outil",
          current: settings.cap,
          options: [10_000, 20_000, 30_000, 50_000, 80_000].map((v) => ({ title: St.fmtBytes(v), value: v })),
        });
        if (picked !== undefined) await S.writeSettings({ cap: picked });
        return settingsMenu();
      }
      if (choice === "ratio" || choice === "cache") {
        const values = choice === "ratio" ? S.RATIO_CHOICES : [0, 0.1, 0.2, 0.3, 0.5];
        const currentValue = choice === "ratio" ? settings.ratio : settings.cacheRatio;
        const picked = await ctx.ui.dialog.select<number>({
          title: choice === "ratio" ? "optchat — ratio octets/token" : "optchat — prix du cache",
          current: currentValue,
          options: values.map((v) => ({ title: choice === "ratio" ? `${v} octets/token` : `${Math.round(v * 100)}%`, value: v })),
        });
        if (picked !== undefined) await S.writeSettings(choice === "ratio" ? { ratio: picked } : { cacheRatio: picked });
        return settingsMenu();
      }
    }

    async function menu(sessionID: string) {
      const entry = await entryFor(sessionID, true);
      const snap = entry.snapshot;
      const settings = await S.readSettings();
      log(`popup ${sessionID}: ${snap.messages} msgs, vue ${snap.sentBytes} o, ${snap.viewLines} lignes, ${entry.gains.requests} requêtes`);
      const choice = await ctx.ui.dialog.select<string>({
        title: `optchat — ${snap.messages} messages · vue ${St.fmtBytes(snap.sentBytes)} · ×${(snap.transcriptBytes / Math.max(1, snap.sentBytes)).toFixed(1)}`,
        placeholder: "taper pour filtrer",
        options: [
          {
            title: "Stats de la session",
            value: "stats",
            description: entry.gains.requests
              ? `gain vs transcript complet, cache, tokens (${St.fmtTokens(entry.gains.last.ours)} tok/tour)`
              : "gain vs transcript complet, cache, tokens",
          },
          { title: "Vue — ce que le modèle voit", value: "view", description: `${snap.viewLines} lignes, ${St.fmtBytes(snap.sentBytes)}, ${Math.round((snap.viewBytes / settings.view) * 100)}% du budget` },
          { title: "Arbre des résumés", value: "tree", description: `${snap.nodes} nœuds — ${snap.settled ? "à jour" : `${snap.unsettled} lignes en attente`}` },
          { title: `Réglages${settings.enabled ? "" : "  (mémoire désactivée)"}`, value: "settings", description: `compacteur ${S.formatModel(settings.compactor)} · vue ${St.fmtBytes(settings.view)}` },
          { title: "Fermer", value: "close" },
        ],
      });
      if (choice === "stats") return showStats(sessionID);
      if (choice === "view") return showView(sessionID, "line", `optchat — vue envoyée`);
      if (choice === "tree") return showTree(sessionID);
      if (choice === "settings") return settingsMenu();
    }

    // ------------------------------------------------------------- commands

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
        message: next.enabled ? "mémoire activée" : "mémoire désactivée",
        variant: next.enabled ? "success" : "warning",
      });
    };

    const off = ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "optchat.menu",
          title: "optchat : mémoire, stats, réglages",
          group: "optchat",
          palette: true,
          suggested: true,
          slash: { name: "optchat", aliases: ["oc"] },
          run: () => {
            log(`cmd /optchat (route ${routeNow()?.type ?? "?"})`);
            return void guard((id) => menu(id), "menu");
          },
        },
        { id: "optchat.stats", title: "optchat : stats de la session", group: "optchat", slash: { name: "optchat_stats" }, run: () => void guard((id) => showStats(id), "stats") },
        { id: "optchat.view", title: "optchat : vue envoyée au modèle", group: "optchat", slash: { name: "optchat_view" }, run: () => void guard((id) => showView(id, "line", "optchat — vue envoyée"), "vue") },
        { id: "optchat.tree", title: "optchat : arbre des résumés", group: "optchat", slash: { name: "optchat_tree" }, run: () => void guard((id) => showTree(id), "arbre") },
        { id: "optchat.settings", title: "optchat : réglages", group: "optchat", slash: { name: "optchat_settings" }, run: () => void settingsMenu().catch((err) => log(`error settings: ${String(err)}`)) },
        { id: "optchat.on", title: "optchat : activer la mémoire", group: "optchat", slash: { name: "optchat_on" }, run: () => void toggle(true) },
        { id: "optchat.off", title: "optchat : désactiver la mémoire", group: "optchat", slash: { name: "optchat_off" }, run: () => void toggle(false) },
      ],
    }));

    // --------------------------------------------------------------- widget

    function Widget(props: { sessionID: string }) {
      const [line, setLine] = createSignal<string | undefined>();
      const [tone, setTone] = createSignal<"ok" | "warn" | "muted">("muted");

      const refresh = async () => {
        try {
          const settings = await S.readSettings();
          if (!settings.enabled) {
            setLine("optchat · désactivé");
            setTone("muted");
            return;
          }
          const entry = await entryFor(props.sessionID);
          const snap = entry.snapshot;
          if (snap.messages === 0) {
            setLine("optchat · pas de mémoire");
            setTone("muted");
            return;
          }
          const ratioGain = snap.transcriptBytes / Math.max(1, snap.sentBytes);
          setLine(
            `optchat · ${snap.messages} msg · vue ${St.fmtBytes(snap.sentBytes)} · ×${ratioGain.toFixed(1)}` +
              (snap.settled ? "" : ` · ${snap.unsettled} en attente`),
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
          <text fg={ratio(ctx.theme, tone())}>{line() ?? "optchat · …"}</text>
        </box>
      );
    }

    try {
      ctx.ui.slot({ append: "sidebar.content", render: (input: AnyRec) => <Show when={input?.sessionID}>{(id: any) => <Widget sessionID={id()} />}</Show> });
    } catch (err) {
      log(`sidebar slot refused: ${String(err)}`);
    }

    log(`loaded (plugin path ${S.settingsPath()}, home ${homedir()})`);
    return () => off?.();
  },
});
