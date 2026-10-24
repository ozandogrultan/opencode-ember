import type { Plugin } from "@opencode-ai/plugin"
import { BIG_TOKENS, card, guardText, isCold, newSession, priceOf, type Session as CoreSession } from "./core.ts"
import { cleanDay, readStore, writeStore, type Day } from "./store.ts"

type Session = CoreSession & { hydrating: boolean; blocked: string | null }

export const EmberPlugin: Plugin = async ({ client }) => {
  const store = readStore()
  const sessions = new Map<string, Session>()
  const helperSessions = new Set<string>()

  const state = (id: string): Session => {
    let s = sessions.get(id)
    if (!s) sessions.set(id, (s = { ...newSession(id), hydrating: false, blocked: null }))
    return s
  }

  const refreshSettings = () => { store.guard = readStore().guard }
  const recordHistory = (apply: (day: Day) => void) => {
    const key = new Date().toISOString().slice(0, 10)
    writeStore((fresh) => {
      const day = cleanDay(fresh.days[key])
      apply(day)
      fresh.days[key] = day
    })
  }

  const toast = async (message: string, variant: "info" | "warning" = "info", duration = 20_000) => {
    await client.tui.showToast({ body: { title: "ember", message, variant, duration } }).catch(() => undefined)
  }

  const hydrate = async (s: Session): Promise<void> => {
    if (s.hydrated || s.hydrating) return
    s.hydrating = true
    try {
      const res = await client.session.messages({ path: { id: s.id }, query: { limit: 50 } }).catch(() => undefined)
      const list = res?.data ?? []
      for (let i = list.length - 1; i >= 0; i--) {
        const info = list[i].info
        if (info.role !== "assistant") continue
        if (info.error || !info.tokens || (info.tokens.input === 0 && info.tokens.cache.read === 0 && info.tokens.cache.write === 0)) continue
        s.lastModel = { providerID: info.providerID, modelID: info.modelID }
        s.ctx = info.tokens.input + info.tokens.cache.read + info.tokens.cache.write
        s.lastRequestAt = info.time.completed ?? info.time.created
        break
      }
      for (let i = list.length - 1; i >= 0; i--) {
        const info = list[i].info
        if (info.role !== "user") continue
        if (!s.lastModel) s.lastModel = info.model
        break
      }
      s.hydrated = true
    } catch {
      // Leave unhydrated so the next turn can retry.
    } finally {
      s.hydrating = false
    }
  }

  const textOf = (parts: unknown): string => {
    if (!Array.isArray(parts)) return ""
    return parts.filter((p) => p?.type === "text" && typeof p.text === "string" && p.synthetic !== true)
      .map((p) => p.text).join("\n").trim()
  }

  return {
    config: async (input) => {
      const command = (input.command ??= {}) as Record<string, { description?: string; template: string }>
      if (!command.ember) command.ember = { description: "Show the prompt-cache cost card", template: "ember" }
    },
    "command.execute.before": async (input, output) => {
      if (input.command !== "ember") return
      let message: string
      const parts = (input.arguments ?? "").trim().split(/\s+/)
      const sub = parts[0]?.toLowerCase()
      if (sub === "guard") {
        const mode = parts[1]?.toLowerCase()
        if (mode === "warn" || mode === "refuse" || mode === "block") {
          store.guard = mode === "block" ? "refuse" : mode
          writeStore((fresh) => { fresh.guard = store.guard })
          message = `ember guard ${store.guard}`
        } else {
          message = "usage: /ember guard warn|refuse"
        }
      } else if (sub === "gain" || sub === "discover") {
        message = "ember gain moved to a terminal binary — run `ember gain` in a shell"
      } else {
        message = card(state(input.sessionID), priceOf(state(input.sessionID).lastModel), store.guard, Date.now())
      }
      await toast(message, "info", 30_000)
      output.parts = []
      // V1 has no handled-command result; throwing prevents prompt creation.
      throw new Error(message.replace(/\n/g, " · "))
    },
    "chat.message": async (input, output) => {
      if (helperSessions.has(input.sessionID)) return
      if (!sessions.has(input.sessionID)) {
        const session = client.session.get
          ? await client.session.get({ path: { id: input.sessionID } }).catch(() => undefined)
          : undefined
        if (session?.data?.title === "ghost-hidden" || session?.data?.parentID) {
          helperSessions.add(input.sessionID)
          return
        }
      }
      refreshSettings()
      const s = state(input.sessionID)
      if (textOf(output.parts).startsWith("/")) return
      if (!s.hydrated) await hydrate(s)
      if (!isCold(s, Date.now()) || s.ctx < BIG_TOKENS) return
      const text = guardText(s, priceOf(s.lastModel), Date.now())
      if (store.guard === "warn") {
        s.pendingColdWrite = true
        await toast(text + " Sending anyway.", "warning")
        return
      }
      s.blocked = `ember: ${text} Prompt blocked by ember guard refuse. Run /ember guard warn to allow cold writes, or /clear and start from a note.`
      await toast(s.blocked, "warning", 10 * 60_000)
    },
    "chat.params": async (input) => {
      const s = sessions.get(input.sessionID)
      if (s?.blocked) {
        const message = s.blocked
        s.blocked = null
        throw new Error(message)
      }
    },
    event: async ({ event }) => {
      try {
        switch (event.type) {
          case "message.updated": {
            const info = event.properties.info
            if (info.role === "user") {
              const s = sessions.get(info.sessionID)
              if (s) s.lastModel = info.model
            }
            break
          }
          case "message.part.updated": {
            const part = event.properties.part
            if (part.type !== "step-finish") break
            const s = sessions.get(part.sessionID)
            if (!s) break
            s.compacted = false
            s.lastRequestAt = Date.now()
            s.ctx = part.tokens.input + part.tokens.cache.read + part.tokens.cache.write
            if (!s.pendingColdWrite) break
            s.pendingColdWrite = false
            if (part.tokens.cache.write <= 0) break
            const price = priceOf(s.lastModel)
            const usd = price ? (part.tokens.cache.write * price[1]) / 1e6 : null
            s.misses.push({ at: Date.now(), tokens: part.tokens.cache.write, usd })
            recordHistory((d) => { d.colds++; d.coldUsd += usd ?? 0 })
            break
          }
          case "session.compacted": {
            const s = sessions.get(event.properties.sessionID)
            if (s) { s.compacted = true; s.ctx = 0 }
            break
          }
          case "message.removed": {
            const s = sessions.get(event.properties.sessionID)
            if (s) Object.assign(s, { ctx: 0, lastRequestAt: 0, compacted: false, pendingColdWrite: false, blocked: null, misses: [] })
            break
          }
          case "session.deleted":
            sessions.delete(event.properties.info.id)
            helperSessions.delete(event.properties.info.id)
            break
        }
      } catch {
        // A broken event must never take the session down.
      }
    },
  }
}
