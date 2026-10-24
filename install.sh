#!/usr/bin/env bash
# Install the ember plugin into an OpenCode V1 or V2 config directory.
# Usage: install.sh [config-dir]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/src"
entry="./plugins/ember"

fail() {
  echo "error: $*" >&2
  exit 1
}

[ -f "$src/index.ts" ] || fail "missing $src/index.ts"

if ! command -v opencode >/dev/null 2>&1; then
  fail "'opencode' is not on PATH"
fi

version="$(opencode --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)"
[ -n "$version" ] || fail "cannot determine the OpenCode version; no files were changed"

cfg="${1:-}"
if [ -z "$cfg" ]; then
  cfg="$(opencode debug paths 2>/dev/null | awk '$1 == "config" { sub(/^[[:space:]]*config[[:space:]]+/, ""); print; exit }')"
fi
cfg="${cfg:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"

if [ "${version%%.*}" -lt 2 ]; then
  mkdir -p "$cfg/plugins" "$cfg/ember"
  cp "$src/v1.ts" "$src/core.ts" "$src/store.ts" "$cfg/ember/"
  sed 's|"./src/|"../ember/|g' "$here/ember.ts" > "$cfg/plugins/ember.ts"
  bin_dir="${EMBER_BIN_DIR:-$HOME/.local/bin}"
  mkdir -p "$bin_dir"
  ln -sf "$here/gain.ts" "$bin_dir/ember"
  echo "installed -> $cfg/plugins/ember.ts (V1 auto-discovery)"
  echo "Restart opencode to load it, then run /ember."
  exit 0
fi

runtime=""
for candidate in node bun; do
  if command -v "$candidate" >/dev/null 2>&1; then
    runtime="$candidate"
    break
  fi
done
[ -n "$runtime" ] || fail "node or bun is required to update the JSON config; no files were changed"

mkdir -p "$cfg"

# Parse both registries before writing anything, so a config we cannot read
# (for example JSONC) leaves the machine untouched.
"$runtime" -e '
  const fs = require("fs")
  const path = require("path")
  const [source, cfg, entry] = process.argv.slice(1)
  const targets = [
    [path.join(cfg, "opencode.json"), "https://opencode.ai/config.json"],
    [path.join(cfg, "cli.json"), "https://opencode.ai/v2/cli.json"],
  ]

  const plans = targets.map(([file, schema]) => {
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
      console.error(`Cannot safely replace symlinked config ${file}; no files were changed. Register "${entry}" manually in its target.`)
      process.exit(1)
    }
    let config = { $schema: schema }
    if (fs.existsSync(file)) {
      try {
        config = JSON.parse(fs.readFileSync(file, "utf8"))
        if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error()
        if ("plugins" in config && !Array.isArray(config.plugins)) throw new Error()
        if ("plugin" in config && !Array.isArray(config.plugin)) throw new Error()
      } catch {
        console.error(`Cannot safely parse ${file} as a JSON object with a plugins array; no files were changed. Add "${entry}" to its plugins list by hand.`)
        process.exit(1)
      }
    }
    const registry = file.endsWith("opencode.json") && !("plugins" in config) && "plugin" in config ? "plugin" : "plugins"
    const plugins = config[registry] ?? []
    const spec = (item) => Array.isArray(item) ? item[0] : item && typeof item === "object" ? item.package : item
    const registered = [...(config.plugins ?? []), ...(config.plugin ?? [])].some((item) => spec(item) === entry)
    if (!registered) config[registry] = [...plugins, entry]
    return { file, config, existed: fs.existsSync(file) }
  })

  const staging = fs.mkdtempSync(path.join(cfg, ".ember-install-"))
  try {
    for (const plan of plans) {
      const name = path.basename(plan.file)
      plan.backup = path.join(staging, `${name}.original`)
      plan.next = path.join(staging, `${name}.next`)
      if (plan.existed) fs.copyFileSync(plan.file, plan.backup, fs.constants.COPYFILE_EXCL)
      const fd = fs.openSync(plan.next, "wx", plan.existed ? fs.statSync(plan.file).mode : 0o600)
      try {
        fs.writeFileSync(fd, JSON.stringify(plan.config, null, 2) + "\n")
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
    }
  } catch (error) {
    console.error(`Could not stage config updates; live configs unchanged. Recovery files: ${staging}`)
    throw error
  }

  const dest = path.join(cfg, "plugins", "ember")
  const owned = fs.readdirSync(source).filter((name) => name.endsWith(".ts"))
  fs.mkdirSync(dest, { recursive: true })
  for (const name of fs.readdirSync(dest)) {
    if (name.endsWith(".ts") && !owned.includes(name)) fs.rmSync(path.join(dest, name))
  }
  for (const name of owned) fs.copyFileSync(path.join(source, name), path.join(dest, name))
  fs.writeFileSync(
    path.join(dest, "package.json"),
    JSON.stringify({ name: "opencode-ember", type: "module", exports: { ".": "./index.ts", "./tui": "./tui.ts" } }, null, 2) + "\n",
  )
  console.log(`installed -> ${dest}`)

  const replaced = []
  try {
    for (const plan of plans) {
      fs.renameSync(plan.next, plan.file)
      replaced.push(plan)
    }
  } catch (error) {
    for (const plan of replaced.reverse()) {
      try {
        if (plan.existed) fs.renameSync(plan.backup, plan.file)
        else fs.rmSync(plan.file)
      } catch (rollbackError) {
        console.error(`Could not restore ${plan.file}: ${rollbackError.message}`)
      }
    }
    console.error(`Config update failed; recovery files: ${staging}`)
    throw error
  }
  for (const { file } of plans) console.log(`registered ${entry} in ${file}`)
  console.log(`config originals -> ${staging}`)
' "$src" "$cfg" "$entry"

# OpenCode V1 loaded ember.ts straight from plugins/; V2 rejects that file.
legacy="$cfg/plugins/ember.ts"
if [ -f "$legacy" ] && grep -q 'local.ember' "$legacy"; then
  rm -f "$legacy"
  echo "removed obsolete V1 plugin $legacy"
fi

# Link the report binary next to the plugin source (bun runs TS directly).
bin_dir="${EMBER_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$bin_dir"
ln -sf "$here/gain.ts" "$bin_dir/ember"
echo "cli -> $bin_dir/ember   (run: ember gain  ·  ember discover)"
echo
echo "Run /ember after the V2 config reload."
