import { Rpc } from "@opencode/plugin/rpc"

export type Notice = {
  sessionID: string
  message: string
  variant: "info" | "warning" | "error"
  duration: number
}

export const EmberRpc = Rpc.define({
  id: "ember",
  methods: {},
  events: {
    notice: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          message: { type: "string" },
          variant: { enum: ["info", "warning", "error"] },
          duration: { type: "number" },
        },
        required: ["sessionID", "message", "variant", "duration"],
        additionalProperties: false,
      },
    },
  },
})
