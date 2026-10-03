import { expect, mock, test } from 'claude-code/testing'

import type { InboxRun, InboxTask } from '../types'
import { brief, fileName, parseCommand, parseTask, serializeTask, toStart } from '../hooks/inbox'

const PROPS = { title: 'Inbox', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const

const task = (id: number, status: InboxTask['status'] = 'open'): InboxTask => ({
  id, file: fileName(id, `task ${id}`), title: `task ${id}`, status, created: '', updated: '', body: '',
})

test('a task file round-trips, its report kept apart from its details', () => {
  const t: InboxTask = { ...task(7), title: 'Fix the login redirect', agent: 'Explore', body: 'It loops on /login.\n\n- check auth.ts', result: 'Fixed in auth.ts.' }
  const text = serializeTask(t)
  expect(text.startsWith('---\nid: 7\ntitle: Fix the login redirect\nstatus: open\nagent: Explore')).toBe(true)
  expect(parseTask(t.file, text)).toEqual(t)
  expect(fileName(7, 'Fix the login redirect!')).toBe('007-fix-the-login-redirect.md')
})

test('a hand-written file with no front matter is an open task titled by its first line', () => {
  const t = parseTask('012-notes.md', '# Clean up the logs\n\nThey are noisy.')
  expect([t.id, t.title, t.status]).toEqual([12, 'Clean up the logs', 'open'])
})

test('the brief names the task and asks for a report', () => {
  const text = brief({ ...task(3), title: 'Add tests', body: 'cover parse()' })
  expect(text).toContain('inbox task #3')
  expect(text).toContain('cover parse()')
  expect(text).toContain('report')
})

test('a drain starts the oldest open tasks up to its width', () => {
  const tasks = [task(1, 'done'), task(2), task(3), task(4), task(5)]
  const runs: InboxRun[] = [{ taskId: 2, agentId: 'a', startedAt: 0, tools: 0, errors: 0, status: 'running', phase: 'work', lastActivityAt: 0, watch: 'active' }]
  expect(toStart(tasks, runs, 3).map(one => one.id)).toEqual([3, 4])
  expect(toStart(tasks, runs, 1)).toEqual([])
})

test('/inbox arguments', () => {
  expect(parseCommand('new --agent Explore --model haiku Find dead code -- in src/')).toEqual({
    kind: 'new', title: 'Find dead code', body: 'in src/', agent: 'Explore', model: 'haiku',
  })
  expect(parseCommand('run 3 #4')).toEqual({ kind: 'run', ids: [3, 4] })
  expect(parseCommand('drain')).toEqual({ kind: 'drain', width: 2 })
  expect(parseCommand('drain off')).toEqual({ kind: 'drain', width: 0 })
  expect(parseCommand('reopen 2')).toEqual({ kind: 'set', id: 2, status: 'open' })
  expect(parseCommand('drain 99').kind).toBe('error')
})

test('add a task, deploy it, and its agent report lands in the file', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-03T10:00:00Z') })
  const files = new Map<string, string>()
  // the engine hands the hooks absolute paths; key the files from .inbox on
  const norm = (p: string) => {
    const slashed = p.split('\\').join('/')
    const at = slashed.indexOf('.inbox')
    return at >= 0 ? slashed.slice(at) : slashed
  }
  on('fs.exists', async (_, e) => ({ value: [...files.keys()].some(k => k === norm(e.path) || k.startsWith(`${norm(e.path)}/`)) }))
  on('fs.list', async (_, e) => ({
    value: [...files.keys()]
      .filter(k => k.startsWith(`${norm(e.path)}/`))
      .map(k => ({ name: k.slice(norm(e.path).length + 1), kind: 'file' as const, size: files.get(k)!.length, mtimeMs: files.get(k)!.length, isLink: false })),
  }))
  on('fs.read', async (_, e) => (files.has(norm(e.path)) ? { value: files.get(norm(e.path))! } : { deny: 'ENOENT' }))
  on('fs.write', async (_, e) => {
    files.set(norm(e.path), e.text)
    return { value: undefined }
  })
  const spawned: { prompt: string; subagentType: string }[] = []
  on('agent.spawn', async (_, e) => {
    // beneath the plugins the spawn arrives as the Agent tool's own input
    const input = e as unknown as { prompt: string; subagent_type?: string }
    spawned.push({ prompt: input.prompt, subagentType: input.subagent_type ?? '' })
    return { model: 'claude-sonnet-5-5', agentId: 'agent-1' }
  })
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('turn.complete', async (_, e) => ({ text: e.answer }))
  const toasts: string[] = []
  on('ui.toast', async (_, e) => {
    toasts.push(String((e as { text?: unknown }).text))
    return { value: undefined }
  })
  const run = (args: string) => $.command.run({ command: 'inbox', args } as Parameters<typeof $.command.run>[0])

  const added = await run('new Fix the flaky test -- it times out on CI')
  expect(String(added.text)).toContain('#1')
  expect(files.get('.inbox/001-fix-the-flaky-test.md')).toContain('status: open')

  const ui = await $.ui.mount({ plugin: 'inbox', surface: 'terminal', component: 'Pane', requestId: 'inbox', props: PROPS })
  expect(await ui.find({ key: 'row-1' })).toBeDefined()
  await ui.press({ key: 'row-1' })
  await ui.press({ key: 'deploy-1' })
  expect(spawned).toHaveLength(1)
  expect(spawned[0]?.subagentType).toBe('general-purpose')
  expect(spawned[0]?.prompt).toContain('it times out on CI')
  // The kit drops a plugin's own spawn result, so start the agent the way Claude
  // would from the brief: the inbox's agent.spawn hook takes the run from there.
  await $.agent.spawn({ subagentType: 'general-purpose', prompt: spawned[0]?.prompt ?? '', description: 'inbox #1: Fix the flaky test' } as Parameters<typeof $.agent.spawn>[0])
  expect(files.get('.inbox/001-fix-the-flaky-test.md')).toContain('status: running')
  expect(files.get('.inbox/001-fix-the-flaky-test.md')).toContain('agentId: agent-1')

  await $.turn.complete({
    agentId: 'agent-1', reason: 'answer', answer: 'Raised the timeout and fixed the race.', text: 'Raised the timeout and fixed the race.',
    durationMs: 1000, isAborted: false, turnId: 't1',
  } as Parameters<typeof $.turn.complete>[0])
  const after = files.get('.inbox/001-fix-the-flaky-test.md') ?? ''
  expect(after).toContain('status: done')
  expect(after).toContain('## Result\n\nRaised the timeout and fixed the race.')
  expect(after).toContain('it times out on CI')

  // typing in the pane adds a task
  await ui.input({ key: 'new-task', text: 'Write the changelog -- for 0.2' })
  expect(files.get('.inbox/002-write-the-changelog.md')).toContain('for 0.2')
  await ui.unmount()
})
