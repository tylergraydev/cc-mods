import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PROPS = { title: 'Explorer', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const
const GIT_ARGV = ['git.exe', '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=normal']

type Sandbox = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]
type Opts = { workbench?: boolean; refuse?: string[] }
type Entry = { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean }

const norm = (p: string) => p.split('\\').join('/').toLowerCase()
const file = (name: string): Entry => ({ name, kind: 'file', size: 1, mtimeMs: 1, isLink: false })
const dir = (name: string): Entry => ({ name, kind: 'dir', size: 0, mtimeMs: 1, isLink: false })

/** The engine beneath the mod: a small disk, git answering `w.porcelain`, and records of every call the mod makes. */
function world($: Sandbox, on: On, opts: Opts = {}) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-03T10:00:00Z') })
  mock.store(on)
  const w = {
    clock,
    porcelain: '',
    revExit: 0,
    deny: false,
    delay: 0,
    inFlight: 0,
    maxInFlight: 0,
    opened: [] as string[],
    closed: [] as string[],
    toasts: [] as string[],
    listed: [] as string[],
    registered: [] as string[],
    fills: [] as { text: string; mode?: string }[],
    runs: [] as { argv: readonly string[]; init: { cwd?: string; timeoutMs?: number } | undefined }[],
    statusRuns: 0,
    DIRS: {
      'c:/repo': [dir('src'), file('a.ts'), file('b.ts'), dir('bin')],
      'c:/repo/src': [file('x.ts')],
    } as Record<string, Entry[]>,
    FILES: {} as Record<string, string>,
  }
  on('session.root', async () => ({ value: 'C:\\repo' }))
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('command.register', async (_, e) => {
    w.registered.push(e.name)
    return opts.refuse?.includes(e.name) ? { deny: 'built-in' } : { value: { command: e.name } }
  })
  on('command.list', async () => ({ value: opts.workbench ? [{ name: 'workbench', description: '', source: 'plugin' }] : [] }) as never)
  on('ui.open', async (_, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', async (_, e) => {
    w.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.toast', async (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.list', async (_, e) => {
    w.listed.push(norm(e.path))
    const found = w.DIRS[norm(e.path)]
    return found ? { value: found } : { deny: 'ENOENT' }
  })
  on('fs.read', async (_, e) => {
    const found = w.FILES[norm(e.path)]
    return found === undefined ? { deny: 'ENOENT' } : { value: found }
  })
  on('fs.exists', async (_, e) => ({ value: norm(e.path) in w.DIRS || norm(e.path) in w.FILES }))
  on('fs.stat', async (_, e) => {
    if (norm(e.path) in w.DIRS) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 1, isLink: false } }
    if (norm(e.path) in w.FILES) return { value: { kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false } }
    return { deny: 'ENOENT' }
  })
  on('fs.write', () => {
    throw new Error('read-only mod wrote')
  })
  const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', async (_, e) => {
    w.runs.push({ argv: e.argv, init: e.init })
    if (e.argv[0] !== 'git.exe') return { deny: 'unexpected' }
    if (e.argv[1] === 'rev-parse') return out('\n', w.revExit)
    w.statusRuns += 1
    w.inFlight += 1
    w.maxInFlight = Math.max(w.maxInFlight, w.inFlight)
    if (w.delay > 0) await clock.sleep(w.delay)
    w.inFlight -= 1
    return out(w.porcelain)
  })
  on('prompt.read', async () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', async (_, e) => {
    w.fills.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })
  on('tool.call', async () => (w.deny ? { deny: 'no' } : { result: {} as never, text: 'ok' }))
  on('turn.complete', async (_, e) => ({ text: e.answer }))
  on('ui.render', async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })

  const command = (args: string, name = 'explorer') => $.command.run({ command: name, args } as Parameters<typeof $.command.run>[0])
  const mount = (surface: 'terminal' | 'desktop' = 'terminal') =>
    $.ui.mount({ plugin: 'solution-explorer', surface, component: 'Pane', requestId: 'solution-explorer', props: PROPS } as never)
  const write = (path: string) => $.tool.call({ tool: 'Write', file_path: path, content: 'x' } as never)
  const turn = async (extra: object = {}) => {
    await $.turn.complete({ answer: 'ok', text: 'ok', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't1', ...extra } as Parameters<typeof $.turn.complete>[0])
    await clock.settle()
  }
  return Object.assign(w, { command, mount, write, turn })
}

