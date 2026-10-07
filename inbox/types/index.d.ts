/** Where an item is in its life, which is also the folder it sits in: `inbox/` itself is `todo`. */
export type InboxStatus = 'todo' | 'processing' | 'review' | 'done' | 'blocked'

/** Who implements an item: Codex (the `codex-runner` agent) for UI items, Claude otherwise. */
export type InboxWorker = 'codex' | 'claude'

/** The last watchdog level announced for a run; "timed out" is a property of the run, not of the item file. */
export type InboxWatch = 'active' | 'idle' | 'timedOut'
export type InboxPhase = 'work' | 'review'

/** One item, as its file `inbox/[<folder>/]<name>.md` holds it. */
export type InboxTask = {
  /** The file name without `.md`, e.g. `70-op-tutorial-step-engine`: how items name each other in `depends-on`. */
  name: string
  /** The number the name starts with; 0 when it has none. `/inbox run 70` finds the item by it. */
  id: number
  /** The path inside `inbox/`: `70-foo.md`, or `processing/70-foo.md`. */
  file: string
  /** The first `# ` heading, or the name. */
  title: string
  status: InboxStatus
  /** The folder the file sits in, as a status; differs from `status` when the file is misfiled. */
  folder: InboxStatus
  /** The front matter as written, every key in its order; the inbox reads some and preserves all. */
  fields: Record<string, string>
  ownerPaths: string[]
  dependsOn: string[]
  /** Who works it: the `worker` field, else routed from the owner paths. */
  worker: InboxWorker
  /** Everything after the front matter, unchanged. */
  body: string
  /** The `## Result` section the worker appended, when there is one. */
  result?: string
  /** The `## Review` section a reviewer appended, when there is one. */
  review?: string
}

/** A subagent working an item in this session, and how far it has got. */
export type InboxRun = {
  /** The item's name. */
  task: string
  agentId: string
  startedAt: number
  endedAt?: number
  tools: number
  errors: number
  lastTool?: string
  /** `abandoned`: replaced by a redeploy; the old agent may still be running. */
  status: 'running' | 'done' | 'failed' | 'abandoned'
  phase: InboxPhase
  worker: InboxWorker
  /** Heartbeat: when the agent's conversation last changed; startedAt at the start. */
  lastActivityAt: number
  /** The tool call in flight, e.g. "Bash npm i". */
  waitingOn?: string
  /** Fingerprint of the agent's message rows at the last poll. */
  seen?: string
  /** The level last announced, so a toast fires once per level. */
  watch: InboxWatch
  redeploys?: number
  /** When the agent list first showed the agent ended; the tick settles without a report once that is old enough. */
  endedSeenAt?: number
}

/** A lock file in inbox/.locks/, as last read. */
export type InboxLock = {
  /** The item's name. */
  task: string
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
      selected: string | null
      filter: InboxFilter
      /** How many subagents a drain keeps busy; 0 when not draining. */
      drain: number
      now: number
      locks: InboxLock[]
      /** This session's id, kept so a reload still owns its locks. */
      sessionId: string
      /** The repository the inbox/ folder was found in, absolute; '' while none is found. */
      root: string
      /** Mirror of the autoReview option, so the pane redraws when it is toggled. */
      autoReview: boolean
    }
  }
}
