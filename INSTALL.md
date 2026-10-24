# Agent task: install the `ember` plugin for opencode

You are on a machine that has opencode. Install the bundled plugin and verify it.
Work through the steps in order and report at the end. Do not invent extra
configuration.

## What you are installing

`ember` is a server-side opencode plugin: `ember.ts` is the whole plugin, `gain.ts`
is the reporting CLI (requires Bun on PATH), and `install.sh` installs both.
It registers one slash command (`/ember`). Its only import from
`@opencode-ai/plugin` is a **type-only** import, which is erased at runtime, so
it needs nothing installed and no package manager for the plugin itself. The
supported opencode range is `engines` in `package.json`; see the README for
compatibility notes. It does not warm caches; OpenCode V2 has built-in warming.

## Steps

1. **Confirm opencode is present.**
   ```sh
   opencode --version
   ```
   If the command is missing, stop and report that opencode is not on `PATH`.
   Confirm `bun --version` too if the user wants the reporting CLI.

2. **Find this directory.** `cd` to the directory containing this `INSTALL.md`
   (the one you are reading from). All paths below are relative to it.

3. **Install.**
   ```sh
   ./install.sh
   ```
   If `install.sh` is not executable, run `bash install.sh` or `chmod +x install.sh`
   first. The script asks opencode for its own config directory
   (`opencode debug paths`, the `config` line), creates `plugins/` if needed,
   and copies the new `ember.ts` in, overwriting any existing file without a
   backup. Back up any local changes before running it. If path discovery fails,
   it uses `${XDG_CONFIG_HOME:-$HOME/.config}/opencode`.

   It also links `gain.ts` as `~/.local/bin/ember` (override with `EMBER_BIN_DIR`).
   Keep this checkout in place and put the chosen bin directory on `PATH`.

   Hand install if you prefer: the destination is `<config>/plugins/ember.ts`,
   where `<config>` is the `config` path from `opencode debug paths` (typically
   `~/.config/opencode`). For a single project instead, copy it to
   `<project>/.opencode/plugins/ember.ts`.

4. **Verify the plugin loads.** This starts opencode's config pipeline, which
   loads plugins, so errors surface here:
   ```sh
   opencode debug config | grep -A2 '"ember"'
   ```
   Expected: a command entry for `ember`. If Bun is available,
   check the CLI with `~/.local/bin/ember gain` (use the chosen bin directory
   if overridden); an empty-history report is valid.

5. **Do not restart anything.** opencode only loads plugins at startup, so the
   running session will not see this; tell the user to quit and restart opencode
   (a fresh `opencode run` picks it up too).

6. **Report** using the format below.

## After install (tell the user, do not run these for them)

- After restarting, `/ember` confirms the command exists. It is free — it does
  not call a model.
- The guard assumes a 5-minute TTL by default. `EMBER_TTL_SECONDS` changes the
  assumption, not the provider's cache tier.

## Failure handling

- If step 4 shows no `ember`, the plugin did not load. Re-run with
  logs: `opencode debug config --print-logs --log-level DEBUG 2>&1 | grep -i plugin`.
  Report the error verbatim.
- If the file exists but not where opencode reports its config, redo step 3 with
  the path from `opencode debug paths`.
- Back up an existing plugin with local changes before overwriting it;
  `install.sh` does not create backups.

## Report format

```
Installed : <absolute path of ember.ts>
Load check: PASS | FAIL (<error>)
Command   : ember present | missing
CLI       : <absolute path of ember link>; verified | skipped (<reason>)
Restart   : required — user must quit and restart opencode
Notes     : <anything unexpected>
```
