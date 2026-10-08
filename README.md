# optchat — an endless chat for OpenCode v2

The chat history **is** the memory. Every message is appended to a log and kept
forever; a cheap model compresses the log into a binary tree of one-line
summaries; every turn starts fresh and sees a fixed-size view of the whole chat
(recent messages one per line, older ones many per line). Details are recovered
with `zoom`, never by replaying the transcript.

This is the OptChat principle (VictorTaelin — the recipe's current title is
*"UniiChat: one chat that never ends"*) implemented as an OpenCode v2 server
plugin:

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

## The explainer film

[media/optchat-v5.mp4](media/optchat-v5.mp4) — **2:26**, 1920x1080, 60 fps. Memory
mode in one segment, then orchestrator mode: one chat holding the mission and a
ledger, sub-agents fanning out, the loop with its tool panel and real
`status` / `collect` calls.

The script it was narrated from is committed next to it
([media/script.json](media/script.json)): one JSON file, one `text` per clip.

**To generate the film, use the psychopomp fork** — this repository only carries
the result and the script, not the engine that turns them into video:

- the scene, the recorded narration and the render commands:
  [96Ems/psychopomp · scenes/optchat](https://github.com/96Ems/psychopomp/tree/main/scenes/optchat)
- the full recipe (narration, reel, contact sheet, render, plus the two anchor
  rules that keep biting):
  [docs/THE_FILM.md](https://github.com/96Ems/psychopomp/blob/main/docs/THE_FILM.md)
- the local TTS/STT stack it needs (Kokoro + Parakeet, no paid API):
  [docs/LOCAL_TTS_STT.md](https://github.com/96Ems/psychopomp/blob/main/docs/LOCAL_TTS_STT.md)

## Install

A plugin directory with an `index.ts` is auto-loaded by the v2 loader:

```bash
git clone https://github.com/96Ems/opencode2-plugin-optchat.git ~/.config/opencode/plugins/optchat
# or copy this directory there, or into <project>/.opencode/plugins/optchat
```

No config edit, no npm dependency: the plugin imports nothing but Node builtins
plus its own modules (`core.ts`, `settings.ts`, `orchestrator.ts`). (Measured on
opencode **2.0.22 and 2.0.23**: the
`plugin: [...]` array of `opencode.json(c)` does not load a local file in these
builds, while `<plugins-dir>/<name>/index.ts` does.)

### Options

Via the config's object form when the loader honours it (`ctx.options`), and via
environment variables otherwise — handy since a directory install has no
`ctx.options`:

| option | env | default | meaning |
|---|---|---|---|
| `view` | `OPTCHAT_VIEW` | `128000` | the mark the view may not pass, in bytes (the recipe's 128 KB: ~500 summary lines). Past it, one batch merges the view down to half |
| `compactor` | `OPTCHAT_COMPACTOR` | the session's own model | `"provider/model"` for the summaries — pick a cheap (but competent) one |
| `dataDir` | `OPTCHAT_DATA_DIR` | `$XDG_DATA_HOME/opencode/optchat` | where chats are stored |
| `enabled` | `OPTCHAT_DISABLED=1` | `true` | set `false` to disable |

## Storage

```
<dataDir>/<sessionID>/
  main/YYYY-MM-DD.jsonl   {i,kind,text,size,date,src,inst}   every message, verbatim
  tree/YYYY-MM-DD.jsonl   {l,i,text,size}               one summary line per node
  view.json               [[l,i], ...]                  the view, as it was left
  optchat.log                                           what the plugin did
  lock                                                  one writer per chat
```

`kind` is `user` (the user's words), `talk` (replies), `tool` (tool calls),
`echo` (tool results), and `note`, reserved for memories imported by an older
system — nothing in this plugin writes it yet. Every line is written with
one `write` then `fsync`. A torn line (crash mid-write) is reported and skipped
at load; the log is history and is never edited.

`view.json` is written whenever the view changes and read back at load: the view
is **kept, not rebuilt**. Folding it again from the log picks different merges
than the live fold did (a merge waits for its parent to be built, so the timing
decides), and every prompt-cache entry would die with the rebuilt view. A saved
view is adopted only while it still tiles the log exactly.

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
  - **cost** the same way round: last turn and whole session, with the
    **saving**, the prices used (input / cache read / output, per million tokens,
    shown in cents) and their source (the model catalogue, i.e. `ModelInfo.cost`);
  - the provider's own numbers (`tokens.in`, `tokens.cache.read`, `tokens.out`,
    and `session.cost`) for the "with optchat" side and for what was really paid;
  - a warning when the counterfactual would not have fitted the model window.
- **View** — one line per part: id, kind, size, whether it is carried whole or
  cut, and a preview. Originals are bright, summaries sit on a grey ramp by level
  (L1 light → L5 dark), and a cut part shows the `zoom(start, count)` that
  recovers it. This replaces reading the raw context string.
- **Summaries** — the tree: how many nodes per level and what each node covers.
- **Settings** — memory on/off, orchestrator mode, compactor model (picked from
  the catalogue), context budget, tool result cap, the bytes-per-token `ratio`,
  and where the file lives.
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
invoice, which keeps the counterfactual comparable. A catalogue entry that
*disagrees* with the invoice is rescaled the same way (some providers ship
nominal prices that bill several times less), and the report names the source it
used: `catalogue`, `inferred` or `rescaled`. The cache read price is what makes a
long prefix cheap; that is why the old hand-entered "cache price" setting is gone.
The summaries cost extra on top — one small model call per node — and the report
says so.

Amounts are shown the way these models are priced: **cents per million tokens**
for the prices, a **per-request row in cents**, and dollars only for session
totals — a request costs a fraction of a cent, so dollars per million would hide
how small the numbers are (0.16 ¢ a request against 0.86 ¢ carrying the whole log).

The **full-transcript column is an upper bound**: past the model's context window
OpenCode would have compacted, and the report warns when that point was reached
(it names how many requests would have gone over). The "with optchat" column is
anchored on what the session really cost, so it always adds up to the invoice.

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

## Orchestrator mode — one conversation, many subagents (optional)

Memory mode above trades cache for a bounded context. Orchestrator mode takes the
other side of that trade: the chat you keep holds a mission and a ledger, while
everything noisy — diffs, logs, file dumps, dead ends — happens in subagent
sessions that the orchestrator starts, follows, resumes and collects.

The orchestrator's own context is **never rewritten**: it stays a normal, short,
append-only conversation, so the prompt cache keeps matching what it already has.
What the plugin adds is the workflow (how to brief, resume and verify subagents)
and the tools to do it.

### 1. Declare the agent

The plugin cannot create an agent, so declare it once:

    // ~/.config/opencode/opencode.jsonc
    {
      "agent": {
        "orchestrator": {
          "description": "Drives subagents: spawn, follow, resume, collect."
        }
      }
    }

The plugin supplies the rest: as this agent you get the workflow prompt and the
tool set below, and nothing else. Every other agent is untouched.

### 2. Turn the mode on

`"orchestrator": true` in `settings.json` (`<data>/settings.json`), or
`OPTCHAT_ORCHESTRATOR=1`.

### 3. Use it

Start a session as that agent (`opencode --agent orchestrator`, or Tab in the TUI)
and ask in plain language:

> spawn one subagent to add the retry logic and one to write its tests; when both
> are done, tell me what changed

Then the tools do the rest:

| tool | what it does |
|---|---|
| `spawn(task, agent?, model?, title?)` | creates a session, sends the brief, returns its id at once — it runs in parallel |
| `collect(id, say?, wait?)` | reads what it returned (bounded to `cap`); `say:` continues the *same* subagent, `wait` blocks until it is idle |
| `status()` | the ledger of this conversation: every run, its subject, its state |
| `stop(id)` | interrupts a running subagent |
| `note(id, task, event?, result?)` | records one ledger line for a run you started with the harness's own subagent tool |
| `find(query, limit?)` | searches this conversation's own log, word for word |
| `zoom(id, n)` / `date(id)` | as in memory mode |

Prefer the harness's own subagent tool. OpenCode v2 ships `task` (it takes the
agent to run), which starts a run natively and resolves the model from the agent's
own configuration; the injected workflow tells the orchestrator to use it when it
exists and to record each run with `note`. `spawn` is the fallback: it creates a
session and prompts it, and on some harness builds such a session sits in the
inbox instead of running.

### What changes for the orchestrator

- Its context is the conversation itself: never rewritten, never compacted by us,
  and the compactor pump is skipped (there is no view to build). `zoom(id, 1)`
  still returns any message whole and `find` searches the log.
- The tool set is **replaced** by the eight above: as this agent you cannot edit
  files, run commands or read the repository. Anything that needs doing is a
  subagent's job — `read`/`search` are last resort, for verifying one precise
  claim, never for exploring.
- Sessions you spawned stay **plain sessions**: the harness's own history, their
  own full tool set, no rewriting. The plugin still logs them.
- The ledger is append-only: `<data>/orchestrator/ledger.jsonl`, one JSON event
  per line (`spawned`, `resumed`, `done`, `failed`, `stopped`).

### Why this design

A subagent's context is not charged to yours — only its return is. That is what
makes many subjects affordable inside one conversation, and because the
orchestrator only ever appends, the prefix cache keeps hitting. The honest
caveat: a subagent costs its own session, so the saving is context and cache, not
"free work".

## Design notes (the parts that are easy to get wrong)

1. **The view is what a turn sends** — rendered once per turn, before the new
   message is logged, and reused for every step of that turn, so a tool-loop call
   re-sends identical bytes from the very start of the payload. Recomputing it per
   step would kill the cache, and replacing it with a coarser "frozen head" of
   tree nodes does not help either: it re-renders the whole log at that level
   (16, 32, 64 messages per line), so the payload shrinks to a fraction of the
   budget and the recent detail the tiling exists to keep is gone.
2. **Never split, and merge in batches.** The view only appends at the end and
   coarsens. A pair is merged only when its parent node exists, and a pair's age
   is measured from its **last** message (`due = (T - last) / 2^l`): measuring
   from its first (`(T - first) / 2^l`) is wrong — checked against the reference
   push over 4,000 steps, it reproduces it on 275 of them, because near ties it
   merges old pairs the push keeps, and rewriting an old line costs the whole
   cached prefix after it. Merges are also held back: one batch fires past
   `view` and merges down to half of it, so the view is a sawtooth that grows one
   line per message and drops in one go. Merging a little at every message
   rewrites tens of view lines per message (measured: 21 vs 80 line-inputs per
   message over 30,000). The start of the view is identical from one turn to the
   next either way.
3. **Only summaries in the view**, never a whole message — a 30 KB tool result
   entering the view would permanently erase old detail.
4. **Never show cut text silently.** An unsummarized line renders as
   `(not summarized yet: zoom it)` when browsed; when a turn needs it, it goes out
   as one bounded line (head and tail, at most `NODE` bytes) carrying the
   `zoom(id, 1)` that recovers the message whole — the fail-safe — and only until
   the compactor catches up during that same turn.
   *Deviation from the spec:* OptChat's turn loop waits (`settle`) until every
   view line is a summary. Here it must not: `ctx.generate.text` is queued behind
   the session request that triggered the hook, so a call issued from a `context`
   hook does not come back while the hook is still awaiting it (measured: a 20 s
   wait with the summary call never returning; the same call resolved seconds
   after the hook returned). The turn is therefore never blocked, and the
   compactor catches up during and after the turn — at most the previous turn's
   last reply can appear as a bounded line once.
5. **Messages are compressed in order**, with up to 8 view lines unsummarized
   ahead of a node before it may start, while merges of finished parts run
   alongside (up to 8 calls at once). The compactor never reads a line that is
   not a summary: a compaction's own view stops at the first unbuilt line. Work
   comes from a **ready queue** — messages queue themselves as they arrive and a
   finished node queues its parent — never from a scan of the tree, which is
   O(N²) over a long chat.
6. **The compactor gets the same prompt a turn gets**, plus the view as
   `<chat>`, plus a task that names the ids (`Compaction: compress message 412 …`)
   and tells the model not to write them back. The size limit is shown as a
   **ruler of 512 dashes**, never as a real sample line: the model copies the
   sample's own content into its answer. Up to 5 tries with the cut-at-limit
   feedback, keeping the shortest answer. A compaction's view is the chat's view
   merged further, into the 16-32 KB band: a summary needs context to resolve
   "do it" or "that file", not the whole chat.
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

79 tests, all pure (no network, no model): `test/core.test.ts` covers byte
handling, free nodes, the compactor's queue, in-order compaction, the fold
(budget, one-batch merge, tiling, monotonicity, the merge order against the
reference push), view.json adoption, the compaction view and prompt, zoom,
message decomposition and capping;
`test/settings.test.ts` covers the settings file, the shared dirs, the cost
model, the bars and the report lines. `bin/measure.ts` prints the same numbers
for a chat from the command line.

## License

MIT — see [LICENSE](LICENSE). The design follows VictorTaelin's OptChat spec
("UniiChat: one chat that never ends").

## Known limits

- **Orchestrator mode — what is verified, and what is not.** Driving subagents has
  been exercised on a live harness (OpenCode v2.0.x, Linux, `muse-spark-1.3`):

  - **Works.** The workflow is injected and actually respected: the model refuses
    to do the work itself, reports verbatim, and never presents a result it did
    not collect (`collect` answered "still running" three times in a row while
    that was true). The ledger records `spawned` / `resumed` / `stopped` with
    their parent, `status` / `collect` / `stop` answer, and the gating holds.
  - **`spawn` is the fallback, and it does not always dispatch.** A session it
    creates and prompts has been seen to stay `running` with no output, and the
    provider log showed the model it fell back to was unavailable in this region;
    passing `agent` and `model` to `session.create` did not change that. OpenCode
    v2 ships its own background subagent mechanism (the `task` tool), which worked
    in the same session — so the workflow tells the orchestrator to prefer `task`
    and to record each run itself with `note`. The plugin's value (workflow,
    ledger, gating, and an orchestrator whose own context stays short and
    cacheable) does not depend on which of the two starts the runs.

- Sessions are per-chat: each OpenCode session gets its own memory (a subagent
  session gets its own too, which matches OptChat's rule that only the master's
  chat is the memory).
- **Provider cache breakpoints are not set by the plugin.** The recipe marks the
  view in 4-line blocks plus the request end (Anthropic's `cache_control`); the
  plugin has no way to reach into a message part for that, so it relies on the
  provider's own prefix cache (implicit on OpenAI-style APIs). The view is built
  to be kind to it: byte-identical system prompt on every call, and a view that
  only appends and coarsens in batches.
- The view sits between half the budget and the budget (`view` is the mark, not a
  target): with the default 128 KB it averages ~96 KB, roughly 25 % less context
  than the old continuous fold carried.
- The view budget is a byte count, not tokens: it is what the plugin measures and
  enforces. The UI converts bytes to tokens with the `ratio` setting (1.3 by
  default); the recipe's own measurement of this dense summary text is ≈ 2 bytes
  per token, so read the token columns as estimates — set `ratio` to 2 for the
  recipe's figure. Keep `view` well under the model's context window either way.
- The compactor runs in the server process, so a one-shot `opencode run` exits
  before it finishes; it catches up as soon as a server stays alive (TUI or the
  background service). With a long-lived server, summaries are always ready
  before the next turn.
- One writer per chat is enforced with a pid lock; a second process logs a
  warning instead of corrupting the log.
