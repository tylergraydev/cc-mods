import type { FsEntry, ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { DoctorCheckId, DoctorHolder, DoctorMarkers, DoctorResult, DoctorStatus } from '../types'
import { gateText, join } from './gates'
import type { DoctorOpts } from './gates'
import {
  authKeys,
  classifyBash,
  evalAuthSecret,
  inRepo,
  matchesImage,
  parseCim,
  parseDockerPs,
  parseDotenvKeys,
  parseEnginesNode,
  parseGlobalJson,
  parseNetstat,
  parseNodeVersion,
  parseNodeWant,
  parseRuntimes,
  parseSdks,
  parseSecretsKeys,
  parseTasklistCsv,
  parseUserSecretsId,
  parseWhere,
  parseWorktrees,
  satisfies,
} from './parse'
import type { CimProc, SecretSource } from './parse'
import { psq } from './summary'

// Every check is read-only. The only processes started are where.exe,
// dotnet.exe (--version, --list-sdks, --list-runtimes), netstat.exe,
// tasklist.exe, powershell.exe (Get-CimInstance), git.exe (rev-parse,
// worktree list), docker.exe (ps) and node.exe (--version). Fix hints are
// text for the person to run, never executed here.

export type Sh = (argv: string[], init?: ProcessRunInit) => Promise<ProcessRunResult>

/**
 * What the checks may touch, built in register.tsx from `$`: the engine
 * interface cannot be followed across an import, so it is handed over as
 * these closures. There is no write among them.
 */
export type Io = {
  read: (path: string) => Promise<string>
  list: (path: string) => Promise<FsEntry[]>
  run: Sh
  now: () => Promise<number>
  env: {
    authSecret: () => Promise<string | undefined>
    appData: () => Promise<string | undefined>
    gitBash: () => Promise<string | undefined>
    nvm: () => Promise<string | undefined>
    fnm: () => Promise<string | undefined>
    volta: () => Promise<string | undefined>
  }
}

export type Ctx = {
  io: Io
  root: string
  markers: DoctorMarkers
  opts: DoctorOpts
  sh: Sh
}

/** What a check answers; the runner adds the id, name, gate and timing. */
export type CheckOut = { status: DoctorStatus; evidence: string; fix?: string; holders?: DoctorHolder[] }

const NAMES: Record<DoctorCheckId, string> = {
  bash: 'Bash on PATH',
  'dotnet-sdk': '.NET SDK',
  'dotnet-runtime': '.NET 8 runtime',
  ports: 'Port holders',
  'git-locks': 'Git locks',
  'git-worktrees': 'Git worktrees',
  docker: 'Docker',
  'auth-secret': 'AUTH_SECRET',
  node: 'Node',
  worker: 'Worker',
}

const LIMIT = 4
const TIMEOUT_MS = 10_000

/** A process runner for one run: memoized by argv, four at a time, 10 s each, in the project root. */
export function makeSh(io: Pick<Io, 'run'>, root: string): Sh {
  const memo = new Map<string, Promise<ProcessRunResult>>()
  let active = 0
  const waiting: (() => void)[] = []
  const slot = async () => {
    if (active >= LIMIT) await new Promise<void>(resolve => waiting.push(resolve))
    active += 1
  }
  const free = () => {
    active -= 1
    waiting.shift()?.()
  }
  return (argv, init) => {
    const key = JSON.stringify([argv, init?.env ?? null])
    const held = memo.get(key)
    if (held) return held
    const ran = (async () => {
      await slot()
      try {
        return await io.run(argv, { cwd: root, timeoutMs: TIMEOUT_MS, ...init })
      } finally {
        free()
      }
    })()
    memo.set(key, ran)
    return ran
  }
}

const firstLine = (text: string) => (text.split(/\r?\n/).find(line => line.trim() !== '') ?? '').trim().slice(0, 140)

/** `2h`, `12m`, `3d`: how long ago, for evidence only (never for the prompt). */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s}s`
  if (s < 5400) return `${Math.round(s / 60)}m`
  if (s < 129_600) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86_400)}d`
}

// ---- bash -----------------------------------------------------------------

export async function checkBash({ io, sh }: Ctx): Promise<CheckOut> {
  const ran = await sh(['where.exe', 'bash'])
  const envPath = await io.env.gitBash()
  return classifyBash(ran.exitCode === 0 ? parseWhere(ran.stdout) : [], envPath !== undefined && envPath !== '')
}

