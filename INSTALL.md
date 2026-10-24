# Agent task: install the `ember` plugin for opencode

You are on a machine that has OpenCode **V1 or V2**. Install the bundled plugin and
verify it. Work through the steps in order and report at the end. Do not invent
extra configuration.

## What you are installing

`ember` is a dual V1/V2 plugin: a V2 server plugin (`src/index.ts`) that guards
cold-cache sends and registers `/ember`, and a TUI companion (`src/tui.ts`) that
shows its warnings and card as toasts. `gain.ts` is the reporting CLI (requires
Bun on PATH). `install.sh` installs all of it. The plugin has no runtime
dependencies; the host provides `@opencode/plugin`. The supported OpenCode range
is `engines` in `package.json`. V1 uses `ember.ts` and `src/v1.ts`. It
does not warm caches; OpenCode V2 has built-in warming.

## Steps

1. **Confirm opencode is present and check its version.**
   ```sh
   opencode --version
   ```
   If the command is missing, stop and report that opencode is not on `PATH`.
   Supported versions are V1 1.18.0+ and V2 2.1.4+. Confirm `bun --version` too if the user wants the
   reporting CLI.

2. **Find this directory.** `cd` to the directory containing this `INSTALL.md`
   (the one you are reading from). All paths below are relative to it.

3. **Install.**
   ```sh
   ./install.sh
   ```
   If `install.sh` is not executable, run `bash install.sh` or `chmod +x install.sh`
   first. The script asks opencode for its own config directory
   (`opencode debug paths`, the `config` line; pass a directory as the first
   argument to choose another), copies `src/` to `<config>/plugins/ember/`
   (replacing the previous copy without a backup), and merges `"./plugins/ember"`
   into `plugins` in `opencode.json` and `cli.json`. Existing entries are kept; a
   config that is not plain JSON is left untouched and the script exits with the
   path to edit by hand. It also removes the obsolete V1 `plugins/ember.ts`.
   On V1 it instead installs `plugins/ember.ts` and supporting modules in
   `<config>/ember/`, without changing JSON config.
   Existing legacy server registries retain their format and tuple options.
   V2 config updates use staged atomic replacements and retain originals in the
   printed `.ember-install-*` directory; a failed second replacement rolls back
   the first. If interrupted, use those originals to recover the prior configs.

   It also links `gain.ts` as `~/.local/bin/ember` (override with `EMBER_BIN_DIR`).
   Keep this checkout in place and put the chosen bin directory on `PATH`.

4. **Verify the registration.**
   ```sh
   grep -l './plugins/ember' "<config>/opencode.json" "<config>/cli.json"
   ```
   On V2 both files should be listed. On V1 verify `plugins/ember.ts` exists;
   it is auto-discovered. If Bun is available, check the CLI with
   `~/.local/bin/ember gain` (use the chosen bin directory if overridden); an
   empty-history report is valid.

5. **Do not restart anything.** V2 reloads watched config on change. Tell V1
   users to restart opencode.

6. **Report** using the format below.

## After install (tell the user, do not run these for them)

- `/ember` shows the card in a toast. It is free — it does not call a model and
  adds nothing to the session.
- The guard assumes a 5-minute TTL by default. `EMBER_TTL_SECONDS` changes the
  assumption, not the provider's cache tier.

## Failure handling

- If `/ember` is unknown, the plugin did not load. Inspect plugin logs without
  sending a model prompt; report the error verbatim.
- If the config directory is not where opencode reports it, rerun step 3 with the
  directory from `opencode debug paths` as the argument.
- Back up local changes to installed plugin source before rerunning. Config
  originals are retained in the installer recovery directory; source copies are not.

## Report format

```
Installed : <absolute path of plugins/ember>
Registered: opencode.json yes|no · cli.json yes|no
CLI       : <absolute path of ember link>; verified | skipped (<reason>)
Reload    : automatic (V2) | user restart required (V1)
Notes     : <anything unexpected>
```
