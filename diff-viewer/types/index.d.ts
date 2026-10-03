export type DvTool = 'Write' | 'Edit' | 'NotebookEdit'
export type DvKind = 'text' | 'patch' | 'binary' | 'unreadable' | 'too-large'
export type DvChange = {
  id: number
  /** as the tool wrote it, slashed */
  path: string
  /** keyOf(root, path): rel to the session root (or abs), lowercased on Windows */
  key: string
  /** display and @-reference spelling */
  rel: string
  tool: DvTool
  /** main-loop turn number: closedTurns + 1 at capture */
  turn: number
  /** set for a subagent's edit */
  agentId?: string
  at: number
  isNew: boolean
  kind: DvKind
  /** kind 'text' only */
  before?: string
  after?: string
  /** kind 'patch' only: unified hunks at max(contextLines, 3) */
  patch?: string
  /** -1 when unknown */
  add: number
  del: number
  note?: string
}
export type DvMode = 'turn' | 'session' | 'git'
export type DvView = {
  mode: DvMode
  /** null = the latest turn with changes */
  turn: number | null
  /** the open row id (t<N>:<key>, s:<key>, g:<key>) or null */
  open: string | null
  expandedTurns: number[]
  wrap: boolean
}
export type DvGitStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'binary'
export type DvGitFile = { key: string; rel: string; status: DvGitStatus; from?: string; hunks: string; add: number; del: number; isTooLarge: boolean }
export type DvGit = { files: DvGitFile[]; note?: string; isTruncated: boolean; ranAtTurn: number; isRunning: boolean }

declare module 'claude-code' {
  interface PluginState {
    'diff-viewer': {
      changes: DvChange[]
      /** main-loop turn.complete count this session */
      closedTurns: number
      nextId: number
      view: DvView
      git: DvGit | null
    }
  }
}
