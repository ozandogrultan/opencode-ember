#!/usr/bin/env bun
// ember gain (alias: ember discover)
//
// Terminal report over the history the ember opencode plugin collects in its
// state file (daily buckets of keepwarm heartbeats and paid cold writes).
// Renders totals, a warming-yield meter and a per-day impact table in the
// spirit of `rtk gain`.
//
// All dollar figures are ESTIMATES built from the same hard-coded price table
// the plugin uses (`PRICES` in ember.ts). Models without a matching price row
// report $0.00 and understate the value columns; raw counters — heartbeats,
// tokens kept warm, idle time, cold-write counts — stay accurate. Delete the
// state file to reset history.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

type Day = {
  pings: number
  read: number
  pingUsd: number
  keptUsd: number
  colds: number
  coldUsd: number
  warmMs: number
}

const TABLE_DAYS = 21
const BAR_DAYS = 12
const METER_DAYS = 28

type Palette = { green: (s: string) => string; cyan: (s: string) => string; red: (s: string) => string; bold: (s: string) => string; dim: (s: string) => string }

const noColor: Palette = {
  green: (s) => s,
  cyan: (s) => s,
  red: (s) => s,
  bold: (s) => s,
  dim: (s) => s,
}

const ansi: Palette = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
}

export function fmtUsd(usd: number): string {
  return "$" + (usd >= 100 ? usd.toFixed(0) : usd >= 1 ? usd.toFixed(2) : usd.toFixed(3))
}

export function fmtTok(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1000 ? Math.round(n / 1000) + "k" : String(n)
}

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h > 0 ? `${h}h${String(m).padStart(2, " ")}m` : `${m}m`
}

const solid = (n: number): string => "█".repeat(Math.max(0, n))

export function render(days: Record<string, Day>, color: boolean): string {
  const palette = color && process.stdout.isTTY ? ansi : noColor
  const entries = Object.entries(days).sort(([a], [b]) => (a < b ? -1 : 1))
  if (entries.length === 0) {
    return "ember gain: no history yet — heartbeats and cold writes record as they happen"
  }
  let pings = 0, read = 0, pingUsd = 0, keptUsd = 0, colds = 0, coldUsd = 0, warmMs = 0
  for (const [, d] of entries) {
    pings += d.pings
    read += d.read
    pingUsd += d.pingUsd
    keptUsd += d.keptUsd
    colds += d.colds
    coldUsd += d.coldUsd
    warmMs += d.warmMs
  }
  const net = keptUsd - pingUsd - coldUsd
  const yieldPct = keptUsd > 0 ? net / keptUsd : 0
  const meterWidth = 28
  const filled = Math.max(0, Math.min(meterWidth, Math.round(Math.max(0, yieldPct) * meterWidth)))
  const lines = [
    palette.bold(palette.green(`Ember Token Savings (All Sessions)`)),
    `${entries[0][0]} → ${entries[entries.length - 1][0]} (${entries.length} ${entries.length === 1 ? "day" : "days"})`,
    "",
    `  Warm heartbeats:    ${pings.toLocaleString("en-US")}`,
    `  Tokens kept warm:   ${fmtTok(read)}`,
    `  Kept-warm value:    ${fmtUsd(keptUsd)} (est. cold re-write price of those reads)`,
    `  Ping spend:         ${fmtUsd(pingUsd)}${pings ? ` (avg ${fmtUsd(pingUsd / pings)}/ping)` : ""}`,
    `  Cold writes paid:   ${colds.toLocaleString("en-US")} for ${fmtUsd(coldUsd)}`,
    `  Net saved:          ${palette.bold(`≈ ${fmtUsd(net)}`)} (estimate)`,
    `  Warming yield:      ${palette.green(solid(filled))}${palette.dim("░".repeat(meterWidth - filled))} ${(yieldPct * 100).toFixed(1)}%`,
    `  Idle held warm:     ≈ ${fmtDuration(warmMs)}`,
    "",
  ]
  lines.push(palette.bold("By Day"))
  const recent = entries.slice(-TABLE_DAYS).reverse()
  const maxNet = Math.max(...recent.map(([, d]) => d.keptUsd - d.pingUsd - d.coldUsd), 1e-6)
  for (const [key, d] of recent) {
    const dayNet = d.keptUsd - d.pingUsd - d.coldUsd
    const bars = dayNet <= 0
      ? palette.dim("░".repeat(BAR_DAYS))
      : palette.cyan(solid(Math.max(1, Math.round((dayNet / maxNet) * BAR_DAYS))).padEnd(BAR_DAYS, " "))
    const coldNote = d.colds ? palette.red(` cold ×${d.colds}`) : ""
    lines.push(
      `  ${key.slice(5)}  pings ${String(d.pings).padStart(4)}  kept ${fmtTok(d.read).padStart(7)}  ` +
      `net ${fmtUsd(dayNet).padStart(8)}  ${bars}${coldNote}`
    )
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
      "ember gain               the historical savings report over the ember plugin's state file",
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
