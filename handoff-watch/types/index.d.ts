/** The latest reading of the context window against the auto-compact point. */
export type Meter = {
  /** Tokens over the ceiling, 0 to 1 and beyond; null until a response is read. */
  fill: number | null
  tokens: number | null
  window: number
  /** The token count fill is measured against: the auto-compact point, or the window. */
  ceiling: number
  ceilingSource: 'threshold' | 'window'
  isAutoCompact: boolean
  lastMeasuredAt: number
}

/** A handoff doc written or marked in this context. */
export type HandoffRecord = {
  fill: number | null
  path: string | null
  at: number
  /** The compaction count when it was made; behind `compactions` once a compaction ran. */
  epoch: number
  source: 'detected' | 'done'
}

/** The nudge on screen. */
export type Nudge = {
  band: number
  fill: number
  reason: 'quiet' | 'commit' | 'waited' | 'urgent'
  at: number
  turn: number
}

declare module 'claude-code' {
  interface PluginState {
    'handoff-watch': {
      meter: Meter
      lastHandoff: HandoffRecord | null
      nudge: Nudge | null
      firedBand: number | null
      urgentFired: boolean
      turnsWaited: number
      turns: number
      lastCheckpointTurn: number | null
      requestedPath: string | null
      compactions: number
      lastCompactAt: number | null
    }
  }
}
