/** One sentence flagged as a confident, unbacked claim about external state. */
export type ClaimFlag = {
  /** ms since the epoch. */
  at: number
  turnId: string
  /** Whitespace-collapsed, capped at 300 chars. */
  sentence: string
  /** Certainty marker table id, e.g. `never-ran`. */
  marker: string
  /** State noun table id, e.g. `prod`. */
  noun: string
}

/** What the last checked main-loop turn came to. */
export type ClaimTurn = {
  turnId: string
  /** Sentences matched before suppression by evidence. */
  candidates: number
  /** Evidence-looking tool calls that succeeded this turn. */
  evidence: number
  /** Flags raised. */
  flagged: number
}

declare module 'claude-code' {
  interface PluginState {
    'claim-check': {
      /** Flagged this session; drives the status line. */
      unverified: number
      /** Most recent, newest last, capped at 50. */
      flags: ClaimFlag[]
      /** For `/claim-check`. */
      lastTurn: ClaimTurn | null
    }
  }
}
