import type { Plugin } from "@opencode/plugin"
import { EmberPlugin } from "./src/v1.ts"

export { EmberPlugin }

export default {
  id: "local.ember",
  server: EmberPlugin,
  // V1 must not resolve V2 runtime imports, which only the V2 host supplies.
  async setup(ctx: Plugin.Context) {
    return (await import("./src/index.ts")).default.setup(ctx)
  },
}
