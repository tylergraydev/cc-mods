import { expect, mock, test } from 'claude-code/testing'
import type { FsEntry } from 'claude-code'

const PROPS = { title: 'Doctor', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const

const SECRET = 'SUPERSECRETVALUE'
const ROOT = 'C:/repo'
const APPHOST = `${ROOT}/src/Shop.AppHost`

const entry = (name: string, kind: 'file' | 'dir'): FsEntry => ({ name, kind, size: 1, mtimeMs: 1, isLink: false })

// A Windows repo with a pinned SDK, an AppHost, a Next app and some trouble.
const DIRS: Record<string, FsEntry[]> = {
  [ROOT]: [entry('.git', 'dir'), entry('global.json', 'file'), entry('Shop.sln', 'file'), entry('src', 'dir'), entry('web', 'dir')],
  [`${ROOT}/src`]: [entry('Shop.AppHost', 'dir')],
  [APPHOST]: [entry('Shop.AppHost.csproj', 'file'), entry('Program.cs', 'file')],
  [`${ROOT}/web`]: [entry('package.json', 'file'), entry('.nvmrc', 'file')],
}
const FILES: Record<string, string> = {
  [`${ROOT}/global.json`]: '{ "sdk": { "version": "9.0.100", "rollForward": "latestFeature" } }',
  [`${APPHOST}/Shop.AppHost.csproj`]: '<Project><PropertyGroup><UserSecretsId>abc-123</UserSecretsId></PropertyGroup></Project>',
  [`${APPHOST}/Program.cs`]: 'builder.AddParameter("auth-secret", secret: true);',
  'C:/appdata/Microsoft/UserSecrets/abc-123/secrets.json': JSON.stringify({ Parameters: { 'auth-secret': SECRET } }),
  [`${ROOT}/web/.nvmrc`]: '22\n',
  [`${ROOT}/web/package.json`]: '{}',
}

const NETSTAT = [
  '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       18232',
  '  TCP    [::]:3001              [::]:0                 LISTENING       2210',
].join('\r\n')
const TASKS = ['"node.exe","18232","Console","1","45,000 K"', '"node.exe","2210","Console","1","30,000 K"', '"Shop.AppHost.exe","5","Console","1","9,000 K"', '"Worker.exe","6","Console","1","9,000 K"'].join('\r\n')
const CIM = JSON.stringify([
  { ProcessId: 18232, Name: 'node.exe', CreationDate: '/Date(1790000000000)/', CommandLine: 'node C:\\code\\old-shop\\web\\next dev' },
  { ProcessId: 2210, Name: 'node.exe', CreationDate: '/Date(1790000000000)/', CommandLine: 'node C:\\repo\\web\\next dev' },
])

// the engine may hand the hooks backslashed paths
const norm = (p: string) => p.split('\\').join('/')

const out = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })

test('start, /dev-doctor, the timer and the pane, all read-only', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-03T10:00:00Z') })
  mock.env(on, { APPDATA: 'C:/appdata', AUTH_SECRET: SECRET })

  const ran: string[][] = []
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  on('session.root', async () => ({ value: ROOT }))
  on('fs.read', async (_, e) => (norm(e.path) in FILES ? { value: FILES[norm(e.path)]! } : { deny: 'ENOENT' }))
  on('fs.list', async (_, e) => ({ value: DIRS[norm(e.path)] ?? [] }))
  on('fs.exists', async (_, e) => ({ value: norm(e.path) in FILES || norm(e.path) in DIRS }))
  on('fs.stat', async () => ({ deny: 'ENOENT' }))
  // The mod is read-only: any write is a failure.
  on('fs.write', () => {
    throw new Error('read-only mod wrote')
  })
  on('process.run', async (_, e) => {
    ran.push([...e.argv])
    const exe = e.argv[0]!.toLowerCase()
    const arg = e.argv[1] ?? ''
    if (exe === 'docker.exe') return { deny: 'ENOENT' }
    if (exe === 'where.exe') return out('C:\\Windows\\System32\\bash.exe\r\nC:\\Program Files\\Git\\bin\\bash.exe\r\n')
    if (exe === 'dotnet.exe') {
      if (arg === '--version') return out('', 1, 'A compatible .NET SDK was not found.')
      if (arg === '--list-sdks') return out('8.0.404 [C:\\Program Files\\dotnet\\sdk]')
      return out('Microsoft.NETCore.App 8.0.11 [C:\\Program Files\\dotnet\\shared\\Microsoft.NETCore.App]')
    }
    if (exe === 'netstat.exe') return out(e.argv[3] === 'tcp' ? NETSTAT : '')
    if (exe === 'tasklist.exe') return out(TASKS)
    if (exe === 'powershell.exe') return out(e.init?.env?.DD_FILTER?.startsWith('ProcessId') ? CIM : '[]')
    if (exe === 'git.exe') return out(arg === 'rev-parse' ? '.git\n.git\n' : `worktree ${ROOT}\nHEAD abc\nbranch refs/heads/main\n`)
    if (exe === 'node.exe') return out('v22.11.0\n')
    return { deny: `unexpected process ${exe}` }
  })
  on('ui.status', async (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', async (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('ui.close', async () => ({ value: undefined }))
  on('command.register', async (_, e) => ({ value: { command: e.name } }))
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('prompt.compose', async () => ({ sections: [] }))
  const runCommand = (args: string) => $.command.run({ command: 'dev-doctor', args } as Parameters<typeof $.command.run>[0])
  const whereRuns = () => ran.filter(argv => argv[0] === 'where.exe').length

  // Session start runs the checks in the background and shows the status line.
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.advance(10)
  expect(whereRuns()).toBe(1)
  expect(statuses.at(-1)).toMatch(/^doctor: \d+\/\d+ ✗$/)
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toBe('dev-doctor FAIL: bash, dotnet-sdk, ports — /dev-doctor')

  // /dev-doctor: a summary for the model; the same fails do not toast again.
  const first = await runCommand('')
  const text = String(first.text)
  expect(whereRuns()).toBe(2)
  expect(toasts).toHaveLength(1)
  expect(text).toContain('FAIL Port holders: 3000: node.exe PID 18232')
  expect(text).toContain('cmd outside repo')
  expect(text).toContain('3001: node.exe PID 2210 (this repo')
  expect(text).toContain('Running: do not restart')
  expect(text).toContain('FAIL .NET SDK: global.json wants 9.0.100 (latestFeature); have 8.0.404')
  expect(text).toContain('SKIP Docker: docker not installed')
  expect(text).toContain('PASS Node: v22.11.0 (wants 22 from .nvmrc)')
  expect(text).toContain('PASS Worker: Worker running')
  expect(text).toContain('found in: user-secrets (Parameters:auth-secret), environment (AUTH_SECRET)')
  expect(text).not.toContain(SECRET)
  expect(toasts.join('\n')).not.toContain(SECRET)

  // The prompt section names the fails and the running app, in at most four lines.
  const composed = await $.prompt.compose({ model: 'claude-sonnet-5-5', promptModel: 'claude-sonnet-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  const section = composed.sections.find(s => s.id === 'dev-doctor:env')
  expect(section?.scope).toBe('session')
  expect(section?.text).toContain('FAIL bash, dotnet-sdk, ports')
  expect(section?.text).toContain('3001 node.exe PID 2210')
  expect(section?.text.split('\n').length).toBeLessThanOrEqual(4)
  expect(section?.text).not.toContain(SECRET)

  // The timer re-runs.
  await clock.advance(5 * 60_000)
  expect(whereRuns()).toBe(3)

  // The pane on both surfaces: rows by key, Re-run runs again.
  for (const surface of ['terminal', 'desktop'] as const) {
    const before = whereRuns()
    const ui = await $.ui.mount({ plugin: 'dev-doctor', surface, component: 'Pane', requestId: 'dev-doctor', props: PROPS })
    expect(await ui.find({ key: 'row-ports' })).toBeDefined()
    expect(await ui.find({ key: 'row-bash' })).toBeDefined()
    expect(await ui.find({ key: 'copy-ports' })).toBeDefined()
    await ui.press({ key: 'rerun' })
    expect(whereRuns()).toBe(before + 1)
    await ui.unmount()
  }

  // /dev-doctor close
  expect(String((await runCommand('close')).text)).toContain('closed')

  // Read-only: nothing that kills, stops, prunes or lists secrets was ever run.
  const BAD = /kill|Stop-Process|taskkill|\brm\b|prune(?! --dry-run)|docker\s+(rm|stop|kill)|user-secrets\s+list/i
  expect(ran.filter(argv => BAD.test(argv.join(' ')))).toEqual([])
  const exes = new Set(ran.map(argv => argv[0]!.toLowerCase()))
  expect([...exes].sort()).toEqual(['dotnet.exe', 'docker.exe', 'git.exe', 'netstat.exe', 'node.exe', 'powershell.exe', 'tasklist.exe', 'where.exe'].sort())
})

test('a quiet folder shows no status line', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-03T10:00:00Z') })
  mock.env(on, {})
  const statuses: (string | undefined)[] = []
  on('session.root', async () => ({ value: 'C:/code/cc-mods' }))
  on('fs.read', async () => ({ deny: 'ENOENT' }))
  on('fs.list', async () => ({ value: [] }))
  on('fs.write', () => {
    throw new Error('read-only mod wrote')
  })
  on('process.run', async () => {
    return out('C:\\Program Files\\Git\\bin\\bash.exe\r\n')
  })
  on('ui.status', async (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', async () => ({ value: undefined }))
  on('command.register', async (_, e) => ({ value: { command: e.name } }))
  on('session.start', async (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: 'C:/code/cc-mods', surface: 'terminal', isInteractive: true })
  await clock.advance(10)
  // Only the bash check runs here, and it passes: the status line is cleared.
  expect(statuses.at(-1)).toBe(undefined)
  expect(statuses.length).toBeGreaterThan(0)
})