// ---- .NET -----------------------------------------------------------------

export async function checkDotnetSdk({ io, root, sh }: Ctx): Promise<CheckOut> {
  const req = parseGlobalJson(await io.read(join(root, 'global.json')).catch(() => ''))
  if (req === null) return { status: 'warn', evidence: 'global.json does not parse' }
  const version = await sh(['dotnet.exe', '--version']).catch(() => undefined)
  if (!version) {
    return { status: 'fail', evidence: 'dotnet not on PATH', fix: 'winget install --id Microsoft.DotNet.SDK.8 -e' }
  }
  const list = await sh(['dotnet.exe', '--list-sdks']).catch(() => undefined)
  const installed = parseSdks(list?.stdout ?? '').map(one => one.version)
  const want = req.version === undefined ? 'any SDK' : `${req.version} (${req.rollForward ?? 'patch'})`
  const major = /^\d+/.exec(req.version ?? '')?.[0] ?? '8'
  const fix = `winget install --id Microsoft.DotNet.SDK.${major} -e   # or edit rollForward in global.json`
  const parsed = satisfies(installed, req)
  if (version.exitCode !== 0) {
    return {
      status: 'fail',
      evidence: `global.json wants ${want}; have ${installed.join(', ') || 'none'}${firstLine(version.stdout + version.stderr) ? ` (${firstLine(version.stderr || version.stdout)})` : ''}`,
      fix,
    }
  }
  // dotnet's own answer wins; say so when the parser reads it differently.
  const note = parsed ? '' : `; parser: none of ${installed.join(', ') || 'no SDKs'} fits`
  return { status: 'pass', evidence: `${version.stdout.trim()} satisfies global.json ${want}${note}` }
}

export async function checkDotnetRuntime({ sh }: Ctx): Promise<CheckOut> {
  const ran = await sh(['dotnet.exe', '--list-runtimes']).catch(() => undefined)
  if (!ran) return { status: 'fail', evidence: 'dotnet not on PATH', fix: 'winget install --id Microsoft.DotNet.Runtime.8 -e' }
  const apps = parseRuntimes(ran.stdout).filter(one => one.name === 'Microsoft.NETCore.App')
  const eight = apps.filter(one => one.version.startsWith('8.'))
  if (eight.length > 0) return { status: 'pass', evidence: `Microsoft.NETCore.App ${eight.map(one => one.version).join(', ')}` }
  return {
    status: 'fail',
    evidence: `no Microsoft.NETCore.App 8.x; have ${apps.map(one => one.version).join(', ') || 'none'}`,
    fix: 'winget install --id Microsoft.DotNet.Runtime.8 -e',
  }
}

// ---- processes and ports ------------------------------------------------

/** Win32_Process rows for a WQL filter, bound to an environment variable so nothing is spliced into the command. */
async function cim(sh: Sh, filter: string): Promise<CimProc[]> {
  const ran = await sh(
    [
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process -Filter $env:DD_FILTER | Select ProcessId,Name,CreationDate,CommandLine | ConvertTo-Json -Compress',
    ],
    { env: { DD_FILTER: filter } },
  )
  return parseCim(ran.stdout)
}

/** The ports to watch: the option's, plus the AppHost's launchSettings applicationUrl ports. */
async function watchedPorts({ io, markers, opts }: Ctx): Promise<number[]> {
  const ports = new Set(opts.ports)
  if (markers.appHostDir) {
    const text = await io.read(join(markers.appHostDir, 'Properties/launchSettings.json')).catch(() => '')
    for (const url of text.matchAll(/"applicationUrl"\s*:\s*"([^"]+)"/g)) {
      for (const one of url[1]!.split(';')) {
        const port = /^https?:\/\/[^:/]+:(\d+)/.exec(one.trim())?.[1]
        if (port) ports.add(Number(port))
      }
    }
  }
  return [...ports].sort((a, b) => a - b)
}

