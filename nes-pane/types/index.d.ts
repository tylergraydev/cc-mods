/** Whether the game runs: not started, choosing a ROM, waiting for a key, or running. */
export type NesMode = 'off' | 'pick' | 'paused' | 'playing'

/** A button the pane holds down until it is let go: the terminal has no key-ups. */
export type NesLatch = 'left' | 'right' | 'b'

export type NesStatus = {
  mode: NesMode
  /** Why it is paused or stopped, shown under the picture (or above the picker). */
  note: string
  /** The game also shows in a window of its own, which takes its keys there. */
  isWindow: boolean
  /** The ROM's title, shown in the pane's title. */
  rom?: string
  /** The latched buttons, shown in the status line under the picture. */
  latched?: NesLatch[]
}

/** Where the picker found a ROM: the recent list, the romDir option, or the mod's run folder. */
export type NesRomSource = 'recent' | 'romDir' | 'run'

/** One row of the picker. */
export type NesRomEntry = {
  /** The file: a `.nes` ROM or a `.zip` that holds one. */
  path: string
  /** The file name without its folder or extension. */
  title: string
  source: NesRomSource
}

declare module 'claude-code' {
  interface PluginState {
    'nes-pane': { status: NesStatus; roms: NesRomEntry[] }
  }
}
