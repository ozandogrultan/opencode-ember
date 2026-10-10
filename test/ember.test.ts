import { describe, expect, it, beforeEach, afterEach, setSystemTime, spyOn } from "bun:test"
import { EmberPlugin, parseDuration } from "../ember"
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

  it("parses durations correctly", () => {
    expect(parseDuration("6h")).toBe(6 * 60 * 60 * 1000)
    expect(parseDuration("90m")).toBe(90 * 60 * 1000)
    expect(parseDuration("2h30m")).toBe((2 * 60 + 30) * 60 * 1000)
    expect(parseDuration("invalid")).toBeNull()
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
    writeFileSync(stateFile, JSON.stringify({ version: 3, guard: "refuse", always: false, sessions: {}, days: {} }))

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

  it("does not arm keepwarm for Ghost's temporary sessions", async () => {
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

  it("points /ember gain at the CLI binary", async () => {
    const plugin = await EmberPlugin({ client: silentClient } as any)
    const cmd = plugin["command.execute.before"]
    await expect(cmd!({ command: "ember", sessionID: "g", arguments: "gain" }, { parts: [] } as any))
      .rejects.toThrow("ember gain moved to a terminal binary — run `ember gain` in a shell")
  })

  it("config hook registers commands and never touches input.provider", async () => {
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
    expect(cfg.command.keepwarm).toBeDefined()
    expect(cfg.command.ember).toBeDefined()

    // Must NEVER inject unconfigured providers into cfg.provider!
    expect(Object.keys(cfg.provider)).toEqual(["google-vertex"])
    expect(cfg.provider.anthropic).toBeUndefined()
    expect(cfg.provider.openai).toBeUndefined()
    expect(cfg.provider["openai-compatible"]).toBeUndefined()
    expect(cfg.provider["google-vertex"].options.fetch).toBeUndefined()
  })

  it("upgrades a legacy store cleanly to version 3 with always disabled", async () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 2,
      guard: "warn",
      always: true,
      sessions: { legacy: { deadline: Date.now() + 10000, every: 240000, ttl: 300000 } },
      days: { "2026-09-30": { pings: 5, read: 100, pingUsd: 0.1, keptUsd: 1, colds: 0, coldUsd: 0, warmMs: 100 } },
    }))

    const plugin = await EmberPlugin({ client: silentClient } as any)
    await plugin["command.execute.before"]!(
      { command: "ember", sessionID: "s", arguments: "guard warn" },
      { parts: [] } as any,
    ).catch(() => {})

    const store = JSON.parse(readFileSync(stateFile, "utf8"))
    expect(store.version).toBe(3)
    expect(store.always).toBe(false)
    expect(store.sessions.legacy).toBeUndefined()
    expect(store.days["2026-09-30"].pings).toBe(5)
  })

  it("stays off when a stamped store was turned off", async () => {
    writeFileSync(stateFile, JSON.stringify({ version: 3, guard: "warn", always: false, sessions: {}, days: {} }))

    const plugin = await EmberPlugin({ client: silentClient } as any)
    await plugin["chat.message"]!({ sessionID: "opted-out" }, { parts: [{ type: "text", text: "Hello" }] } as any)

    const store = JSON.parse(readFileSync(stateFile, "utf8"))
    expect(store.sessions["opted-out"]).toBeUndefined()
  })

  it("keeps another session's window when two instances share the state file", async () => {
    const a = await EmberPlugin({ client: silentClient } as any)
    const b = await EmberPlugin({ client: silentClient } as any)

    await expect(a["command.execute.before"]!(
      { command: "keepwarm", sessionID: "proc-a", arguments: "30m" }, { parts: [] } as any,
    )).rejects.toThrow("keepwarm")

    await expect(b["command.execute.before"]!(
      { command: "keepwarm", sessionID: "proc-b", arguments: "30m" }, { parts: [] } as any,
    )).rejects.toThrow("keepwarm")

    const store = JSON.parse(readFileSync(stateFile, "utf8"))
    expect(store.sessions["proc-a"]).toBeDefined()
    expect(store.sessions["proc-b"]).toBeDefined()

    await a.dispose!()
    await b.dispose!()
  })

  const captureTimers = () => {
    const real = globalThis.setTimeout
    const timers: Array<{ delay: number; fn: () => void }> = []
    ;(globalThis as any).setTimeout = (fn: () => void, delay: number) => {
      timers.push({ delay, fn })
      return { unref() {} } as any
    }
    return { timers, restore: () => ((globalThis as any).setTimeout = real) }
  }

  const priorTurn = (minutesAgo: number) => ({
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

  it("adopts a session that is only known from shared state when it goes idle", async () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 3, guard: "warn", always: false,
      sessions: { orphan: { deadline: Date.now() + 30 * 60 * 1000, every: 240000, ttl: 300000, continuous: false } },
      days: {},
    }))
    const clock = captureTimers()
    const plugin = await EmberPlugin({ client: priorTurn(1) } as any)
    try {
      await plugin.event!({ event: { type: "session.idle", properties: { sessionID: "orphan" } } } as any)
      expect(clock.timers.length).toBe(1)
    } finally {
      clock.restore()
      await plugin.dispose!()
    }
  })

  it("adopts the always setting another process changed", async () => {
    writeFileSync(stateFile, JSON.stringify({ version: 3, guard: "warn", always: false, sessions: {}, days: {} }))
    const a = await EmberPlugin({ client: silentClient } as any)
    const b = await EmberPlugin({ client: silentClient } as any)
    try {
      await expect(a["command.execute.before"]!(
        { command: "keepwarm", sessionID: "a1", arguments: "always" }, { parts: [] } as any,
      )).rejects.toThrow("keepwarm")
      await b["chat.message"]!({ sessionID: "b1" }, { parts: [{ type: "text", text: "Hi" }] } as any)
      const store = JSON.parse(readFileSync(stateFile, "utf8"))
      expect(store.always).toBe(true)
      expect(store.sessions.b1).toBeDefined()
    } finally {
      await a.dispose!()
      await b.dispose!()
    }
  })

  it("does not undo another process's /keepwarm off", async () => {
    const a = await EmberPlugin({ client: silentClient } as any)
    const b = await EmberPlugin({ client: silentClient } as any)
    try {
      await expect(a["command.execute.before"]!(
        { command: "keepwarm", sessionID: "a1", arguments: "off" }, { parts: [] } as any,
      )).rejects.toThrow("keepwarm")
      await b["chat.message"]!({ sessionID: "b1" }, { parts: [{ type: "text", text: "Hi" }] } as any)
      const store = JSON.parse(readFileSync(stateFile, "utf8"))
      expect(store.always).toBe(false)
      expect(store.sessions.b1).toBeUndefined()
    } finally {
      await a.dispose!()
      await b.dispose!()
    }
  })

  const settle = () => new Promise((r) => setImmediate(r))

  it("ping fails closed without provider calls, forks, prompts, or fake counters", async () => {
    const sessionCalls: string[] = []
    const client = {
      ...priorTurn(1),
      session: {
        ...priorTurn(1).session,
        status: async () => {
          sessionCalls.push("status")
          return { data: {} }
        },
        fork: async () => {
          sessionCalls.push("fork")
          return { data: { id: "f1" } }
        },
        prompt: async () => {
          sessionCalls.push("prompt")
          return { data: {} }
        },
        delete: async () => {
          sessionCalls.push("delete")
          return { data: {} }
        },
      },
    }

    const clock = captureTimers()
    const plugin = await EmberPlugin({ client } as any)
    try {
      await expect(plugin["command.execute.before"]!(
        { command: "keepwarm", sessionID: "failclosed", arguments: "30m" },
        { parts: [] } as any,
      )).rejects.toThrow("keepwarm")

      expect(clock.timers.length).toBe(1)
      clock.timers[0].fn()
      await settle()

      expect(sessionCalls).toEqual([])
      const store = JSON.parse(readFileSync(stateFile, "utf8"))
      expect(store.sessions.failclosed).toBeUndefined()
      const today = new Date().toISOString().slice(0, 10)
      expect(store.days[today]?.pings ?? 0).toBe(0)
    } finally {
      clock.restore()
      await plugin.dispose!()
    }
  })

  it("does not arm subagent sessions", async () => {
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

  it("does not adopt a persisted subagent session when it goes idle", async () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 3, guard: "warn", always: false,
      sessions: { child: { deadline: Date.now() + 30 * 60 * 1000, every: 240000, ttl: 300000, continuous: false } },
      days: {},
    }))
    const clock = captureTimers()
    const plugin = await EmberPlugin({ client: {
      ...priorTurn(1),
      session: { ...priorTurn(1).session, get: async () => ({ data: { parentID: "root" } }) },
    } } as any)
    try {
      await plugin.event!({ event: { type: "session.idle", properties: { sessionID: "child" } } } as any)
      expect(clock.timers.length).toBe(0)
      expect(JSON.parse(readFileSync(stateFile, "utf8")).sessions.child).toBeUndefined()
    } finally {
      clock.restore()
      await plugin.dispose!()
    }
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
      await plugin.dispose!()
      expect(await holder.exited).toBe(0)
    }
  })

  it("does not write state when lock acquisition times out", async () => {
    const stored = JSON.stringify({ version: 3, guard: "warn", always: false, sessions: {}, days: {} })
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
      await plugin.dispose!()
    }
  })

  it("keeps every session when several processes write the state file at once", async () => {
    const script = join(tmpDir, "writer.ts")
    writeFileSync(script, `
      import { EmberPlugin } from ${JSON.stringify(join(import.meta.dir, "..", "ember"))}
      const client = { tui: { showToast: async () => {} }, session: { messages: async () => ({ data: [] }) } }
      const plugin = await EmberPlugin({ client } as any)
      for (let i = 0; i < 15; i++) {
        await plugin["command.execute.before"]!(
          { command: "keepwarm", sessionID: process.argv[2] + "-" + i, arguments: "30m" },
          { parts: [] } as any,
        ).catch(() => {})
      }
      await plugin.dispose!()
    `)
    const procs = ["a", "b", "c", "d", "e", "f"].map((id) =>
      Bun.spawn(["bun", script, id], { env: { ...process.env, EMBER_STATE_FILE: stateFile }, stdout: "ignore", stderr: "ignore" }),
    )
    await Promise.all(procs.map((p) => p.exited))
    expect(Object.keys(JSON.parse(readFileSync(stateFile, "utf8")).sessions).length).toBe(90)
  })
})
