import { Plugin } from "@opencode/plugin/tui"
import { EmberRpc, type Notice } from "./rpc.ts"

export default Plugin.define({
  id: "ember.tui",
  setup(ctx) {
    return ctx.client.rpc(EmberRpc).events.on("notice", ({ data }) => {
      const { sessionID, message, variant, duration } = data as Notice
      ctx.ui.toast.show({ title: "ember", message, variant, duration, sessionID })
    })
  },
})
