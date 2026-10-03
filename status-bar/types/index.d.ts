/** One plugin's latest status text, as the combined line holds it. */
export type BarSegment = {
  plugin: string
  /** The text the plugin pinned, cleaned. */
  text: string
  /** When it arrived, ms since the epoch. */
  at: number
}

export type BarMode = 'status' | 'band'

/** What `/statusbar` changes; stored across sessions. */
export type BarPrefs = {
  mode: BarMode
  isOn: boolean
  /** Lower-case plugin names whose statuses are dropped. */
  hidden: string[]
}

declare module 'claude-code' {
  interface PluginState {
    /** `prefs` is null until session.start has read the store. */
    'status-bar': { segments: Record<string, BarSegment>; prefs: BarPrefs | null }
  }
}
