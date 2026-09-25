import type { Plugin } from "@opencode-ai/plugin"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// ember for opencode.
//
// A port of karanb192/claude-code-mods `cache-tax` (the "Mod" form) to
// opencode's plugin API. It does three things:
//
//   1. Keep the prompt cache warm. Every session stays armed by default;
//      after the cache TTL has almost lapsed the plugin sends one
//      request over a *fork* of the session, which refreshes the same prefix
//      without appending a single message to the real conversation.
//      `/keepwarm off` stops it for the session and turns the default off.
//   2. Stop you on a cold send. When the TTL has lapsed and the context is
//      large, `/ember guard refuse` hard blocks the prompt and displays an
//      informative message in the turn before any provider tokens are spent.
//      `/ember guard warn` (default) shows the price and sends anyway.
//   3. Keep score. `/ember` prints warm/cold, context, cold price, the
//      break-even and this session's cold writes.
//
// Hard rule: keepwarm must never invalidate the cache. So a ping
//   - runs on a fork of the same session with the same model and the same
//     agent (and therefore the same tools and system prompt) as the real
//     session, so its prefix is byte-identical and only appends;
//   - sends a constant one-line prompt and never touches provider options,
//     context files, tools or the model;
//   - stops itself the moment a ping reads nothing or writes at least a tenth
//     of what it read, i.e. the cache was already gone;
//   - on window expiry simply stops, leaving the conversation untouched.
// The empirical check after every ping is the safety net: if opencode's cache
// tier is shorter than the assumed TTL, the next ping proves it and the loop
// turns itself off rather than hammering a cold cache.
//
// Note on TTL: opencode's interactive sessions mark `cache_control` without a
// `ttl`, which is Anthropic's 5-minute tier (and the equivalent elsewhere).
// The default assumed TTL here is therefore 5 minutes and pings land at ~4.
// If you run a provider that actually holds an hour, set EMBER_TTL_SECONDS
// or run `/keepwarm 6h ttl 1h` and pings move to the ~54-minute cadence the
// original mod used.

// Env knobs exist so the whole thing can be exercised in seconds for free:
//   EMBER_TTL_SECONDS    assume a shorter cache tier (default 300)
//   EMBER_MIN_CONTEXT    cold-guard context floor in tokens (default 50000)
//   EMBER_MIN_PING_SECONDS   ping floor (default 60)
const DEFAULT_TTL_MS = envSeconds("EMBER_TTL_SECONDS") ?? 5 * 60 * 1000
const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000
// Windows armed without an explicit duration — at session start, and after a
// cold write — are the same six hours as the default window.
const AUTO_WARM_MS = DEFAULT_WINDOW_MS
// Stamped into the state file on every write. `always` defaulted to false
// before v2, so an unstamped store's `false` is the old default rather than a
// deliberate `/keepwarm off` and must not be honoured.
const STORE_VERSION = 2
const BIG_TOKENS = envNumber("EMBER_MIN_CONTEXT") ?? 50_000
const MIN_PING_MS = (envNumber("EMBER_MIN_PING_SECONDS") ?? 60) * 1000
const PING_PROMPT = "Reply with the single word: warm"
const STOP_NOTICE_MS = 5_000
const STALE_MS = 24 * 60 * 60 * 1000
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
}

type Store = {
  version: number
  guard: GuardMode
  always: boolean
  sessions: Record<string, { deadline: number; every: number; ttl?: number; continuous?: boolean }>
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
  const id = model.modelID.toLowerCase().replace(/[\s.]+/g, "-")
  for (const row of PRICES) if (id.includes(row[0])) return [row[1], row[2], row[3]]
  return null
}

function fmtUsd(usd: number | null): string {
  return usd == null ? "n/a" : "$" + (usd >= 100 ? usd.toFixed(0) : usd.toFixed(2))
}

function fmtTok(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1000 ? Math.round(n / 1000) + "k" : String(n)
}

