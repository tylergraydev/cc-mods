/** One rate-limit window as last read. */
export type UsageWindow = {
  /** `5h`, `7d`, or another window's short name. */
  label: string
  /** 0 to 100 (past 100 on an exceeded spend limit). */
  percent: number
  /** When the window resets, ms since the epoch. */
  resetsAt?: number
  /** How long the window is, in ms; 0 when unknown. */
  lengthMs: number
}

/** One tool's latest reading. */
export type UsageSource = {
  windows: UsageWindow[]
  /** When the reading was taken, ms since the epoch. */
  seenAt: number
  plan?: string
}

export type UsagePoint = { t: number; p: number }

export type UsageSnapshot = {
  cc: UsageSource | null
  codex: UsageSource | null
  /** Keyed `cc:5h`, `codex:7d`, ... */
  history: Record<string, UsagePoint[]>
  /** The time the drawing counts down from. */
  now: number
  codexNote?: string
}

declare module 'claude-code' {
  interface PluginState {
    'usage-tracker': { snapshot: UsageSnapshot }
  }
}
