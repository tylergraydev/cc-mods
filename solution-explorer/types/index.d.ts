export type ExEntry = { name: string; kind: 'file' | 'dir' | 'other'; isLink: boolean }
export type ExListing = { entries: ExEntry[]; error?: string; at: number }
export type ExProject = { name: string; file: string | null; dir: string; rawPath: string }
export type ExSolution = { file: string; name: string; projects: ExProject[]; others: number; error?: string }
export type GitCode = 'modified' | 'added' | 'untracked' | 'deleted' | 'renamed' | 'conflict'
export type ExGitMark = { code: GitCode; rel: string; from?: string }
export type ExGit = {
  /** keyOf(rel) -> mark; rel is relative to the explorer root */
  byPath: Record<string, ExGitMark>
  untrackedDirs: string[]
  /** set when git is off, missing, timed out or not a repo; drawn as one dim header note */
  note?: string
  at: number
  isRunning: boolean
}
/** keyOf(absolute path) -> the path as written and when it was last touched */
export type ExTouch = { abs: string; at: number }
export type ExFlags = { showHidden: boolean; changesOnly: boolean }
export type ExFilter = { text: string; searched: number; isPartial: boolean }
export type ExRules = { names: string[]; dirNames: string[]; paths: string[]; exts: string[]; unsupported: number }
/** What $.store keeps per root under `view:<keyOf(root)>` */
export type ExView = { expanded: string[]; showHidden: boolean; changesOnly: boolean }

declare module 'claude-code' {
  interface PluginState {
    'solution-explorer': {
      /** the effective root, slashed; '' before boot */
      root: string
      /** rel dir ('' = root) -> listing */
      listings: Record<string, ExListing>
      /** row ids that are open (sln, p:..., r, d:...) */
      expanded: string[]
      git: ExGit
      touched: Record<string, ExTouch>
      filter: ExFilter | null
      flags: ExFlags
      /** null = no .sln/.slnx found */
      solution: ExSolution | null
      rules: ExRules
      /** row id highlighted after /explorer show; cleared on the next press */
      reveal: string | null
    }
  }
}
