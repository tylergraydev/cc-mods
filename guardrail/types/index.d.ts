export type GuardKind = 'no-verify' | 'live'

export type GuardBlock = {
  kind: GuardKind
  /** Rule id: `git-no-verify`, `git-hooks-path`, `husky-off`, `sqlpackage`, ... */
  rule: string
  /** Dry-run key the live command needed (live only). */
  key?: string
  /** Short display label, e.g. `sqlpackage`, `sync-prod-to-stage.ps1`. */
  label: string
  /** Redacted, truncated to 160 chars. */
  command: string
  at: number
}

export type GuardDryRun = { key: string; label: string; rule: string; command: string; at: number }

export type GuardAllowance = {
  kind: GuardKind
  grantedAt: number
  expiresAt: number
  by: 'command' | 'band'
}

export type GuardSession = {
  /** One per key, newest replaces. */
  dryRuns: GuardDryRun[]
  /** Count of denies this session. */
  blocked: number
  /** Last unresolved block; drives the band. */
  pending: GuardBlock | null
  allowance: GuardAllowance | null
  /** Count of one-shot passes used. */
  allowed: number
}

declare module 'claude-code' {
  interface PluginState {
    guardrail: { session: GuardSession }
  }
}
