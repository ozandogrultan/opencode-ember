# AGENTS.md — ember

## What this is

An [opencode](https://opencode.ai) **server plugin** (not a TUI plugin) that keeps
a session's prefix cache warm across a break, prices a lapsed cache before a cold
send, and reports what a break cost. It is a port of
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
- `CHANGELOG.md` — Keep a Changelog; `[Unreleased]` is the next release body.

## Commands

```bash
bun install
bun run test        # bun test + changelog tooling
bun run typecheck   # tsc --noEmit
bun run lint:sh     # bash -n on the scripts
bun run gain        # run the reporting CLI
```

## Hard-won rules — do not regress

- **A ping only appends.** Reuse the session's exact model, agent, tools and
  system prompt, and send a constant one-line prompt. Never edit, clear,
  compact, or delete-and-recreate the session.
- **Never cold-rewrite.** Ping only while the last request is still inside the
  cache tier. A session resumed after the tier expired waits for the next real
  turn instead of forking a cold cache.
- **Self-stop on doubt.** A ping that wrote at least a tenth of what it read
  means the cache was already gone: stop. Two consecutive zero-activity
  readbacks stop it too; one inconclusive report or transient error retries
  once first.
- **Shared, versioned state.** Every write re-reads and merges
  `~/.local/share/opencode/ember.json` so sessions armed by other opencode
  processes are never dropped. A pre-v2 unstamped `always: false` is the old
  default, not an opt-out.
- **Prices are estimates.** They are hard-coded list rates; unpriced models must
  read `$0.00` while raw counters (heartbeats, tokens, cold writes) stay
  accurate.

## Verifying

```bash
bun run test && bun run typecheck && bun run lint:sh
```

## Conventions

Commits follow [Conventional Commits](CONTRIBUTING.md#commit-messages); the type
decides the release bump. See `CONTRIBUTING.md` and `RELEASING.md`.