function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`
}

export function parseDuration(text: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim())
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 * 1000
}

function everyFor(ttl: number): number {
  const slack = Math.max(MIN_PING_MS, Math.round(ttl * 0.1))
  return Math.max(MIN_PING_MS, Math.min(ttl - slack, 55 * 60 * 1000))
}

function readStore(): Store {
  try {
    const file = stateFilePath()
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    const stamped = parsed.version === STORE_VERSION
    return {
      version: STORE_VERSION,
      guard: parsed.guard === "refuse" || parsed.guard === "block" ? "refuse" : "warn",
      always: stamped ? parsed.always !== false : true,
      sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
    }
  } catch {
    return { version: STORE_VERSION, guard: "warn", always: true, sessions: {} }
  }
}

function writeStore(current: Store, apply?: (fresh: Store) => void): void {
  try {
    // Several opencode processes may share one state file (cmux spawns one
    // per workspace). Re-read and merge instead of writing the possibly
    // stale in-memory snapshot, or windows armed elsewhere get dropped.
    const fresh = readStore()
    fresh.always = current.always
    fresh.guard = current.guard
    const now = Date.now()
    for (const [id, entry] of Object.entries(fresh.sessions)) {
      if (now - entry.deadline > STALE_MS) delete fresh.sessions[id]
    }
    apply?.(fresh)
    const file = stateFilePath()
    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + ".tmp"
    writeFileSync(tmp, JSON.stringify(fresh, null, 2))
    renameSync(tmp, file)
  } catch {
    // a failed write only costs us a restored window, never the conversation
  }
}

export const EmberPlugin: Plugin = async ({ client }) => {
  const store = readStore()
  const sessions = new Map<string, Session>()
  const pingForks = new Set<string>()
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
      // Older stores predate this flag; their default windows were armed by
      // `always`, so restore those as continuous when that setting is on.
      continuous: persisted?.continuous ?? store.always,
      stopped: null,
      lastPing: null,
      pinging: false,
      timer: null,
      stumble: 0,
    }
    sessions.set(id, s)
    return s
  }

  const persistSession = (s: Session) => {
    writeStore(store, (fresh) => {
      if (s.deadline) fresh.sessions[s.id] = { deadline: s.deadline, every: s.every, ttl: s.ttl, continuous: s.continuous }
      else delete fresh.sessions[s.id]
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
      if (!s.continuous) return stop(s, null)
      s.deadline = now + DEFAULT_WINDOW_MS
      persistSession(s)
    }
    // A ping past the cache tier would cold-write the fork itself; the loop
    // then stops and the context is dead anyway. Wait for the next real turn
    // to refresh lastRequestAt instead of paying to rebuild a dead cache.
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
    if (s.pinging) return
    if (!s.deadline || (Date.now() >= s.deadline && !s.continuous)) return stop(s, null)
    if (Date.now() >= s.deadline) {
      s.deadline = Date.now() + DEFAULT_WINDOW_MS
      persistSession(s)
    }
    if (!s.lastModel) return stop(s, "no model seen yet for this session")
    s.pinging = true
    let forkID: string | null = null
    try {
      const status = await client.session.status().catch(() => undefined)
      if (status?.data?.[s.id]?.type === "busy") {
        s.pinging = false
        clearTimer(s)
        s.timer = setTimeout(() => void ping(s), 20_000)
        return
      }

      const forked = await client.session.fork({ path: { id: s.id } })
      forkID = forked.data?.id ?? null
      if (!forkID) throw new Error("fork failed")
      pingForks.add(forkID)

      const answer = await client.session.prompt({
        path: { id: forkID },
        body: {
          model: { providerID: s.lastModel.providerID, modelID: s.lastModel.modelID },
          agent: s.lastAgent ?? undefined,
          parts: [{ type: "text", text: PING_PROMPT }],
        },
      })
      const info = answer.data?.info
      const tokens = info?.tokens
      if (info?.error) throw new Error(`the ping model returned an error: ${JSON.stringify(info.error)}`)
      if (!tokens) throw new Error("no usage on the ping")

      const read = tokens.cache.read
      const write = tokens.cache.write
      const price = priceOf(s.lastModel)
      const usd = price
        ? (read * price[0] + write * price[1] + tokens.input * (price[1] / 2) + tokens.output * price[2]) / 1e6
        : null
      const warm = read > 0 && write < Math.max(1000, read / 10)
      const silent = read === 0 && write === 0
      s.lastPing = { at: Date.now(), read, write, usd, warm }

      if (!warm && silent) {
        // No cache numbers at all usually means the provider left usage off
        // the ping, not that the cache is gone (a truly cold ping would
        // write). Retry once at the next cadence; stop only if it happens
        // twice in a row, so one flaky usage report cannot kill the heartbeat.
        s.stumble++
        if (s.stumble < 2) {
          s.lastRequestAt = Date.now()
          s.pinging = false
          schedule(s)
          persistSession(s)
          return
        }
        const why =
          `the ping reported no cache activity on consecutive pings (${fmtUsd(usd)}); ` +
          `the provider may not cache this prefix or report cache usage`
        await toast(`keepwarm stopped: ${why}`, "warning", STOP_NOTICE_MS)
        return stop(s, why)
      }

      if (!warm) {
        s.stumble = 0
        const why =
          `the ping read ${read} and wrote ${fmtTok(write)} tokens (${fmtUsd(usd)}), so the cache was already gone`
        await toast(`keepwarm stopped: ${why}`, "warning", STOP_NOTICE_MS)
        return stop(s, why)
      }

      s.stumble = 0

      // The ping refreshed the shared prefix, so the TTL now runs from here.
      // No toast on success: pings fire every few minutes and would spam
      // the TUI. Failures and stops below still notify.
      s.lastRequestAt = Date.now()
      s.pinging = false
      schedule(s)
      persistSession(s)
    } catch (error) {
      s.pinging = false
      s.stumble++
      // A transient network or API hiccup should not stop warming for good;
      // retry at the next cadence and stop only after two in a row.
      if (s.stumble < 2) {
        schedule(s)
        return
      }
      const why = `the ping failed: ${error instanceof Error ? error.message : String(error)}`
      await toast(`keepwarm stopped: ${why}`, "error", STOP_NOTICE_MS)
      stop(s, why)
    } finally {
      if (forkID) pingForks.delete(forkID)
      if (forkID) await client.session.delete({ path: { id: forkID } }).catch(() => undefined)
      s.pinging = false
    }
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
    const s = state(sessionID)
    const args = raw.trim()
    const [head, ...rest] = args.split(/\s+/)
    const sub = (head ?? "").toLowerCase()

    if (sub === "status") return { text: stoppedText(s) ?? "keepwarm off", keepwarm: true }

    if (sub === "off") {
      stop(s, null)
      s.stopped = null
      store.always = false
      persistSession(s)
      return { text: "keepwarm off · always off", keepwarm: true }
    }

    if (sub === "always") {
      store.always = true
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
      "/keepwarm                 keep this session warm for six hours",
      "/keepwarm 90m             a window of your own (also 2h30m, 6h)",
      "/keepwarm always          keep this and future sessions armed until closed (default)",
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
            writeStore(store)
            message = `ember guard ${store.guard}`
          } else {
            message = "usage: /ember guard warn|refuse"
          }
        } else {
          message = card(s)
        }
      }
      // The command text is never sent to the model: the toast carries the
      // result, and throwing stops opencode before it builds a prompt.
      await toast(message, "info", 30_000)
      output.parts = []
      throw new Error(message.replace(/\n/g, " · "))
    },

    "chat.message": async (input, output) => {
      if (pingForks.has(input.sessionID) || helperSessions.has(input.sessionID)) return
      if (!sessions.has(input.sessionID)) {
        const session = client.session.get
          ? await client.session.get({ path: { id: input.sessionID } }).catch(() => undefined)
          : undefined
        if (session?.data?.title === "ghost-hidden") {
          helperSessions.add(input.sessionID)
          return
        }
      }
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
            if (s.pendingColdWrite) {
              if (part.tokens.cache.write > 0) {
                const price = priceOf(s.lastModel)
                const usd = price ? (part.tokens.cache.write * price[1]) / 1e6 : null
                s.misses.push({ at: Date.now(), tokens: part.tokens.cache.write, usd })
                if (!s.deadline) arm(s, AUTO_WARM_MS, undefined, store.always)
              }
              s.pendingColdWrite = false
            }
            break
          }
          case "session.idle": {
            const s = sessions.get(event.properties.sessionID)
            if (!s || !s.deadline || s.stopped) break
            schedule(s)
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
            writeStore(store, (fresh) => {
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
