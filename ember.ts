import type { Plugin } from "@opencode-ai/plugin"
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const DEFAULT_TTL_MS = envSeconds("EMBER_TTL_SECONDS") ?? 5 * 60 * 1000
const STORE_VERSION = 3
const BIG_TOKENS = envNumber("EMBER_MIN_CONTEXT") ?? 50_000
const GAIN_RETENTION_DAYS = 90

function stateFilePath(): string {
  return process.env.EMBER_STATE_FILE ?? join(homedir(), ".local", "share", "opencode", "ember.json")
}

// $ per million tokens: [family, cache read, cache write, output]. Longest
// family name first; a model id matches the first row it contains. Writes use
// the 5-minute tier, which is what opencode's inline cache_control selects.
const PRICES: Array<[string, number, number, number]> = [
  ["fable-5-1", 0.25, 12.5, 50],
  ["fable-5", 1, 12.5, 50],
  ["opus-5", 0.5, 6.25, 25],
  ["opus-4", 0.5, 6.25, 25],
  ["sonnet-5", 0.2, 2.5, 10],
  ["sonnet", 0.3, 3.75, 15],
  ["haiku", 0.1, 1.25, 5],
  ["gpt-5-6-sol", 0.44, 4.4, 22],
  ["gpt-5-6-terra", 0.22, 2.2, 13.2],
  ["gpt-5-6-luna", 0.022, 0.22, 1.32],
  ["gpt-5-5", 0.55, 5.5, 33],
  ["gpt-5-4-mini", 0.083, 0.825, 4.95],
  ["gpt-5-4", 0.275, 2.75, 16.5],
  ["gpt-5-mini", 0.028, 0.275, 2.2],
  ["gpt-5-nano", 0.006, 0.055, 0.44],
  ["gpt-5-1", 0.138, 1.375, 11],
  ["gpt-5", 0.138, 1.375, 11],
  ["gemini-3-8-flash", 0.075, 0.75, 3.75],
  ["gemini-3-7-flash", 0.075, 0.75, 3.75],
  ["gemini-3-6-flash", 0.075, 0.75, 3.75],
  ["gemini-3-5-flash-lite", 0.03, 0.3, 2.5],
  ["gemini-3-5-flash", 0.15, 1.5, 9],
  ["gemini-3-1-flash-lite", 0.025, 0.25, 1.5],
  ["gemini-2-5-pro", 0.125, 1.25, 10],
  ["gemini-2-5-flash-lite", 0.01, 0.1, 0.4],
  ["gemini-2-5-flash", 0.03, 0.3, 2.5],
  ["gemini", 0.075, 0.75, 3.75],
]

type ModelRef = { providerID: string; modelID: string }
type GuardMode = "refuse" | "warn"
type Miss = { at: number; tokens: number; usd: number | null }

type Session = {
  id: string
  ctx: number
  ttl: number
  lastModel: ModelRef | null
  lastRequestAt: number
  compacted: boolean
  hydrating: boolean
  hydrated: boolean
  blocked: string | null
  pendingColdWrite: boolean
  misses: Miss[]
}

type Store = {
  version: number
  guard: GuardMode
  days: Record<string, Day>
  [key: string]: unknown
}

type Day = {
  colds: number
  coldUsd: number
  [key: string]: unknown
}