export async function checkPorts(ctx: Ctx): Promise<CheckOut> {
  const { sh, root, io } = ctx
  const ports = await watchedPorts(ctx)
  if (ports.length === 0) return { status: 'skip', evidence: 'no ports to watch' }
  const [v4, v6] = await Promise.all([
    sh(['netstat.exe', '-ano', '-p', 'tcp']),
    sh(['netstat.exe', '-ano', '-p', 'tcpv6']).catch(() => undefined),
  ])
  const held = new Map<number, number>()
  for (const row of parseNetstat(`${v4.stdout}\n${v6?.stdout ?? ''}`)) {
    if (ports.includes(row.port) && !held.has(row.port)) held.set(row.port, row.pid)
  }
  if (held.size === 0) return { status: 'pass', evidence: `${ports.join(', ')} free` }

  const pids = [...new Set(held.values())]
  const tasks = parseTasklistCsv((await sh(['tasklist.exe', '/FO', 'CSV', '/NH']).catch(() => undefined))?.stdout ?? '')
  const procs = await cim(sh, pids.map(pid => `ProcessId=${pid}`).join(' OR ')).catch(() => [])
  const now = await io.now()

  const holders: (DoctorHolder & { cmd: string | null; up: string })[] = []
  for (const [port, pid] of held) {
    const proc = procs.find(one => one.pid === pid)
    const image = proc?.name || tasks.find(one => one.pid === pid)?.image || 'unknown'
    const cmd = proc?.cmd ?? null
    holders.push({
      port,
      pid,
      image,
      isOwn: cmd !== null && inRepo(cmd, root),
      cmd,
      up: proc?.created === undefined ? '' : `, up ${ago(now - proc.created)}`,
    })
  }

  let worst: DoctorStatus = 'warn'
  let fixPid: number | undefined
  const parts = holders.map(h => {
    if (h.isOwn) return `${h.port}: ${h.image} PID ${h.pid} (this repo${h.up}). Running: do not restart`
    if (h.cmd === null) return `${h.port}: ${h.image} PID ${h.pid}, unknown owner (command line unreadable)`
    worst = 'fail'
    fixPid ??= h.pid
    return `${h.port}: ${h.image} PID ${h.pid}${h.up}, cmd outside repo`
  })

  // Next quietly takes the next port when its own is busy.
  for (const b of holders) {
    const a = holders.find(h => h.port === b.port - 1)
    if (a && a.pid !== b.pid && !a.isOwn && /^node/i.test(b.image) && /next/i.test(b.cmd ?? '')) {
      parts.push(`Next moved to ${b.port} because ${a.port} is taken`)
      worst = 'fail'
      fixPid ??= a.pid
    }
  }

  const fix =
    worst === 'fail' && fixPid !== undefined
      ? `Get-Process -Id ${fixPid} | Select Id,ProcessName,StartTime,Path   # confirm it is stale, then: Stop-Process -Id ${fixPid}`
      : undefined
  return {
    status: worst,
    evidence: parts.join(' | '),
    ...(fix ? { fix } : {}),
    holders: holders.map(({ port, pid, image, isOwn }) => ({ port, pid, image, isOwn })),
  }
}

export async function checkWorker({ sh, markers, opts }: Ctx): Promise<CheckOut> {
  const tasks = await sh(['tasklist.exe', '/FO', 'CSV', '/NH'])
  const images = parseTasklistCsv(tasks.stdout)
  const apphost = opts.appHostProcess || (markers.appHostDir ?? '').replaceAll('\\', '/').split('/').pop() || ''
  let dotnet: CimProc[] | undefined
  const viaDotnet = async (name: string) => {
    dotnet ??= await cim(sh, "Name='dotnet.exe'").catch(() => [])
    return dotnet.find(p => (p.cmd ?? '').toLowerCase().includes(name.toLowerCase()))
  }
  const find = async (name: string) =>
    images.find(one => matchesImage(one.image, name)) ?? (await viaDotnet(name))
  if (!(await find(apphost))) return { status: 'skip', evidence: 'AppHost not running' }
  const found = await find(opts.workerProcess)
  const pid = found && 'pid' in found ? found.pid : undefined
  if (found) return { status: 'pass', evidence: `${opts.workerProcess} running${pid === undefined ? '' : ` (PID ${pid})`}` }
  return {
    status: 'fail',
    evidence: `AppHost is running but no process named ${opts.workerProcess}`,
    fix: `$apphost=${psq(markers.appHostDir ?? '.')}; dotnet run --project $apphost   # only if the app is meant to be up; ask first`,
  }
}

// ---- git ------------------------------------------------------------------

