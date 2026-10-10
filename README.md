# opencode-ember

[![CI](https://github.com/ozandogrultan/opencode-ember/actions/workflows/ci.yml/badge.svg)](https://github.com/ozandogrultan/opencode-ember/actions/workflows/ci.yml)

Estimate the cost of a **cold prompt-cache rewrite**, warn or block before
the send, and report recorded cold writes across sessions.

A port of [`cache-tax`](https://github.com/karanb192/claude-code-mods/tree/main/plugins/cache-tax)
to [opencode](https://opencode.ai). One self-contained plugin file, no runtime
dependencies.

> **Looking for cache warming?** OpenCode V2 supports
> [session warming out of the box](https://opencode.ai/v2/docs/warming/),
> without a plugin. Check its built-in `warming` setting first. It is disabled
> by default, and warming requests can incur provider costs.

> Why "ember": a banked fire you keep smoldering while you are away.

## What it does

- **Keepwarm does not currently warm caches.** `/keepwarm` arms a timer, but
  its callback stops with `"no supported captured model request is available"`.
  It never sends a background provider request or mutates sessions or provider config.
- **`/ember guard warn` (default) shows the price and sends anyway.** When the TTL has
  lapsed and the context is large, a graceful warning is shown while the message sends.
  `/ember guard refuse` hard blocks cold sends and shows an informative error in the turn,
  preventing accidental rewrites until you switch to `warn` or `/clear`.
- **`/ember` keeps score.** Warm or cold, context size, cold-rewrite price, the
  break-even (how many pings cost one cold write, and the idle that covers),
  keepwarm state, guard mode, and this session's cold writes.
- **`ember gain` reports history.** After a cold-send warning, a completed step
  with cache-write tokens records a cold write in a UTC daily bucket. The report
  includes cold-write counts and estimated costs, plus any stored heartbeat history.
  Totals cover all retained buckets; the per-day table shows the latest 21.
  `ember discover` is an alias; `ember gain --json` dumps the raw buckets.

## Requirements

- [opencode](https://opencode.ai) with the 1.18.x server-plugin API
  (`@opencode-ai/plugin`; see [package.json](package.json) for the development version).
  OpenCode V2 compatibility is not verified.
- A provider with prefix caching and reported token usage. Built-in estimates
  cover selected Anthropic, OpenAI, and Gemini model families.
- [Bun](https://bun.sh) on `PATH` to run the reporting CLI.

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
shell if that directory is on `PATH`. The link points to this checkout's
`gain.ts`, so keep the checkout in place. An alternative is
`npm install -g opencode-ember` for the CLI; this does not load the plugin into opencode.
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

in `opencode.json` for the 1.18.x API, then restart opencode. Install the CLI
separately with `npm install -g opencode-ember` if you want `ember gain`.

## Usage

```
/keepwarm [6h|90m] [every 2m] [ttl 1h] | always | status | off
/ember [guard warn|refuse]
ember gain | discover [--json]     # the report, from any shell
```

| command | effect |
| --- | --- |
| `/keepwarm` | arm a 30-minute timer window (default cadence 4m); retain always mode if enabled |
| `/keepwarm 90m` | a window of your own (`2h30m`, `6h`, …) |
| `/keepwarm always` | persist automatic arming for this and future normal sessions |
| `/keepwarm 6h every 2m` | override the ping period (floor 1m) |
| `/keepwarm 6h ttl 1h` | assume the 1-hour cache tier |
| `/keepwarm status` | the status line |
| `/keepwarm off` | stop this session's timer and disable automatic arming globally |
| `/ember` | the card |
| `/ember guard warn` | show the price and send (default) |
| `/ember guard refuse` | hard block cold sends |
| `ember gain` | terminal report over collected history (alias `ember discover`) |

Automatic arming is disabled by default. `/keepwarm` and `/keepwarm always`
arm timers explicitly; a recorded cold write can also arm a 30-minute window.
None of these paths sends warming requests. `/keepwarm off` does not cancel
timers already armed in other sessions.

Slash commands show their result in a toast and abort before any model call.
The command result may also appear as an error in the turn. `guard block` is an
alias for `guard refuse`.

Guard mode is persisted globally and shared across sessions and processes.

## Cache TTL and cadence

The default assumed TTL is **5 minutes**. The guard compares it with the time
of the latest completed model step; it does not query the provider's cache.
Default timer cadence is 80% of the TTL, subject to the configured floor:
4 minutes for a 5-minute TTL, or 48 minutes for a 1-hour TTL.

`/keepwarm 6h ttl 1h` changes this session's assumed TTL;
`EMBER_TTL_SECONDS=3600` changes the default. Neither selects a provider cache
tier or changes the price table. The card's break-even calculation is theoretical:
background warming is unavailable.

## Safe warming status

The plugin never forks, prompts, deletes, or appends to a session for background
warming, and never mutates `config.provider` or provider `options.fetch`.
Background warming fails closed with `"no supported captured model request is available"`
and never issues background provider requests or forked sessions.

Important safety guarantees:
- **Zero background provider requests:** Background warming fails closed immediately;
  it never sends provider calls, consumes model quota, or triggers provider authentication loops.
- **No session mutation:** Real session history and parent/child topologies are never altered.
- **Usage-based accounting:** Recorded cold-write costs use reported cache-write tokens
  and built-in rate estimates; no synthetic
  heartbeats or tokens are recorded for failed or unsupported background requests.
- **In-memory state hygiene:** No credentials, request headers, or prompts are written to disk.

## Configuration

| env var | default | meaning |
| --- | --- | --- |
| `EMBER_TTL_SECONDS` | `300` | assumed cache tier |
| `EMBER_MIN_CONTEXT` | `50000` | cold-guard context floor, tokens |
| `EMBER_MIN_PING_SECONDS` | `60` | ping floor |
| `EMBER_STATE_FILE` | `~/.local/share/opencode/ember.json` | state path shared by plugin and CLI |

## Prices and the reporting caveats (read this too)

Dollar figures come from a small built-in table in `ember.ts` (`PRICES`: cache
read, cache write and output rates per model family). Two consequences:

- **Every figure is an estimate.** Prices are hard-coded list rates for the
  Anthropic/OpenAI/Gemini families the plugin knows; they do not follow your provider,
  plan, negotiated rates, or prompt-fee changes. The card estimates a cold rewrite
  using the whole context and the write rate, and a warm turn using the read rate.
  Recorded cold-write costs use reported cache-write tokens and the write rate;
  normal input and output costs are not added to the report. Treat every dollar
  value in `/ember` and `ember gain` as an approximation, not an invoice.
  The report's net savings is kept-warm value minus ping spend and recorded
  cold-write cost; without stored warming history it can only be zero or negative.
- **Unpriced models read $0.00.** Models without a matching row — e.g. custom
  OpenAI-compatible ids like `custom-unpriced-model` or provider relays — report no cost, so
  the kept-warm value, ping spend, cold-write cost, net savings and the warming
  yield meter all run understated (or read $0.00) for them. Raw counters —
  heartbeat counts, tokens kept warm, idle time held warm, cold-write counts —
  are independent of pricing. This version adds no heartbeat or kept-warm counters.
  Add a row to `PRICES` in `ember.ts` to include a model in the estimates.

State lives in `~/.local/share/opencode/ember.json` (schema version 3).
Multiple opencode processes (one per workspace/cmux session) share the
file: every write re-reads it and merges, so a process writing its own session's
window preserves sessions armed elsewhere. Reading older or unversioned state
preserves guard settings and recorded gain history, but disables automatic arming
and discards legacy session windows; version-3 settings and windows are retained.
Daily history is trimmed to approximately 90 stored date buckets on writes,
not 90 calendar days. Delete the file to reset settings and history.

## Testing

Free command checks (no model call; shown with default settings):

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

Cold guard — launch with a 5-second pseudo-TTL and a 1-token floor:

```sh
EMBER_TTL_SECONDS=5 EMBER_MIN_CONTEXT=1 opencode
```

Send a normal message and wait for it to finish. Run `/ember guard refuse`,
wait at least 6 seconds, and send another message: the guard should block it
before a provider call. `/ember guard warn` allows the next send with a warning.
Normal sends cost whatever your provider charges.

Check fail-closed keepwarm without a model call:

```
/keepwarm 1h every 1m
```

In a fresh session with no prior turn, wait a little over a minute, then run
`/keepwarm status`. Expect `no supported captured model request is available`.
The callback sends no provider request, records no heartbeat, and shows no stop
toast. Run `/keepwarm off` afterward.

Repository checks:

```sh
bun install
bun run test && bun run typecheck && bun run lint:sh
bash scripts/changelog.sh check
```

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
