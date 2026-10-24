# AGENTS.md — ember

## What this is

An [opencode](https://opencode.ai) **V1 and V2 plugin** (a server plugin plus an optional V2 TUI
companion, one package) that prices a lapsed cache before a cold send and reports
what a break cost. It is a port of
[`cache-tax`](https://github.com/karanb192/claude-code-mods/tree/main/plugins/cache-tax);
the price arithmetic and safety rules are the original author's.

`README.md` is the user-facing contract — read it before changing behaviour.

## Layout

- `ember.ts` — dual default entry (`server` for V1, lazy `setup` for V2) and
  the existing named `EmberPlugin` export; V1 must not import V2 runtime modules.
- `src/v1.ts` — V1 hooks, using the shared core and store.
- `src/index.ts` — server plugin (`Plugin.define`, id `ember`): the `context`
  hook (cold-send guard), the `/ember` command, and the event loop
  (`session.step.ended`, compaction, revert, delete). It owns all decisions and
  state.
- `src/tui.ts` — TUI companion (id `ember.tui`). It only turns `notice` RPC events
  from the server into toasts; it holds no logic.
- `src/rpc.ts` — the `ember` RPC definition (one `notice` event) both sides import.
- `src/core.ts` — pure logic: pricing table, coldness, formatting, guard text
  and card.
- `src/store.ts` — the shared, locked, merge-on-write state file.
- `gain.ts` — the `ember gain` / `ember discover` CLI over the state file
  (a standalone `bin`, no runtime deps).
- `INSTALL.md` — step-by-step install and verification for an agent.
- `install.sh` — copies `src/` into `<config>/plugins/ember/`, registers it in
  `opencode.json` and `cli.json` (merge, never clobber), and links the CLI as
  `~/.local/bin/ember`. On V1, installs `plugins/ember.ts` and supporting modules
  in `<config>/ember/`, leaving JSON untouched.
- `test/` — bun tests (`bun test`); `test/harness.ts` fakes the plugin context.
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
  Never fork, prompt, delete, or append to a session — no `session.synthetic`, no
  synthetic messages; V2 notices use RPC and a TUI toast, V1 uses `client.tui`.
  Never mutate provider config or wrap provider fetch
  (which clobbers authentication plugins). Cache warming belongs to OpenCode V2,
  not this plugin.
- **The `context` hook fires on every agent model call.** Guard only the call whose last
  message is the user's prompt; tool-loop steps must pass untouched. Throwing in
  the hook blocks the provider call and surfaces as the session error (refuse).
- **Local plugin directories load `index.ts` at their root.** `exports` alone is
  not followed for a path in `plugins`, which is why `install.sh` copies `src/`
  flat into `plugins/ember/`.
- **No runtime dependencies.** `@opencode/plugin` and `effect` come from the host;
  the package ships TypeScript source only.
- **Shared, versioned state.** Every write re-reads and merges
  `~/.local/share/opencode/ember.json` so other opencode processes' history is
  preserved. Unknown top-level and per-day fields (including the `always`,
  `sessions` and heartbeat fields of older versions) must pass through writes
  untouched and are never acted on.
- **Prices are estimates.** Rates come from the model's own cache-write cost when
  OpenCode reports one, else the hard-coded list-rate table; unpriced models must
  read `$0.00` while cold-write counts stay accurate.

## Verifying

```bash
bun run test && bun run typecheck && bun run lint:sh
bash scripts/changelog.sh check
```

## Conventions

Commits follow [Conventional Commits](CONTRIBUTING.md#commit-messages); the type
decides the release bump. See `CONTRIBUTING.md` and `RELEASING.md`.