export async function checkGitLocks({ io, root, sh, opts }: Ctx): Promise<CheckOut> {
  const ran = await sh(['git.exe', 'rev-parse', '--git-dir', '--git-common-dir'])
  if (ran.exitCode !== 0) return { status: 'skip', evidence: 'not a git repository' }
  const [dir = '.git', common = dir] = ran.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const abs = (p: string) => (/^[A-Za-z]:|^[\\/]/.test(p) ? p : join(root, p))
  const gitDir = abs(dir)
  const commonDir = abs(common)

  const found: { path: string; mtimeMs: number }[] = []
  const scan = async (path: string, only?: string) => {
    for (const one of await io.list(path).catch(() => [])) {
      if (one.kind === 'file' && one.name.endsWith('.lock') && (only === undefined || one.name === only)) {
        found.push({ path: join(path, one.name), mtimeMs: one.mtimeMs })
      }
    }
  }
  await scan(gitDir)
  if (commonDir !== gitDir) await scan(commonDir)
  for (const one of (await io.list(join(commonDir, 'worktrees')).catch(() => [])).slice(0, 20)) {
    if (one.kind === 'dir') await scan(join(join(commonDir, 'worktrees'), one.name), 'index.lock')
  }
  if (found.length === 0) return { status: 'pass', evidence: 'no lock files' }

  const now = await io.now()
  const aged = found.map(one => ({ ...one, age: now - one.mtimeMs }))
  const stale = aged.find(one => one.age >= opts.lockStaleSeconds * 1000)
  const label = (one: (typeof aged)[number]) => `${one.path.split('/').pop()} ${ago(one.age)} old`
  if (!stale) return { status: 'warn', evidence: `${aged.map(label).join(', ')}; a git operation in progress?` }
  return {
    status: 'fail',
    evidence: `stale: ${aged.map(label).join(', ')}`,
    fix: `$lock = ${psq(stale.path)}; if (-not (Get-Process git -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath $lock }`,
  }
}

export async function checkWorktrees({ root, sh }: Ctx): Promise<CheckOut> {
  const ran = await sh(['git.exe', 'worktree', 'list', '--porcelain'])
  if (ran.exitCode !== 0) return { status: 'skip', evidence: 'not a git repository' }
  const trees = parseWorktrees(ran.stdout)
  const stale = trees.filter(one => one.prunable !== undefined)
  if (stale.length === 0) return { status: 'pass', evidence: `${trees.length} worktree${trees.length === 1 ? '' : 's'}, none prunable` }
  const r = psq(root)
  return {
    status: 'fail',
    evidence: `${stale.length} prunable: ${stale.map(one => one.path).join(', ')}`,
    fix: `git -C ${r} worktree prune --dry-run; git -C ${r} worktree prune`,
  }
}

// ---- docker ---------------------------------------------------------------

export async function checkDocker({ sh, opts }: Ctx): Promise<CheckOut> {
  const ran = await sh(
    ['docker.exe', 'ps', '-a', '--filter', 'status=exited', '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}'],
    { timeoutMs: 8000 },
  ).catch(() => undefined)
  if (!ran) return { status: 'skip', evidence: 'docker not installed' }
  if (ran.exitCode !== 0) {
    const text = ran.stderr + ran.stdout
    if (/error during connect|daemon|pipe/i.test(text)) return { status: 'skip', evidence: 'Docker Desktop not running' }
    if (/permission|denied|docker-users/i.test(text)) return { status: 'skip', evidence: 'no permission to reach Docker (docker-users group?)' }
    return { status: 'skip', evidence: `docker ps failed: ${firstLine(text)}` }
  }
  const exited = parseDockerPs(ran.stdout)
  const old = exited.filter(one => one.ageHours !== null && one.ageHours >= opts.dockerExitedHours)
  if (old.length === 0) return { status: 'pass', evidence: `${exited.length} exited, none older than ${opts.dockerExitedHours}h` }
  return {
    status: 'fail',
    evidence: `${old.length} exited over ${opts.dockerExitedHours}h: ${old.map(one => `${one.name} (${one.status.replace(/^Exited \(\d+\) /, '')})`).join(', ')}`,
    fix: `docker container ls -a --filter status=exited   # review first\ndocker container prune --filter 'until=${opts.dockerExitedHours}h'`,
  }
}

// ---- AUTH_SECRET: names only ------------------------------------------------

