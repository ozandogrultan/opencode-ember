import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const install = join(import.meta.dir, "..", "install.sh")

describe("install.sh", () => {
  let dir: string
  let cfg: string
  let bin: string

  const fakeOpencode = (version: string) => {
    mkdirSync(join(dir, "path"), { recursive: true })
    const file = join(dir, "path", "opencode")
    writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "opencode v${version}"; else printf 'config %s\\n' ${JSON.stringify(cfg)}; fi\n`)
    chmodSync(file, 0o755)
  }

  const run = async (version = "2.1.4", discover = false, env: Record<string, string> = {}) => {
    fakeOpencode(version)
    const proc = Bun.spawn(["bash", install, ...(discover ? [] : [cfg])], {
      env: { ...process.env, PATH: `${join(dir, "path")}:${process.env.PATH}`, EMBER_BIN_DIR: bin, ...env },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { out, err, code }
  }

  const json = (name: string) => JSON.parse(readFileSync(join(cfg, name), "utf8"))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ember-install-"))
    cfg = join(dir, "config with spaces")
    bin = join(dir, "bin")
    mkdirSync(cfg)
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("copies the plugin and registers it in opencode.json and cli.json", async () => {
    const { code } = await run()
    expect(code).toBe(0)
    for (const file of ["index.ts", "tui.ts", "core.ts", "store.ts", "rpc.ts", "package.json"]) {
      expect(existsSync(join(cfg, "plugins", "ember", file))).toBe(true)
    }
    expect(json("opencode.json").plugins).toEqual(["./plugins/ember"])
    expect(json("cli.json").plugins).toEqual(["./plugins/ember"])
    expect(json("plugins/ember/package.json").exports).toEqual({ ".": "./index.ts", "./tui": "./tui.ts" })
  })

  it("merges into existing config and is idempotent", async () => {
    writeFileSync(join(cfg, "opencode.json"), JSON.stringify({ model: "x/y", plugins: ["other", { package: "p", options: { a: 1 } }] }))
    writeFileSync(join(cfg, "cli.json"), JSON.stringify({ cursor: { shape: "bar" }, plugins: ["cli-plugin"] }))

    await run()
    await run()

    expect(json("opencode.json")).toEqual({
      model: "x/y",
      plugins: ["other", { package: "p", options: { a: 1 } }, "./plugins/ember"],
    })
    expect(json("cli.json")).toEqual({ cursor: { shape: "bar" }, plugins: ["cli-plugin", "./plugins/ember"] })
  })

  it("leaves everything untouched when a config cannot be parsed", async () => {
    const jsonc = '{\n  // comment\n  "plugins": []\n}\n'
    writeFileSync(join(cfg, "cli.json"), jsonc)

    const { code, err } = await run()

    expect(code).toBe(1)
    expect(err).toContain("no files were changed")
    expect(readFileSync(join(cfg, "cli.json"), "utf8")).toBe(jsonc)
    expect(existsSync(join(cfg, "opencode.json"))).toBe(false)
    expect(existsSync(join(cfg, "plugins"))).toBe(false)
  })

  it("removes the obsolete V1 plugin file", async () => {
    mkdirSync(join(cfg, "plugins"))
    writeFileSync(join(cfg, "plugins", "ember.ts"), 'export default { id: "local.ember", server: () => {} }\n')

    await run()

    expect(existsSync(join(cfg, "plugins", "ember.ts"))).toBe(false)
  })

  it("keeps V1 auto-discovery, supporting imports and existing JSON untouched", async () => {
    const original = '{ "plugin": ["other"], "model": "x/y" }\n'
    writeFileSync(join(cfg, "opencode.json"), original)
    const { code, err } = await run("1.19.3")
    expect(code).toBe(0)
    expect(err).toBe("")
    expect(readFileSync(join(cfg, "opencode.json"), "utf8")).toBe(original)
    expect(existsSync(join(cfg, "cli.json"))).toBe(false)
    expect(readFileSync(join(cfg, "plugins", "ember.ts"), "utf8")).toContain('"../ember/v1.ts"')
    for (const file of ["v1.ts", "core.ts", "store.ts"]) expect(existsSync(join(cfg, "ember", file))).toBe(true)
    const loaded = await import(join(cfg, "plugins", "ember.ts"))
    expect(loaded.default.server).toBe(loaded.EmberPlugin)
  })

  it("preserves singular V1 plugin entries when installing V2", async () => {
    const plugins = ["auth-plugin", ["options-plugin", { nested: { enabled: true } }]]
    writeFileSync(join(cfg, "opencode.json"), JSON.stringify({ plugin: plugins }))
    expect((await run()).code).toBe(0)
    expect(json("opencode.json").plugin).toEqual([...plugins, "./plugins/ember"])
    expect(json("opencode.json").plugins).toBeUndefined()
    expect((await run()).code).toBe(0)
    expect(json("opencode.json").plugin).toEqual([...plugins, "./plugins/ember"])
  })

  it("leaves both registries and their string, tuple and object options intact", async () => {
    const legacy = ["auth-plugin", ["legacy", { retain: [1, 2] }], ["./plugins/ember", { keep: true }]]
    const native = ["native-auth", { package: "native", options: { nested: { keep: true } } }]
    writeFileSync(join(cfg, "opencode.json"), JSON.stringify({ plugin: legacy, plugins: native }))
    expect((await run()).code).toBe(0)
    expect(json("opencode.json")).toEqual({ plugin: legacy, plugins: native })
  })

  it("never migrates V1 registries, including auth plugin options", async () => {
    const original = JSON.stringify({ plugin: ["auth-plugin", ["legacy", { keep: true }]], plugins: [{ package: "native", options: { a: 1 } }] })
    writeFileSync(join(cfg, "opencode.json"), original)
    expect((await run("1.18.0")).code).toBe(0)
    expect(readFileSync(join(cfg, "opencode.json"), "utf8")).toBe(original)
  })

  for (const failure of ["staging", "second replacement"] as const) {
    it(`keeps both original configs intact after a ${failure} failure`, async () => {
      const originals = ['{ "plugin": ["auth-plugin", ["other", {"keep": true}]] }\n', '{ "plugins": ["cli-auth"] }\n']
      for (const [i, file] of ["opencode.json", "cli.json"].entries()) writeFileSync(join(cfg, file), originals[i])
      const preload = join(dir, "failure.cjs")
      writeFileSync(preload, `
        const fs = require("node:fs")
        const open = fs.openSync, write = fs.writeFileSync, rename = fs.renameSync
        const files = new Map()
        fs.openSync = function(file, ...args) { const fd = open.call(this, file, ...args); files.set(fd, String(file)); return fd }
        fs.writeFileSync = function(file, ...args) {
          if (${JSON.stringify(failure)} === "staging" && files.get(file)?.endsWith("cli.json.next")) throw new Error("injected disk full")
          return write.call(this, file, ...args)
        }
        fs.renameSync = function(from, to) {
          if (${JSON.stringify(failure)} === "second replacement" && String(from).endsWith("cli.json.next")) throw new Error("injected rename failure")
          return rename.call(this, from, to)
        }
      `)
      const result = await run("2.1.4", false, { NODE_OPTIONS: `--require=${preload}` })
      expect(result.code).toBe(1)
      expect(result.err).toContain("injected")
      for (const [i, file] of ["opencode.json", "cli.json"].entries()) expect(readFileSync(join(cfg, file), "utf8")).toBe(originals[i])
      const recovery = join(cfg, readdirSync(cfg).find((name) => name.startsWith(".ember-install-"))!)
      expect(readFileSync(join(recovery, "cli.json.original"), "utf8")).toBe(originals[1])
      if (failure === "staging") expect(existsSync(join(cfg, "plugins"))).toBe(false)
    })
  }

  it("retains exact original bytes in recoverable backups after atomic replacements", async () => {
    const original = '{ "plugins": ["auth-plugin"] }\n'
    writeFileSync(join(cfg, "opencode.json"), original)
    expect((await run()).code).toBe(0)
    const recovery = join(cfg, readdirSync(cfg).find((name) => name.startsWith(".ember-install-"))!)
    expect(readFileSync(join(recovery, "opencode.json.original"), "utf8")).toBe(original)
    expect(json("opencode.json").plugins).toEqual(["auth-plugin", "./plugins/ember"])
  })

  it("discovers the V1 config path without changing JSON", async () => {
    expect((await run("1.19.3", true)).code).toBe(0)
    expect(existsSync(join(cfg, "plugins", "ember.ts"))).toBe(true)
    expect(existsSync(join(cfg, "opencode.json"))).toBe(false)
  })
})