function envNumber(name: string): number | null {
  const raw = process.env[name]
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

function envSeconds(name: string): number | null {
  const seconds = envNumber(name)
  return seconds == null ? null : seconds * 1000
}

function priceOf(model: ModelRef | null): [number, number, number] | null {
  if (!model) return null
  const target = `${model.providerID}/${model.modelID}`.toLowerCase()
  for (const [family, read, write, output] of PRICES) {
    if (target.includes(family)) return [read, write, output]
  }
  return null
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return "0s"
  const sec = Math.round(ms / 1000)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}h${m > 0 ? `${m}m` : ""}`
  if (m > 0) return `${m}m${s > 0 ? `${s}s` : ""}`
  return `${s}s`
}

function fmtTok(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M tok`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k tok`
  return `${n} tok`
}

function fmtUsd(n: number | null): string {
  if (n == null) return "$0.00"
  if (n >= 100) return `$${n.toFixed(0)}`
  if (n >= 10) return `$${n.toFixed(2)}`
  if (n >= 0.01) return `$${n.toFixed(2)}`
  if (n > 0) return `$${n.toFixed(3)}`
  return "$0.00"
}

function cleanDay(raw: unknown): Day {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  return { ...d, colds: Number(d.colds) || 0, coldUsd: Number(d.coldUsd) || 0 }
}

function readStore(): Store {
  try {
    const parsed = JSON.parse(readFileSync(stateFilePath(), "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("corrupt store")
    return {
      ...parsed,
      version: STORE_VERSION,
      guard: parsed.guard === "refuse" ? "refuse" : "warn",
      days: parsed.days && typeof parsed.days === "object" ? parsed.days : {},
    }
  } catch {
    return { version: STORE_VERSION, guard: "warn", days: {} }
  }
}

function withLock<T>(filePath: string, fn: () => T): T {
  const lock = `${filePath}.lock`
  const maxWait = 5000
  const step = 25
  const start = Date.now()
  let held = false
  while (!held) {
    try {
      mkdirSync(lock)
      held = true
    } catch {
      try {
        const stats = statSync(lock)
        if (Date.now() - stats.mtimeMs > 5000) {
          rmSync(lock, { recursive: true, force: true })
        }
      } catch {}
      if (Date.now() - start > maxWait) {
        throw new Error("timed out acquiring ember state lock")
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, step)
    }
  }
  try {
    return fn()
  } finally {
    if (held) rmSync(lock, { recursive: true, force: true })
  }
}

function writeStore(apply?: (store: Store) => void): void {
  try {
    const file = stateFilePath()
    mkdirSync(dirname(file), { recursive: true })
    withLock(file, () => {
      const fresh = readStore()
      const dayKeys = Object.keys(fresh.days).sort()
      while (dayKeys.length > GAIN_RETENTION_DAYS) {
        delete fresh.days[dayKeys.shift()!]
      }
      apply?.(fresh)
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(fresh, null, 2))
      renameSync(tmp, file)
    })
  } catch {
    // a failed write only drops a history entry, never the conversation
  }
}

export const EmberPlugin: Plugin = async ({ client }) => {
  const store = readStore()
  const sessions = new Map<string, Session>()
  const helperSessions = new Set<string>()

  const state = (id: string): Session => {
    const existing = sessions.get(id)
    if (existing) return existing
    const s: Session = {
      id,
      ctx: 0,
      ttl: DEFAULT_TTL_MS,
      lastModel: null,
      lastRequestAt: 0,
      compacted: false,
      hydrating: false,
      hydrated: false,
      blocked: null,
      pendingColdWrite: false,
      misses: [],
    }
    sessions.set(id, s)
    return s
  }

  const refreshSettings = () => {
    const fresh = readStore()
    store.guard = fresh.guard
  }

  const recordHistory = (apply: (day: Day) => void) => {
    const key = new Date().toISOString().slice(0, 10)
    writeStore((fresh) => {
      const day = cleanDay(fresh.days[key])
      apply(day)
      fresh.days[key] = day
    })
  }

  const coldUsd = (s: Session): number | null => {
    const price = priceOf(s.lastModel)
    return price ? (s.ctx * price[1]) / 1e6 : null
  }

  const warmUsd = (s: Session): number | null => {
    const price = priceOf(s.lastModel)
    return price ? (s.ctx * price[0]) / 1e6 : null
  }

  const isCold = (s: Session): boolean =>
    s.lastRequestAt > 0 && !s.compacted && Date.now() - s.lastRequestAt >= s.ttl

  const guardText = (s: Session): string => {
    const price = priceOf(s.lastModel)
    const cold = coldUsd(s)
    const warm = warmUsd(s)
    const cost = price
      ? ` at $${price[1]}/MTok = ${fmtUsd(cold)}${warm == null ? "" : ` (a warm turn would have cost ${fmtUsd(warm)})`}`
      : ""
    return (
      `the prompt cache went cold ${fmtDuration(Date.now() - s.lastRequestAt - s.ttl)} ago. ` +
      `Sending this re-writes ${s.ctx.toLocaleString("en-US")} tokens${cost}.`
    )
  }

  const card = (s: Session): string => {
    const warm = !isCold(s)
    const lines = [
      `ember: ${warm ? "warm" : "cold"} · context ${fmtTok(s.ctx)} · TTL ${fmtDuration(s.ttl)}`,
      `cold rewrite ${fmtUsd(coldUsd(s))}`,
      `guard: ${store.guard}`,
      `cold writes this session: ${s.misses.length}${
        s.misses.length ? ` — ${fmtUsd(s.misses.reduce((a, m) => a + (m.usd ?? 0), 0))}` : ""
      }`,
    ]
    return lines.join("\n")
  }

  const toast = async (
    message: string,
    variant: "info" | "success" | "warning" | "error" = "info",
    duration = 20_000,
  ) => {
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
      // leave unhydrated; the next turn will seed from live events
    } finally {
      s.hydrating = false
    }
  }

  const textOf = (parts: unknown): string => {
    if (!Array.isArray(parts)) return ""
    return parts
      .filter((p): p is { type: string; text: string; synthetic?: boolean } => {
        const part = p as { type?: string; text?: unknown; synthetic?: unknown }
        return part?.type === "text" && typeof part.text === "string" && part.synthetic !== true
      })
      .map((p) => p.text)
      .join("\n")
      .trim()
  }

  return {
    config: async (input) => {
      const command = (input.command ??= {}) as Record<string, { description?: string; template: string }>
      if (!command["ember"])
        command["ember"] = { description: "Show the prompt-cache cost card", template: "ember" }
    },

    "command.execute.before": async (input, output) => {
      if (input.command !== "ember") return
      let message: string
      const parts = (input.arguments ?? "").trim().split(/\s+/)
      const sub = parts[0]?.toLowerCase()
      if (sub === "guard") {
        const mode = parts[1]?.toLowerCase()
        if (mode === "warn" || mode === "refuse" || mode === "block") {
          store.guard = mode === "block" ? "refuse" : (mode as GuardMode)
          writeStore((fresh) => {
            fresh.guard = store.guard
          })
          message = `ember guard ${store.guard}`
        } else {
          message = "usage: /ember guard warn|refuse"
        }
      } else if (sub === "gain" || sub === "discover") {
        message = "ember gain moved to a terminal binary — run `ember gain` in a shell"
      } else {
        message = card(state(input.sessionID))
      }
      // The command text is never sent to the model: the toast carries the
      // result, and throwing stops opencode before it builds a prompt.
      await toast(message, "info", 30_000)
      output.parts = []
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
      const text = textOf(output.parts)
      if (text.startsWith("/")) return

      if (!s.hydrated) await hydrate(s)

      const cold = isCold(s) && s.ctx >= BIG_TOKENS
      if (!cold) return

      if (store.guard === "warn") {
        s.pendingColdWrite = true
        await toast(guardText(s) + " Sending anyway.", "warning")
        return
      }

      const message =
        `ember: ${guardText(s)} ` +
        `Prompt blocked by ember guard refuse. Run /ember guard warn to allow cold writes, or /clear and start from a note.`
      s.blocked = message
      await toast(message, "warning", 10 * 60_000)
    },

    "chat.params": async (input) => {
      const s = sessions.get(input.sessionID)
      if (s?.blocked) {
        const msg = s.blocked
        s.blocked = null
        throw new Error(msg)
      }
    },

    event: async ({ event }) => {
      try {
        switch (event.type) {
          case "message.updated": {
            const info = event.properties.info
            if (info.role === "user") {
              const s = sessions.get(info.sessionID)
              if (s) {
                s.lastModel = info.model
              }
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
            if (s.pendingColdWrite) {
              if (part.tokens.cache.write > 0) {
                const price = priceOf(s.lastModel)
                const usd = price ? (part.tokens.cache.write * price[1]) / 1e6 : null
                s.misses.push({ at: Date.now(), tokens: part.tokens.cache.write, usd })
                recordHistory((d) => {
                  d.colds++
                  d.coldUsd += usd ?? 0
                })
              }
              s.pendingColdWrite = false
            }
            break
          }
          case "session.compacted": {
            const s = sessions.get(event.properties.sessionID)
            if (!s) break
            s.compacted = true
            s.ctx = 0
            break
          }
          case "message.removed": {
            const s = sessions.get(event.properties.sessionID)
            if (!s) break
            s.ctx = 0
            s.lastRequestAt = 0
            s.compacted = false
            s.pendingColdWrite = false
            s.blocked = null
            s.misses = []
            break
          }
          case "session.deleted": {
            const s = sessions.get(event.properties.info.id)
            if (!s) break
            sessions.delete(s.id)
            break
          }
        }
      } catch {
        // a broken event must never take the session down
      }
    },
  }
}

export default { id: "local.ember", server: EmberPlugin }
