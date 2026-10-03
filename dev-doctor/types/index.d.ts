export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip'

export type DoctorCheckId =
  | 'bash'
  | 'dotnet-sdk'
  | 'dotnet-runtime'
  | 'ports'
  | 'git-locks'
  | 'git-worktrees'
  | 'docker'
  | 'auth-secret'
  | 'node'
  | 'worker'

/** A process found holding a watched port. */
export type DoctorHolder = {
  port: number
  image: string
  pid: number
  /** True when its command line names this repo's root: the app is running. */
  isOwn: boolean
}

export type DoctorResult = {
  id: DoctorCheckId
  name: string
  status: DoctorStatus
  /** One line; never contains a secret value. */
  evidence: string
  /** Copy-pasteable PowerShell; paths single-quoted. Text only, never run. */
  fix?: string
  /** Why it ran or was skipped, e.g. "AppHost: src/Shop.AppHost". */
  gate: string
  /** The port check's holders, for the prompt section. */
  holders?: DoctorHolder[]
  ms: number
  at: number
}

export type DoctorMarkers = {
  isWindows: boolean
  isGit: boolean
  hasGlobalJson: boolean
  isDotnet: boolean
  appHostDir?: string
  isNode: boolean
  /** The folder holding the package.json that was found. */
  nodeDir?: string
  hasCompose: boolean
}

export type DoctorRun = {
  root: string
  reason: 'start' | 'timer' | 'command' | 'tool'
  startedAt: number
  finishedAt: number
  markers: DoctorMarkers
  results: DoctorResult[]
}

declare module 'claude-code' {
  interface PluginState {
    'dev-doctor': {
      run: DoctorRun | null
      isRunning: boolean
      toastedFails: DoctorCheckId[]
      expanded: string | null
    }
  }
}
