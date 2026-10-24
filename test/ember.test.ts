import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fmtUsd, priceFromCost } from "../src/core.ts"
import { assistant, harness, SONNET, type Options } from "./harness.ts"

const MIN = 60 * 1000

const history = (minutesAgo: number, read = 60000) => [
  assistant(SONNET, { input: 1000, read }, minutesAgo * MIN),
  { type: "user" },
]

describe("opencode-ember", () => {
  let tmpDir: string
  let stateFile: string
  const open: Array<{ close: () => Promise<void> }> = []

  const start = async (options: Options = {}) => {
    const h = await harness(options)
    open.push(h)
    return h
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ember-test-"))
    stateFile = join(tmpDir, "ember.json")
    process.env.EMBER_STATE_FILE = stateFile
  })

  afterEach(async () => {
    await Promise.all(open.splice(0).map((h) => h.close()))
    delete process.env.EMBER_STATE_FILE
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const today = () => new Date().toISOString().slice(0, 10)
  const stored = () => JSON.parse(readFileSync(stateFile, "utf8"))

  for (const mode of ["refuse", "warn"] as const) {
    it(`reports a failed ${mode} save and stays fail-closed until a successful retry`, async () => {
      writeFileSync(stateFile, JSON.stringify({ version: 3, guard: mode === "refuse" ? "warn" : "refuse", days: {} }))
      const h = await start({ context: history(10) })
      const blocked = `${stateFile}.${process.pid}.tmp`
      mkdirSync(blocked)
      await expect(h.command("s", `guard ${mode}`)).rejects.toThrow("could not save guard settings")
      expect(h.notices.at(-1)?.variant).toBe("error")
      expect(h.notices.at(-1)?.message).not.toBe(`ember guard ${mode}`)
      await expect(h.command("s", "")).rejects.toThrow("could not save guard settings")
      expect(h.notices.at(-1)?.message).not.toContain("cold rewrite")
      await expect(h.send("s")).rejects.toThrow("Prompt blocked by ember guard refuse")
      expect(stored().guard).toBe(mode === "refuse" ? "warn" : "refuse")
      rmSync(blocked, { recursive: true })
      await h.command("s", "guard warn")
      await expect(h.send("s")).resolves.toBeUndefined()
      expect(stored().guard).toBe("warn")
    })
  }

  it("does not fail a normal conversation when history cannot be saved", async () => {
    const h = await start({ context: history(10) })
    mkdirSync(`${stateFile}.${process.pid}.tmp`)
    await expect(h.send("s")).resolves.toBeUndefined()
    await expect(h.stepEnded("s", 1000)).resolves.toBeUndefined()
    expect(existsSync(stateFile)).toBe(false)
  })

  it("defaults guard to warn and sends a cold cache with a notice", async () => {
    const h = await start({ context: history(10, 55000) })
    await expect(h.send("s")).resolves.toBeUndefined()

    expect(h.notices.length).toBe(1)
    expect(h.notices[0].variant).toBe("warning")
    expect(h.notices[0].sessionID).toBe("s")
    expect(h.notices[0].message).toContain("the prompt cache went cold")
    expect(h.notices[0].message).toContain("Sending anyway")
  })

  it("blocks the send when guard is refuse and records nothing", async () => {
    writeFileSync(stateFile, JSON.stringify({ version: 3, guard: "refuse", days: {} }))
    const h = await start({ context: history(10, 55000) })

    await expect(h.send("s")).rejects.toThrow("Prompt blocked by ember guard refuse")
    await h.stepEnded("s", 61000)
    expect(JSON.parse(readFileSync(stateFile, "utf8")).days).toEqual({})
  })

  it("only guards the first step after a prompt, not tool-loop steps", async () => {
    writeFileSync(stateFile, JSON.stringify({ version: 3, guard: "refuse", days: {} }))
    const h = await start({ context: history(10) })

    await expect(h.send("s", SONNET, "tool")).resolves.toBeUndefined()
    expect(h.notices.length).toBe(0)
  })

  it("supports /ember guard block as an alias for refuse", async () => {
    const h = await start()
    await h.command("s1", "guard block")

    expect(h.notices[0].message).toBe("ember guard refuse")
    expect(stored().guard).toBe("refuse")
  })

  it("does not warn if context is small or cache is warm", async () => {
    const small = await start({ context: history(10, 5000) })
    await small.send("small")
    expect(small.notices.length).toBe(0)

    const warm = await start({ context: history(1) })
    await warm.send("warm")
    expect(warm.notices.length).toBe(0)
  })

  it("gracefully formats warning for models without pricing", async () => {
    const custom = { providerID: "custom-provider", id: "unpriced-custom-model" }
    const h = await start({ context: [assistant(custom, { input: 1000, read: 120000 }, 10 * MIN), { type: "user" }] })
    await h.send("s", custom)

    expect(h.notices.length).toBe(1)
    expect(h.notices[0].message).toContain("121,000 tokens.")
    expect(h.notices[0].message).not.toContain("n/a")
    expect(h.notices[0].message).toContain("Sending anyway")
  })

  it("prefers the rates the model reports and falls back to the table", async () => {
    const models = [
      {
        id: "claude-sonnet-4-5-20250929",
        modelID: "claude-sonnet-4-5-20250929",
        providerID: "anthropic",
        cost: [{ input: 1, output: 2, cache: { read: 0.5, write: 10 } }],
      },
    ]
    const reported = await start({ context: history(10), models })
    await reported.send("s")
    expect(reported.notices[0].message).toContain("at $10/MTok")

    const table = await start({ context: history(10), models: [{ ...models[0], cost: [] }] })
    await table.send("s")
    expect(table.notices[0].message).toContain("at $3.75/MTok")
  })

  it("picks the context tier that covers the rewrite", () => {
    const cost = [
      { output: 1, cache: { read: 1, write: 2 } },
      { tier: { type: "context" as const, size: 200000 }, output: 1, cache: { read: 1, write: 4 } },
    ]
    expect(priceFromCost(cost, 100000)).toEqual([1, 2, 1])
    expect(priceFromCost(cost, 300000)).toEqual([1, 4, 1])
    expect(priceFromCost([{ output: 1, cache: { read: 0, write: 0 } }], 100)).toBeNull()
  })

  it("records a cold write in today's bucket after a guarded send", async () => {
    const h = await start({ context: history(10) })
    await h.send("cold")
    await h.stepEnded("cold", 61000)

    expect(stored().days[today()].colds).toBe(1)
    expect(stored().days[today()].coldUsd).toBeCloseTo((61000 * 3.75) / 1e6, 6)
  })

  it("records nothing for a warm step or when no cache was written", async () => {
    const h = await start({ context: history(1) })
    await h.send("warm")
    await h.stepEnded("warm", 5000)
    expect(existsSync(stateFile)).toBe(false)

    const cold = await start({ context: history(10) })
    await cold.send("cold")
    await cold.stepEnded("cold", 0, 60000)
    expect(existsSync(stateFile)).toBe(false)
  })

  it("does not write state for Ghost's temporary sessions", async () => {
    const h = await start({
      get: () => ({ title: "ghost-hidden" }),
      context: [],
    })
    await h.send("ghost-helper")
    expect(existsSync(stateFile)).toBe(false)
    expect(h.notices.length).toBe(0)
  })

  it("does not track subagent sessions", async () => {
    const h = await start({ get: () => ({ title: "explore", parentID: "root" }), context: history(10) })
    await h.send("child")
    await h.stepEnded("child", 61000)
    expect(existsSync(stateFile)).toBe(false)
    expect(h.notices.length).toBe(0)
  })

  it("points /ember gain at the CLI binary", async () => {
    const h = await start()
    await h.command("g", "gain")
    expect(h.notices[0].message).toBe("ember gain moved to a terminal binary — run `ember gain` in a shell")
  })

  it("registers only the /ember command and a context hook", async () => {
    const h = await start()
    expect(h.commands.map((c) => c.name)).toEqual(["ember"])
  })

  it("shows the card without keepwarm or break-even lines", async () => {
    const h = await start()
    await h.command("card", "")
    const { message, variant } = h.notices[0]
    expect(variant).toBe("info")
    expect(message).toContain("ember: warm")
    expect(message).toContain("guard: warn")
    expect(message).not.toContain("keepwarm")
    expect(message).not.toContain("break-even")
  })

  it("prints the same price in the guard text and the card", async () => {
    const haiku = { providerID: "anthropic", id: "claude-haiku-4-5" }
    const h = await start({ context: [assistant(haiku, { input: 0, read: 60000 }, 10 * MIN), { type: "user" }] })
    await h.send("s", haiku)
    await h.stepEnded("s", 60000)
    await h.command("s", "")

    expect(fmtUsd(0.075)).toBe("$0.07")
    expect(h.notices[0].message).toContain("= $0.07")
    expect(h.notices[1].message).toContain("cold writes this session: 1 — $0.07")
  })

  it("rounds small, mid and large amounts", () => {
    expect(fmtUsd(null)).toBe("$0.00")
    expect(fmtUsd(0)).toBe("$0.00")
    expect(fmtUsd(0.0000003)).toBe("$0.000")
    expect(fmtUsd(0.0075)).toBe("$0.007")
    expect(fmtUsd(12.345)).toBe("$12.35")
    expect(fmtUsd(250.4)).toBe("$250")
  })

  it("seeds a session from its history and treats a compaction as warm", async () => {
    const h = await start({ context: history(10) })
    await h.command("c", "")
    expect(h.notices[0].message).toContain("ember: cold · context 61k tok")

    const compacted = await start({ context: [assistant(SONNET, { input: 1, read: 60000 }, 10 * MIN), { type: "compaction" }] })
    await compacted.send("s")
    expect(compacted.notices.length).toBe(0)
  })

  it("resets a session on compaction and on revert, and forgets it on delete", async () => {
    const h = await start({ context: history(10) })
    await h.send("s")
    await h.emit("session.compaction.ended", { sessionID: "s" })
    await h.send("s")
    expect(h.notices.length).toBe(1)

    await h.emit("session.revert.committed", { sessionID: "s" })
    await h.command("s", "")
    expect(h.notices[1].message).toContain("context 0 tok")

    await h.emit("session.deleted", { sessionID: "s" })
    await h.command("s", "")
    expect(h.notices[2].message).toContain("context 61k tok")
  })

  it("upgrades a legacy store to version 3 and keeps its history", async () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        version: 2,
        guard: "warn",
        always: true,
        sessions: { legacy: { deadline: Date.now() + 10000, every: 240000, ttl: 300000 } },
        days: { "2026-09-30": { pings: 5, read: 100, pingUsd: 0.1, keptUsd: 1, colds: 2, coldUsd: 0.4, warmMs: 100 } },
      }),
    )

    const h = await start()
    await h.command("s", "guard warn")

    const store = stored()
    expect(store.version).toBe(3)
    expect(store.days["2026-09-30"]).toEqual({ pings: 5, read: 100, pingUsd: 0.1, keptUsd: 1, colds: 2, coldUsd: 0.4, warmMs: 100 })
  })

  it("never arms anything from a stored always flag or session window", async () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        version: 3,
        guard: "warn",
        always: true,
        sessions: { s1: { deadline: Date.now() + 60_000, every: 1000, ttl: 300000, continuous: true } },
        days: {},
      }),
    )
    const real = globalThis.setTimeout
    let timers = 0
    ;(globalThis as any).setTimeout = (...args: any[]) => {
      timers++
      return (real as any)(...args)
    }
    try {
      const h = await start({ context: history(1) })
      await h.send("s1")
      await h.emit("session.idle", { sessionID: "s1" })
      expect(timers).toBe(0)
    } finally {
      ;(globalThis as any).setTimeout = real
    }
  })

  it("preserves unknown top-level and per-day fields across a write", async () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        version: 3,
        guard: "warn",
        future: { nested: [1, 2] },
        days: {
          [today()]: { colds: 1, coldUsd: 0.1, extra: "kept", pings: 3 },
          "2026-01-01": { colds: 0, coldUsd: 0, other: true },
        },
      }),
    )

    const h = await start({ context: history(10) })
    await h.send("x")
    await h.stepEnded("x", 1000)

    const store = stored()
    expect(store.future).toEqual({ nested: [1, 2] })
    expect(store.days["2026-01-01"].other).toBe(true)
    expect(store.days[today()].extra).toBe("kept")
    expect(store.days[today()].pings).toBe(3)
    expect(store.days[today()].colds).toBe(2)
  })

  it("waits for a state lock held longer than 500 milliseconds", async () => {
    const lock = `${stateFile}.lock`
    mkdirSync(lock)
    const holder = Bun.spawn(
      [
        "bun",
        "-e",
        `
      import { rmSync } from "node:fs"
      setTimeout(() => rmSync(process.argv[1], { recursive: true }), 1000)
    `,
        lock,
      ],
      { stdout: "ignore", stderr: "pipe" },
    )
    const h = await start()
    try {
      await h.command("waiting", "guard refuse")
      expect(existsSync(lock)).toBe(false)
      expect(stored().guard).toBe("refuse")
    } finally {
      expect(await holder.exited).toBe(0)
    }
  })

  it("does not write state when lock acquisition times out", async () => {
    const before = JSON.stringify({ version: 3, guard: "warn", days: {} })
    writeFileSync(stateFile, before)
    const lock = `${stateFile}.lock`
    mkdirSync(lock)
    const h = await start()
    const now = Date.now()
    const clock = spyOn(Date, "now").mockReturnValueOnce(now).mockReturnValueOnce(now).mockReturnValue(now + 6000)
    try {
      await expect(h.command("timeout", "guard refuse")).rejects.toThrow("could not save guard settings")
      expect(readFileSync(stateFile, "utf8")).toBe(before)
      expect(existsSync(lock)).toBe(true)
    } finally {
      clock.mockRestore()
    }
  })

  it("keeps every cold write when several processes write the state file at once", async () => {
    const script = join(tmpDir, "writer.ts")
    writeFileSync(
      script,
      `
      import { assistant, harness } from ${JSON.stringify(join(import.meta.dir, "harness.ts"))}
      import { EmberPlugin } from ${JSON.stringify(join(import.meta.dir, "..", "ember.ts"))}
      const SONNET = { providerID: "anthropic", id: "claude-sonnet-4-5-20250929" }
      const h = await harness({ context: [assistant(SONNET, { input: 1000, read: 60000 }, 10 * 60 * 1000), { type: "user" }] })
      const v1 = await EmberPlugin({ client: {
        tui: { showToast: async () => {} },
        session: { messages: async () => ({ data: [{ info: {
          role: "assistant", providerID: SONNET.providerID, modelID: SONNET.id,
          tokens: { input: 1000, cache: { read: 60000, write: 0 } },
          time: { completed: Date.now() - 600000 },
        } }] }) },
      } } as any)
      for (let i = 0; i < 15; i++) {
        const sessionID = process.argv[2] + "-" + i
        if (i % 2) {
          await v1["chat.message"]({ sessionID }, { parts: [{ type: "text", text: "ping" }] })
          await v1.event({ event: { type: "message.part.updated", properties: { part: {
            type: "step-finish", sessionID, tokens: { input: 1000, cache: { read: 0, write: 1000 } },
          } } } })
        } else {
          await h.send(sessionID)
          await h.stepEnded(sessionID, 1000)
        }
      }
      await h.close()
    `,
    )
    const procs = ["a", "b", "c", "d", "e", "f"].map((id) =>
      Bun.spawn(["bun", script, id], { env: { ...process.env, EMBER_STATE_FILE: stateFile }, stdout: "ignore", stderr: "ignore" }),
    )
    expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0, 0, 0, 0, 0])
    expect(stored().days[today()].colds).toBe(90)
  })
})
