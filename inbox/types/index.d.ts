export type InboxStatus = 'open' | 'running' | 'done' | 'failed'

/** The last watchdog level announced for a run; "timed out" is a property of the run, not of the task file. */
export type InboxWatch = 'active' | 'idle' | 'timedOut'
export type InboxPhase = 'work' | 'review'

/** One task, as its file `.inbox/<id>-<slug>.md` holds it. */
export type InboxTask = {
  id: number
  file: string
  title: string
  status: InboxStatus
  /** The subagent type to deploy; general-purpose when absent. */
  agent?: string
  model?: string
  created: string
  updated: string
  /** The last agent deployed on it. */
  agentId?: string
  /** Short sha of the commit a review made (or found) for this task. */
  commit?: string
  body: string
  /** The last agent's report. */
  result?: string
}

/** A subagent working a task in this session, and how far it has got. */
export type InboxRun = {
  taskId: number
  agentId: string
  startedAt: number
  endedAt?: number
  tools: number
  errors: number
  lastTool?: string
  /** `abandoned`: replaced by a redeploy; the old agent may still be running. */
  status: 'running' | 'done' | 'failed' | 'abandoned'
  phase: InboxPhase
  /** Heartbeat: when the agent's conversation last changed; startedAt at the start. */
  lastActivityAt: number
  /** The tool call in flight, e.g. "Bash npm i". */
  waitingOn?: string
  /** Fingerprint of the agent's message rows at the last poll. */
  seen?: string
  /** The level last announced, so a toast fires once per level. */
  watch: InboxWatch
  redeploys?: number
}

/** A lock file in .inbox/.locks/, as last read. */
export type InboxLock = {
  task: number
  phase: InboxPhase
  session: string
  host?: string
  acquiredAt: string
  refreshedAt: string
  nonce: string
  released: boolean
  releasedAt?: string
}

export type InboxFilter = 'active' | 'all' | 'done'

declare module 'claude-code' {
  interface PluginState {
    inbox: {
      tasks: InboxTask[]
      runs: InboxRun[]
      selected: number | null
      filter: InboxFilter
      /** How many subagents a drain keeps busy; 0 when not draining. */
      drain: number
      now: number
      locks: InboxLock[]
      /** This session's id, kept so a reload still owns its locks. */
      sessionId: string
    }
  }
}
