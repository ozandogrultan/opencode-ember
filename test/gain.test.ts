import { describe, expect, it } from "bun:test"
import { render, fmtUsd, main } from "../gain"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const days = {
  "2026-09-20": { pings: 120, read: 60_000_000, pingUsd: 0.6, keptUsd: 6, colds: 4, coldUsd: 2, warmMs: 480_000 },
  "2026-09-21": { colds: 1, coldUsd: 0.5 },
  "2026-09-22": { colds: 0, coldUsd: 0 },
}

describe("ember gain CLI", () => {
  it("renders cold-write totals and a per-day table", () => {
    const out = render(days as any, false)
    expect(out).toContain("Ember Cold Writes (All Sessions)")
    expect(out).toContain("2026-09-20 → 2026-09-22 (3 days)")
    expect(out).toContain("Cold writes paid:   5 for $2.50")
    expect(out).toContain("Avg per cold write: $0.500")
    expect(out).toContain("By Day")
    expect(out).toContain("09-20  cold    4  cost    $2.00  ████████████")
    expect(out).toContain("09-21  cold    1  cost   $0.500  ███")
    expect(out).toContain("09-22  cold    0  cost   $0.000  ░░░░░░░░░░░░")
  })

  it("ignores heartbeat history left in the state file", () => {
    const out = render(days as any, false)
    for (const word of ["heartbeat", "ping", "kept", "Net saved", "yield", "Idle"]) {
      expect(out.toLowerCase()).not.toContain(word.toLowerCase())
    }
  })

  it("says so when there is no history yet", () => {
    expect(render({}, false)).toContain("no history yet")
  })

  it("formats helpers", () => {
    expect(fmtUsd(0.0005)).toBe("$0.001")
  })

  it("main() exits 0 on gain and discover, 1 on unknown subcommands", () => {
    const dir = mkdtempSync(join(tmpdir(), "ember-gain-"))
    const previous = process.env.EMBER_STATE_FILE
    process.env.EMBER_STATE_FILE = join(dir, "state.json")
    writeFileSync(process.env.EMBER_STATE_FILE, JSON.stringify({ version: 3, days }))
    try {
      expect(main(["discover"])).toBe(0)
      expect(main(["gain"])).toBe(0)
      expect(main(["nope"])).toBe(1)
    } finally {
      if (previous === undefined) delete process.env.EMBER_STATE_FILE
      else process.env.EMBER_STATE_FILE = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
