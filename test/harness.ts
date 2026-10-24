import plugin from "../src/index.ts"

export const SONNET = { providerID: "anthropic", id: "claude-sonnet-4-5-20250929" }

export const assistant = (model: { providerID: string; id: string }, tokens: { input: number; read: number; write?: number }, agoMs: number) => ({
  type: "assistant",
  model,
  tokens: { input: tokens.input, output: 1, reasoning: 0, cache: { read: tokens.read, write: tokens.write ?? 0 } },
  time: { created: Date.now() - agoMs, completed: Date.now() - agoMs },
})

export type Options = {
  context?: unknown[]
  get?: (sessionID: string) => unknown
  models?: unknown[]
}

export async function harness(options: Options = {}) {
  const hooks = new Map<string, (event: any) => Promise<void> | void>()
  const commands: any[] = []
  const notices: Array<{ sessionID: string; message: string; variant: string; duration: number }> = []
  const queue: any[] = []
  const processed: Array<() => void> = []
  let wake: (() => void) | undefined

  const ctx = {
    rpc: {
      register: async () => ({
        events: { emit: async (_name: string, data: any) => void notices.push(data) },
        dispose: async () => {},
      }),
    },
    session: {
      hook: async (name: string, callback: (event: any) => Promise<void> | void) => void hooks.set(name, callback),
      get: async (input: { sessionID: string }) => options.get?.(input.sessionID),
      context: async () => options.context ?? [],
    },
    command: {
      transform: async (callback: (editor: { add: (definition: unknown) => void }) => void) =>
        callback({ add: (definition) => void commands.push(definition) }),
    },
    model: { list: async () => ({ data: options.models ?? [] }) },
    event: {
      async *subscribe({ signal }: { signal: AbortSignal }) {
        while (!signal.aborted) {
          if (!queue.length) await new Promise<void>((resolve) => (wake = resolve))
          const event = queue.shift()
          if (!event) return
          yield event
          processed.shift()?.()
        }
      },
    },
  }

  const cleanup = (await plugin.setup(ctx as never)) as (() => Promise<void>) | undefined

  return {
    notices,
    commands,
    send: (sessionID: string, model = SONNET, last = "user") =>
      hooks.get("context")!({
        sessionID,
        model,
        agent: "build",
        messages: [{ role: last }],
        system: [],
        options: {},
        tools: {},
      }),
    emit: (type: string, data: unknown) =>
      new Promise<void>((resolve) => {
        processed.push(resolve)
        queue.push({ type, data })
        wake?.()
      }),
    stepEnded: (sessionID: string, write: number, read = 0) =>
      new Promise<void>((resolve) => {
        processed.push(resolve)
        queue.push({
          type: "session.step.ended",
          data: { sessionID, tokens: { input: 10, output: 5, reasoning: 0, cache: { read, write } } },
        })
        wake?.()
      }),
    command: (sessionID: string, text: string) =>
      commands[0].execute({ sessionID, prompt: { text, files: [], agents: [] }, delivery: "steer" }),
    close: async () => {
      queue.push(undefined)
      wake?.()
      await cleanup?.()
    },
  }
}
