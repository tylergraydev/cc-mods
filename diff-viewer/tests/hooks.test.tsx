import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PROPS = { title: 'Diff', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const
const GIT_ARGV = ['git.exe', '--no-optional-locks', '-c', 'core.quotepath=off', 'diff', 'HEAD', '--no-color', '--no-ext-diff', '--relative', '--unified=3', '--']
const GIT_OUT = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,1 +1,2 @@',
  ' keep',
  '+added',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -1,1 +1,1 @@',
  '-x',
  '+y',
  '',
].join('\n')

type Sandbox = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]
type Opts = { workbench?: boolean; refuse?: string[] }

const norm = (p: string) => p.split('\\').join('/').toLowerCase()

/** The engine beneath the mod: a small disk, git answering `w.gitOut`, and records of every call the mod makes. */
function world($: Sandbox, on: On, opts: Opts = {}) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-03T10:00:00Z') })
  mock.store(on)
  const w = {
    clock,
    gitOut: GIT_OUT,
    gitExit: 0,
    gitErr: '',
    draft: '',
    deny: false,
    error: false,
    opened: [] as string[],
    closed: [] as string[],
    toasts: [] as string[],
    registered: [] as string[],
    log: [] as string[],
    fills: [] as { text: string; mode?: string }[],
    runs: [] as { argv: readonly string[]; init: { cwd?: string; timeoutMs?: number } | undefined }[],
    FILES: new Map<string, string>(),
  }
  on('session.root', async () => ({ value: 'C:/repo' }))
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('session.end', async () => ({ sessionId: 's1' }))
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
  on('ui.scroll', async () => ({}))
  on('fs.read', async (_, e) => {
    w.log.push(`read:${norm(e.path)}`)
    const found = w.FILES.get(norm(e.path))
    return found === undefined ? { deny: 'ENOENT' } : { value: found }
  })
  on('fs.exists', async (_, e) => ({ value: w.FILES.has(norm(e.path)) }))
  on('fs.write', () => {
    throw new Error('read-only mod wrote')
  })
  on('process.run', async (_, e) => {
    w.runs.push({ argv: e.argv, init: e.init })
    return { value: { exitCode: w.gitExit, stdout: w.gitOut, stderr: w.gitErr, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.read', async () => ({ value: { text: w.draft, cursor: w.draft.length } }))
  on('prompt.fill', async (_, e) => {
    w.fills.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })
  // a tool that really changes the stub disk
  on('tool.call', async (_, e: any) => {
    w.log.push(`tool:${e.tool}`)
    if (w.deny) return { deny: 'no' }
    if (w.error) return { isError: true, result: undefined, text: 'boom' } as never
    if (e.tool === 'Write') w.FILES.set(norm(e.file_path), e.content)
    if (e.tool === 'Edit') w.FILES.set(norm(e.file_path), (w.FILES.get(norm(e.file_path)) ?? '').replace(e.old_string, e.new_string))
    return { result: {} as never, text: 'ok' }
  })
  on('turn.complete', async (_, e) => ({ text: e.answer }))
  on('ui.render', async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return e.requestId === 'workbench' ? (
      <Box key="frame">
        <Box key="slot-diff-viewer" width={40} />
      </Box>
    ) : (
      <Box key="engine" />
    )
  })

  const command = (args: string, name = 'diff') => $.command.run({ command: name, args } as Parameters<typeof $.command.run>[0])
  const write = (p: string, content: string, extra: object = {}) => $.tool.call({ tool: 'Write', file_path: p, content, ...extra } as never)
  const edit = (p: string, from: string, to: string) => $.tool.call({ tool: 'Edit', file_path: p, old_string: from, new_string: to } as never)
  const turnEnd = (agentId?: string) =>
    $.turn.complete({ answer: 'ok', text: 'ok', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't', ...(agentId ? { agentId } : {}) } as never)
  const mount = (surface: 'terminal' | 'desktop' = 'terminal', requestId = 'diff-viewer') =>
    $.ui.mount({ plugin: 'diff-viewer', surface, component: 'Pane', requestId, props: PROPS } as never)
  return Object.assign(w, { command, write, edit, turnEnd, mount })
}

test('/diff opens the dock first when the workbench is there, then the pane', async ($, on) => {
  const w = world($, on, { workbench: true })
  const r = await w.command('')
  expect(String(r.text)).toContain('Diff opened')
  expect(w.opened).toEqual(['workbench', 'diff-viewer'])
})

test('without the workbench the pane opens alone', async ($, on) => {
  const w = world($, on, { workbench: false })
  await w.command('')
  expect(w.opened).toEqual(['diff-viewer'])
})

test('a Write is read before and after, and drawn with its hunk', async ($, on) => {
  const w = world($, on)
  w.FILES.set('c:/repo/a.ts', 'one\n')
  await w.write('C:\\repo\\a.ts', 'one\ntwo\n')
  expect(w.log.indexOf('read:c:/repo/a.ts')).toBeLessThan(w.log.indexOf('tool:Write'))
  expect(w.log.lastIndexOf('read:c:/repo/a.ts')).toBeGreaterThan(w.log.indexOf('tool:Write'))
  const ui = await w.mount()
  expect((await ui.find({ key: 'st:t1:a.ts' }))?.text).toContain('+1')
  await ui.press({ key: 'f:t1:a.ts' })
  const hunk = await ui.find({ key: 'hunk:t1:a.ts:0' })
  expect(JSON.stringify(hunk)).toContain('+two')
  expect(JSON.stringify(hunk)).toContain('@@ -1,1 +1,2 @@')
  await ui.unmount()
})

test('a new file is tagged new', async ($, on) => {
  const w = world($, on)
  await w.write('C:/repo/new.ts', 'x\ny\n')
  const ui = await w.mount()
  expect((await ui.find({ key: 'tag:t1:new.ts' }))?.text).toContain('new')
  expect((await ui.find({ key: 'st:t1:new.ts' }))?.text).toContain('+2')
  await ui.unmount()
})

test('an Edit is captured with its before and after lines', async ($, on) => {
  const w = world($, on)
  w.FILES.set('c:/repo/a.ts', 'x = 1\n')
  await w.edit('C:/repo/a.ts', 'x = 1', 'x = 2')
  const ui = await w.mount()
  await ui.press({ key: 'f:t1:a.ts' })
  const hunk = JSON.stringify(await ui.find({ key: 'hunk:t1:a.ts:0' }))
  expect(hunk).toContain('-x = 1')
  expect(hunk).toContain('+x = 2')
  await ui.unmount()
})

for (const mode of ['deny', 'error'] as const) {
  test(`a ${mode === 'deny' ? 'denied' : 'errored'} Edit is not captured`, async ($, on) => {
    const w = world($, on)
    w.FILES.set('c:/repo/a.ts', 'x = 1\n')
    w[mode] = true
    await w.edit('C:/repo/a.ts', 'x = 1', 'x = 2')
    const ui = await w.mount()
    expect(await ui.find({ key: 'row:t1:a.ts' })).toBeUndefined()
    expect(await ui.find({ key: 'note' })).toBeDefined()
    await ui.unmount()
  })
}

test('other tool calls pass through with no reads and no process', async ($, on) => {
  const w = world($, on)
  const r = await $.tool.call({ tool: 'Bash', command: 'echo hi' } as never)
  expect(r.text).toBe('ok')
  expect(w.log).toEqual(['tool:Bash'])
  expect(w.runs.length).toBe(0)
  const ui = await w.mount()
  expect(await ui.find({ key: 'row:t1:a.ts' })).toBeUndefined()
  await ui.unmount()
})

test('turns group the edits; a subagent turn does not close one', async ($, on) => {
  const w = world($, on)
  await w.write('C:/repo/a.ts', 'a\n')
  await w.turnEnd('sub-1')
  await w.write('C:/repo/b.ts', 'b\n')
  let ui = await w.mount()
  expect(await ui.find({ key: 'row:t1:a.ts' })).toBeDefined()
  expect(await ui.find({ key: 'row:t1:b.ts' })).toBeDefined()
  await ui.unmount()
  await w.turnEnd()
  await w.write('C:/repo/c.ts', 'c\n')
  ui = await w.mount()
  expect((await ui.find({ key: 'hdr' }))?.text).toContain('turn 2')
  expect(await ui.find({ key: 'turn:1' })).toBeDefined()
  expect(await ui.find({ key: 'row:t1:a.ts' })).toBeUndefined()
  await ui.press({ key: 'turn:1' })
  expect(await ui.find({ key: 'f:t1:a.ts' })).toBeDefined()
  await ui.unmount()
  const r = await w.command('turn 1')
  expect(String(r.text)).toContain('turn 1: 2 files')
})

test('a subagent edit is tagged sub', async ($, on) => {
  const w = world($, on)
  await w.write('C:/repo/s.ts', 'x\n', { agentId: 'sub-1' })
  const ui = await w.mount()
  expect((await ui.find({ key: 'tag:t1:s.ts' }))?.text).toContain('sub')
  await ui.unmount()
})

test('git mode runs the exact argv once, on request only', async ($, on) => {
  const w = world($, on)
  const r = await w.command('git')
  expect(String(r.text)).toContain('git: 2 files vs HEAD')
  expect(w.runs[0]?.argv).toEqual(GIT_ARGV)
  expect(w.runs[0]?.init?.cwd).toBe('C:/repo')
  expect(w.runs[0]?.init?.timeoutMs).toBe(10000)
  const ui = await w.mount()
  expect(await ui.find({ key: 'f:g:src/a.ts' })).toBeDefined()
  await ui.press({ key: 'f:g:src/a.ts' })
  expect(await ui.find({ key: 'hunk:g:src/a.ts:0' })).toBeDefined()
  await ui.unmount()
  await w.write('C:/repo/q.ts', 'q\n')
  await w.turnEnd()
  expect(w.runs.length).toBe(1)
})

test('a git failure becomes the note, never a toast', async ($, on) => {
  const w = world($, on)
  w.gitExit = 128
  w.gitErr = 'fatal: not a git repository'
  await w.command('git')
  const ui = await w.mount()
  expect((await ui.find({ key: 'sum' }))?.text).toContain('not a git repository')
  expect(w.toasts).toEqual([])
  await ui.unmount()
})

test('rows open, close and step', async ($, on) => {
  const w = world($, on)
  await w.write('C:/repo/a.ts', 'a\n')
  await w.write('C:/repo/b.ts', 'b\n')
  const ui = await w.mount()
  await ui.press({ key: 'f:t1:a.ts' })
  expect(await ui.find({ key: 'hunks:t1:a.ts' })).toBeDefined()
  await ui.press({ key: 'f:t1:a.ts' })
  expect(await ui.find({ key: 'hunks:t1:a.ts' })).toBeUndefined()
  await ui.press({ key: 'next' })
  await ui.press({ key: 'next' })
  expect(await ui.find({ key: 'hunks:t1:b.ts' })).toBeDefined()
  expect(await ui.find({ key: 'hunks:t1:a.ts' })).toBeUndefined()
  await ui.press({ key: 'all' })
  expect(await ui.find({ key: 'hunks:t1:b.ts' })).toBeUndefined()
  await ui.unmount()
})

test('clicking a path appends an @reference to the draft', async ($, on) => {
  const w = world($, on)
  await w.write('C:/repo/a.ts', 'a\n')
  const ui = await w.mount()
  await ui.press({ key: 'ref:t1:a.ts' })
  expect(w.fills[0]).toEqual({ text: '@a.ts ', mode: 'append' })
  w.draft = 'see'
  await ui.press({ key: 'ref:t1:a.ts' })
  expect(w.fills[1]?.text).toBe(' @a.ts ')
  await ui.unmount()
})

test('commands: session, file, clear and usage', async ($, on) => {
  const w = world($, on)
  await w.write('C:/repo/a.ts', 'a\n')
  await w.write('C:/repo/b.ts', 'b\n')
  await w.edit('C:/repo/a.ts', 'a', 'A')
  expect(String((await w.command('session')).text)).toContain('session: 2 files in 3 changes')
  const file = await w.command('file a.ts')
  expect(String(file.text)).toContain('a.ts: +')
  const ui = await w.mount()
  expect(await ui.find({ key: 'hunks:s:a.ts' })).toBeDefined()
  await ui.unmount()
  expect(String((await w.command('file nope.ts')).text)).toContain('No recorded change')
  expect(String((await w.command('bogus')).text)).toContain('Usage: /diff')
  expect((await w.command('clear')).text).toBe('Diff record cleared (3 changes forgotten).')
  const after = await w.mount()
  expect(await after.find({ key: 'note' })).toBeDefined()
  expect(await after.find({ key: 'row:s:a.ts' })).toBeUndefined()
  await after.unmount()
})

test('/diff-viewer stands in when /diff is refused', async ($, on) => {
  const w = world($, on, { refuse: ['diff'] })
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true } as never)
  expect(w.registered).toContain('diff-viewer')
  expect(String((await w.command('', 'diff-viewer')).text)).toContain('Diff opened')
})

