# Agent task: install the `ember` plugin for opencode

You are on a machine that has opencode. Install the bundled plugin and verify it.
Work through the steps in order and report at the end. Do not invent extra
configuration.

## What you are installing

```
.
├── ember.ts             the whole plugin — one file, no runtime dependencies
├── install.sh           copies it into opencode's global plugin dir
├── README.md            human-facing docs (leave alone)
└── INSTALL.md           this file
```

`ember` is a server-side opencode plugin. It registers two slash commands
(`/keepwarm`, `/ember`) and hooks `chat.message`, `event` and
`command.execute.before`. Its only import from `@opencode-ai/plugin` is a
**type-only** import, which is erased at runtime, so it needs nothing installed
and no package manager.

## Steps

1. **Confirm opencode is present.**
   ```sh
   opencode --version
   ```
   If the command is missing, stop and report that opencode is not on `PATH`.

2. **Find this directory.** `cd` to the directory containing this `INSTALL.md`
   (the one you are reading from). All paths below are relative to it.

3. **Install.**
   ```sh
   ./install.sh
   ```
   If `install.sh` is not executable, run `sh install.sh` or `chmod +x install.sh`
   first. The script asks opencode for its own config directory
   (`opencode debug paths`, the `config` line), creates `plugins/` if needed,
   backs up an existing `ember.ts`, and copies the new one in.

   Hand install if you prefer: the destination is `<config>/plugins/ember.ts`,
   where `<config>` is the `config` path from `opencode debug paths` (typically
   `~/.config/opencode`). For a single project instead, copy it to
   `<project>/.opencode/plugins/ember.ts`.

4. **Verify the plugin loads.** This starts opencode's config pipeline, which
   loads plugins, so errors surface here:
   ```sh
   opencode debug config | grep -A2 -E '"keepwarm"|"ember"'
   ```
   Expected: a `command` object containing `keepwarm` and `ember`, and a
   `plugin_origins` entry whose `spec` is a `file://` URL ending in
   `plugins/ember.ts`.

5. **Do not restart anything.** opencode only loads plugins at startup, so the
   running session will not see this; tell the user to quit and restart opencode
   (a fresh `opencode run` picks it up too).

6. **Report** using the format below.

## After install (tell the user, do not run these for them)

- After restarting, `/keepwarm status` and `/ember` confirm the commands exist.
  Both are free — they do not call a model.
- opencode uses the 5-minute cache tier, so pings are about every 4 minutes;
  `/keepwarm 6h ttl 1h` is available if their provider holds an hour.

## Failure handling

- If step 4 shows no `keepwarm`/`ember`, the plugin did not load. Re-run with
  logs: `opencode debug config --print-logs --log-level DEBUG 2>&1 | grep -i plugin`.
  Report the error verbatim.
- If the file exists but not where opencode reports its config, redo step 3 with
  the path from `opencode debug paths`.
- Never delete an existing `ember.ts` without a backup; `install.sh` already
  backs it up.

## Report format

```
Installed : <absolute path of ember.ts>
Load check: PASS | FAIL (<error>)
Commands  : keepwarm, ember present | missing
Restart   : required — user must quit and restart opencode
Notes     : <anything unexpected>
```
