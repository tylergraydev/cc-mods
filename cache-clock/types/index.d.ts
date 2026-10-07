export type Phase = 'idle' | 'working' | 'warm' | 'warn' | 'cold'

/** What the band and the status read: written by the tick, the turn hooks and the buttons. */
export type Reading = {
  /** When the last main-thread request ended, in clock ms; null before the first, and after a compact or a clear. */
  anchorAt: number | null
  /** True while a main-loop turn runs: every request in it refreshes the cache. */
  working: boolean
  phase: Phase
  /** Milliseconds until the cache lapses as of the last phase change; negative once it has. The tick recomputes it. */
  remainingMs: number
  /** Whole minutes since the lapse; 0 while warm. The band redraws when this changes. */
  coldMinutes: number
  /** The person pressed Keep going, or a button already acted: no band until the next lapse. */
  dismissed: boolean
  /** The context window's last reading, for the band's re-send estimate. */
  tokens: number | null
  percent: number | null
  /** True when a /handoff command is registered in this session (handoff-watch). */
  hasHandoff: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'cache-clock': {
      reading: Reading
      /** The TTL in force: the store's override, else the option. */
      ttlMinutes: number
      /** Draw the band after a lapse. */
      bandOn: boolean
    }
  }
}