test('the pane draws on both surfaces', async ($, on) => {
  const w = world($, on)
  await w.write('C:/repo/a.ts', 'a\n')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await w.mount(surface)
    for (const key of ['hdr', 'tools', 'f:t1:a.ts', 'ref:t1:a.ts']) expect(await ui.find({ key })).toBeDefined()
    await ui.unmount()
  }
})

test('inside the workbench the pane fills its slot and has no close button', async ($, on) => {
  const w = world($, on)
  await w.write('C:/repo/a.ts', 'a\n')
  const ui = await w.mount('terminal', 'workbench')
  expect(await ui.find({ key: 'hdr' })).toBeDefined()
  expect(await ui.find({ key: 'close' })).toBeUndefined()
  await ui.unmount()
})

test('maxChanges limits what is kept', { options: { maxChanges: 5 } }, async ($, on) => {
  const w = world($, on)
  for (let i = 0; i < 7; i++) await w.write(`C:/repo/f${i}.ts`, 'x\n')
  const ui = await w.mount()
  let rows = 0
  for (let i = 0; i < 7; i++) if (await ui.find({ key: `row:t1:f${i}.ts` })) rows += 1
  expect(rows).toBe(5)
  await ui.unmount()
})

test('/clear empties the record', async ($, on) => {
  const w = world($, on)
  await w.write('C:/repo/a.ts', 'a\n')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)
  const ui = await w.mount()
  expect(await ui.find({ key: 'row:t1:a.ts' })).toBeUndefined()
  expect(await ui.find({ key: 'note' })).toBeDefined()
  await ui.unmount()
})
