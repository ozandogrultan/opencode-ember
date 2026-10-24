import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, { EmberPlugin } from "../ember.ts"

export async function v1Harness(parentID?: string) {
  const toasts: any[] = []
  const hooks = await EmberPlugin({ client: {
    tui: { showToast: async ({ body }: any) => { toasts.push(body) } },
    session: {
      get: async () => ({ data: { parentID } }),
      messages: async () => ({ data: [{ info: {
        role: "assistant", providerID: "anthropic", modelID: "claude-sonnet-4-5",
        tokens: { input: 1000, cache: { read: 60000, write: 0 } },
        time: { completed: Date.now() - 600000 },
      } }] }),
    },
  } } as any)
  return {
    hooks, toasts,
    send: async (sessionID = "v1") => {
      await hooks["chat.message"]!({ sessionID } as any, { parts: [{ type: "text", text: "ping" }] } as any)
      await hooks["chat.params"]!({ sessionID } as any, {} as any)
    },
    step: async (sessionID = "v1") => hooks.event!({ event: {
      type: "message.part.updated", properties: { part: {
        type: "step-finish", sessionID, tokens: { input: 1000, cache: { read: 0, write: 60000 } },
      } },
    } } as any),
    command: async (args = "") => {
      const output = { parts: [{ type: "text", text: "ember" }] }
      await expect(hooks["command.execute.before"]!({ command: "ember", sessionID: "v1", arguments: args } as any, output as any)).rejects.toThrow()
      expect(output.parts).toEqual([])
    },
  }
}

describe("V1 compatibility", () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ember-v1-"))
    file = join(dir, "state.json")
    process.env.EMBER_STATE_FILE = file
  })
  afterEach(() => { delete process.env.EMBER_STATE_FILE; rmSync(dir, { recursive: true, force: true }) })

  it("preserves named exports and selects one server implementation", () => {
    expect(plugin.id).toBe("local.ember")
    expect(plugin.server).toBe(EmberPlugin)
    expect(typeof plugin.setup).toBe("function")
  })
  it("warns, records cold writes and preserves legacy fields", async () => {
    writeFileSync(file, JSON.stringify({ version: 2, guard: "warn", always: true, sessions: { old: {} }, days: {} }))
    const h = await v1Harness()
    await h.send()
    expect(h.toasts[0].message).toContain("Sending anyway")
    await h.step()
    const s = JSON.parse(readFileSync(file, "utf8"))
    expect(s.version).toBe(3)
    expect(s.always).toBe(true)
    expect(s.sessions).toEqual({ old: {} })
    expect(Object.values(s.days)[0]).toEqual({ colds: 1, coldUsd: 0.225 })
    await h.command()
    expect(h.toasts.at(-1).message).toContain("cold writes this session: 1")
  })
  it("refuses in chat.params and allows warn after a guard command", async () => {
    const h = await v1Harness()
    await h.command("guard refuse")
    await expect(h.send()).rejects.toThrow("Prompt blocked by ember guard refuse")
    await h.command("guard warn")
    await expect(h.send()).resolves.toBeUndefined()
  })
  it("ignores subagents", async () => {
    const h = await v1Harness("parent")
    await h.send()
    expect(h.toasts).toEqual([])
  })
  for (const mode of ["refuse", "warn"] as const) {
    it(`reports failed ${mode} saves without silently reverting to warn`, async () => {
      const original = JSON.stringify({ version: 3, guard: mode === "refuse" ? "warn" : "refuse", days: {} })
      writeFileSync(file, original)
      const h = await v1Harness()
      const blocked = `${file}.${process.pid}.tmp`
      mkdirSync(blocked)
      await h.command(`guard ${mode}`)
      expect(h.toasts.at(-1).variant).toBe("error")
      expect(h.toasts.at(-1).message).toContain("could not save guard settings")
      await h.command()
      expect(h.toasts.at(-1).variant).toBe("error")
      expect(h.toasts.at(-1).message).not.toContain("cold rewrite")
      await expect(h.send()).rejects.toThrow("Prompt blocked by ember guard refuse")
      expect(readFileSync(file, "utf8")).toBe(original)
      rmSync(blocked, { recursive: true })
      await h.command("guard warn")
      expect(h.toasts.at(-1).message).toBe("ember guard warn")
      await expect(h.send()).resolves.toBeUndefined()
    })
  }
  it("does not fail a normal conversation when history cannot be saved", async () => {
    const h = await v1Harness()
    mkdirSync(`${file}.${process.pid}.tmp`)
    await expect(h.send()).resolves.toBeUndefined()
    await expect(h.step()).resolves.toBeUndefined()
    expect(existsSync(file)).toBe(false)
  })
})
