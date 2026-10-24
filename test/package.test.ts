import { expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

it("packs all entrypoints and loads V1 without V2 runtime dependencies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ember-pack-"))
  try {
    const pack = Bun.spawnSync(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", dir], { cwd: join(import.meta.dir, "..") })
    expect(pack.exitCode).toBe(0)
    const [{ filename }] = JSON.parse(pack.stdout.toString())
    expect(Bun.spawnSync(["tar", "-xzf", join(dir, filename), "-C", dir]).exitCode).toBe(0)
    const pkg = JSON.parse(readFileSync(join(dir, "package", "package.json"), "utf8"))
    for (const file of [pkg.main, ...Object.values(pkg.exports), "src/v1.ts", "src/core.ts", "src/store.ts", "src/rpc.ts", "src/index.ts", "gain.ts"] as string[]) {
      expect(existsSync(join(dir, "package", file))).toBe(true)
    }
    const run = Bun.spawnSync(["bun", "-e", `const m = await import(${JSON.stringify(join(dir, "package", "ember.ts"))}); if(m.default.server !== m.EmberPlugin || typeof m.default.setup !== "function") process.exit(1)`])
    expect(run.stderr.toString()).toBe("")
    expect(run.exitCode).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
