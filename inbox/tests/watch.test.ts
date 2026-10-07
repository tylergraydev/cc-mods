import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

import type { InboxLock, InboxRun } from '../types'
import { parseTask, summary } from '../hooks/inbox'
import { lockState, parseLock, serializeLock } from '../hooks/lock'
import { beatText, fingerprint, inFlight, observe, shortDuration, step, watchConfig } from '../hooks/watch'

const MIN = 60_000
const T0 = Date.parse('2026-10-03T10:00:00Z')
const PROPS = { title: 'Inbox', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const
const cfg = watchConfig({ idleMinutes: 10, timeoutMinutes: 30 })

const run = (over: Partial<InboxRun> = {}): InboxRun => ({
  task: '1-task-1', agentId: 'agent-1', startedAt: T0, tools: 0, errors: 0, status: 'running', phase: 'work', worker: 'claude', lastActivityAt: T0, watch: 'active', seen: 'a', ...over,
})

const row = (role: 'user' | 'assistant', toolUses: SessionMessage['toolUses'] = [], toolResults: SessionMessage['toolResults'] = []): SessionMessage =>
  ({ role, text: '', toolUses, toolResults } as unknown as SessionMessage)

const use = (tool: string, input: Record<string, unknown>, text?: string) => ({ tool, input, ...(text !== undefined ? { text } : {}) }) as SessionMessage['toolUses'][number]

const bash = (text?: string) => [row('user'), row('assistant', [use('Bash', { command: 'npm test' }, text)])]

test('the heartbeat moves only when the agent\'s conversation changes', () => {
  expect(fingerprint([])).toBe('0:0:0')
  const pending = bash()
  const answered = bash('ok')
  expect(fingerprint(pending)).not.toBe(fingerprint(answered))
  expect(inFlight(pending)).toBe('Bash npm test')
  expect(inFlight(answered)).toBeUndefined()

  const first = observe(run({ seen: undefined }), T0 + MIN, fingerprint(pending), inFlight(pending))
  expect(first.lastActivityAt).toBe(T0)
  expect(first.waitingOn).toBe('Bash npm test')
  const same = observe(first, T0 + 2 * MIN, fingerprint(pending), inFlight(pending))
  expect(same.lastActivityAt).toBe(T0)
  const moved = observe(same, T0 + 3 * MIN, fingerprint(answered), inFlight(answered))
  expect(moved.lastActivityAt).toBe(T0 + 3 * MIN)
  expect(moved.waitingOn).toBeUndefined()
})

test('the levels rise with idle time and each fires once', () => {
  const active = run()
  expect(step(active, T0 + 9 * MIN, cfg).fire).toBeUndefined()
  const { run: idle, fire } = step(active, T0 + 10 * MIN, cfg)
  expect(fire).toBe('idle')
  expect(idle.watch).toBe('idle')
  expect(step(idle, T0 + 20 * MIN, cfg).fire).toBeUndefined()
  const { run: out, fire: fired } = step(idle, T0 + 30 * MIN, cfg)
  expect(fired).toBe('timedOut')
  expect(out.watch).toBe('timedOut')
  // activity again: the level drops without a toast, and idle fires once more later
  const back = step({ ...out, lastActivityAt: T0 + 31 * MIN }, T0 + 31 * MIN, cfg)
  expect(back.fire).toBeUndefined()
  expect(back.run.watch).toBe('active')
  expect(step(back.run, T0 + 41 * MIN, cfg).fire).toBe('idle')
  // the wall-clock cap counts even while the agent is busy
  const capped = watchConfig({ idleMinutes: 10, timeoutMinutes: 30, maxRunMinutes: 60 })
  expect(step(run({ lastActivityAt: T0 + 60 * MIN }), T0 + 60 * MIN, capped).fire).toBe('timedOut')
})

test('the row note names the call in flight and the idle time', () => {
  expect(shortDuration(40_000)).toBe('40s')
  expect(shortDuration(4 * MIN)).toBe('4m')
  expect(shortDuration(65 * MIN)).toBe('1h05m')
  expect(beatText(run({ waitingOn: 'Bash npm test' }), T0 + 12 * MIN, cfg)).toEqual({ text: 'in Bash 12m', tone: 'yellow' })
  expect(beatText(run(), T0 + 2 * MIN, cfg)).toEqual({ text: 'idle 2m', tone: 'dim' })
  expect(beatText(run(), T0 + 31 * MIN, cfg)).toEqual({ text: 'timed out · idle 31m', tone: 'red' })
})

test('a lock is free, mine, held or stale', () => {
  const lock = parseLock(serializeLock({ task: '1-task-1', phase: 'work', session: 'sess-B', acquiredAt: 'x', refreshedAt: new Date(T0).toISOString(), nonce: 'n', released: false }))!
  expect(lockState(undefined, T0, 'sess-A', 20 * MIN)).toBe('free')
  expect(lockState(lock, T0 + MIN, 'sess-B', 20 * MIN)).toBe('mine')
  expect(lockState(lock, T0 + MIN, 'sess-A', 20 * MIN)).toBe('held')
  expect(lockState(lock, T0 + 21 * MIN, 'sess-A', 20 * MIN)).toBe('stale')
  expect(lockState({ ...lock, released: true }, T0, 'sess-A', 20 * MIN)).toBe('free')
  expect(parseLock('not json')).toBeUndefined()
  expect(parseLock('{"task":1}')).toBeUndefined()
})

const taskFile = (name: string, status: string, over = '') =>
  `---\nstatus: ${status}\ncreated: 2026-10-03\nowner-paths: packages/${name}\n${over}---\n# Task ${name}\n\nbody ${name}\n`

test('the summary says where the inbox stands', () => {
  const tasks = [
    parseTask('processing/1-task-1.md', taskFile('1-task-1', 'processing')),
    parseTask('2-task-2.md', taskFile('2-task-2', 'todo')),
    parseTask('3-task-3.md', taskFile('3-task-3', 'todo', 'depends-on: 2-task-2\n')),
    parseTask('review/4-task-4.md', taskFile('4-task-4', 'review')),
  ]
  const text = summary({ tasks, runs: [run()], locks: [], me: 'sess-A', now: T0 + 12 * MIN, cfg, drain: 0 })
  expect(text).toContain('1 ready')
  expect(text).toContain('1 waiting')
  expect(text).toContain('1 processing (1 live here; 1-task-1 idle 12m)')
  expect(text).toContain('1 in review')
  expect(text).toContain('Next: /inbox run 2-task-2 · /inbox drain · /inbox review 4-task-4')
  expect(summary({ tasks: [], runs: [], locks: [], me: '', now: T0, cfg, drain: 0 })).toContain('The inbox is empty')
})

/** The engine beneath the plugin: an inbox/ tree in memory, one agent, collected toasts. */
function harness(on: On, files: Map<string, string>, rows: () => SessionMessage[]) {
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
  on('process.run', async (_, e) => {
    const argv = [...(e as unknown as { argv: string[] }).argv]
    ran.push(argv)
    if (argv[0] === 'git') {
      const isOne = argv.some(arg => arg.endsWith(': 1-task-1$'))
      return { value: { exitCode: 0, stdout: isOne ? 'abc1234 fix: thing\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const [to = '', from = ''] = [argv.pop() ?? '', argv.pop() ?? '']
    const text = files.get(norm(from))
    if (text === undefined || files.has(norm(to))) return { value: { exitCode: 1, stdout: '', stderr: 'ENOENT', isStdoutTruncated: false, isStderrTruncated: false } }
    files.delete(norm(from))
    files.set(norm(to), text)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.id', async () => ({ value: 'sess-A' }))
  on('session.messages', async () => ({ value: rows() }))
  const agents: { status: string } = { status: 'running' }
  on('agent.list', async () => ({ value: [{ id: 'agent-1', status: agents.status }] as never }))
  const pane: { reason?: string } = {}
  on('ui.open', async () => ({ value: pane.reason ? { isPlaced: false as const, reason: pane.reason } : { isPlaced: true as const } }))
  const spawned: string[] = []
  on('agent.spawn', async (_, e) => {
    spawned.push((e as { prompt: string }).prompt)
    return { model: 'claude-sonnet-5-5', agentId: 'agent-1' }
  })
  on('turn.complete', async (_, e) => ({ text: e.answer }))
  const toasts: string[] = []
  on('ui.toast', async (_, e) => {
    toasts.push(String((e as { text?: unknown }).text))
    return { value: undefined }
  })
  return { spawned, toasts, pane, ran, agents }
}

const lockFile = (over: Partial<InboxLock>): string =>
  serializeLock({ task: '1-task-1', phase: 'review', session: 'sess-B', acquiredAt: new Date(T0 - 5 * MIN).toISOString(), refreshedAt: new Date(T0 - 2 * MIN).toISOString(), nonce: 'x', released: false, ...over })

test('an idle worker toasts once per level and its row shows it', { options: { idleMinutes: 10, timeoutMinutes: 30 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const files = new Map([['inbox/1-task-1.md', taskFile('1-task-1', 'todo')]])
  const { toasts } = harness(on, files, () => bash())
  const say = (args: string) => $.command.run({ command: 'inbox', args } as Parameters<typeof $.command.run>[0])

  await say('list')
  // a spawn Claude makes from the inbox skill on a todo item: the mod claims it on the way
  await $.agent.spawn({ subagentType: 'general-purpose', prompt: 'x', description: 'inbox 1-task-1' } as Parameters<typeof $.agent.spawn>[0])
  expect(files.has('inbox/1-task-1.md')).toBe(false)
  expect(files.get('inbox/processing/1-task-1.md')).toContain('status: processing')
  expect(files.get('inbox/processing/1-task-1.md')).toContain('agent-id: agent-1')
  await say('status')
  await clock.advance(11 * MIN)
  await say('status')
  await say('status')
  expect(toasts.filter(t => t.startsWith('inbox: 1-task-1'))).toHaveLength(1)
  expect(toasts.find(t => t.startsWith('inbox: 1-task-1'))).toMatch(/^inbox: 1-task-1 idle 1[01]m$/)
  expect(String((await say('status')).text)).toContain('1-task-1 idle')

  await clock.advance(20 * MIN)
  await say('status')
  await say('status')
  const stalls = toasts.filter(t => t.startsWith('inbox: 1-task-1'))
  expect(stalls).toHaveLength(2)
  expect(stalls[1]).toContain('timed out')

  const ui = await $.ui.mount({ plugin: 'inbox', surface: 'terminal', component: 'Pane', requestId: 'inbox', props: PROPS })
  expect(String((await ui.find({ key: 'beat-1-task-1' }))?.text)).toContain('timed out')
  await ui.unmount()
})

test('an item another session holds is not worked, and a stale lock is taken over', { options: { lockStaleMinutes: 20 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const files = new Map([
    ['inbox/1-task-1.md', taskFile('1-task-1', 'todo')],
    ['inbox/.locks/1-task-1.lock', lockFile({})],
  ])
  const { spawned } = harness(on, files, () => bash())
  const say = (args: string) => $.command.run({ command: 'inbox', args } as Parameters<typeof $.command.run>[0])

  const refused = await say('run 1')
  expect(String(refused.text)).toContain('locked by another session')
  expect(spawned).toHaveLength(0)
  const ui = await $.ui.mount({ plugin: 'inbox', surface: 'terminal', component: 'Pane', requestId: 'inbox', props: PROPS })
  expect(String((await ui.find({ key: 'lock-1-task-1' }))?.text)).toContain('locked by other session')
  await ui.unmount()

  const model = await $.agent.spawn({ subagentType: 'general-purpose', prompt: 'x', description: 'inbox 1-task-1' } as Parameters<typeof $.agent.spawn>[0])
  expect('deny' in model && model.deny).toContain('locked by')
  expect(files.has('inbox/1-task-1.md')).toBe(true)

  await clock.advance(19 * MIN)
  await $.agent.spawn({ subagentType: 'general-purpose', prompt: 'x', description: 'inbox 1-task-1' } as Parameters<typeof $.agent.spawn>[0])
  expect(files.get('inbox/.locks/1-task-1.lock')).toContain('"session":"sess-A"')
  expect(files.get('inbox/.locks/1-task-1.lock')).toContain('"released":false')
  expect(files.has('inbox/processing/1-task-1.md')).toBe(true)
  // the worker ends without moving the item: the run fails, its message is kept, the lock goes
  await $.turn.complete({
    agentId: 'agent-1', reason: 'answer', answer: 'I ran out of time.', text: 'I ran out of time.', durationMs: 1000, isAborted: false, turnId: 't1',
  } as Parameters<typeof $.turn.complete>[0])
  expect(files.get('inbox/.locks/1-task-1.lock')).toContain('"released":true')
  expect(files.get('inbox/processing/1-task-1.md')).toContain('## Result')
  expect(files.get('inbox/processing/1-task-1.md')).toContain('I ran out of time.')
})

test('review checks for a commit first', async ($, on) => {
  mock.clock(on, { now: T0 })
  const files = new Map([
    ['inbox/review/1-task-1.md', taskFile('1-task-1', 'review')],
    ['inbox/review/2-task-2.md', taskFile('2-task-2', 'review')],
  ])
  const { spawned, ran } = harness(on, files, () => [])
  const say = (args: string) => $.command.run({ command: 'inbox', args } as Parameters<typeof $.command.run>[0])

  const found = await say('review 1')
  expect(String(found.text)).toContain('already committed in abc1234')
  expect(spawned).toHaveLength(0)
  expect(files.get('inbox/review/1-task-1.md')).toContain('commit: abc1234')

  await say('review 2')
  expect(spawned).toHaveLength(1)
  expect(spawned[0]).toContain('Inbox: 2-task-2')
  expect(ran.filter(argv => argv[0] === 'git')).toHaveLength(2)
})

test('every answer says where the inbox stands', async ($, on) => {
  mock.clock(on, { now: T0 })
  const files = new Map<string, string>()
  const { pane } = harness(on, files, () => [])
  const say = (args: string) => $.command.run({ command: 'inbox', args } as Parameters<typeof $.command.run>[0])

  expect(String((await say('drain')).text)).toMatch(/^Nothing to drain/)
  // no inbox/ folder anywhere: the answer names the folder it expected, not just "empty"
  expect(String((await say('status')).text)).toContain('No inbox/ folder under /repo')
  expect(String((await say('refresh')).text)).toContain('No inbox/ folder under /repo')
  // the folder exists (only the template in it): empty, and the answer says which folder
  files.set('inbox/_TEMPLATE.md', '---\nstatus: todo\n---\n# <Title>\n')
  expect(String((await say('refresh')).text)).toContain('Refreshed: 0 items in /repo/inbox/')
  expect(String((await say('status')).text)).toContain('The inbox is empty: no items in /repo/inbox/')

  pane.reason = 'too narrow'
  expect(String((await say('')).text)).toContain('Pane not shown')
})

test('a codex worker whose turn.complete arrives after the agent list says it ended still gets its report recorded', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const files = new Map([['inbox/71-overlay.md', taskFile('71-overlay', 'todo', 'worker: codex\n')]])
  const { agents, toasts } = harness(on, files, () => [])
  const say = (args: string) => $.command.run({ command: 'inbox', args } as Parameters<typeof $.command.run>[0])

  await $.agent.spawn({ subagentType: 'codex-runner', prompt: 'x', description: 'inbox 71-overlay' } as Parameters<typeof $.agent.spawn>[0])
  expect(files.get('inbox/processing/71-overlay.md')).toContain('agent-id: agent-1')
  // the worker moves the item, then the agent list shows it ended before its turn.complete arrives
  const text = files.get('inbox/processing/71-overlay.md') ?? ''
  files.delete('inbox/processing/71-overlay.md')
  files.set('inbox/review/71-overlay.md', `${text.replace('status: processing', 'status: review')}\n## Result\n\nDone.\n`)
  agents.status = 'completed'
  await say('status')
  await clock.advance(5_000)
  await say('status')
  expect(toasts.some(t => t.includes('ready for review'))).toBe(false)
  await $.turn.complete({
    agentId: 'agent-1', reason: 'answer', text: 'x', durationMs: 1, isAborted: false, turnId: 't1',
    answer: 'Codex ok · model gpt-6.1-sol · thread 01a10565-30c0-7970-837d-2510de3bdfdd · run C:/code/tcg-sim/.codex/runs/20261004-013058-op-tutorial-chapter-list\nSummary',
  } as Parameters<typeof $.turn.complete>[0])
  const after = files.get('inbox/review/71-overlay.md') ?? ''
  expect(after).toContain('codex-thread: 01a10565-30c0-7970-837d-2510de3bdfdd')
  expect(after).toContain('codex-run: C:/code/tcg-sim/.codex/runs/20261004-013058-op-tutorial-chapter-list')
  expect(toasts.filter(t => t.includes('71-overlay ready for review'))).toHaveLength(1)
  // and with no turn.complete at all, the tick settles once the grace period is over
  await clock.advance(30_000)
  await say('status')
  expect(toasts.filter(t => t.includes('71-overlay ready for review'))).toHaveLength(1)
})
