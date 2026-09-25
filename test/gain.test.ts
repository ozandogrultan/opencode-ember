import { describe, expect, it } from "bun:test"
import { render, fmtTok, fmtUsd, main } from "../gain"

const days = {
  "2026-09-20": { pings: 120, read: 60_000_000, pingUsd: 0.6, keptUsd: 6, colds: 1, coldUsd: 2, warmMs: 480_000 },
  "2026-09-21": { pings: 60, read: 30_000_000, pingUsd: 0.3, keptUsd: 3, colds: 0, coldUsd: 0, warmMs: 240_000 },
}

describe("ember gain CLI", () => {
  it("renders totals, a yield meter and a per-day table", () => {
    const out = render(days as any, false)
    expect(out).toContain("Ember Token Savings (All Sessions)")
    expect(out).toContain("2026-09-20 → 2026-09-21 (2 days)")
    expect(out).toContain("Warm heartbeats:    180")
    expect(out).toContain("Tokens kept warm:   90.0M")
    expect(out).toContain("Kept-warm value:    $9.00 (est. cold re-write price")
    expect(out).toContain("Net saved:          ≈ $6.10 (estimate)")
    expect(out).toContain("Warming yield:      ")
    expect(out).toContain("67.8%")
    expect(out).toContain("By Day")
    expect(out).toContain("09-21  pings   60  kept   30.0M  net    $2.70")
    expect(out).toContain("09-20  pings  120  kept   60.0M  net    $3.40")
    expect(out).toContain("cold ×1")
  })

  it("says so when there is no history yet", () => {
    expect(render({}, false)).toContain("no history yet")
  })

  it("formats helpers", () => {
    expect(fmtTok(90_400_000)).toBe("90.4M")
    expect(fmtUsd(0.0005)).toBe("$0.001")
  })

  it("main() exits 0 on gain and discover, 1 on unknown subcommands", () => {
    expect(main(["discover"])).toBe(0)
    expect(main(["gain"])).toBe(0)
    expect(main(["nope"])).toBe(1)
  })
})
