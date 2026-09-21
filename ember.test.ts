import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { EmberPlugin, parseDuration } from "./ember"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
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
})
