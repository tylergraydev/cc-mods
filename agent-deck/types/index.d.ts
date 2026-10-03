/** One tool call a subagent made. */
export type AgentCall = {
  id: string
  /** `Grep login`, `Bash npm test`, ... */
  label: string
  at: number
  isDone: boolean
  isError?: boolean
}

/** One subagent of the session as the deck tracks it. */
export type AgentRow = {
  id: string
  /** `Explore`, `general-purpose`, a plugin's agent, `fork`, ... */
  type: string
  description: string
  /** `running`, `completed`, `failed`, `killed`, ... */
  status: string
  model?: string
  parentId?: string
  isBackground?: boolean
  /** A preset run it belongs to, `review #1`. */
  group?: string
  /** The plugin that spawned it, `agent-deck` for the deck's own. */
  spawnedBy?: string
  startedAt: number
  endedAt?: number
  toolCount: number
  errorCount: number
  /** The latest calls, newest last. */
  calls: AgentCall[]
  answer?: string
  tokens?: number
}

/** What the deck enforces on every spawn. */
export type DeckPolicy = {
  /** How many subagents may run at once; 0 for no cap. */
  maxRunning: number
  /** Agent type to the model it is forced onto when the call names none. */
  models: Record<string, string>
}

declare module 'claude-code' {
  interface PluginState {
    'agent-deck': {
      agents: AgentRow[]
      selected: string | null
      policy: DeckPolicy
      now: number
    }
  }
}
