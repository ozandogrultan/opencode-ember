# opencode-ember

[![CI](https://github.com/ozandogrultan/opencode-ember/actions/workflows/ci.yml/badge.svg)](https://github.com/ozandogrultan/opencode-ember/actions/workflows/ci.yml)

Keep an LLM prompt cache **warm across a break**, guard a **cold rewrite**
before you pay for it, and see exactly what the break cost.

A port of [`cache-tax`](https://github.com/karanb192/claude-code-mods/tree/main/plugins/cache-tax)
to [opencode](https://opencode.ai). One self-contained plugin file, no runtime
dependencies.

> Why "ember": a banked fire you keep smoldering while you are away.

## What it does

- **Keepwarm is opt-in, fail-closed, and never mutates sessions or provider config.**
  The plugin never forks, prompts, deletes, or appends to a session for background warming,
  and never wraps provider `options.fetch`. Background warming fails closed with
  `"no supported captured model request is available"` and never issues background provider requests.
- **`/ember guard warn` (default) shows the price and sends anyway.** When the TTL has
  lapsed and the context is large, a graceful warning is shown while the message sends.
  `/ember guard refuse` hard blocks cold sends and shows an informative error in the turn,
  preventing accidental rewrites until you switch to `warn` or `/clear`.
- **`/ember` keeps score.** Warm or cold, context size, cold-rewrite price, the
  break-even (how many pings cost one cold write, and the idle that covers),
  keepwarm state, guard mode, and this session's cold writes.
- **`ember gain` reports history.** Every warm heartbeat and every paid cold
  write is bucketed per day (kept warm for up to 90 days), and the `ember gain`
  terminal binary reports total heartbeats, tokens kept warm, the kept-warm
  value against ping spend and realized cold writes, net savings, a
  warming-yield meter, and a per-day impact table — in the spirit of `rtk gain`.
  `ember discover` is an alias; `ember gain --json` dumps the raw buckets.

## Requirements

- [opencode](https://opencode.ai) (server plugins, `chat.message` +
  `command.execute.before` hooks; tested on 1.18.x).
- A provider with prefix caching. Anthropic is the best-supported; pricing
  tables for Fable/Opus/Sonnet/Haiku are built in.

## Install

### From this repo (recommended)

```sh
git clone https://github.com/ozandogrultan/opencode-ember.git
cd opencode-ember
./install.sh
```

Then **restart opencode** — plugins are loaded at startup only.

`install.sh` also links the report binary as `~/.local/bin/ember` (set
`EMBER_BIN_DIR` to choose another directory), so `ember gain` works from any
shell. It requires [`bun`](https://bun.sh) on PATH; an alternative is
`npm install -g .` from the repo, or copy `gain.ts` somewhere on your PATH.
`/ember gain` inside opencode tells you to use the binary instead.

`install.sh` asks opencode for its own config directory (`opencode debug paths`)
and copies `ember.ts` into `<config>/plugins/`, overwriting any existing file.

### Manually

Copy `ember.ts` to one of:

- `~/.config/opencode/plugins/ember.ts` — all projects (global)
- `<project>/.opencode/plugins/ember.ts` — one project

### From npm

```json
{ "plugin": ["opencode-ember"] }
```

in `opencode.json`, then restart opencode.

## Usage

```
/keepwarm [6h|90m] [every 2m] [ttl 1h] | always | status | off
/ember [guard warn|refuse]
ember gain | discover [--json]     # the report, from any shell
```

| command | effect |
| --- | --- |
| `/keepwarm` | arm warming for a 30-minute window (default cadence ~4m) |
| `/keepwarm 90m` | a window of your own (`2h30m`, `6h`, …) |
| `/keepwarm always` | keep this and future sessions armed across breaks (30m idle window per turn) |
| `/keepwarm 6h every 2m` | override the ping period (floor 1m) |
| `/keepwarm 6h ttl 1h` | assume the 1-hour cache tier |
| `/keepwarm status` | the status line |
| `/keepwarm off` | stop, forget the window, turn always off |
| `/ember` | the card |
| `/ember guard warn` | show the price and send (default) |
| `/ember guard refuse` | hard block cold sends |
| `ember gain` | terminal report over collected history (alias `ember discover`) |

Keepwarm is disabled by default and requires explicit opt-in (`/keepwarm` or
`/keepwarm always`). It warms only after an eligible normal request is captured in memory.

## The 5-minute tier (read this)

opencode marks `cache_control` **without a `ttl`**, i.e. the **5-minute** tier,
so pings land at ~4 minutes, not the original mod's 50. If your provider
actually holds an hour, run `/keepwarm 6h ttl 1h` (or set
`EMBER_TTL_SECONDS=3600`) for a ~54-minute cadence.

Economically that matters: on a 200k-token context a cache read is ~$0.05 and a
cold write ~$4, so ~80 pings cost one cold write. Warm a one-hour break and you
win; warm a whole working day on the 5-minute tier and you are near break-even.

Warming is bounded by the active 30-minute window measured from the latest
non-warming request. Continuous warming (`/keepwarm always`) rearms on subsequent
normal model turns rather than running perpetually while idle; once the 30-minute
idle window lapses, warming stops. Turn it off anytime with `/keepwarm off`.

## Safe warming status

The plugin never forks, prompts, deletes, or appends to a session for background
warming, and never mutates `config.provider` or provider `options.fetch`.
Background warming fails closed with `"no supported captured model request is available"`
and never issues background provider requests or forked sessions.

Important safety guarantees:
- **Zero background provider requests:** Background warming fails closed immediately;
  it never sends provider calls, consumes model quota, or triggers provider authentication loops.
- **No session mutation:** Real session history and parent/child topologies are never altered.
- **Accurate accounting:** Dollar rates are based on actual turns; no synthetic
  heartbeats or tokens are recorded for failed or unsupported background requests.
- **In-memory state hygiene:** No credentials, request headers, or prompts are written to disk.

## Configuration

| env var | default | meaning |
| --- | --- | --- |
| `EMBER_TTL_SECONDS` | `300` | assumed cache tier |
| `EMBER_MIN_CONTEXT` | `50000` | cold-guard context floor, tokens |
| `EMBER_MIN_PING_SECONDS` | `60` | ping floor |

## Prices and the reporting caveats (read this too)

Dollar figures come from a small built-in table in `ember.ts` (`PRICES`: cache
read, cache write and output rates per model family). Two consequences:

- **Every figure is an estimate.** Prices are hard-coded list rates for the
  Anthropic/OpenAI families the plugin knows; they do not follow your provider,
  plan, negotiated rates, or prompt-fee changes. Uncached input tokens use the
  write rate estimate (`price[1]`), cached tokens use the read rate (`price[0]`),
  and output tokens use `price[2]`. Treat every dollar value in `/ember` and
  `ember gain` as an approximation, not an invoice.
- **Unpriced models read $0.00.** Models without a matching row — e.g. custom
  OpenAI-compatible ids like `custom-unpriced-model` or provider relays — report no cost, so
  the kept-warm value, ping spend, cold-write cost, net savings and the warming
  yield meter all run understated (or read $0.00) for them. Raw counters —
  heartbeat counts, tokens kept warm, idle time held warm, cold-write counts —
  stay accurate regardless. Add a row to `PRICES` in `ember.ts` if you want
  dollar accuracy for such a model.

State lives in `~/.local/share/opencode/ember.json` (schema version 3).
Multiple opencode processes (one per workspace/cmux session) share the
file: every write re-reads it and merges, so a process writing its own session's
window never drops sessions armed elsewhere. Upgrading preserves guard settings
and recorded gain history, but resets warming to disabled and clears legacy session
windows so keepwarm requires an explicit `/keepwarm` to re-arm. Delete the file to reset.

## Testing

Free (no model call):

```sh
opencode debug config | grep -A2 -E '"keepwarm"|"ember"'   # loaded?
```

```
/keepwarm status     # "keepwarm off"
/keepwarm 6h         # arms
/ember               # card
/ember guard warn    # switch guard
ember gain           # the report (CLI)
/keepwarm off
```

Cold guard, for about one small call — launch with a 5-second pseudo-TTL and a
1-token floor, send a message, wait 6s, send another (blocked):

```sh
EMBER_TTL_SECONDS=5 EMBER_MIN_CONTEXT=1 opencode
```

Prove a ping shares the cache (one cache read) — in a warm session with real
context:

```
/keepwarm 1h every 1m
```

Wait a minute, then run `/ember`. Its last-ping cache read should be close to
your context size: that is the proof the keepalive ping hit the main cache. Successful
pings are silent; failures and stops still show a toast. If the ping reports
no cache activity, the provider may not cache this prefix or report cache
usage, so keepwarm stops rather than paying for unverified pings. Stop notices
appear briefly in the TUI (five seconds); `/keepwarm status` or `/ember` shows
the reason afterward.

## How it works

`config` (registers `/keepwarm` and `/ember` commands), `chat.message` + `chat.params`
(cold-send guard), `event` (token/price tracking from `step-finish`, session cleanup),
and `command.execute.before` (handles `/keepwarm` and `/ember`, aborted before any model call).

## Credits

Ported from [`karanb192/claude-code-mods` → `cache-tax`](https://github.com/karanb192/claude-code-mods/tree/main/plugins/cache-tax).
The design, the price arithmetic and the safety rules are theirs; this is the
opencode translation.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the check suite and commit
conventions, [AGENTS.md](AGENTS.md) for the design rules, and
[CHANGELOG.md](CHANGELOG.md) for what changed.

## License

MIT © Ozan Dogrultan
