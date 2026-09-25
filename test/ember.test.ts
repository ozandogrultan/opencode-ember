import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { EmberPlugin, parseDuration } from "../ember"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
    writeFileSync(stateFile, JSON.stringify({ guard: "refuse", always: false, sessions: {} }))

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

    // First attempt: chat.message does NOT throw unhandled error (prevents generic 500 in OpenCode)
    await expect(chatMessage!(input, output)).resolves.toBeUndefined()
    expect(toasts.length).toBe(1)
    expect(toasts[0].body.message).toContain("the prompt cache went cold")
    expect(toasts[0].body.message).toContain("Prompt blocked by ember guard refuse")

    // chat.params throws the informative message before provider call
    await expect(chatParams!({ sessionID: "test-session-refuse" } as any, {} as any)).rejects.toThrow(
      "Prompt blocked by ember guard refuse"
    )

    // Resend attempt: it STILL hard blocks (no soft drop once bypass)
    await expect(chatMessage!(input, output)).resolves.toBeUndefined()
    await expect(chatParams!({ sessionID: "test-session-refuse" } as any, {} as any)).rejects.toThrow(
      "Prompt blocked by ember guard refuse"
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
                providerID: "doctolib-litellm",
                modelID: "gemini-3.8-flash-20260902",
                tokens: { input: 1000, cache: { read: 120000, write: 0 } },
                time: { completed: Date.now() - 10 * 60 * 1000 },
              },
            },
            {
              info: { role: "user", agent: "build", model: { providerID: "doctolib-litellm", modelID: "gemini-3.8-flash-20260902" } },
            },
          ],
        }),
      },
    }

    const plugin = await EmberPlugin({ client: mockClient } as any)
    const chatMessage = plugin["chat.message"]

    const input = { sessionID: "test-gemini" }
    const output = { parts: [{ type: "text", text: "Hello gemini" }] } as any

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

  it("arms a six-hour window at session start by default", async () => {
    const plugin = await EmberPlugin({ client: silentClient } as any)
    const chatMessage = plugin["chat.message"]

    await chatMessage!({ sessionID: "default-warm" }, { parts: [{ type: "text", text: "Hello" }] } as any)

    const store = JSON.parse(readFileSync(stateFile, "utf8"))
    const armed = store.sessions["default-warm"]
    expect(armed).toBeDefined()
    const hours = (armed.deadline - Date.now()) / (60 * 60 * 1000)
    expect(hours).toBeGreaterThan(5.9)
    expect(hours).toBeLessThanOrEqual(6)
    expect(armed.continuous).toBe(true)
  })

  it("renews an expired always-on window when the session becomes idle", async () => {
    writeFileSync(stateFile, JSON.stringify({
      version: 2, guard: "warn", always: true,
      sessions: { resumed: { deadline: Date.now() - 1000, every: 240000, ttl: 300000 } },
    }))
    const plugin = await EmberPlugin({ client: silentClient } as any)
    try {
      await plugin["chat.message"]!({ sessionID: "resumed" }, { parts: [{ type: "text", text: "Hi" }] } as any)
      await plugin.event!({ event: { type: "session.idle", properties: { sessionID: "resumed" } } } as any)
      const renewed = JSON.parse(readFileSync(stateFile, "utf8")).sessions.resumed
      expect(renewed.continuous).toBe(true)
      expect(renewed.deadline).toBeGreaterThan(Date.now() + 5 * 60 * 60 * 1000)
    } finally {
      await plugin.dispose!()
    }
  })

  it("leaves an explicitly timed window bounded even with always enabled", async () => {
    const plugin = await EmberPlugin({ client: silentClient } as any)
    try {
      await plugin["chat.message"]!({ sessionID: "timed" }, { parts: [{ type: "text", text: "Hi" }] } as any)
      await expect(plugin["command.execute.before"]!(
        { command: "keepwarm", sessionID: "timed", arguments: "90m" }, { parts: [] } as any,
      )).rejects.toThrow("keepwarm")
      expect(JSON.parse(readFileSync(stateFile, "utf8")).sessions.timed.continuous).toBe(false)
    } finally {
      await plugin.dispose!()
    }
  })

  it("ignores a legacy store's always:false and warms anyway", async () => {
    writeFileSync(stateFile, JSON.stringify({ guard: "warn", always: false, sessions: {} }))

    const plugin = await EmberPlugin({ client: silentClient } as any)
    const chatMessage = plugin["chat.message"]

    await chatMessage!({ sessionID: "legacy-store" }, { parts: [{ type: "text", text: "Hello" }] } as any)

    const store = JSON.parse(readFileSync(stateFile, "utf8"))
    expect(store.sessions["legacy-store"]).toBeDefined()
    expect(store.version).toBe(2)
  })

  it("points /ember gain at the CLI binary", async () => {
    const plugin = await EmberPlugin({ client: silentClient } as any)
    const cmd = plugin["command.execute.before"]
    await expect(cmd!({ command: "ember", sessionID: "g", arguments: "gain" }, { parts: [] } as any))
      .rejects.toThrow("ember gain moved to a terminal binary — run `ember gain` in a shell")
  })

  it("stays off when a stamped store was turned off", async () => {
    writeFileSync(stateFile, JSON.stringify({ version: 2, guard: "warn", always: false, sessions: {} }))

    const plugin = await EmberPlugin({ client: silentClient } as any)
    const chatMessage = plugin["chat.message"]

    await chatMessage!({ sessionID: "opted-out" }, { parts: [{ type: "text", text: "Hello" }] } as any)

    const store = JSON.parse(readFileSync(stateFile, "utf8"))
    expect(store.sessions["opted-out"]).toBeUndefined()
  })

  it("keeps another session's window when two instances share the state file", async () => {
    const a = await EmberPlugin({ client: silentClient } as any)
    const b = await EmberPlugin({ client: silentClient } as any)

    await a["chat.message"]!({ sessionID: "proc-a" }, { parts: [{ type: "text", text: "Hi" }] } as any)
    // b loaded its store snapshot before proc-a was armed; its own write
    // must still preserve the window armed by the other instance.
    await b["chat.message"]!({ sessionID: "proc-b" }, { parts: [{ type: "text", text: "Hi" }] } as any)

    let store = JSON.parse(readFileSync(stateFile, "utf8"))
    expect(store.sessions["proc-a"]).toBeDefined()
    expect(store.sessions["proc-b"]).toBeDefined()

    await a["chat.message"]!({ sessionID: "proc-a" }, { parts: [{ type: "text", text: "Again" }] } as any)
    store = JSON.parse(readFileSync(stateFile, "utf8"))
    expect(store.sessions["proc-b"]).toBeDefined()
    expect(store.sessions["proc-a"].deadline).toBeGreaterThan(
      Date.now() + 5 * 60 * 60 * 1000
    )
  })
})
