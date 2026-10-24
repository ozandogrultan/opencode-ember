# AGENTS.md — ember

## What this is

An [opencode](https://opencode.ai) **server plugin** (not a TUI plugin) that
prices a lapsed cache before a cold send and reports what a break cost. It is a port of
[`cache-tax`](https://github.com/karanb192/claude-code-mods/tree/main/plugins/cache-tax);
the price arithmetic and safety rules are the original author's.

`README.md` is the user-facing contract — read it before changing behaviour.

## Layout

- `ember.ts` — the whole plugin: hooks, shared state store, pricing table
  and the `/ember` command.
- `gain.ts` — the `ember gain` / `ember discover` CLI over the state file
  (a standalone `bin`, no runtime deps).
- `INSTALL.md` — step-by-step install and verification for an agent.
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

- **No timers, heartbeats, or background requests, and never mutate sessions or provider config.**
  Never fork, prompt, delete, or append to a session. Never mutate
  `config.provider` or wrap provider `options.fetch` (which clobbers
  authentication plugins and breaks provider initialization). Cache warming
  belongs to OpenCode V2, not this plugin.
- **Shared, versioned state.** Every write re-reads and merges
  `~/.local/share/opencode/ember.json` so other opencode processes' history is
  preserved. Unknown top-level and per-day fields (including the `always`,
  `sessions` and heartbeat fields of older versions) must pass through writes
  untouched and are never acted on.
- **Prices are estimates.** They are hard-coded list rates; unpriced models must
  read `$0.00` while cold-write counts stay accurate.

## Verifying

```bash
bun run test && bun run typecheck && bun run lint:sh
bash scripts/changelog.sh check
```

## Conventions

Commits follow [Conventional Commits](CONTRIBUTING.md#commit-messages); the type
decides the release bump. See `CONTRIBUTING.md` and `RELEASING.md`.
