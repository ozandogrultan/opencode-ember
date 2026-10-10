# AGENTS.md — ember

## What this is

An [opencode](https://opencode.ai) **server plugin** (not a TUI plugin) that
prices a lapsed cache before a cold send and reports what a break cost. It is a port of
[`cache-tax`](https://github.com/karanb192/claude-code-mods/tree/main/plugins/cache-tax);
the price arithmetic and safety rules are the original author's.

`README.md` is the user-facing contract — read it before changing behaviour.

## Layout

- `ember.ts` — the whole plugin: hooks, shared state store, pricing table,
  timers, `/keepwarm` and `/ember` commands.
- `gain.ts` — the `ember gain` / `ember discover` CLI over the state file
  (a standalone `bin`, no runtime deps).
- `install.sh` — copies `ember.ts` into opencode's global plugin directory and
  links the CLI as `~/.local/bin/ember`.
- `test/` — bun tests (`bun test`).
- `tests/changelog.sh`, `scripts/changelog.sh` — release bookkeeping.
- `CHANGELOG.md` — Keep a Changelog; released versions only.

## Commands

```bash
bun install
bun run test        # bun test + changelog tooling
bun run typecheck   # tsc --noEmit
bun run lint:sh     # bash -n on the scripts
bun run gain        # run the reporting CLI
```

## Hard-won rules — do not regress

- **Background warming is unavailable, fail-closed, and never mutates sessions or provider config.**
  Never fork, prompt, delete, or append to a session for background warming.
  Never mutate `config.provider` or wrap provider `options.fetch` (which clobbers
  authentication plugins and breaks provider initialization). Background warming
  fails closed with "no supported captured model request is available" and never
  issues background provider requests.
- **Shared, versioned state.** Every write re-reads and merges
  `~/.local/share/opencode/ember.json` so sessions armed by other opencode
  processes are preserved. Automatic arming is disabled by default; unstamped
  defaults must not be implicitly enabled. Explicit commands and recorded cold
  writes can arm timers, but no timer sends a warming request.
- **Prices are estimates.** They are hard-coded list rates; unpriced models must
  read `$0.00` while raw counters (heartbeats, tokens, cold writes) stay
  accurate.

## Verifying

```bash
bun run test && bun run typecheck && bun run lint:sh
bash scripts/changelog.sh check
```

## Conventions

Commits follow [Conventional Commits](CONTRIBUTING.md#commit-messages); the type
decides the release bump. See `CONTRIBUTING.md` and `RELEASING.md`.
