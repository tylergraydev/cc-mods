import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { InboxRun, InboxTask } from '../types'
import {
  brief,
  codexBrief,
  fileName,
  parseCodexReport,
  parseCommand,
  parseTask,
  readiness,
  reviewBrief,
  rootCandidates,
  routeWorker,
  serializeTask,
  spawnSpec,
  toStart,
  withFields,
} from '../hooks/inbox'

const PROPS = { title: 'Inbox', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const

/** An item file as the repo's AGENTS.md describes it. */
const itemFile = (title: string, front: Record<string, string>, body = '## Goal\nBuild it.\n\n## Acceptance criteria\n- it works') =>
  `---\n${Object.entries(front).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n# ${title}\n\n${body}\n`

const item = (file: string, front: Record<string, string> = {}, title = `Item ${file}`): InboxTask =>
  parseTask(file, itemFile(title, { status: 'todo', created: '2026-10-03', 'owner-paths': 'packages/game-foo', ...front }))

const running = (task: string, over: Partial<InboxRun> = {}): InboxRun => ({
  task, agentId: `agent-${task}`, startedAt: 0, tools: 0, errors: 0, status: 'running', phase: 'work', worker: 'claude', lastActivityAt: 0, watch: 'active', ...over,
})

test('an item file is read with every field kept, and written back unchanged', () => {
  const text = itemFile('One Piece tutorial: step engine', {
    status: 'todo', created: '2026-10-03', 'owner-paths': 'packages/game-onepiece/src/tutorial.ts, docs/one-piece-tutorial.md', 'depends-on': '', worker: 'claude', 'codex-thread': 'abc',
  })
  const task = parseTask('70-op-tutorial-step-engine.md', text)
  expect([task.name, task.id, task.status, task.folder, task.title, task.worker]).toEqual(['70-op-tutorial-step-engine', 70, 'todo', 'todo', 'One Piece tutorial: step engine', 'claude'])
  expect(task.ownerPaths).toEqual(['packages/game-onepiece/src/tutorial.ts', 'docs/one-piece-tutorial.md'])
  expect(task.dependsOn).toEqual([])
  expect(task.fields['codex-thread']).toBe('abc')
  expect(serializeTask(task)).toBe(text)
  expect(fileName(76, 'Riftbound: board polish!')).toBe('76-riftbound-board-polish.md')
})

test('the folder gives the status when the front matter has none, and the template placeholders count as empty', () => {
  const t = parseTask('review/12-notes.md', '---\ncreated: 2026-10-01\nowner-paths: <paths this item may edit>\ndepends-on: <optional>\n---\n# Clean up the logs\n\nThey are noisy.\n\n## Result\n\nDone, see logs.ts.\n')
  expect([t.id, t.title, t.status, t.folder]).toEqual([12, 'Clean up the logs', 'review', 'review'])
  expect(t.ownerPaths).toEqual([])
  expect(t.result).toBe('Done, see logs.ts.')
  const moved = withFields(t, { status: 'done', reviewed: '2026-10-04T00:00:00Z', commit: 'abc1234' }, 'done/12-notes.md')
  expect([moved.status, moved.folder, moved.fields.commit, moved.file]).toEqual(['done', 'done', 'abc1234', 'done/12-notes.md'])
  expect(moved.fields.created).toBe('2026-10-01')
})

test('the inbox folder is looked for at the project root first, then the cwd, then the parents, never twice', () => {
  // a shell `cd inbox` moved the cwd into the queue itself: the root still comes first
  expect(rootCandidates('C:\\code\\tcg-sim', 'C:/code/tcg-sim/inbox/')).toEqual(['C:/code/tcg-sim', 'C:/code/tcg-sim/inbox', 'C:/code'])
  // a session started in a package folder finds the repo's inbox two levels up
  expect(rootCandidates('/home/t/repo/packages/game-foo', '/home/t/repo/packages/game-foo')).toEqual([
    '/home/t/repo/packages/game-foo', '/home/t/repo/packages', '/home/t/repo', '/home/t',
  ])
  expect(rootCandidates('', '/work')).toEqual(['/work'])
  expect(rootCandidates('C:/', 'C:/')).toEqual(['C:'])
})

test('/inbox refresh (or reload) re-reads the queue', () => {
  expect(parseCommand('refresh')).toEqual({ kind: 'refresh' })
  expect(parseCommand(' reload ')).toEqual({ kind: 'refresh' })
  expect(parseCommand('status')).toEqual({ kind: 'status' })
})

test('UI items go to Codex, anything else to Claude, and the worker field wins', () => {
  expect(routeWorker(['apps/client/src/games/foo', 'apps/landing/index.html'])).toBe('codex')
  expect(routeWorker(['apps/client/src/foo.tsx', 'packages/game-foo/src/rules.ts'])).toBe('claude')
  expect(routeWorker([])).toBe('claude')
  expect(item('1-a.md', { 'owner-paths': 'apps/client/src/a' }).worker).toBe('codex')
  expect(item('1-a.md', { 'owner-paths': 'apps/client/src/a', worker: 'claude' }).worker).toBe('claude')
})

test('readiness: dependencies, overlapping owner paths, locks and folders', () => {
  const tasks = [
    item('70-engine.md', { 'owner-paths': 'packages/game-op/src/tutorial.ts, docs/op.md' }),
    item('71-overlay.md', { 'owner-paths': 'apps/client/src/games/op/ui', 'depends-on': '70-engine' }),
    item('72-list.md', { 'owner-paths': 'apps/client/src/games/op/ui/List.tsx', 'depends-on': '71-overlay.md' }),
    item('73-chapters.md', { 'owner-paths': 'packages/game-op/src/tutorial/chapters', 'depends-on': '99-missing, 70-engine' }),
    item('67-home.md', { 'owner-paths': 'apps/client/src/home' }),
  ]
  const why = (name: string, runs: InboxRun[] = [], blocked = new Set<string>()) => {
    const can = readiness(tasks.find(one => one.name === name)!, tasks, runs, blocked)
    return can.ready ? 'ready' : can.why
  }
  expect(why('70-engine')).toBe('ready')
  expect(why('67-home')).toBe('ready')
  expect(why('71-overlay')).toBe('waits on 70-engine (todo)')
  expect(why('73-chapters')).toBe('waits on 99-missing (missing)')
  expect(why('70-engine', [], new Set(['70-engine']))).toBe('locked by another session')

  // 70 lands in review/: 71 is ready, 72 still waits on 71, 73 still misses 99
  const later = tasks.map(one => (one.name === '70-engine' ? withFields(one, { status: 'review' }, 'review/70-engine.md') : one))
  const can = (name: string) => readiness(later.find(one => one.name === name)!, later, [])
  expect(can('71-overlay')).toEqual({ ready: true })
  expect(can('72-list')).toEqual({ ready: false, why: 'waits on 71-overlay (todo)' })

  // 71 being processed owns the folder 72's file sits in
  const busy = later.map(one => (one.name === '71-overlay' ? withFields(one, { status: 'processing' }, 'processing/71-overlay.md') : one))
  const lists = busy.map(one => (one.name === '72-list' ? { ...one, dependsOn: [] } : one))
  expect(readiness(lists.find(one => one.name === '72-list')!, lists, [])).toEqual({ ready: false, why: 'paths overlap with 71-overlay' })
  expect(readiness(lists.find(one => one.name === '71-overlay')!, lists, [])).toEqual({ ready: false, why: 'is processing' })
  expect(readiness(parseTask('blocked/5-x.md', '---\nstatus: todo\n---\n# x\n'), [], [])).toEqual({ ready: false, why: 'misfiled in blocked/' })
})

test('a drain starts ready items up to its width, never two that share a path', () => {
  const tasks = [
    item('1-a.md', { 'owner-paths': 'packages/a' }),
    item('2-b.md', { 'owner-paths': 'packages/a/src' }),
    item('3-c.md', { 'owner-paths': 'packages/c' }),
    item('4-d.md', { 'owner-paths': 'packages/d' }),
    item('5-e.md', { 'owner-paths': 'packages/e', 'depends-on': '1-a' }),
  ]
  expect(toStart(tasks, [], 3).map(one => one.name)).toEqual(['1-a', '3-c', '4-d'])
  expect(toStart(tasks, [running('3-c')], 2).map(one => one.name)).toEqual(['1-a'])
  expect(toStart(tasks, [running('1-a')], 3).map(one => one.name)).toEqual(['3-c', '4-d'])
})

test('briefs: the worker rules with absolute paths, the codex-runner header, the reviewer steps', () => {
  const task = item('71-overlay.md', { 'owner-paths': 'apps/client/src/games/op/ui', 'codex-thread': 'thr_123' }, 'Guided overlay')
  const claude = brief(task, 'C:/code/tcg-sim')
  expect(claude).toContain('C:/code/tcg-sim/inbox/71-overlay.md')
  expect(claude).toContain('Do not commit')
  expect(claude).toContain('inbox/review/')
  const codex = codexBrief(task, 'C:/code/tcg-sim', 40, 'gpt-5.6-terra')
  expect(codex.startsWith('Repo: C:/code/tcg-sim\nsandbox: workspace-write\nslug: 71-overlay\ndelay: 40\nresume: thr_123\nmodel: gpt-5.6-terra\nBrief:\n')).toBe(true)
  const spec = spawnSpec(task, 'C:/code/tcg-sim', 1)
  expect([spec.subagentType, spec.model, spec.description]).toEqual(['codex-runner', undefined, 'inbox 71-overlay'])
  expect(spec.prompt).toContain('delay: 20')
  const first = spawnSpec(item('70-engine.md'), 'C:/code/tcg-sim')
  expect([first.subagentType, first.model, first.description]).toEqual(['general-purpose', 'sonnet', 'inbox 70-engine'])
  expect(first.prompt).not.toContain('delay:')
  const review = reviewBrief(withFields(task, { status: 'review' }, 'review/71-overlay.md'), 'C:/code/tcg-sim', 'Inbox')
  expect(review).toContain('C:/code/tcg-sim/inbox/review/71-overlay.md')
  expect(review).toContain('Inbox: 71-overlay')
  expect(review).toContain('inbox/done/')
  expect(parseCodexReport('Codex ok · model gpt-5.6-terra · thread 019a7b2c-1111-2222-3333-444455556666 · run C:/code/tcg-sim/.codex/runs/20261004-003000-71-overlay\nSummary')).toEqual({
    thread: '019a7b2c-1111-2222-3333-444455556666', run: 'C:/code/tcg-sim/.codex/runs/20261004-003000-71-overlay',
  })
})

test('/inbox arguments', () => {
  expect(parseCommand('new --worker codex --paths apps/client/src/home,apps/landing --after 67-home Home screen polish -- make it pop')).toEqual({
    kind: 'new', title: 'Home screen polish', body: 'make it pop', worker: 'codex', paths: ['apps/client/src/home', 'apps/landing'], after: ['67-home'],
  })
  expect(parseCommand('new --worker gpt x').kind).toBe('error')
  expect(parseCommand('run 70 71-overlay')).toEqual({ kind: 'run', items: ['70', '71-overlay'] })
  expect(parseCommand('review 70')).toEqual({ kind: 'review', items: ['70'] })
  expect(parseCommand('accept 70 abc1234')).toEqual({ kind: 'accept', item: '70', commit: 'abc1234' })
  expect(parseCommand('reopen 70')).toEqual({ kind: 'reopen', items: ['70'] })
  expect(parseCommand('unlock 70 --force')).toEqual({ kind: 'unlock', item: '70', force: true })
  expect(parseCommand('drain')).toEqual({ kind: 'drain', width: 2 })
  expect(parseCommand('drain off')).toEqual({ kind: 'drain', width: 0 })
  expect(parseCommand('drain 11').kind).toBe('error')
})

/** The engine beneath the plugin: an inbox/ tree in memory (moved by node or mv), one agent, collected toasts. */
export function harness(on: On, files: Map<string, string>) {
  // the engine hands the hooks absolute paths; key the files from the last `inbox` folder on
  const norm = (p: string) => {
    const parts = p.split(/[\\/]/)
    const at = parts.lastIndexOf('inbox')
    return at >= 0 ? parts.slice(at).join('/') : p
  }
  on('session.cwd', async () => ({ value: '/repo' }))
  on('fs.exists', async (_, e) => ({ value: [...files.keys()].some(k => k === norm(e.path) || k.startsWith(`${norm(e.path)}/`)) }))
  on('fs.list', async (_, e) => ({
    value: [...files.keys()]
      .filter(k => k.startsWith(`${norm(e.path)}/`) && !k.slice(norm(e.path).length + 1).includes('/'))
      .map(k => ({ name: k.slice(norm(e.path).length + 1), kind: 'file' as const, size: files.get(k)!.length, mtimeMs: files.get(k)!.length, isLink: false })),
  }))
  on('fs.read', async (_, e) => (files.has(norm(e.path)) ? { value: files.get(norm(e.path))! } : { deny: 'ENOENT' }))
  on('fs.write', async (_, e) => {
    files.set(norm(e.path), e.text)
    return { value: undefined }
  })
  const ran: string[][] = []
  const git: { stdout: string } = { stdout: '' }
  on('process.run', async (_, e) => {
    const argv = [...(e as unknown as { argv: string[] }).argv]
    ran.push(argv)
    if (argv[0] === 'git') return { value: { exitCode: 0, stdout: git.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const [to = '', from = ''] = [argv.pop() ?? '', argv.pop() ?? '']
    const text = files.get(norm(from))
    if (text === undefined || files.has(norm(to))) return { value: { exitCode: 1, stdout: '', stderr: 'ENOENT', isStdoutTruncated: false, isStderrTruncated: false } }
    files.delete(norm(from))
    files.set(norm(to), text)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.id', async () => ({ value: 'sess-A' }))
  on('session.messages', async () => ({ value: [] }))
  on('agent.list', async () => ({ value: [{ id: 'agent-1', status: 'running' }] as never }))
  const pane: { reason?: string } = {}
  on('ui.open', async () => ({ value: pane.reason ? { isPlaced: false as const, reason: pane.reason } : { isPlaced: true as const } }))
  const spawned: { prompt: string; subagentType: string; model?: string; description: string }[] = []
  on('agent.spawn', async (_, e) => {
    // beneath the plugins the spawn arrives as the Agent tool's own input
    const input = e as unknown as { prompt: string; subagent_type?: string; model?: string; description: string }
    spawned.push({ prompt: input.prompt, subagentType: input.subagent_type ?? '', ...(input.model ? { model: input.model } : {}), description: input.description })
    return { model: input.model ?? 'claude-opus-5-5', agentId: `agent-${spawned.length}` }
  })
  on('turn.complete', async (_, e) => ({ text: e.answer }))
  const toasts: string[] = []
  on('ui.toast', async (_, e) => {
    toasts.push(String((e as { text?: unknown }).text))
    return { value: undefined }
  })
  return { spawned, toasts, pane, ran, git }
}

test('auto-review starts a reviewer as soon as a worker lands an item in review/, once', { options: { autoReview: true } }, async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-04T10:00:00Z') })
  const files = new Map<string, string>([
    ['inbox/70-engine.md', itemFile('Step engine', { status: 'todo', created: '2026-10-03', 'owner-paths': 'packages/game-op/src/tutorial.ts', worker: 'claude' })],
  ])
  const { spawned, toasts } = harness(on, files)
  const say = (args: string) => $.command.run({ command: 'inbox', args } as Parameters<typeof $.command.run>[0])

  // Claude starts the worker the way the inbox skill does; the mod claims the item on the way
  await $.agent.spawn({ subagentType: 'general-purpose', prompt: 'x', description: 'inbox 70-engine' } as Parameters<typeof $.agent.spawn>[0])
  expect(files.get('inbox/processing/70-engine.md')).toContain('agent-id: agent-1')
  // the worker files its result and moves the item
  const text = files.get('inbox/processing/70-engine.md') ?? ''
  files.delete('inbox/processing/70-engine.md')
  files.set('inbox/review/70-engine.md', `${text.replace('status: processing', 'status: review')}\n## Result\n\nBuilt it.\n`)
  await $.turn.complete({
    agentId: 'agent-1', reason: 'answer', answer: 'Done', text: 'Done', durationMs: 1000, isAborted: false, turnId: 't1',
  } as Parameters<typeof $.turn.complete>[0])
  // a reviewer was asked for at once, with the review brief
  expect(spawned.at(-1)?.description).toBe('inbox 70-engine review')
  expect(spawned.at(-1)?.prompt).toContain('Inbox: 70-engine')
  expect(toasts.some(t => t.startsWith('auto-review'))).toBe(true)
  // the same item is not auto-reviewed twice this session, even when a drain runs
  const before = spawned.length
  await say('drain 2')
  expect(spawned.length).toBe(before)
})

test('dispatch claims the item into processing/, the worker moves it to review/, a reviewer takes it to done/', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-04T10:00:00Z') })
  const files = new Map<string, string>([
    ['inbox/_TEMPLATE.md', '---\nstatus: todo\n---\n# <Title>\n'],
    ['inbox/70-engine.md', itemFile('Step engine', { status: 'todo', created: '2026-10-03', 'owner-paths': 'packages/game-op/src/tutorial.ts', worker: 'claude' })],
    ['inbox/71-overlay.md', itemFile('Guided overlay', { status: 'todo', created: '2026-10-03', 'owner-paths': 'apps/client/src/games/op/ui', 'depends-on': '70-engine' })],
    ['inbox/done/66-old.md', itemFile('Old', { status: 'done', commit: 'abc1234', 'owner-paths': 'docs/x.md' })],
  ])
  const { spawned, toasts, git } = harness(on, files)
  const say = (args: string) => $.command.run({ command: 'inbox', args } as Parameters<typeof $.command.run>[0])

  const listed = String((await say('list')).text)
  expect(listed).toContain('70-engine  Step engine  [claude] (ready)')
  expect(listed).toContain('71-overlay  Guided overlay  [codex] (waits on 70-engine (todo))')
  expect(listed).not.toContain('_TEMPLATE')

  expect(String((await say('run 71')).text)).toContain('71-overlay is not ready: waits on 70-engine (todo)')
  expect(spawned).toHaveLength(0)

  const ui = await $.ui.mount({ plugin: 'inbox', surface: 'terminal', component: 'Pane', requestId: 'inbox', props: PROPS })
  await ui.press({ key: 'row-70-engine' })
  await ui.press({ key: 'deploy-70-engine' })
  expect(spawned).toHaveLength(1)
  expect([spawned[0]?.subagentType, spawned[0]?.model, spawned[0]?.description]).toEqual(['general-purpose', 'sonnet', 'inbox 70-engine'])
  expect(spawned[0]?.prompt).toContain('/repo/inbox/processing/70-engine.md')
  // The kit drops a plugin's own spawn result: no agent id comes back, so the mod undoes its claim...
  expect(files.has('inbox/70-engine.md')).toBe(true)
  expect(files.get('inbox/70-engine.md')).not.toContain('claim-id')
  // ...and claims again when Claude starts the worker the way the inbox skill does: `inbox <item>`.
  await $.agent.spawn({ subagentType: 'general-purpose', prompt: spawned[0]?.prompt ?? '', description: 'inbox 70-engine' } as Parameters<typeof $.agent.spawn>[0])
  expect(files.has('inbox/70-engine.md')).toBe(false)
  const claimed = files.get('inbox/processing/70-engine.md') ?? ''
  expect(claimed).toContain('status: processing')
  expect(claimed).toContain('worker-kind: subagent')
  expect(claimed).toContain('worker-agent: claude')
  expect(claimed).toContain('claim-id: 70-engine-2026-10-04T10-00-00Z')
  expect(claimed).toContain('created: 2026-10-03')
  expect(claimed).toContain('agent-id: agent-2')
  expect(files.get('inbox/.locks/70-engine.lock')).toContain('"released":false')
  expect(await ui.find({ key: 'deploy-71-overlay' })).toBeUndefined()

  // the worker does its part: result appended, status review, file moved
  const text = files.get('inbox/processing/70-engine.md') ?? ''
  files.delete('inbox/processing/70-engine.md')
  files.set('inbox/review/70-engine.md', `${text.replace('status: processing', 'status: review\nfinished: 2026-10-04T10:30:00Z')}\n## Result\n\nBuilt the step runner. Files: packages/game-op/src/tutorial.ts\n`)
  await $.turn.complete({
    agentId: 'agent-2', reason: 'answer', answer: 'Done: inbox/review/70-engine.md', text: 'Done', durationMs: 1000, isAborted: false, turnId: 't1',
  } as Parameters<typeof $.turn.complete>[0])
  expect(toasts.some(t => t.startsWith('✓ inbox 70-engine ready for review'))).toBe(true)
  expect(files.get('inbox/.locks/70-engine.lock')).toContain('"released":true')
  expect(String((await say('status')).text)).toContain('1 in review')

  // 71 is ready now, and goes to Codex with the item name as its slug
  expect(String((await say('status')).text)).toContain('Next: /inbox run 71-overlay')
  await ui.press({ key: 'row-71-overlay' })
  await ui.press({ key: 'deploy-71-overlay' })
  // the harness records the test's own spawns too, so the pane's are every other entry
  expect([spawned[2]?.subagentType, spawned[2]?.description]).toEqual(['codex-runner', 'inbox 71-overlay'])
  expect(spawned[2]?.prompt.startsWith('Repo: /repo\nsandbox: workspace-write\nslug: 71-overlay\nBrief:\n')).toBe(true)
  await $.agent.spawn({ subagentType: 'codex-runner', prompt: spawned[2]?.prompt ?? '', description: 'inbox 71-overlay' } as Parameters<typeof $.agent.spawn>[0])
  expect(files.get('inbox/processing/71-overlay.md')).toContain('worker-agent: codex')

  // a reviewer on 70: it commits, moves the item to done/, and reports the sha
  git.stdout = ''
  await ui.press({ key: 'row-70-engine' })
  await ui.press({ key: 'review-70-engine' })
  expect(spawned[4]?.description).toBe('inbox 70-engine review')
  expect(spawned[4]?.prompt).toContain('Inbox: 70-engine')
  await $.agent.spawn({ subagentType: 'general-purpose', prompt: spawned[4]?.prompt ?? '', description: 'inbox 70-engine review' } as Parameters<typeof $.agent.spawn>[0])
  const reviewed = files.get('inbox/review/70-engine.md') ?? ''
  files.delete('inbox/review/70-engine.md')
  files.set('inbox/done/70-engine.md', `${reviewed.replace('status: review', 'status: done\nreviewed: 2026-10-04T11:00:00Z')}\n## Review\n\nAccepted.\n`)
  await $.turn.complete({
    agentId: 'agent-6', reason: 'answer', answer: 'Accepted.\nCOMMIT: beef123', text: 'x', durationMs: 1000, isAborted: false, turnId: 't2',
  } as Parameters<typeof $.turn.complete>[0])
  expect(files.get('inbox/done/70-engine.md')).toContain('commit: beef123')
  expect(toasts.some(t => t === '✓ inbox 70-engine accepted, committed beef123')).toBe(true)

  // typing in the pane adds an item with the template's shape and the next number
  await ui.input({ key: 'new-task', text: 'Write the changelog -- for 0.3' })
  const added = files.get('inbox/72-write-the-changelog.md') ?? ''
  expect(added).toContain('status: todo')
  expect(added).toContain('# Write the changelog')
  expect(added).toContain('## Goal\nfor 0.3')
  await ui.unmount()
})

test('reopen sends an orphaned processing item back with its claim kept as prev-*, and accept moves a reviewed one to done/', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-04T10:00:00Z') })
  const files = new Map<string, string>([
    ['inbox/processing/70-engine.md', itemFile('Step engine', { status: 'processing', created: '2026-10-03', 'owner-paths': 'packages/a', started: '2026-10-03T20:00:00Z', 'claim-id': 'x', 'worker-kind': 'subagent', 'worker-agent': 'claude', dispatched: '2026-10-03T20:00:00Z' })],
    ['inbox/review/71-overlay.md', itemFile('Overlay', { status: 'review', created: '2026-10-03', 'owner-paths': 'apps/client/src/x' })],
  ])
  harness(on, files)
  const say = (args: string) => $.command.run({ command: 'inbox', args } as Parameters<typeof $.command.run>[0])

  expect(String((await say('reopen 70')).text)).toBe('70-engine is todo again.')
  const back = files.get('inbox/70-engine.md') ?? ''
  expect(files.has('inbox/processing/70-engine.md')).toBe(false)
  expect(back).toContain('status: todo')
  expect(back).toContain('prev-claim-id: x')
  expect(back).toContain('prev-worker-agent: claude')
  expect(back).not.toContain('\nclaim-id:')

  expect(String((await say('accept 71 cafe123')).text)).toBe('71-overlay is done (commit cafe123).')
  const done = files.get('inbox/done/71-overlay.md') ?? ''
  expect(done).toContain('status: done')
  expect(done).toContain('commit: cafe123')
  expect(done).toContain('## Review')
  expect(String((await say('reopen 71')).text)).toContain('is done (commit cafe123)')
})
