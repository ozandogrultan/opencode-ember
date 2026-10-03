import type { Plugin } from "@opencode-ai/plugin"
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const DEFAULT_TTL_MS = envSeconds("EMBER_TTL_SECONDS") ?? 5 * 60 * 1000
const DEFAULT_WINDOW_MS = 30 * 60 * 1000
const AUTO_WARM_MS = DEFAULT_WINDOW_MS
const STORE_VERSION = 3
const BIG_TOKENS = envNumber("EMBER_MIN_CONTEXT") ?? 50_000
const MIN_PING_MS = (envNumber("EMBER_MIN_PING_SECONDS") ?? 60) * 1000
const STOP_NOTICE_MS = 5_000
const STALE_MS = 24 * 60 * 60 * 1000
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
type Ping = { at: number; read: number; write: number; usd: number | null; warm: boolean }
type Miss = { at: number; tokens: number; usd: number | null }

type Session = {
  id: string
  ctx: number
  ttl: number
  every: number
  lastModel: ModelRef | null
  lastAgent: string | null
  lastRequestAt: number
  compacted: boolean
  hydrating: boolean
  hydrated: boolean
  blocked: string | null
  pendingColdWrite: boolean
  misses: Miss[]
  deadline: number
  continuous: boolean
  stopped: string | null
  lastPing: Ping | null
  pinging: boolean
  timer: ReturnType<typeof setTimeout> | null
  stumble: number
  tail: number
}

type Store = {
  version: number
  guard: GuardMode
  always: boolean
  sessions: Record<string, { deadline: number; every: number; ttl?: number; continuous?: boolean }>
  days: Record<string, Day>
}

type Day = {
  pings: number
  read: number
  pingUsd: number
  keptUsd: number
  colds: number
  coldUsd: number
  warmMs: number
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

function everyFor(ttl: number): number {
  return Math.max(MIN_PING_MS, Math.round(ttl * 0.8))
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

export function parseDuration(raw: string): number | null {
  const s = raw.trim()
  const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i)
  if (!m || (!m[1] && !m[2] && !m[3])) return null
  const h = Number(m[1] ?? 0)
  const min = Number(m[2] ?? 0)
  const sec = Number(m[3] ?? 0)
  return (h * 3600 + min * 60 + sec) * 1000
}

function cleanDay(raw: unknown): Day {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  return {
    pings: Number(d.pings) || 0,
    read: Number(d.read) || 0,
    pingUsd: Number(d.pingUsd) || 0,
    keptUsd: Number(d.keptUsd) || 0,
    colds: Number(d.colds) || 0,
    coldUsd: Number(d.coldUsd) || 0,
    warmMs: Number(d.warmMs) || 0,
  }
}

function readStore(): Store {
  try {
    const file = stateFilePath()
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    if (!parsed || typeof parsed !== "object") throw new Error("corrupt store")
    const isV3 = parsed.version === STORE_VERSION
    return {
      version: STORE_VERSION,
      guard: parsed.guard === "refuse" ? "refuse" : "warn",
      always: isV3 && parsed.always === true,
      sessions: isV3 && parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
      days: parsed.days && typeof parsed.days === "object" ? parsed.days : {},
    }
  } catch {
    return { version: STORE_VERSION, guard: "warn", always: false, sessions: {}, days: {} }
  }
}

function withLock<T>(filePath: string, fn: () => T): T {
  const lock = `${filePath}.lock`
  const maxWait = 500
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
        break
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
      const now = Date.now()
      for (const [id, sess] of Object.entries(fresh.sessions)) {
        if (sess.deadline && sess.deadline < now - STALE_MS) {
          delete fresh.sessions[id]
        }
      }
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
    // a failed write only costs us a restored window, never the conversation
  }
}