test('/explorer opens the dock first when the workbench is there, then the pane', async ($, on) => {
  const w = world($, on, { workbench: true })
  const r = await w.command('')
  expect(String(r.text)).toContain('Explorer opened')
  expect(w.opened).toEqual(['workbench', 'solution-explorer'])
})

test('without the workbench the pane opens alone', async ($, on) => {
  const w = world($, on, { workbench: false })
  await w.command('')
  expect(w.opened).toEqual(['solution-explorer'])
})

test('the tree draws on both surfaces, hiding bin until Hidden is pressed', async ($, on) => {
  const w = world($, on)
  await w.command('')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await w.mount(surface)
    expect(await ui.find({ key: 'n:d:src' })).toBeDefined()
    expect(await ui.find({ key: 'n:f:a.ts' })).toBeDefined()
    expect(await ui.find({ key: 'n:f:b.ts' })).toBeDefined()
    expect(await ui.find({ key: 'n:d:bin' })).toBeUndefined()
    await ui.press({ key: 'hidden' })
    expect(await ui.find({ key: 'n:d:bin' })).toBeDefined()
    await ui.press({ key: 'hidden' })
    await ui.unmount()
  }
})

test('a folder is listed when it is first opened, and closes again', async ($, on) => {
  const w = world($, on)
  await w.command('')
  // finding a solution peeks one level down, so count the listings instead of asking for none
  const peeked = w.listed.filter(one => one === 'c:/repo/src').length
  const ui = await w.mount()
  await ui.press({ key: 'n:d:src' })
  expect(w.listed.filter(one => one === 'c:/repo/src').length).toBe(peeked + 1)
  expect(await ui.find({ key: 'n:f:src/x.ts' })).toBeDefined()
  await ui.press({ key: 'n:d:src' })
  expect(await ui.find({ key: 'n:f:src/x.ts' })).toBeUndefined()
  await ui.unmount()
})

test('a file click appends an @reference to the prompt', async ($, on) => {
  const w = world($, on)
  await w.command('')
  const ui = await w.mount()
  await ui.press({ key: 'n:f:a.ts' })
  expect(w.fills[0]).toEqual({ text: '@a.ts ', mode: 'append' })
  await ui.unmount()
})

test('a Write marks the row and counts in the header', async ($, on) => {
  const w = world($, on)
  await w.command('')
  await w.write('C:\\repo\\a.ts')
  const ui = await w.mount()
  expect((await ui.find({ key: 'mark:f:a.ts' }))?.text).toContain('●')
  expect((await ui.find({ key: 'hdr-sum' }))?.text).toContain('1 touched')
  await ui.unmount()
})

test('a denied Write does not mark', async ($, on) => {
  const w = world($, on)
  await w.command('')
  w.deny = true
  await w.write('C:\\repo\\b.ts')
  const ui = await w.mount()
  expect((await ui.find({ key: 'mark:f:b.ts' }))?.text ?? '').not.toContain('●')
  await ui.unmount()
})

test('other tool calls pass through untouched, with no disk or git work', async ($, on) => {
  const w = world($, on)
  await w.command('')
  const listed = w.listed.length
  const ran = w.runs.length
  const r = await $.tool.call({ tool: 'Bash', command: 'echo hi' } as never)
  expect(r.text).toBe('ok')
  expect(w.listed.length).toBe(listed)
  expect(w.runs.length).toBe(ran)
  const ui = await w.mount()
  expect((await ui.find({ key: 'hdr-sum' }))?.text).toContain('0 touched')
  await ui.unmount()
})

