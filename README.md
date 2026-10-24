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
to [opencode](https://opencode.ai). One self-contained plugin file, no runtime
dependencies.

**Install:** clone the repo, run `./install.sh`, and restart opencode
([details](#install)).

## What it does

- **`/ember guard warn` (default) shows the price and sends anyway.** When the TTL has
  lapsed and the context is large, a graceful warning is shown while the message sends.
  `/ember guard refuse` hard blocks cold sends and shows an informative error in the turn,
  preventing accidental rewrites until you switch to `warn` or `/clear`.
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

- [opencode](https://opencode.ai) with the server-plugin API
  (`@opencode-ai/plugin`). [package.json](package.json) records the supported
  opencode range (`engines`) and the plugin version used for development.
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

in `opencode.json`, then restart opencode. Install the CLI
separately with `npm install -g opencode-ember` if you want `ember gain`.

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

Slash commands show their result in a toast and abort before any model call.
The command result may also appear as an error in the turn. `guard block` is an
alias for `guard refuse`.

Guard mode is persisted globally and shared across sessions and processes.

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

Dollar figures come from a small built-in table in `ember.ts` (`PRICES`: cache
read, cache write and output rates per model family). Two consequences:

- **Every figure is an estimate.** Prices are hard-coded list rates for the
  Anthropic/OpenAI/Gemini families the plugin knows; they do not follow your provider,
  plan, negotiated rates, or prompt-fee changes. The card estimates a cold rewrite
  using the whole context and the write rate, and a warm turn using the read rate.
  Recorded cold-write costs use reported cache-write tokens and the write rate;
  normal input and output costs are not added to the report. Treat every dollar
  value in `/ember` and `ember gain` as an approximation, not an invoice.
- **Unpriced models read $0.00.** Models without a matching row — e.g. custom
  OpenAI-compatible ids like `custom-unpriced-model` or provider relays — report no cost, so
  the cold-write cost runs understated (or reads $0.00) for them. Cold-write
  counts are independent of pricing. Add a row to `PRICES` in `ember.ts` to include a model in the estimates.

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

Free command checks (no model call; shown with default settings):

```sh
opencode debug config | grep -A2 '"ember"'   # loaded?
```

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

`config` (registers the `/ember` command), `chat.message` + `chat.params`
(cold-send guard), `event` (token/price tracking from `step-finish`, session cleanup),
and `command.execute.before` (handles `/ember`, aborted before any model call).

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
