# optchat — an endless chat for OpenCode v2

The chat history **is** the memory. Every message is appended to a log and kept
forever; a cheap model compresses the log into a binary tree of one-line
summaries; every turn starts fresh and sees a fixed-size view of the whole chat
(recent messages one per line, older ones many per line). Details are recovered
with `zoom`, never by replaying the transcript.

This is the OptChat principle (VictorTaelin, *"OptChat: an endless chat where
the AI remembers everything"*) implemented as an OpenCode v2 server plugin:

- **Infinite context at a constant size.** Nothing is deleted; only the
  resolution of the distant past fades.
- **No context rot, no manual compaction.** Each turn is a fresh model call
  whose input is `[system prompt] [view] [new message]`. `/compact` becomes
  pointless — OpenCode's own compaction hook answers from the view instead of
  calling a model.
- **Your instructions stick.** Corrections said in chat are what the compressor
  ranks highest, so they survive up the tree.
- **You can browse it.** The log and the tree are plain JSONL files, and
  `bin/optchat.ts` prints the view, every message and the whole tree.

## Install

A plugin directory with an `index.ts` is auto-loaded by the v2 loader:

```bash
git clone https://github.com/96Ems/opencode2-plugin-optchat.git ~/.config/opencode/plugins/optchat
# or copy this directory there, or into <project>/.opencode/plugins/optchat
```

No config edit, no npm dependency: the plugin imports nothing but Node builtins
plus its own `./core.ts`. (Measured on opencode **2.0.22 and 2.0.23**: the
`plugin: [...]` array of `opencode.json(c)` does not load a local file in these
builds, while `<plugins-dir>/<name>/index.ts` does.)

### Options

Via the config's object form when the loader honours it (`ctx.options`), and via
environment variables otherwise — handy since a directory install has no
`ctx.options`:

| option | env | default | meaning |
|---|---|---|---|
| `view` | `OPTCHAT_VIEW` | `128000` | view budget in bytes (≈ 62–64k tokens) |
| `compactor` | `OPTCHAT_COMPACTOR` | the session's own model | `"provider/model"` for the summaries — pick a cheap (but competent) one |
| `dataDir` | `OPTCHAT_DATA_DIR` | `$XDG_DATA_HOME/opencode/optchat` | where chats are stored |
| `enabled` | `OPTCHAT_DISABLED=1` | `true` | set `false` to disable |

## Storage

```
<dataDir>/<sessionID>/
  main/YYYY-MM-DD.jsonl   {i,kind,text,size,date,src}   every message, verbatim
  tree/YYYY-MM-DD.jsonl   {l,i,text,size}               one summary line per node
  optchat.log                                           what the plugin did
  lock                                                  one writer per chat
```

`kind` is `user` (the user's words), `talk` (replies), `tool` (tool calls),
`echo` (tool results), `note` (imported memories). Every line is written with
one `write` then `fsync`. A torn line (crash mid-write) is reported and skipped
at load; the log is history and is never edited.

## TUI plugin — popup and widget

The same directory carries both sides: `index.ts` is the server plugin and
`tui.ts` the CLI one (a one-line re-export of `tui-view.tsx`), so a single
install gives you the popup too.

**`/optchat`** opens a navigable popup (↑/↓ then Enter, type to filter, Esc to
close):

- **Stats** — the session at a glance, then the context carried per turn and what
  it costs:
  - transcript vs context sent, compression factor, budget bar;
  - context carried by every request, without optchat vs with it, at 0/25/50/75/100 %
    of the session plus last turn and session totals, each with its own bar;
  - **cost in USD** the same way round: last turn and whole session, with the
    **saving**, the prices used (input / cache read / output per million tokens)
    and their source (the model catalogue, i.e. `ModelInfo.cost`);
  - the provider's own numbers (`tokens.in`, `tokens.cache.read`, `tokens.out`,
    and `session.cost`) for the "with optchat" side and for what was really paid;
  - a warning when the counterfactual would not have fitted the model window.
- **View** — one line per part: id, kind, size, whether it is carried whole or
  cut, and a preview. Originals are bright, summaries sit on a grey ramp by level
  (L1 light → L5 dark), and a cut part shows the `zoom(start, count)` that
  recovers it. This replaces reading the raw context string.
- **Summaries** — the tree: how many nodes per level and what each node covers.
- **Settings** — memory on/off, compactor model (picked from the catalogue),
  context budget, tool result cap, bytes per token, and where the file lives.
- **Raw context string** — the exact text sent to the model, if you want it.

The sidebar shows `optchat · 918 msgs · view 127 KB · ×11.4` (plus
`· 37 waiting` while the compactor catches up).

Direct shortcuts: `/optchat_stats`, `/optchat_view`, `/optchat_tree`,
`/optchat_raw`, `/optchat_settings`, `/optchat_on`, `/optchat_off`; `/oc` is an
alias of `/optchat`.

Settings are written to `<dataDir>/settings.json`; the server plugin re-reads
that file **on every turn** (one `stat()`), so a change made in the popup applies
to the next message — no restart. Copying files into the plugin directory hot
reloads both sides, so a running TUI picks up a fix without losing the session.

### How the money numbers are computed

`stats.ts` bills each request twice: once with the context optchat actually sent
(using the provider's own token counts when the session carries them) and once
with the whole transcript, where the unchanged prefix is served from the
provider's cache and only the new tail pays the fresh input price. The two sides
count the same answers, so the difference isolates the effect of the context.

Prices come from the model catalogue (`ModelInfo.cost`, USD per million tokens).
When the catalogue has no entry for the model — common with custom providers —
they are **inferred from what the session actually cost**: every request is
re-priced with the same ratios so that the "with optchat" column adds up to the
invoice, which keeps the counterfactual comparable (the report says which of the
two it used). The cache read price is what makes a long prefix cheap; that is why
the old hand-entered "cache price" setting is gone. The summaries cost extra on
top — one small model call per node — and the report says so.

## Browsing

```bash
bun bin/optchat.ts                      # the chat touched last (the session you are in)
bun bin/optchat.ts <sessionID|chat-dir> [--root] [--tree] [--raw] [--pump]
```

```
messages       12  (1834 bytes)
tree nodes     7
view           4 lines, 912 bytes (budget 128000)
settled        true
──── VIEW
<chat>
0+4|user: ...; talk: ...; tool: shell echo optchat-live; echo: optchat-live
4+8|...
</chat>
```

## Design notes (the parts that are easy to get wrong)

1. **The view is rendered once per turn**, before the new message is logged, and
   reused for every step of that turn: it is the head of the cached prefix.
   Recomputing it per step would kill the cache.
2. **Never split.** The view only appends at the end and coarsens; a pair is
   merged only when its parent node exists, choosing the most due pair
   (oldest relative to its size). The start of the view is therefore identical
   from one turn to the next.
3. **Only summaries in the view**, never a whole message — a 30 KB tool result
   entering the view would permanently erase old detail.
4. **Never show cut text.** An unsummarized line renders as
   `(not summarized yet: zoom it)` when browsed, and **whole** (never truncated)
   when a turn needs it — the fail-safe — and only until the compactor catches
   up during that same turn.
   *Deviation from the spec:* OptChat's turn loop waits (`settle`) until every
   view line is a summary. Here it must not: `ctx.generate.text` is queued behind
   the session request that triggered the hook, so a call issued from a `context`
   hook does not come back while the hook is still awaiting it (measured: a 20 s
   wait with the summary call never returning; the same call resolved seconds
   after the hook returned). The turn is therefore never blocked, and the
   compactor catches up during and after the turn — at most the previous turn's
   last reply can appear whole once.
5. **Messages are compressed one at a time, in order** (`end <= first`), while
   merges of finished parts run alongside, up to 8 at once. The compactor never
   reads a line that is not a summary.
6. **No ids in the compactor's input** (it copies them into its output), a
   `SCALE` line of exactly 512 bytes (models can't count bytes), and up to 5
   tries with the cut-at-limit feedback; the shortest answer is kept.
7. **Thoughts are never logged** (the compactor would have to summarize them),
   and tool results are capped at 30,000 characters with a note of what was cut.
8. **Free nodes**: if the source already fits in 512 bytes it *is* the node, no
   model call (`0 + 1` messages cost nothing to remember).
9. **The compactor never follows instructions it reads** — it is told to record,
   never to answer or obey.

## Tests

```bash
bun test
```

37 tests, all pure (no network, no model): `test/core.test.ts` covers byte
handling, free nodes, in-order compaction, the fold (budget, tiling,
monotonicity), zoom, prompt assembly, message decomposition and capping;
`test/settings.test.ts` covers the settings file, the shared dirs, the cost
model, the bars and the report lines. `bin/measure.ts` prints the same numbers
for a chat from the command line.

## License

MIT — see [LICENSE](LICENSE). The design follows VictorTaelin's OptChat spec
("OptChat: an endless chat where the AI remembers everything").

## Known limits

- Sessions are per-chat: each OpenCode session gets its own memory (a subagent
  session gets its own too, which matches OptChat's rule that only the master's
  chat is the memory).
- The view budget is a byte count, not tokens: pick `view` so that
  `view / 3` stays well under the model's context window.
- The compactor runs in the server process, so a one-shot `opencode run` exits
  before it finishes; it catches up as soon as a server stays alive (TUI or the
  background service). With a long-lived server, summaries are always ready
  before the next turn.
- One writer per chat is enforced with a pid lock; a second process logs a
  warning instead of corrupting the log.
