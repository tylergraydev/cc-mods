export type CueId =
  | 'agent.spawn'
  | 'agent.done'
  | 'agent.failed'
  | 'permission.ask'
  | 'permission.autoDenied'
  | 'turn.done'
  | 'turn.failed'
  | 'session.compactAuto'
  | 'session.end'
  | 'tool.longBash'

/** `builtin:<name>`, `user:<filename>` or `off`. */
export type SoundId = string

/** `$.store` key `mapping`. */
export type SoundMapping = { version: 1; cues: Partial<Record<CueId, SoundId>> }

/** `$.store` key `mute`; `until` is null when not muted. */
export type MuteRecord = { until: number | null }

/** A .wav or .mp3 the person dropped in ~/.claude/sounds. */
export type UserSound = { file: string; path: string; size: number; mime: 'audio/wav' | 'audio/mpeg' }

export type KnownAgent = { description: string; isTop: boolean }

export type AudioHealth = { isUnavailable: boolean; reason?: string; hasToasted: boolean }

declare module 'claude-code' {
  interface PluginState {
    'sound-board': {
      mapping: SoundMapping
      /** ms since the epoch the mute ends; 8.64e15 is forever; null is not muted. */
      mutedUntil: number | null
      /** cue to ms; `*` is the last cue of any kind. */
      lastPlayed: Record<string, number>
      lastPriority: number
      audio: AudioHealth
      userSounds: UserSound[]
      known: Record<string, KnownAgent>
      isHeadless: boolean
      now: number
    }
  }
}
