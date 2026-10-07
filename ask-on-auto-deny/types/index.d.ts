export type DenialOutcome = 'pending' | 'allowed' | 'used' | 'refused' | 'expired'
export type DenialSource = 'classic' | 'tool-result'
export type DecidedBy = 'band' | 'command' | 'dialog'

/** One auto-mode denial as recorded. */
export type Denial = {
  /** tool_use_id when known, else `d<seq>`. */
  id: string
  /** Display number, 1-based, increasing per session: `/auto-allow allow 3`. */
  n: number
  tool: string
  /** matchKey(tool, input): canonical JSON, or a length+hash form past 4000 chars. */
  key: string
  /** At most 120 chars: command head or file path. */
  summary: string
  /** Classifier reason, cut to 500 chars. */
  reason: string
  /** `Self-Modification`, or `classifier` when the reason has no [Tag]. */
  tag: string
  /** Set when the denial happened inside a subagent. */
  agentId?: string
  at: number
  source: DenialSource
  /** How many times this same call was denied while pending. */
  times: number
  outcome: DenialOutcome
  decidedAt?: number
  by?: DecidedBy
}

/** A one-shot permission for one exact call. */
export type Allowance = {
  denialId: string
  n: number
  tool: string
  key: string
  summary: string
  grantedAt: number
  expiresAt: number
  by: DecidedBy
}

export type AutoDenySession = {
  /** Ring buffer, newest last, at most 20. */
  denials: Denial[]
  /** Live one-shot allowances (also capped at 20). */
  allowances: Allowance[]
  /** Last `n` handed out. */
  seq: number
}

declare module 'claude-code' {
  interface PluginState {
    'ask-on-auto-deny': { session: AutoDenySession }
  }
}
