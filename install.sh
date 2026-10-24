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
    const plugins = config.plugins ?? config.plugin ?? []
    const spec = (item) => (item && typeof item === "object" && !Array.isArray(item) ? item.package : item)
    if (!plugins.some((item) => spec(item) === entry)) config.plugins = [...plugins, entry]
    return { file, config }
  })

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

  for (const { file, config } of plans) {
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n")
    console.log(`registered ${entry} in ${file}`)
  }
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