export async function checkAuthSecret({ io, root, markers }: Ctx): Promise<CheckOut> {
  const apphost = markers.appHostDir ?? root
  const sources: SecretSource[] = []

  const fromEnv = await io.env.authSecret()
  if (fromEnv !== undefined) sources.push({ label: 'environment', keys: new Map([['AUTH_SECRET', fromEnv !== '']]) })

  const dirs = [root, ...(await io.list(root).catch(() => [])).filter(one => one.kind === 'dir' && !/^(node_modules|bin|obj|\..*)$/i.test(one.name)).slice(0, 20).map(one => join(root, one.name))]
  for (const dir of dirs) {
    for (const name of ['.env', '.env.local']) {
      const text = await io.read(join(dir, name)).catch(() => undefined)
      if (text === undefined) continue
      const keys = parseDotenvKeys(text)
      if (authKeys(keys).length > 0) sources.push({ label: join(dir, name).slice(root.length + 1) || name, keys })
    }
  }

  const entries = await io.list(apphost).catch(() => [])
  let id: string | undefined
  for (const one of entries.filter(e => e.name.endsWith('.csproj'))) {
    id ??= parseUserSecretsId(await io.read(join(apphost, one.name)).catch(() => ''))
  }
  const appData = await io.env.appData()
  if (id && appData) {
    const text = await io.read(join(appData, `Microsoft/UserSecrets/${id}/secrets.json`)).catch(() => undefined)
    if (text !== undefined) sources.unshift({ label: 'user-secrets', keys: parseSecretsKeys(text) })
  }

  let isForwarded = false
  for (const one of entries.filter(e => e.name.endsWith('.cs'))) {
    const text = await io.read(join(apphost, one.name)).catch(() => '')
    if (/AUTH_SECRET|auth-secret/i.test(text)) isForwarded = true
  }
  return evalAuthSecret(sources, isForwarded, apphost)
}

// ---- node -------------------------------------------------------------------

export async function checkNode({ io, markers, opts, sh }: Ctx): Promise<CheckOut> {
  const ran = await sh(['node.exe', '--version']).catch(() => undefined)
  if (!ran || ran.exitCode !== 0) return { status: 'fail', evidence: 'node not on PATH', fix: 'winget install --id OpenJS.NodeJS.LTS -e' }
  const have = parseNodeVersion(ran.stdout)
  const dir = markers.nodeDir ?? '.'
  let want: number | undefined
  let from = 'config'
  for (const file of ['.nvmrc', '.node-version']) {
    want ??= parseNodeWant(await io.read(join(dir, file)).catch(() => ''))
    if (want !== undefined && from === 'config') from = file
  }
  if (want === undefined) {
    want = parseEnginesNode(await io.read(join(dir, 'package.json')).catch(() => ''))
    if (want !== undefined) from = 'package.json engines'
  }
  if (want === undefined) want = opts.nodeMajor
  const version = ran.stdout.trim()
  if (have === want) return { status: 'pass', evidence: `${version} (wants ${want} from ${from})` }

  const nvm = await io.env.nvm()
  const fnm = await io.env.fnm()
  const volta = await io.env.volta()
  const fix =
    fnm ? `fnm install ${want}; fnm use ${want}`
    : volta ? `volta install node@${want}`
    : nvm ? `nvm install ${want}; nvm use ${want}`
    : `winget install --id OpenJS.NodeJS -e   # then pick Node ${want}`
  return { status: 'fail', evidence: `${version}, but ${want} is wanted (from ${from})`, fix }
}

// ---- runner -----------------------------------------------------------------

const CHECKS: Record<DoctorCheckId, (ctx: Ctx) => Promise<CheckOut>> = {
  bash: checkBash,
  'dotnet-sdk': checkDotnetSdk,
  'dotnet-runtime': checkDotnetRuntime,
  ports: checkPorts,
  'git-locks': checkGitLocks,
  'git-worktrees': checkWorktrees,
  docker: checkDocker,
  'auth-secret': checkAuthSecret,
  node: checkNode,
  worker: checkWorker,
}

/** One check as a result: timed, with a throw turned into a SKIP. */
export async function runCheck(id: DoctorCheckId, ctx: Ctx): Promise<DoctorResult> {
  const started = await ctx.io.now()
  let out: CheckOut
  try {
    out = await CHECKS[id](ctx)
  } catch (error) {
    out = { status: 'skip', evidence: `could not run: ${String(error instanceof Error ? error.message : error).slice(0, 100)}` }
  }
  const at = await ctx.io.now()
  return { id, name: NAMES[id], ...out, gate: gateText(id, ctx.markers, ctx.root), ms: at - started, at }
}
