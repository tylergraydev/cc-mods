import type { DoctorCheckId, DoctorMarkers } from '../types'
import type { Io } from './checks'

export const CHECK_IDS: DoctorCheckId[] = [
  'bash',
  'dotnet-sdk',
  'dotnet-runtime',
  'ports',
  'git-locks',
  'git-worktrees',
  'docker',
  'auth-secret',
  'node',
  'worker',
]

/** The checks whose answer changes while the person works. */
export const VOLATILE_IDS: DoctorCheckId[] = ['ports', 'worker', 'docker', 'git-locks', 'git-worktrees']

export type DoctorOpts = {
  ports: number[]
  intervalMinutes: number
  nodeMajor: number
  workerProcess: string
  appHostProcess: string
  dockerExitedHours: number
  lockStaleSeconds: number
  disabled: string[]
  rerunAfterTools: boolean
  composeSection: boolean
}

const num = (value: unknown, fallback: number) => {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}
const str = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback)
const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)
const csv = (text: string) =>
  text
    .split(',')
    .map(part => part.trim())
    .filter(part => part !== '')

/** The mod's options with the manifest's defaults filled in. */
export function parseOpts(options: Record<string, unknown> | undefined): DoctorOpts {
  const o = options ?? {}
  return {
    ports: csv(str(o.ports, '3000,3001'))
      .map(Number)
      .filter(n => Number.isInteger(n) && n > 0 && n < 65536),
    intervalMinutes: num(o.intervalMinutes, 5),
    nodeMajor: num(o.nodeMajor, 22),
    workerProcess: str(o.workerProcess, 'Worker').trim(),
    appHostProcess: str(o.appHostProcess, '').trim(),
    dockerExitedHours: num(o.dockerExitedHours, 24),
    lockStaleSeconds: num(o.lockStaleSeconds, 120),
    disabled: csv(str(o.disabledChecks, '')).map(id => id.toLowerCase()),
    rerunAfterTools: flag(o.rerunAfterTools, true),
    composeSection: flag(o.composeSection, true),
  }
}

export const join = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '')}/${name}`

const SKIP_DIRS = /^(node_modules|bin|obj|dist|build|out|packages|\..*)$/i

/** What the project root holds: the facts every check's gate reads. */
export async function detectMarkers(io: Pick<Io, 'list'>, root: string): Promise<DoctorMarkers> {
  const listing = (dir: string) => io.list(dir).catch(() => [])
  const top = await listing(root)
  const src = top.some(one => one.kind === 'dir' && one.name === 'src') ? await listing(join(root, 'src')) : []
  const topDirs = top.filter(one => one.kind === 'dir' && !SKIP_DIRS.test(one.name)).slice(0, 30)

  let appHostDir: string | undefined
  const candidates = [
    ...topDirs.map(one => join(root, one.name)),
    ...src.filter(one => one.kind === 'dir').map(one => join(join(root, 'src'), one.name)),
  ]
  for (const dir of candidates) {
    if (!/AppHost$/i.test(dir)) continue
    if ((await listing(dir)).some(one => one.name.endsWith('.csproj'))) {
      appHostDir = dir
      break
    }
  }

  let nodeDir: string | undefined
  if (top.some(one => one.kind === 'file' && one.name === 'package.json')) nodeDir = root
  else {
    for (const one of topDirs) {
      if ((await listing(join(root, one.name))).some(file => file.name === 'package.json')) {
        nodeDir = join(root, one.name)
        break
      }
    }
  }

  return {
    isWindows: /^[A-Za-z]:/.test(root),
    isGit: top.some(one => one.name === '.git'),
    hasGlobalJson: top.some(one => one.kind === 'file' && one.name === 'global.json'),
    isDotnet: top.some(one => /\.slnx?$/i.test(one.name)),
    ...(appHostDir === undefined ? {} : { appHostDir }),
    isNode: nodeDir !== undefined,
    ...(nodeDir === undefined ? {} : { nodeDir }),
    hasCompose: top.some(one => one.kind === 'file' && /^(docker-)?compose.*\.ya?ml$/i.test(one.name)),
  }
}

/** Whether a project marker matched at all: the quiet rule's input. */
export const hasProjectMarker = (m: DoctorMarkers) =>
  m.hasGlobalJson || m.isDotnet || m.appHostDir !== undefined || m.isNode

/** Whether a check runs here: a pure table over the markers and the options. */
export function isApplicable(id: DoctorCheckId, m: DoctorMarkers, opts: DoctorOpts): boolean {
  if (opts.disabled.includes(id)) return false
  switch (id) {
    case 'bash':
      return m.isWindows
    case 'dotnet-sdk':
      return m.hasGlobalJson
    case 'dotnet-runtime':
      return m.hasGlobalJson || m.isDotnet || m.appHostDir !== undefined
    case 'ports':
      return m.isWindows && (m.isNode || m.appHostDir !== undefined)
    case 'git-locks':
    case 'git-worktrees':
      return m.isGit
    case 'docker':
      return m.appHostDir !== undefined || m.hasCompose
    case 'auth-secret':
      return m.appHostDir !== undefined
    case 'node':
      return m.isNode
    case 'worker':
      return m.appHostDir !== undefined && opts.workerProcess !== ''
  }
}

/** Why a check ran, for the pane: the marker that gated it in. */
export function gateText(id: DoctorCheckId, m: DoctorMarkers, root: string): string {
  const rel = (dir: string | undefined) =>
    dir === undefined ? '' : dir.replaceAll('\\', '/').replace(root.replaceAll('\\', '/').replace(/\/+$/, '') + '/', '')
  switch (id) {
    case 'bash':
      return 'every Windows repo'
    case 'dotnet-sdk':
      return 'global.json'
    case 'dotnet-runtime':
      return m.appHostDir ? `AppHost: ${rel(m.appHostDir)}` : m.hasGlobalJson ? 'global.json' : 'solution file'
    case 'ports':
    case 'node':
      return m.isNode ? `package.json: ${rel(m.nodeDir) || '.'}` : `AppHost: ${rel(m.appHostDir)}`
    case 'git-locks':
    case 'git-worktrees':
      return 'git repository'
    case 'docker':
      return m.appHostDir ? `AppHost: ${rel(m.appHostDir)}` : 'compose file'
    case 'auth-secret':
    case 'worker':
      return `AppHost: ${rel(m.appHostDir)}`
  }
}
