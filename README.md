<h1 align="center">
  <img src="assets/logo.svg" alt="ember" height="96">
</h1>

<p align="center">
  <a href="https://github.com/ozandogrultan/opencode-ember/actions/workflows/ci.yml"><img src="https://github.com/ozandogrultan/opencode-ember/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/opencode-ember"><img src="https://img.shields.io/npm/v/opencode-ember" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="#contributing"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs welcome"></a>
  <a href="https://github.com/ozandogrultan/opencode-ember/stargazers"><img src="https://img.shields.io/github/stars/ozandogrultan/opencode-ember?style=social" alt="GitHub stars"></a>
</p>

See what a **cold prompt-cache rewrite** will cost before you send it. When
the cache TTL has lapsed on a large context, ember shows the price or blocks
the send, and `ember gain` reports the cold writes you paid for across sessions.

A port of [`cache-tax`](https://github.com/karanb192/claude-code-mods/tree/main/plugins/cache-tax)
to [opencode](https://opencode.ai) V1 and V2. A server plugin plus an optional V2 TUI companion,
no runtime dependencies.

**Install:** clone the repo and run `./install.sh` ([details](#install)).

## What it does

- **`/ember guard warn` (default) shows the price and sends anyway.** When the TTL has
  lapsed and the context is large, a warning toast is shown while the message sends.
  `/ember guard refuse` hard blocks cold sends before the provider call and shows the
  price as the session error, preventing accidental rewrites until you switch to `warn`
  or start a new session.
- **`/ember` keeps score.** Warm or cold, context size, cold-rewrite price,
  guard mode, and this session's cold writes.
- **`ember gain` reports history.** After a cold-send warning, a completed step
  with cache-write tokens records a cold write in a UTC daily bucket. The report
  shows cold-write counts and estimated costs.
  Totals cover all retained buckets; the per-day table shows only the most recent days.
  `ember discover` is an alias; `ember gain --json` dumps the raw buckets.

> **Looking for cache warming?** OpenCode V2 supports
> [session warming out of the box](https://opencode.ai/v2/docs/warming/),
> without a plugin. Check its built-in `warming` setting first. It is disabled
> by default, and warming requests can incur provider costs.

## Requirements

- [opencode](https://opencode.ai) **V1 1.18.0+ or V2 2.1.4+** (see
  `engines.opencode` in [package.json](package.json)). Both use the same package.
- A provider with prefix caching and reported token usage. Prices come from the
  rates OpenCode reports for the model when it has a cache-write price, otherwise
  from a built-in table for selected Anthropic, OpenAI, and Gemini families.
- The TUI (and on V2 its ember companion), for the warning and `/ember` toasts. Without it (for example
  `opencode run`) the guard still blocks and records, but nothing is shown for
  `warn` and `/ember`.
- [Bun](https://bun.sh) on `PATH` to run the reporting CLI.

## Install

### From this repo (recommended)

```sh
git clone https://github.com/ozandogrultan/opencode-ember.git
cd opencode-ember
./install.sh [config-dir]
```

On V1, restart opencode. V2 reloads watched config on change.

`install.sh` copies `src/` into `<config>/plugins/ember/` (the config directory
comes from `opencode debug paths`, or pass one), then merges `"./plugins/ember"`
into the `plugins` array of `opencode.json` (server) and `cli.json` (terminal,
also active when connected to a remote server). Existing entries are kept, a
config it cannot parse as plain JSON is left untouched, and the V1
`plugins/ember.ts` is removed when upgrading to V2.
On V1 it installs `plugins/ember.ts` for auto-discovery with its supporting
modules in `<config>/ember/`; existing config files are not modified.
An existing legacy server `plugin` registry stays in that format, including tuple
options. Config updates are staged and atomically replaced; originals remain in
the printed `.ember-install-*` recovery directory. A failed second replacement
rolls back the first.

It also links the report binary as `~/.local/bin/ember` (set `EMBER_BIN_DIR` to
choose another directory), so `ember gain` works from any shell if that
directory is on `PATH`. The link points to this checkout's `gain.ts`, so keep the
checkout in place. An alternative is `npm install -g opencode-ember` for the CLI;
this does not load the plugin into opencode. `/ember gain` inside opencode tells
you to use the binary instead.

### From npm

```json
{ "plugins": ["opencode-ember"] }
```

in V2 `opencode.json` (or `opencode plugin add opencode-ember`). Add the same
`plugins` entry to `cli.json` for warning and card toasts, including remote-server sessions.
V1 keeps its singular config unchanged: `{ "plugin": ["opencode-ember"] }`;
restart V1 after installation. The package exports the V2 TUI companion as `./tui`.
Install the CLI separately with `npm install -g opencode-ember` if you want
`ember gain`.

### Manually

On V2, copy the files in `src/` to `<config>/plugins/ember/`, add a `package.json` with
`"exports": { ".": "./index.ts", "./tui": "./tui.ts" }`, and add
`"./plugins/ember"` to `plugins` in `opencode.json` and `cli.json`.
On V1, use `install.sh` so the single-file auto-discovered entry and its shared
imports are installed together.

## Usage

```
/ember [guard warn|refuse]
ember gain | discover [--json]     # the report, from any shell
```

| command | effect |
| --- | --- |
| `/ember` | the card |
| `/ember guard warn` | show the price and send (default) |
| `/ember guard refuse` | hard block cold sends |
| `ember gain` | terminal report over collected history (alias `ember discover`) |

`/ember` shows its result in a toast and never calls a model or adds a message to
the session. `guard block` is an alias for `guard refuse`.

Guard mode is persisted globally and shared across sessions and processes.
If saving fails, ember reports an error and refuses cold sends in the current
process until a guard command saves successfully. Other processes and restarts
may still use the previous saved setting.

## Cache TTL

The default assumed TTL is **5 minutes**. The guard compares it with the time
of the latest completed model step; it does not query the provider's cache.
`EMBER_TTL_SECONDS=3600` changes the assumed TTL. It does not select a provider
cache tier or change the price table.

## Configuration

| env var | default | meaning |
| --- | --- | --- |
| `EMBER_TTL_SECONDS` | `300` | assumed cache tier |
| `EMBER_MIN_CONTEXT` | `50000` | cold-guard context floor, tokens |
| `EMBER_STATE_FILE` | `~/.local/share/opencode/ember.json` | state path shared by plugin and CLI |

## Prices and the reporting caveats (read this too)

Dollar figures use the cache rates OpenCode reports for the model, or, when it
reports no cache-write price, a small built-in table in `src/core.ts` (`PRICES`:
cache read, cache write and output rates per model family). Two consequences:

- **Every figure is an estimate.** The built-in table holds list rates for the
  Anthropic/OpenAI/Gemini families the plugin knows; it does not follow your provider,
  plan, negotiated rates, or prompt-fee changes. The card estimates a cold rewrite
  using the whole context and the write rate, and a warm turn using the read rate.
  Recorded cold-write costs use reported cache-write tokens and the write rate;
  normal input and output costs are not added to the report. Treat every dollar
  value in `/ember` and `ember gain` as an approximation, not an invoice.
- **Unpriced models read $0.00.** Models without a matching row — e.g. custom
  OpenAI-compatible ids like `custom-unpriced-model` or provider relays — report no cost, so
  the cold-write cost runs understated (or reads $0.00) for them. Cold-write
  counts are independent of pricing. Add a row to `PRICES` in `src/core.ts` to include a model in the estimates.

State lives in a versioned file, `~/.local/share/opencode/ember.json` by default.
Multiple opencode processes (one per workspace/cmux session) share the
file: every write re-reads it and merges, so a process writing preserves the
history and any fields it does not recognise (including those written by older
or newer versions). Older state files, including the `always` and `sessions`
fields from versions with `/keepwarm`, stay readable and are ignored.
Daily history is trimmed to a bounded number of stored date buckets on writes,
not a number of calendar days. Delete the file to reset settings and history.
The file holds only the guard mode and daily cold-write counts and costs; no
credentials, request headers, or prompts are written to disk.

## Testing

Free command checks (no model call; shown with default settings). If `/ember` is
unknown, the plugin did not load:

```
/ember               # card
/ember guard warn    # switch guard
ember gain           # the report (CLI)
```

Cold guard — launch with a 5-second pseudo-TTL and a 1-token floor:

```sh
EMBER_TTL_SECONDS=5 EMBER_MIN_CONTEXT=1 opencode
```

Send a normal message and wait for it to finish. Run `/ember guard refuse`,
wait at least 6 seconds, and send another message: the guard should block it
before a provider call. `/ember guard warn` allows the next send with a warning.
Normal sends cost whatever your provider charges.

Repository checks are listed in [CONTRIBUTING.md](CONTRIBUTING.md).

## How it works

The V2 server plugin registers a `context` hook (runs before each agent model call; only
the call that answers a new prompt is guarded, so tool-loop steps pass), the
`/ember` command, and an event loop (`session.step.ended` for token tracking and
cold-write recording; compaction, revert and delete resets). It never appends to
a session. Warnings and the card reach the screen through an `ember` RPC `notice`
event that the TUI companion shows as a toast; refusing throws from the hook, which
OpenCode reports as the session error. Subagent sessions are ignored.
V1 retains its `chat.message` / `chat.params` guard and token-usage event hooks,
with the same shared pricing, guard calculations and version-3 state store.

## Credits

Ported from [`karanb192/claude-code-mods` → `cache-tax`](https://github.com/karanb192/claude-code-mods/tree/main/plugins/cache-tax).
The design, the price arithmetic and the safety rules are theirs; this is the
opencode translation.

## More OpenCode plugins

- [sesh](https://github.com/ozandogrultan/opencode-sesh) — search, preview, and resume every session across every project.
- [ghost](https://github.com/ozandogrultan/opencode-ghost) — suggests your next prompt as ghost text in the empty composer.
- [quill](https://github.com/ozandogrultan/opencode-quill) — local word completion and next-word prediction as you type.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the check suite and commit
conventions, [AGENTS.md](AGENTS.md) for the design rules, and
[CHANGELOG.md](CHANGELOG.md) for what changed.

## License

MIT © Ozan Dogrultan
