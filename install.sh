#!/usr/bin/env bash
# Install the ember plugin into opencode's global plugin directory.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/ember.ts"

if [ ! -f "$src" ]; then
  echo "error: missing $src" >&2
  exit 1
fi

if ! command -v opencode >/dev/null 2>&1; then
  echo "error: 'opencode' is not on PATH" >&2
  exit 1
fi

# Prefer opencode's own reported config path; fall back to the XDG default.
cfg="$(opencode debug paths 2>/dev/null | awk '$1 == "config" { print $2; exit }')"
if [ -z "$cfg" ]; then
  cfg="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
fi

dest="$cfg/plugins"
mkdir -p "$dest"
target="$dest/ember.ts"

if [ -f "$target" ]; then
  backup="$target.bak.$(date +%Y%m%d%H%M%S)"
  cp "$target" "$backup"
  echo "backed up existing plugin to $backup"
fi

cp "$src" "$target"
echo "installed -> $target"

# Link the report binary next to the plugin source (bun runs TS directly).
bin_dir="${EMBER_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$bin_dir"
ln -sf "$here/gain.ts" "$bin_dir/ember"
echo "cli -> $bin_dir/ember   (run: ember gain  ·  ember discover)"
echo
echo "Add the plugin, then restart opencode; verify with:"
echo "  opencode debug config | grep -A2 -E '\"keepwarm\"|\"ember\"'"
echo "  opencode debug config | grep -A3 ember | grep '\"ember\"'"
