export const DEFAULT_TTL_MS = envSeconds("EMBER_TTL_SECONDS") ?? 5 * 60 * 1000
export const BIG_TOKENS = envNumber("EMBER_MIN_CONTEXT") ?? 50_000

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

export type ModelRef = { providerID: string; modelID: string }
export type Price = readonly [read: number, write: number, output: number]
export type GuardMode = "refuse" | "warn"
export type Miss = { at: number; tokens: number; usd: number | null }

export type Session = {
  id: string
  ctx: number
  ttl: number
  lastModel: ModelRef | null
  lastRequestAt: number
  compacted: boolean
  hydrated: boolean
  pendingColdWrite: boolean
  misses: Miss[]
}

export type ModelCost = {
  tier?: { type: "context"; size: number }
  output: number
  cache: { read: number; write: number }
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

export function newSession(id: string): Session {
  return {
    id,
    ctx: 0,
    ttl: DEFAULT_TTL_MS,
    lastModel: null,
    lastRequestAt: 0,
    compacted: false,
    hydrated: false,
    pendingColdWrite: false,
    misses: [],
  }
}

export function priceOf(model: ModelRef | null): Price | null {
  if (!model) return null
  const target = `${model.providerID}/${model.modelID}`.toLowerCase()
  for (const [family, read, write, output] of PRICES) {
    if (target.includes(family)) return [read, write, output]
  }
  return null
}

/** The rates a provider reports for a model, for the context size being rewritten. */
export function priceFromCost(cost: readonly ModelCost[], tokens: number): Price | null {
  const tier = cost
    .filter((c) => c.tier && c.tier.size <= tokens)
    .sort((a, b) => b.tier!.size - a.tier!.size)[0]
  const c = tier ?? cost.find((c) => !c.tier) ?? cost[0]
  return c && c.cache.write > 0 ? [c.cache.read, c.cache.write, c.output] : null
}

export function fmtDuration(ms: number): string {
  if (ms <= 0) return "0s"
  const sec = Math.round(ms / 1000)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}h${m > 0 ? `${m}m` : ""}`
  if (m > 0) return `${m}m${s > 0 ? `${s}s` : ""}`
  return `${s}s`
}

export function fmtTok(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M tok`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k tok`
  return `${n} tok`
}

export function fmtUsd(n: number | null): string {
  if (n == null) return "$0.00"
  if (n >= 100) return `$${n.toFixed(0)}`
  if (n >= 0.01) return `$${n.toFixed(2)}`
  if (n > 0) return `$${n.toFixed(3)}`
  return "$0.00"
}

export const coldUsd = (s: Session, price: Price | null): number | null => (price ? (s.ctx * price[1]) / 1e6 : null)

export const warmUsd = (s: Session, price: Price | null): number | null => (price ? (s.ctx * price[0]) / 1e6 : null)

export const isCold = (s: Session, now: number): boolean => s.lastRequestAt > 0 && !s.compacted && now - s.lastRequestAt >= s.ttl

export function guardText(s: Session, price: Price | null, now: number): string {
  const warm = warmUsd(s, price)
  const cost = price
    ? ` at $${price[1]}/MTok = ${fmtUsd(coldUsd(s, price))}${warm == null ? "" : ` (a warm turn would have cost ${fmtUsd(warm)})`}`
    : ""
  return (
    `the prompt cache went cold ${fmtDuration(now - s.lastRequestAt - s.ttl)} ago. ` +
    `Sending this re-writes ${s.ctx.toLocaleString("en-US")} tokens${cost}.`
  )
}

export function card(s: Session, price: Price | null, guard: GuardMode, now: number): string {
  return [
    `ember: ${isCold(s, now) ? "cold" : "warm"} · context ${fmtTok(s.ctx)} · TTL ${fmtDuration(s.ttl)}`,
    `cold rewrite ${fmtUsd(coldUsd(s, price))}`,
    `guard: ${guard}`,
    `cold writes this session: ${s.misses.length}${
      s.misses.length ? ` — ${fmtUsd(s.misses.reduce((a, m) => a + (m.usd ?? 0), 0))}` : ""
    }`,
  ].join("\n")
}
