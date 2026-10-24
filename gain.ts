#!/usr/bin/env bun
// ember gain (alias: ember discover)
//
// Terminal report over the history the ember opencode plugin collects in its
// state file (daily buckets of recorded cold writes). Renders totals and a
// per-day table in the spirit of `rtk gain`. Other fields in the buckets, such
// as heartbeat history from earlier versions, are left in the file and ignored.
//
// All dollar figures are ESTIMATES built from the same hard-coded price table
// the plugin uses (`PRICES` in ember.ts). Models without a matching price row
// report $0.00 and understate the cost column; cold-write counts stay
// accurate. Delete the state file to reset history.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

type Day = {
  colds: number
  coldUsd: number
}

const TABLE_DAYS = 21
const BAR_DAYS = 12

type Palette = { green: (s: string) => string; cyan: (s: string) => string; bold: (s: string) => string; dim: (s: string) => string }

const noColor: Palette = {
  green: (s) => s,
  cyan: (s) => s,
  bold: (s) => s,
  dim: (s) => s,
}

const ansi: Palette = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
}

export function fmtUsd(usd: number): string {
  return "$" + (usd >= 100 ? usd.toFixed(0) : usd >= 1 ? usd.toFixed(2) : usd.toFixed(3))
}

const solid = (n: number): string => "█".repeat(Math.max(0, n))

export function render(days: Record<string, Day>, color: boolean): string {
  const palette = color && process.stdout.isTTY ? ansi : noColor
  const entries = Object.entries(days).sort(([a], [b]) => (a < b ? -1 : 1))
  if (entries.length === 0) {
    return "ember gain: no history yet — cold writes record as they happen"
  }
  let colds = 0, coldUsd = 0
  for (const [, d] of entries) {
    colds += d.colds || 0
    coldUsd += d.coldUsd || 0
  }
  const lines = [
    palette.bold(palette.green(`Ember Cold Writes (All Sessions)`)),
    `${entries[0][0]} → ${entries[entries.length - 1][0]} (${entries.length} ${entries.length === 1 ? "day" : "days"})`,
    "",
    `  Cold writes paid:   ${colds.toLocaleString("en-US")} for ${fmtUsd(coldUsd)}`,
    `  Avg per cold write: ${colds ? fmtUsd(coldUsd / colds) : fmtUsd(0)}`,
    "",
  ]
  lines.push(palette.bold("By Day"))
  const recent = entries.slice(-TABLE_DAYS).reverse()
  const maxColds = Math.max(...recent.map(([, d]) => d.colds || 0), 1)
  for (const [key, d] of recent) {
    const n = d.colds || 0
    const bars = n <= 0
      ? palette.dim("░".repeat(BAR_DAYS))
      : palette.cyan(solid(Math.max(1, Math.round((n / maxColds) * BAR_DAYS))).padEnd(BAR_DAYS, " "))
    lines.push(`  ${key.slice(5)}  cold ${String(n).padStart(4)}  cost ${fmtUsd(d.coldUsd || 0).padStart(8)}  ${bars}`)
  }
  return lines.join("\n")
}

export function readDays(): Record<string, Day> {
  const file = process.env.EMBER_STATE_FILE ?? join(homedir(), ".local", "share", "opencode", "ember.json")
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    return parsed.days && typeof parsed.days === "object" ? parsed.days : {}
  } catch {
    return {}
  }
}

const usage = (code: 0 | 1): number => {
  process.stdout.write(
    [
      "ember gain               the cold-write report over the ember plugin's state file",
      "ember discover           alias for ember gain",
      "ember gain --json        dump the raw daily buckets",
      "",
      "State: $EMBER_STATE_FILE or ~/.local/share/opencode/ember.json",
    ].join("\n") + "\n",
  )
  return code
}

export function main(args: Array<string>): number {
  const json = args.includes("--json")
  const rest = args.filter((a) => a !== "--json")
  const sub = rest[0] ?? "gain"
  if (sub !== "gain" && sub !== "discover") {
    usage(1)
    return 1
  }
  if (json) {
    process.stdout.write(JSON.stringify(readDays(), null, 2) + "\n")
    return 0
  }
  process.stdout.write(render(readDays(), true) + "\n")
  return 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
