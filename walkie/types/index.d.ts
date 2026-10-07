/** Who answers the drops: this session, another live session, or nobody yet. */
export type WalkieOwner = 'mine' | 'other' | 'free'

declare module 'claude-code' {
  interface PluginState {
    walkie: { owner: WalkieOwner }
  }
}
