import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { GuardMode } from "./core.ts"

export const STORE_VERSION = 3
const GAIN_RETENTION_DAYS = 90

export type Day = {
  colds: number
  coldUsd: number
  [key: string]: unknown
}

export type Store = {
  version: number
  guard: GuardMode
  days: Record<string, Day>
  [key: string]: unknown
}

export function stateFilePath(): string {
  return process.env.EMBER_STATE_FILE ?? join(homedir(), ".local", "share", "opencode", "ember.json")
}

export function cleanDay(raw: unknown): Day {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  return { ...d, colds: Number(d.colds) || 0, coldUsd: Number(d.coldUsd) || 0 }
}

export function readStore(): Store {
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

export function writeStore(apply?: (store: Store) => void): boolean {
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
    return true
  } catch {
    return false
  }
}
