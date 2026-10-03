import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

import type { InboxLock, InboxRun } from '../types'
import { parseCommand, summary } from '../hooks/inbox'
import { lockState, parseLock, serializeLock } from '../hooks/lock'
import { beatText, fingerprint, inFlight, observe, shortDuration, step, watchConfig } from '../hooks/watch'

const MIN = 60_000
const T0 = Date.parse('2026-10-03T10:00:00Z')
const PROPS = { title: 'Inbox', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const
const cfg = watchConfig({ idleMinutes: 10, timeoutMinutes: 30 })

const run = (over: Partial<InboxRun> = {}): InboxRun => ({
  taskId: 1, agentId: 'agent-1', startedAt: T0, tools: 0, errors: 0, status: 'running', phase: 'work', lastActivityAt: T0, watch: 'active', seen: 'a', ...over,
})

const bash = (text?: string): SessionMessage[] => [
  { role: 'user', text: 'go', toolUses: [] },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'npm i' }, ...(text === undefined ? {} : { text }) }] },
]

test('the heartbeat moves only when the agent does', () => {
  const quiet = observe(run({ seen: 'a' }), T0 + 5 * MIN, 'a', undefined)
  expect(quiet.lastActivityAt).toBe(T0)
  const moved = observe(run({ seen: 'a' }), T0 + 5 * MIN, 'b', undefined)
  expect(moved.lastActivityAt).toBe(T0 + 5 * MIN)
  // the first poll is a baseline, not activity
  expect(observe(run({ seen: undefined }), T0 + 5 * MIN, 'a', undefined).lastActivityAt).toBe(T0)
  expect(fingerprint(bash())).not.toBe(fingerprint(bash('done')))
  expect(inFlight(bash())).toBe('Bash npm i')
  expect(inFlight(bash('done'))).toBeUndefined()
  expect(shortDuration(40_000)).toBe('40s')
  expect(shortDuration(4 * MIN)).toBe('4m')
  expect(shortDuration(65 * MIN)).toBe('1h05m')
  expect(beatText(run(), T0 + 4 * MIN, cfg)).toEqual({ text: 'idle 4m', tone: 'dim' })
  expect(beatText(run({ waitingOn: 'Bash npm i' }), T0 + 12 * MIN, cfg)).toEqual({ text: 'in Bash 12m', tone: 'yellow' })
  expect(beatText(run(), T0 + 31 * MIN, cfg)).toEqual({ text: 'timed out · idle 31m', tone: 'red' })
})

test('each stall level fires once, and again after the agent moves', () => {
  let held = run()
  const fired: string[] = []
  for (const minute of [9, 10, 11, 12, 29, 30, 31, 45]) {
    const out = step(held, T0 + minute * MIN, cfg)
    held = out.run
    if (out.fire) fired.push(`${out.fire}@${minute}`)
  }
  expect(fired).toEqual(['idle@10', 'timedOut@30'])
  // activity resumes: the latch resets without firing, and a new stall fires again
  const back = step({ ...held, lastActivityAt: T0 + 50 * MIN }, T0 + 51 * MIN, cfg)
  expect(back.fire).toBeUndefined()
  expect(back.run.watch).toBe('active')
  expect(step(back.run, T0 + 61 * MIN, cfg).fire).toBe('idle')
})

test('config is clamped', () => {
  const odd = watchConfig({ idleMinutes: 0, timeoutMinutes: 0, onTimeout: 'bogus' })
  expect(odd.idleMs).toBe(MIN)
  expect(odd.timeoutMs).toBeGreaterThan(odd.idleMs)
  expect(odd.onTimeout).toBe('mark')
})