test('Changes shows only what was touched, and toggles back', async ($, on) => {
  const w = world($, on)
  await w.command('')
  await w.write('C:\\repo\\a.ts')
  const ui = await w.mount()
  await ui.press({ key: 'changes' })
  expect(await ui.find({ key: 'n:f:a.ts' })).toBeDefined()
  expect(await ui.find({ key: 'n:f:b.ts' })).toBeUndefined()
  await ui.press({ key: 'changes' })
  expect(await ui.find({ key: 'n:f:b.ts' })).toBeDefined()
  await ui.unmount()
})

test('a git porcelain line marks the row, and git is asked the safe way', async ($, on) => {
  const w = world($, on)
  w.porcelain = ' M b.ts\0'
  await w.command('')
  const ui = await w.mount()
  expect((await ui.find({ key: 'git:f:b.ts' }))?.text).toContain('M')
  const status = w.runs.find(r => r.argv[1] === '--no-optional-locks')
  expect(status?.argv).toEqual(GIT_ARGV)
  expect(status?.init?.cwd).toBe('C:/repo')
  expect(status?.init?.timeoutMs).toBe(5000)
  await ui.unmount()
})

test('git runs when a main-loop turn ends, never for a subagent, never twice at once', async ($, on) => {
  const w = world($, on)
  await w.command('')
  const base = w.statusRuns
  await w.turn({ agentId: 'sub-1' })
  expect(w.statusRuns).toBe(base)
  await w.turn()
  expect(w.statusRuns).toBe(base + 1)

  w.delay = 10
  w.maxInFlight = 0
  const before = w.statusRuns
  await w.turn()
  await w.turn()
  await w.clock.advance(20)
  await w.clock.advance(20)
  expect(w.statusRuns - before).toBeLessThanOrEqual(2)
  expect(w.maxInFlight).toBe(1)
})

test('outside a repo the header says so and nothing toasts', async ($, on) => {
  const w = world($, on)
  w.revExit = 128
  await w.command('')
  await w.turn()
  await w.turn()
  const ui = await w.mount()
  expect((await ui.find({ key: 'hdr-sum' }))?.text).toContain('not a git repository')
  expect(w.toasts).toEqual([])
  expect(w.statusRuns).toBe(0)
  await ui.unmount()
})

test('a refused name falls back to /solution-explorer', async ($, on) => {
  const w = world($, on, { refuse: ['explorer'] })
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  expect(w.registered).toContain('solution-explorer')
  const r = await w.command('', 'solution-explorer')
  expect(String(r.text)).toContain('Explorer opened')
})

test('a solution file groups the tree by project', async ($, on) => {
  const w = world($, on)
  w.DIRS['c:/repo'] = [dir('src'), file('app.sln')]
  w.DIRS['c:/repo/src'] = [dir('App')]
  w.DIRS['c:/repo/src/app'] = [file('A.cs')]
  w.FILES['c:/repo/app.sln'] =
    'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "src\\App\\App.csproj", "{11111111-1111-1111-1111-111111111111}"\r\nEndProject\r\n'
  await w.command('')
  const ui = await w.mount()
  expect(await ui.find({ key: 'n:sln' })).toBeDefined()
  expect(await ui.find({ key: 'n:p:src/App' })).toBeDefined()
  expect(await ui.find({ key: 'n:r' })).toBeDefined()
  await ui.unmount()
})

test('find walks the folders and shows the matches, and clear removes the filter', async ($, on) => {
  const w = world($, on)
  const r = await w.command('find x')
  expect(String(r.text)).toContain('Showing names containing "x"')
  const ui = await w.mount()
  expect(await ui.find({ key: 'n:f:src/x.ts' })).toBeDefined()
  expect(await ui.find({ key: 'filter-row' })).toBeDefined()
  await ui.press({ key: 'clear-filter' })
  expect(await ui.find({ key: 'filter-row' })).toBeUndefined()
  await ui.unmount()
})
