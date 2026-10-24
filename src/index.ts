import { Plugin } from "@opencode/plugin"
import {
  BIG_TOKENS,
  GUARD_SAVE_ERROR,
  card,
  guardText,
  isCold,
  newSession,
  priceFromCost,
  priceOf,
  type GuardMode,
  type ModelCost,
  type Price,
  type Session,
} from "./core.ts"
import { EmberRpc, type Notice } from "./rpc.ts"
import { cleanDay, readStore, writeStore, type Day } from "./store.ts"

type ModelInfo = { id: string; modelID: string; providerID: string; cost: readonly ModelCost[] }

export default Plugin.define({
  id: "ember",
  async setup(ctx) {
    const guard = { mode: readStore().guard as GuardMode, unsaved: false }
    const sessions = new Map<string, Session>()
    const helperSessions = new Set<string>()
    const hydrating = new Map<string, Promise<void>>()
    const abort = new AbortController()
    let models: Promise<ModelInfo[]> | undefined

    const rpc = await ctx.rpc.register(EmberRpc, {})

    const notice = async (sessionID: string, message: string, variant: Notice["variant"], duration: number) => {
      await rpc.events.emit("notice", { sessionID, message, variant, duration }).catch(() => undefined)
    }

    const state = (id: string): Session => {
      let s = sessions.get(id)
      if (!s) sessions.set(id, (s = newSession(id)))
      return s
    }

    const loadModels = (): Promise<ModelInfo[]> =>
      (models ??= ctx.model
        .list()
        .then((res) => res.data as unknown as ModelInfo[])
        .catch(() => {
          models = undefined
          return []
        }))

    const priceFor = async (s: Session): Promise<Price | null> => {
      const model = s.lastModel
      if (!model) return null
      const info = (await loadModels()).find(
        (m) => m.providerID === model.providerID && (m.id === model.modelID || m.modelID === model.modelID),
      )
      return (info && priceFromCost(info.cost, s.ctx)) ?? priceOf(model)
    }

    const recordHistory = (apply: (day: Day) => void) => {
      const key = new Date().toISOString().slice(0, 10)
      writeStore((fresh) => {
        const day = cleanDay(fresh.days[key])
        apply(day)
        fresh.days[key] = day
      })
    }

    const isHelper = async (id: string): Promise<boolean> => {
      if (helperSessions.has(id)) return true
      if (sessions.has(id)) return false
      const info = await ctx.session.get({ sessionID: id }).catch(() => undefined)
      if (info?.title === "ghost-hidden" || info?.parentID) {
        helperSessions.add(id)
        return true
      }
      return false
    }

    const hydrate = (s: Session): Promise<void> => {
      if (s.hydrated) return Promise.resolve()
      let pending = hydrating.get(s.id)
      if (!pending) {
        pending = (async () => {
          const list = await ctx.session.context({ sessionID: s.id })
          for (let i = list.length - 1; i >= 0; i--) {
            const message = list[i]
            if (message.type === "compaction") {
              s.compacted = true
              break
            }
            if (message.type !== "assistant") continue
            const t = message.tokens
            if (message.error || !t || (t.input === 0 && t.cache.read === 0 && t.cache.write === 0)) continue
            s.lastModel = { providerID: message.model.providerID, modelID: message.model.id }
            s.ctx = t.input + t.cache.read + t.cache.write
            s.lastRequestAt = message.time.completed ?? message.time.created
            break
          }
          s.hydrated = true
        })()
          .catch(() => undefined)
          .finally(() => hydrating.delete(s.id))
        hydrating.set(s.id, pending)
      }
      return pending
    }

    await ctx.session.hook("context", async (e) => {
      if (e.messages[e.messages.length - 1]?.role !== "user") return
      if (await isHelper(e.sessionID)) return
      if (!guard.unsaved) guard.mode = readStore().guard
      const s = state(e.sessionID)
      await hydrate(s)
      s.lastModel = { providerID: e.model.providerID, modelID: e.model.id }

      if (!isCold(s, Date.now()) || s.ctx < BIG_TOKENS) return
      const text = guardText(s, await priceFor(s), Date.now())

      if (guard.mode === "warn") {
        s.pendingColdWrite = true
        await notice(s.id, `${text} Sending anyway.`, "warning", 20_000)
        return
      }
      throw new Error(
        `ember: ${text} Prompt blocked by ember guard refuse. Run /ember guard warn to allow cold writes, or start a new session from a note.`,
      )
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "ember",
        description: "Show the prompt-cache cost card, or set the guard: /ember guard warn|refuse",
        async execute({ sessionID, prompt }) {
          const parts = prompt.text.trim().split(/\s+/)
          const sub = parts[0]?.toLowerCase()
          let message: string
          let variant: Notice["variant"] = "info"
          if (sub === "guard") {
            const mode = parts[1]?.toLowerCase()
            if (mode === "warn" || mode === "refuse" || mode === "block") {
              const requested = mode === "block" ? "refuse" : mode
              const saved = writeStore((fresh) => { fresh.guard = requested })
              guard.mode = saved ? requested : "refuse"
              guard.unsaved = !saved
              message = saved ? `ember guard ${guard.mode}` : GUARD_SAVE_ERROR
              if (!saved) variant = "error"
            } else {
              message = "usage: /ember guard warn|refuse"
            }
          } else if (sub === "gain" || sub === "discover") {
            message = "ember gain moved to a terminal binary — run `ember gain` in a shell"
          } else {
            if (guard.unsaved) {
              await notice(sessionID, GUARD_SAVE_ERROR, "error", 30_000)
              throw new Error(GUARD_SAVE_ERROR)
            }
            guard.mode = readStore().guard
            const helper = await isHelper(sessionID)
            const s = state(sessionID)
            if (!helper) await hydrate(s)
            message = card(s, await priceFor(s), guard.mode, Date.now())
          }
          await notice(sessionID, message, variant, 30_000)
          if (variant === "error") throw new Error(message)
        },
      })
    })

    const onStepEnded = async (sessionID: string, tokens: { cache: { read: number; write: number }; input: number }) => {
      const s = sessions.get(sessionID)
      if (!s) return
      s.compacted = false
      s.lastRequestAt = Date.now()
      s.ctx = tokens.input + tokens.cache.read + tokens.cache.write
      if (!s.pendingColdWrite) return
      s.pendingColdWrite = false
      if (tokens.cache.write <= 0) return
      const price = await priceFor(s)
      const usd = price ? (tokens.cache.write * price[1]) / 1e6 : null
      s.misses.push({ at: Date.now(), tokens: tokens.cache.write, usd })
      recordHistory((d) => {
        d.colds++
        d.coldUsd += usd ?? 0
      })
    }

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
        try {
          switch (event.type) {
            case "session.step.ended":
              await onStepEnded(event.data.sessionID, event.data.tokens)
              break
            case "session.compaction.ended": {
              const s = sessions.get(event.data.sessionID)
              if (!s) break
              s.compacted = true
              s.ctx = 0
              break
            }
            case "session.revert.committed": {
              const s = sessions.get(event.data.sessionID)
              if (!s) break
              s.ctx = 0
              s.lastRequestAt = 0
              s.compacted = false
              s.pendingColdWrite = false
              s.misses = []
              break
            }
            case "session.deleted":
              sessions.delete(event.data.sessionID)
              helperSessions.delete(event.data.sessionID)
              break
            case "model.updated":
              models = undefined
              break
          }
        } catch {
          // a broken event must never take the session down
        }
      }
    })().catch(() => undefined)

    return async () => {
      abort.abort()
      await rpc.dispose()
    }
  },
})