test('lock states', () => {
  const lock = (over: Partial<InboxLock> = {}): InboxLock => ({
    task: 1, phase: 'work', session: 'sess-B', acquiredAt: '', refreshedAt: new Date(T0 - 2 * MIN).toISOString(), nonce: 'n', released: false, ...over,
  })
  const stale = 20 * MIN
  expect(lockState(undefined, T0, 'sess-A', stale)).toBe('free')
  expect(lockState(lock({ released: true }), T0, 'sess-A', stale)).toBe('free')
  expect(lockState(lock({ session: 'sess-A' }), T0, 'sess-A', stale)).toBe('mine')
  expect(lockState(lock(), T0, 'sess-A', stale)).toBe('held')
  expect(lockState(lock(), T0 + 19 * MIN, 'sess-A', stale)).toBe('stale')
  expect(parseLock(serializeLock(lock()))).toEqual(lock())
  expect(parseLock('not json')).toBeUndefined()
})

test('/inbox arguments added by the watchdog', () => {
  expect(parseCommand('status')).toEqual({ kind: 'status' })
  expect(parseCommand('review 3 4')).toEqual({ kind: 'review', ids: [3, 4] })
  expect(parseCommand('commit 3')).toEqual({ kind: 'review', ids: [3] })
  expect(parseCommand('unlock 2 --force')).toEqual({ kind: 'unlock', id: 2, force: true })
  expect(parseCommand('unlock 2')).toEqual({ kind: 'unlock', id: 2, force: false })
  expect(parseCommand('review').kind).toBe('error')
})

test('the summary says where the inbox stands', () => {
  const tasks = [1, 2, 3].map(id => ({ id, file: `00${id}-t.md`, title: `t${id}`, status: id === 1 ? ('running' as const) : ('open' as const), created: '', updated: '', body: '' }))
  const text = summary({ tasks, runs: [run()], locks: [], me: 'sess-A', now: T0 + 12 * MIN, cfg, drain: 0 })
  expect(text).toContain('2 open')
  expect(text).toContain('1 running (#1 idle 12m)')
  expect(text).toContain('Next: /inbox run 2')
  expect(summary({ tasks: [], runs: [], locks: [], me: '', now: T0, cfg, drain: 0 })).toContain('The inbox is empty')
})

/** The engine beneath the plugin: files in memory, one agent, collected toasts. */
function harness(on: On, files: Map<string, string>, rows: () => SessionMessage[]) {
  const norm = (p: string) => {
    const slashed = p.split('\\').join('/')
    const at = slashed.indexOf('.inbox')
    return at >= 0 ? slashed.slice(at) : slashed
  }
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
  on('session.id', async () => ({ value: 'sess-A' }))
  on('session.messages', async () => ({ value: rows() }))
  on('agent.list', async () => ({ value: [{ id: 'agent-1', status: 'running' }] as never }))
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
  return { spawned, toasts, pane }
}

const taskFile = (id: number, status: string) => `---\nid: ${id}\ntitle: task ${id}\nstatus: ${status}\ncreated: 2026-10-03T09:00:00Z\nupdated: 2026-10-03T09:00:00Z\n---\n\nbody ${id}\n`
const lockFile = (over: Partial<InboxLock>): string =>
  serializeLock({ task: 1, phase: 'review', session: 'sess-B', acquiredAt: new Date(T0 - 5 * MIN).toISOString(), refreshedAt: new Date(T0 - 2 * MIN).toISOString(), nonce: 'x', released: false, ...over })

