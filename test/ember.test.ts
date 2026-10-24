import { describe, expect, it, beforeEach, afterEach, setSystemTime, spyOn } from "bun:test"
import { EmberPlugin } from "../ember"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

describe("opencode-ember", () => {
  let tmpDir: string
  let stateFile: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ember-test-"))
    stateFile = join(tmpDir, "ember.json")
    process.env.EMBER_STATE_FILE = stateFile
  })

  afterEach(() => {
    delete process.env.EMBER_STATE_FILE
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("defaults guard to warn and does not throw on cold cache send", async () => {
    const toasts: any[] = []
    const mockClient = {
      tui: {
        showToast: async (opts: any) => {
          toasts.push(opts)
        },
      },
      session: {
        messages: async () => ({
          data: [
            {
              info: {
                role: "assistant",
                providerID: "anthropic",
                modelID: "claude-sonnet-4-5-20250929",
                tokens: { input: 1000, cache: { read: 55000, write: 0 } },
                time: { completed: Date.now() - 10 * 60 * 1000 },
              },
            },
            {
              info: {
                role: "user",
                agent: "build",
                model: { providerID: "anthropic", modelID: "claude-sonnet-4-5-20250929" },
              },
            },
          ],
        }),
      },
    }

    const plugin = await EmberPlugin({ client: mockClient } as any)
    const chatMessage = plugin["chat.message"]
    expect(chatMessage).toBeDefined()

    const input = { sessionID: "test-session" }
    const output = { parts: [{ type: "text", text: "Hello world" }] } as any

    await expect(chatMessage!(input, output)).resolves.toBeUndefined()

    expect(toasts.length).toBe(1)
    expect(toasts[0].body.variant).toBe("warning")
    expect(toasts[0].body.message).toContain("the prompt cache went cold")
    expect(toasts[0].body.message).toContain("Sending anyway")
  })

  it("handles guard refuse mode when explicitly set", async () => {
    writeFileSync(stateFile, JSON.stringify({ version: 3, guard: "refuse", days: {} }))

    const toasts: any[] = []
    const mockClient = {
      tui: {
        showToast: async (opts: any) => {
          toasts.push(opts)
        },
      },
      session: {
        messages: async () => ({
          data: [
            {
              info: {
                role: "assistant",
                providerID: "anthropic",
                modelID: "claude-sonnet-4-5-20250929",
                tokens: { input: 1000, cache: { read: 55000, write: 0 } },
                time: { completed: Date.now() - 10 * 60 * 1000 },
              },
            },
            {
              info: {
                role: "user",
                agent: "build",
                model: { providerID: "anthropic", modelID: "claude-sonnet-4-5-20250929" },
              },
            },
          ],
        }),
      },
    }

    const plugin = await EmberPlugin({ client: mockClient } as any)
    const chatMessage = plugin["chat.message"]
    const chatParams = plugin["chat.params"]
    expect(chatMessage).toBeDefined()
    expect(chatParams).toBeDefined()

    const input = { sessionID: "test-session-refuse" }
    const output = { parts: [{ type: "text", text: "Hello refuse" }] } as any

    await expect(chatMessage!(input, output)).resolves.toBeUndefined()
    expect(toasts.length).toBe(1)
    expect(toasts[0].body.message).toContain("the prompt cache went cold")
    expect(toasts[0].body.message).toContain("Prompt blocked by ember guard refuse")

    await expect(chatParams!({ sessionID: "test-session-refuse" } as any, {} as any)).rejects.toThrow(
      "Prompt blocked by ember guard refuse",
    )
  })

  it("supports /ember guard block as an alias for refuse", async () => {
    const plugin = await EmberPlugin({ client: { tui: { showToast: async () => {} } } } as any)
    const cmd = plugin["command.execute.before"]
    expect(cmd).toBeDefined()

    const input = { command: "ember", sessionID: "s1", arguments: "guard block" }
    const output = { parts: [] } as any
    await expect(cmd!(input, output)).rejects.toThrow("ember guard refuse")
  })

  it("does not warn if context is small or cache is warm", async () => {
    const toasts: any[] = []
    const mockClient = {
      tui: { showToast: async (opts: any) => toasts.push(opts) },
      session: {
        messages: async () => ({
          data: [
            {
              info: {
                role: "assistant",
                providerID: "anthropic",
                modelID: "claude-sonnet-4-5-20250929",
                tokens: { input: 1000, cache: { read: 5000, write: 0 } },
                time: { completed: Date.now() - 10 * 60 * 1000 },
              },
            },
            {
              info: { role: "user", agent: "build", model: { providerID: "anthropic", modelID: "claude-sonnet-4-5-20250929" } },
            },
          ],
        }),
      },
    }

    const plugin = await EmberPlugin({ client: mockClient } as any)
    const chatMessage = plugin["chat.message"]

    const input = { sessionID: "test-small-ctx" }
    const output = { parts: [{ type: "text", text: "Hello" }] } as any

    await expect(chatMessage!(input, output)).resolves.toBeUndefined()
    expect(toasts.length).toBe(0)
  })

  it("gracefully formats warning for models without pricing", async () => {
    const toasts: any[] = []
    const mockClient = {
      tui: { showToast: async (opts: any) => toasts.push(opts) },
      session: {
        messages: async () => ({
          data: [
            {
              info: {
                role: "assistant",
                providerID: "custom-provider",
                modelID: "unpriced-custom-model",
                tokens: { input: 1000, cache: { read: 120000, write: 0 } },
                time: { completed: Date.now() - 10 * 60 * 1000 },
              },
            },
            {
              info: { role: "user", agent: "build", model: { providerID: "custom-provider", modelID: "unpriced-custom-model" } },
            },
          ],
        }),
      },
    }

    const plugin = await EmberPlugin({ client: mockClient } as any)
    const chatMessage = plugin["chat.message"]

    const input = { sessionID: "test-unpriced" }
    const output = { parts: [{ type: "text", text: "Hello custom" }] } as any

    await expect(chatMessage!(input, output)).resolves.toBeUndefined()
    expect(toasts.length).toBe(1)
    expect(toasts[0].body.message).toContain("121,000 tokens.")
    expect(toasts[0].body.message).not.toContain("n/a")
    expect(toasts[0].body.message).toContain("Sending anyway")
  })

  const silentClient = {
    tui: { showToast: async () => {} },
    session: { messages: async () => ({ data: [] }) },
  }

  const coldClient = (minutesAgo: number) => ({
    tui: { showToast: async () => {} },
    session: {
      messages: async () => ({
        data: [
          {
            info: {
              role: "assistant",
              providerID: "anthropic",
              modelID: "claude-sonnet-4-5-20250929",
              tokens: { input: 1000, cache: { read: 60000, write: 0 } },
              time: { completed: Date.now() - minutesAgo * 60 * 1000 },
            },
          },
          { info: { role: "user", agent: "build", model: { providerID: "anthropic", modelID: "claude-sonnet-4-5-20250929" } } },
        ],
      }),
    },
  })

  const stepFinish = (sessionID: string, write: number) =>
    ({
      event: {
        type: "message.part.updated",
        properties: {
          part: { type: "step-finish", sessionID, tokens: { input: 10, output: 5, cache: { read: 0, write } } },
        },
      },
    }) as any

  const today = () => new Date().toISOString().slice(0, 10)

  it("records a cold write in today's bucket after a guarded send", async () => {
    const plugin = await EmberPlugin({ client: coldClient(10) } as any)
    await plugin["chat.message"]!({ sessionID: "cold" }, { parts: [{ type: "text", text: "Hello" }] } as any)
    await plugin.event!(stepFinish("cold", 61000))

    const store = JSON.parse(readFileSync(stateFile, "utf8"))
    expect(store.days[today()].colds).toBe(1)
    expect(store.days[today()].coldUsd).toBeCloseTo((61000 * 3.75) / 1e6, 6)
  })

  it("does not write state for Ghost's temporary sessions", async () => {
    const plugin = await EmberPlugin({ client: {
      tui: { showToast: async () => {} },
      session: {
        get: async () => ({ data: { title: "ghost-hidden" } }),
        messages: async () => { throw new Error("helper session should not hydrate") },
      },
    } } as any)

    await plugin["chat.message"]!({ sessionID: "ghost-helper" }, { parts: [{ type: "text", text: "Suggest a reply" }] } as any)
    expect(existsSync(stateFile)).toBe(false)
  })

  it("does not write state for subagent sessions", async () => {
    const plugin = await EmberPlugin({ client: {
      tui: { showToast: async () => {} },
      session: {
        get: async () => ({ data: { title: "explore", parentID: "root" } }),
        messages: async () => { throw new Error("subagent session should not hydrate") },
      },
    } } as any)

    await plugin["chat.message"]!({ sessionID: "child" }, { parts: [{ type: "text", text: "Search" }] } as any)
    expect(existsSync(stateFile)).toBe(false)
  })

  it("points /ember gain at the CLI binary", async () => {
    const plugin = await EmberPlugin({ client: silentClient } as any)
    const cmd = plugin["command.execute.before"]
    await expect(cmd!({ command: "ember", sessionID: "g", arguments: "gain" }, { parts: [] } as any))
      .rejects.toThrow("ember gain moved to a terminal binary — run `ember gain` in a shell")
  })

  it("config hook registers only /ember and never touches input.provider", async () => {
    const plugin = await EmberPlugin({ client: silentClient } as any)
    const configHook = plugin.config
    expect(configHook).toBeDefined()

    const cfg: any = {
      command: {},
      provider: {
        "google-vertex": { options: { location: "global" } },
      },
    }

    await configHook!(cfg)
    expect(Object.keys(cfg.command)).toEqual(["ember"])

    // Must NEVER inject unconfigured providers into cfg.provider!
    expect(Object.keys(cfg.provider)).toEqual(["google-vertex"])
    expect(cfg.provider["google-vertex"].options.fetch).toBeUndefined()
  })

  it("ignores /keepwarm", async () => {
    const plugin = await EmberPlugin({ client: silentClient } as any)
    await expect(plugin["command.execute.before"]!(
      { command: "keepwarm", sessionID: "k", arguments: "30m" }, { parts: [] } as any,
    )).resolves.toBeUndefined()
    expect(existsSync(stateFile)).toBe(false)
  })

  it("shows the card without keepwarm or break-even lines", async () => {
    const plugin = await EmberPlugin({ client: silentClient } as any)
    const error = await plugin["command.execute.before"]!(
      { command: "ember", sessionID: "card", arguments: "" }, { parts: [] } as any,
    ).catch((e: Error) => e)
    expect(error.message).toContain("ember: warm")
    expect(error.message).toContain("guard: warn")
    expect(error.message).not.toContain("keepwarm")
    expect(error.message).not.toContain("break-even")
  })

  it("upgrades a legacy store to version 3 and keeps its history", async () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 2,
      guard: "warn",
      always: true,
      sessions: { legacy: { deadline: Date.now() + 10000, every: 240000, ttl: 300000 } },
      days: { "2026-09-30": { pings: 5, read: 100, pingUsd: 0.1, keptUsd: 1, colds: 2, coldUsd: 0.4, warmMs: 100 } },
    }))

    const plugin = await EmberPlugin({ client: silentClient } as any)
    await plugin["command.execute.before"]!(
      { command: "ember", sessionID: "s", arguments: "guard warn" },
      { parts: [] } as any,
    ).catch(() => {})

    const store = JSON.parse(readFileSync(stateFile, "utf8"))
    expect(store.version).toBe(3)
    expect(store.days["2026-09-30"]).toEqual({ pings: 5, read: 100, pingUsd: 0.1, keptUsd: 1, colds: 2, coldUsd: 0.4, warmMs: 100 })
  })

  it("never arms anything from a stored always flag or session window", async () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 3,
      guard: "warn",
      always: true,
      sessions: { s1: { deadline: Date.now() + 60_000, every: 1000, ttl: 300000, continuous: true } },
      days: {},
    }))
    const real = globalThis.setTimeout
    let timers = 0
    ;(globalThis as any).setTimeout = (...args: any[]) => {
      timers++
      return (real as any)(...args)
    }
    try {
      const plugin = await EmberPlugin({ client: coldClient(1) } as any)
      await plugin["chat.message"]!({ sessionID: "s1" }, { parts: [{ type: "text", text: "Hi" }] } as any)
      await plugin.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } } as any)
      expect(timers).toBe(0)
    } finally {
      ;(globalThis as any).setTimeout = real
    }
  })

  it("preserves unknown top-level and per-day fields across a write", async () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 3,
      guard: "warn",
      future: { nested: [1, 2] },
      days: {
        [today()]: { colds: 1, coldUsd: 0.1, extra: "kept", pings: 3 },
        "2026-01-01": { colds: 0, coldUsd: 0, other: true },
      },
    }))

    const plugin = await EmberPlugin({ client: coldClient(10) } as any)
    await plugin["chat.message"]!({ sessionID: "x" }, { parts: [{ type: "text", text: "Hello" }] } as any)
    await plugin.event!(stepFinish("x", 1000))

    const store = JSON.parse(readFileSync(stateFile, "utf8"))
    expect(store.future).toEqual({ nested: [1, 2] })
    expect(store.days["2026-01-01"].other).toBe(true)
    expect(store.days[today()].extra).toBe("kept")
    expect(store.days[today()].pings).toBe(3)
    expect(store.days[today()].colds).toBe(2)
  })

  it("waits for a state lock held longer than 500 milliseconds", async () => {
    const lock = `${stateFile}.lock`
    mkdirSync(lock)
    const holder = Bun.spawn(["bun", "-e", `
      import { rmSync } from "node:fs"
      setTimeout(() => rmSync(process.argv[1], { recursive: true }), 1000)
    `, lock], { stdout: "ignore", stderr: "pipe" })
    const plugin = await EmberPlugin({ client: silentClient } as any)
    try {
      await expect(plugin["command.execute.before"]!(
        { command: "ember", sessionID: "waiting", arguments: "guard refuse" },
        { parts: [] } as any,
      )).rejects.toThrow("ember guard refuse")
      expect(existsSync(lock)).toBe(false)
      expect(JSON.parse(readFileSync(stateFile, "utf8")).guard).toBe("refuse")
    } finally {
      expect(await holder.exited).toBe(0)
    }
  })

  it("does not write state when lock acquisition times out", async () => {
    const stored = JSON.stringify({ version: 3, guard: "warn", days: {} })
    writeFileSync(stateFile, stored)
    const lock = `${stateFile}.lock`
    mkdirSync(lock)
    const plugin = await EmberPlugin({ client: silentClient } as any)
    const now = Date.now()
    const clock = spyOn(Date, "now")
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(now)
      .mockReturnValue(now + 6000)
    try {
      await expect(plugin["command.execute.before"]!(
        { command: "ember", sessionID: "timeout", arguments: "guard refuse" },
        { parts: [] } as any,
      )).rejects.toThrow("ember guard refuse")
      expect(readFileSync(stateFile, "utf8")).toBe(stored)
      expect(existsSync(lock)).toBe(true)
    } finally {
      clock.mockRestore()
    }
  })

  it("keeps every cold write when several processes write the state file at once", async () => {
    const script = join(tmpDir, "writer.ts")
    writeFileSync(script, `
      import { EmberPlugin } from ${JSON.stringify(join(import.meta.dir, "..", "ember"))}
      const client = {
        tui: { showToast: async () => {} },
        session: {
          messages: async () => ({
            data: [
              { info: { role: "assistant", providerID: "anthropic", modelID: "claude-sonnet-4-5-20250929",
                tokens: { input: 1000, cache: { read: 60000, write: 0 } }, time: { completed: Date.now() - 10 * 60 * 1000 } } },
              { info: { role: "user", agent: "build", model: { providerID: "anthropic", modelID: "claude-sonnet-4-5-20250929" } } },
            ],
          }),
        },
      }
      const plugin = await EmberPlugin({ client } as any)
      for (let i = 0; i < 15; i++) {
        const sessionID = process.argv[2] + "-" + i
        await plugin["chat.message"]!({ sessionID }, { parts: [{ type: "text", text: "Hi" }] } as any)
        await plugin.event!({ event: { type: "message.part.updated", properties: { part: {
          type: "step-finish", sessionID, tokens: { input: 1, output: 1, cache: { read: 0, write: 1000 } } } } } } as any)
      }
    `)
    const procs = ["a", "b", "c", "d", "e", "f"].map((id) =>
      Bun.spawn(["bun", script, id], { env: { ...process.env, EMBER_STATE_FILE: stateFile }, stdout: "ignore", stderr: "ignore" }),
    )
    await Promise.all(procs.map((p) => p.exited))
    expect(JSON.parse(readFileSync(stateFile, "utf8")).days[today()].colds).toBe(90)
  })
})