export const EmberPlugin: Plugin = async ({ client }) => {
  const store = readStore()
  const sessions = new Map<string, Session>()
  const helperSessions = new Set<string>()

  const state = (id: string): Session => {
    const existing = sessions.get(id)
    if (existing) return existing
    const persisted = store.sessions[id]
    const s: Session = {
      id,
      ctx: 0,
      ttl: persisted?.ttl ?? DEFAULT_TTL_MS,
      every: persisted?.every ?? everyFor(persisted?.ttl ?? DEFAULT_TTL_MS),
      lastModel: null,
      lastAgent: null,
      lastRequestAt: 0,
      compacted: false,
      hydrating: false,
      hydrated: false,
      blocked: null,
      pendingColdWrite: false,
      misses: [],
      deadline: persisted?.deadline ?? 0,
      continuous: persisted?.continuous ?? false,
      stopped: null,
      lastPing: null,
      pinging: false,
      timer: null,
      stumble: 0,
      tail: 0,
    }
    sessions.set(id, s)
    return s
  }

  const refreshSettings = () => {
    const fresh = readStore()
    store.always = fresh.always
    store.guard = fresh.guard
  }

  const persistSession = (s: Session) => {
    writeStore((fresh) => {
      if (!s.deadline) {
        delete fresh.sessions[s.id]
      } else {
        fresh.sessions[s.id] = { deadline: s.deadline, every: s.every, ttl: s.ttl, continuous: s.continuous }
      }
    })
  }

  const recordHistory = (apply: (day: Day) => void) => {
    const key = new Date().toISOString().slice(0, 10)
    writeStore((fresh) => {
      const day = fresh.days[key] ? cleanDay(fresh.days[key]) : { pings: 0, read: 0, pingUsd: 0, keptUsd: 0, colds: 0, coldUsd: 0, warmMs: 0 }
      apply(day)
      fresh.days[key] = day
    })
  }

  const clearTimer = (s: Session) => {
    if (s.timer) clearTimeout(s.timer)
    s.timer = null
  }

  const stoppedText = (s: Session): string | undefined => {
    if (s.stopped) return s.stopped
    if (!s.deadline) return undefined
    const left = fmtDuration(s.deadline - Date.now())
    const next = s.lastRequestAt ? ` · ping in ${fmtDuration(s.lastRequestAt + s.every - Date.now())}` : " · waiting for the first turn"
    const ping = s.lastPing ? ` · last ping read ${fmtTok(s.lastPing.read)} ${fmtUsd(s.lastPing.usd)}` : ""
    return `keepwarm ${s.continuous ? "always" : `${left} left`}${next}${ping}`
  }

  const stop = (s: Session, why: string | null) => {
    clearTimer(s)
    s.deadline = 0
    s.continuous = false
    s.stopped = why
    s.lastPing = why ? s.lastPing : null
    persistSession(s)
  }

  const schedule = (s: Session) => {
    clearTimer(s)
    if (!s.deadline) return
    const now = Date.now()
    if (now >= s.deadline) {
      if (s.continuous) {
        s.deadline = now + DEFAULT_WINDOW_MS
        persistSession(s)
      } else {
        return stop(s, null)
      }
    }
    if (s.lastRequestAt && now >= s.lastRequestAt + s.ttl) return
    const base = s.lastRequestAt || now
    const delay = Math.max(1000, Math.min(base + s.every - now, s.deadline - now))
    s.timer = setTimeout(() => void ping(s), delay)
  }

  const arm = (s: Session, windowMs?: number, ttl?: number, continuous = false) => {
    if (ttl) s.ttl = ttl
    s.every = everyFor(s.ttl)
    if (windowMs) s.deadline = Date.now() + windowMs
    if (!s.deadline) return
    s.continuous = continuous
    s.stopped = null
    schedule(s)
    persistSession(s)
  }

  const ping = async (s: Session) => {
    clearTimer(s)
    if (!s.deadline || (Date.now() >= s.deadline && !s.continuous)) return stop(s, null)
    stop(s, "no supported captured model request is available")
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

  const breakEven = (s: Session): string => {
    const price = priceOf(s.lastModel)
    if (!price || s.ctx <= 0) return "break-even: unknown"
    const pings = Math.floor(price[1] / price[0])
    return `break-even: ${pings} pings ≈ 1 cold write (${fmtDuration(pings * s.every)} idle)`
  }

  const card = (s: Session): string => {
    const warm = !isCold(s)
    const lines = [
      `ember: ${warm ? "warm" : "cold"} · context ${fmtTok(s.ctx)} · TTL ${fmtDuration(s.ttl)}`,
      `cold rewrite ${fmtUsd(coldUsd(s))} · ${breakEven(s)}`,
      `keepwarm: ${stoppedText(s) ?? "off"}`,
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
        s.tail = info.tokens.output + (info.tokens.reasoning ?? 0)
        s.lastRequestAt = info.time.completed ?? info.time.created
        break
      }
      for (let i = list.length - 1; i >= 0; i--) {
        const info = list[i].info
        if (info.role !== "user") continue
        s.lastAgent = info.agent
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

  const handleCommand = (sessionID: string, raw: string): { text: string; keepwarm: boolean } => {
    refreshSettings()
    const s = state(sessionID)
    const args = raw.trim()
    const [head, ...rest] = args.split(/\s+/)
    const sub = (head ?? "").toLowerCase()

    if (sub === "status") return { text: stoppedText(s) ?? "keepwarm off", keepwarm: true }

    if (sub === "off") {
      stop(s, null)
      s.stopped = null
      store.always = false
      writeStore((fresh) => {
        fresh.always = false
      })
      return { text: "keepwarm off · always off", keepwarm: true }
    }

    if (sub === "always") {
      store.always = true
      writeStore((fresh) => {
        fresh.always = true
      })
      arm(s, DEFAULT_WINDOW_MS, undefined, true)
      return { text: "keepwarm always on for this and future sessions", keepwarm: true }
    }

    // <dur> [every <dur>] [ttl <dur>]
    let window = DEFAULT_WINDOW_MS
    if (sub) {
      const parsed = parseDuration(sub)
      if (!parsed) return { text: usage(), keepwarm: true }
      window = parsed
    }
    let ttl: number | undefined
    let every: number | undefined
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i].toLowerCase()
      const value = rest[i + 1] ? parseDuration(rest[i + 1]) : null
      if (token === "every" && value) {
        every = Math.max(MIN_PING_MS, value)
        i++
      } else if (token === "ttl" && value) {
        ttl = value
        i++
      }
    }
    // A plain /keepwarm refreshes the always-on session; only an explicit
    // duration opts this session into a bounded window.
    arm(s, window, ttl, !sub && store.always)
    if (every) {
      s.every = every
      schedule(s)
      persistSession(s)
    }
    return { text: stoppedText(s) ?? `keepwarm armed for ${fmtDuration(window)}`, keepwarm: true }
  }

  const usage = (): string =>
    [
      "/keepwarm                 arm warming for 30 minutes (or current window)",
      "/keepwarm 90m             a window of your own (also 2h30m, 6h)",
      "/keepwarm always          keep this and future sessions armed across breaks (30m window per turn)",
      "/keepwarm 6h every 2m     override the ping period (floor 1m)",
      "/keepwarm 6h ttl 1h       assume the 1-hour cache tier",
      "/keepwarm status          the status line",
      "/keepwarm off             stop, forget the window, turn always off",
      "/ember                    the card",
      "/ember guard warn         show the price and send (default)",
      "/ember guard refuse       hard block cold sends",
    ].join("\n")

  return {
    config: async (input) => {
      const command = (input.command ??= {}) as Record<string, { description?: string; template: string }>
      if (!command.keepwarm)
        command.keepwarm = { description: "Keep the prompt cache warm across a break", template: "keepwarm" }
      if (!command["ember"])
        command["ember"] = { description: "Show the prompt-cache cost card", template: "ember" }
    },

    "command.execute.before": async (input, output) => {
      if (input.command !== "keepwarm" && input.command !== "ember") return
      let message: string
      if (input.command === "keepwarm") {
        message = handleCommand(input.sessionID, input.arguments ?? "").text
      } else {
        const s = state(input.sessionID)
        const parts = (input.arguments ?? "").trim().split(/\s+/)
        if (parts[0]?.toLowerCase() === "guard") {
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
        } else {
          const sub = parts[0]?.toLowerCase()
          if (sub === "gain" || sub === "discover") {
            message = "ember gain moved to a terminal binary — run `ember gain` in a shell"
          } else {
            message = card(s)
          }
        }
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

      if (store.always && !s.deadline) arm(s, DEFAULT_WINDOW_MS, undefined, true)

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
                s.lastAgent = info.agent
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
            s.tail = part.tokens.output + (part.tokens.reasoning ?? 0)
            s.stopped = null
            if (store.always && !s.deadline) arm(s, AUTO_WARM_MS, undefined, true)
            if (s.pendingColdWrite) {
              if (part.tokens.cache.write > 0) {
                const price = priceOf(s.lastModel)
                const usd = price ? (part.tokens.cache.write * price[1]) / 1e6 : null
                s.misses.push({ at: Date.now(), tokens: part.tokens.cache.write, usd })
                if (!s.deadline) arm(s, AUTO_WARM_MS, undefined, store.always)
                recordHistory((d) => {
                  d.colds++
                  d.coldUsd += usd ?? 0
                })
              }
              s.pendingColdWrite = false
            }
            break
          }
          case "session.idle": {
            const id = event.properties.sessionID
            let s = sessions.get(id)
            if (!s) {
              if (helperSessions.has(id)) break
              const persisted = readStore().sessions[id]
              if (!persisted || !persisted.deadline || Date.now() >= persisted.deadline) break
              const info = client.session.get ? await client.session.get({ path: { id } }).catch(() => undefined) : undefined
              if (info?.data?.parentID) {
                helperSessions.add(id)
                writeStore((fresh) => {
                  delete fresh.sessions[id]
                })
                break
              }
              store.sessions[id] = persisted
              s = state(id)
              await hydrate(s)
            }
            if (s.deadline && !s.stopped && Date.now() < s.deadline) {
              schedule(s)
            }
            break
          }
          case "session.compacted": {
            const s = sessions.get(event.properties.sessionID)
            if (!s) break
            // Compaction rewrites the prefix; pinging is pointless until the
            // next real turn re-establishes a cache entry.
            s.compacted = true
            s.ctx = 0
            clearTimer(s)
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
            stop(s, null)
            break
          }
          case "session.deleted": {
            const s = sessions.get(event.properties.info.id)
            if (!s) break
            clearTimer(s)
            sessions.delete(s.id)
            writeStore((fresh) => {
              delete fresh.sessions[s.id]
            })
            break
          }
        }
      } catch {
        // a broken event must never take the session down
      }
    },

    dispose: async () => {
      for (const s of sessions.values()) clearTimer(s)
    },
  }
}

export default { id: "local.ember", server: EmberPlugin }