test('an idle worker toasts once per level and its row shows it', { options: { idleMinutes: 10, timeoutMinutes: 30 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const files = new Map([['.inbox/001-task-1.md', taskFile(1, 'open')]])
  const { toasts } = harness(on, files, () => bash())
  const say = (args: string) => $.command.run({ command: 'inbox', args } as Parameters<typeof $.command.run>[0])

  await say('list')
  await $.agent.spawn({ subagentType: 'general-purpose', prompt: 'x', description: 'inbox #1: task 1' } as Parameters<typeof $.agent.spawn>[0])
  expect(files.get('.inbox/001-task-1.md')).toContain('status: running')
  await say('status')
  await clock.advance(11 * MIN)
  await say('status')
  await say('status')
  expect(toasts.filter(t => t.startsWith('inbox: task 1'))).toHaveLength(1)
  expect(toasts.find(t => t.startsWith('inbox: task 1'))).toMatch(/^inbox: task 1 idle 1[01]m$/)
  expect(String((await say('status')).text)).toContain('#1 idle')

  await clock.advance(20 * MIN)
  await say('status')
  await say('status')
  const stalls = toasts.filter(t => t.startsWith('inbox: task 1'))
  expect(stalls).toHaveLength(2)
  expect(stalls[1]).toContain('timed out')

  const ui = await $.ui.mount({ plugin: 'inbox', surface: 'terminal', component: 'Pane', requestId: 'inbox', props: PROPS })
  expect(String((await ui.find({ key: 'beat-1' }))?.text)).toContain('timed out')
  await ui.unmount()
})

test('a task another session holds is not worked, and a stale lock is taken over', { options: { lockStaleMinutes: 20 } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const files = new Map([
    ['.inbox/001-task-1.md', taskFile(1, 'open')],
    ['.inbox/.locks/001.lock', lockFile({})],
  ])
  const { spawned } = harness(on, files, () => bash())
  const say = (args: string) => $.command.run({ command: 'inbox', args } as Parameters<typeof $.command.run>[0])

  const refused = await say('run 1')
  expect(String(refused.text)).toContain('locked by other session')
  expect(spawned).toHaveLength(0)
  const ui = await $.ui.mount({ plugin: 'inbox', surface: 'terminal', component: 'Pane', requestId: 'inbox', props: PROPS })
  expect(String((await ui.find({ key: 'lock-1' }))?.text)).toContain('locked by other session')
  await ui.unmount()

  const model = await $.agent.spawn({ subagentType: 'general-purpose', prompt: 'x', description: 'inbox #1: task 1' } as Parameters<typeof $.agent.spawn>[0])
  expect('deny' in model && model.deny).toContain('locked by')

  await clock.advance(19 * MIN)
  await $.agent.spawn({ subagentType: 'general-purpose', prompt: 'x', description: 'inbox #1: task 1' } as Parameters<typeof $.agent.spawn>[0])
  expect(files.get('.inbox/.locks/001.lock')).toContain('"session":"sess-A"')
  expect(files.get('.inbox/.locks/001.lock')).toContain('"released":false')
  await $.turn.complete({
    agentId: 'agent-1', reason: 'answer', answer: 'Done.', text: 'Done.', durationMs: 1000, isAborted: false, turnId: 't1',
  } as Parameters<typeof $.turn.complete>[0])
  expect(files.get('.inbox/.locks/001.lock')).toContain('"released":true')
})

test('review checks for a commit first', async ($, on) => {
  mock.clock(on, { now: T0 })
  const files = new Map([
    ['.inbox/001-task-1.md', taskFile(1, 'done')],
    ['.inbox/002-task-2.md', taskFile(2, 'done')],
  ])
  const { spawned } = harness(on, files, () => [])
  const ran: string[][] = []
  on('process.run', async (_, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    ran.push(argv)
    const isOne = argv.some(arg => arg.endsWith(': 1$'))
    return { value: { exitCode: 0, stdout: isOne ? 'abc1234 fix: thing\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const say = (args: string) => $.command.run({ command: 'inbox', args } as Parameters<typeof $.command.run>[0])

  const found = await say('review 1')
  expect(String(found.text)).toContain('already committed in abc1234')
  expect(spawned).toHaveLength(0)
  expect(files.get('.inbox/001-task-1.md')).toContain('commit: abc1234')

  await say('review 2')
  expect(spawned).toHaveLength(1)
  expect(spawned[0]).toContain('Inbox-Task: 2')
  expect(ran).toHaveLength(2)
})

test('every answer says where the inbox stands', async ($, on) => {
  mock.clock(on, { now: T0 })
  const files = new Map<string, string>()
  const { pane } = harness(on, files, () => [])
  const say = (args: string) => $.command.run({ command: 'inbox', args } as Parameters<typeof $.command.run>[0])

  expect(String((await say('drain')).text)).toMatch(/^Nothing to drain/)
  expect(String((await say('status')).text)).toContain('The inbox is empty')

  pane.reason = 'too narrow'
  expect(String((await say('')).text)).toContain('Pane not shown')
})
