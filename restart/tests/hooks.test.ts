import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { readConfig, relaunchCommand } from '../hooks/register'

type Sandbox = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

/** The engine beneath the mod: records spawns, command runs, prompt submits and toasts; the helper's cmd exits at once. */
function world($: Sandbox, on: On, opts: { spawnCode?: number } = {}) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-07T15:00:00Z') })
  mock.store(on)
  const w = {
    clock,
    spawned: [] as string[][],
    runs: [] as string[],
    submits: [] as string[],
    toasts: [] as string[],
  }
  on('command.register', async (_, e) => ({ value: { command: e.name } }))
  on('ui.toast', async (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('process.spawn', async function* (_, e) {
    w.spawned.push([...e.argv])
    yield { stream: 'stdout' as const, text: 'started' }
    return { value: { code: opts.spawnCode ?? 0, signal: null } } as never
  })
  on('command.run', async (_, e) => {
    w.runs.push(e.command)
    return { text: '' }
  })
  on('prompt.submit', async (_, e) => {
    w.submits.push(e.text)
    return { text: e.text }
  })
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  const start = () => $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  const command = (args = '') => $.command.run({ command: 'restart', args } as Parameters<typeof $.command.run>[0])
  return Object.assign(w, { start, command })
}

test('/restart starts the helper outside the tree with "claude -c", then runs /exit', async ($, on) => {
  const t = world($, on)
  await t.start()
  const r = await t.command()
  expect(r.text).toContain('"claude -c"')
  expect(t.spawned).toHaveLength(1)
  const argv = t.spawned[0]
  expect(argv.slice(0, 5)).toEqual(['cmd.exe', '/c', 'start', '/b', ''])
  expect(argv[5]).toBe('python.exe')
  expect(argv[6]).toMatch(/restart\.py$/)
  expect(argv.slice(-3)).toEqual(['--', 'claude', '-c'])
  expect(t.runs).toEqual([])
  await t.clock.advance(300)
  expect(t.runs).toEqual(['exit'])
  expect(t.toasts[0]).toContain('exiting')
})

test('fresh drops -c; other words become claude arguments', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.command('fresh')
  expect(t.spawned[0].slice(-2)).toEqual(['--', 'claude'])
  await t.command('-r abc')
  expect(t.spawned[1].slice(-4)).toEqual(['--', 'claude', '-r', 'abc'])
})

test('a helper that fails to start exits nothing', async ($, on) => {
  const t = world($, on, { spawnCode: 1 })
  await t.start()
  const r = await t.command()
  expect(r.text).toContain('could not start')
  await t.clock.advance(1000)
  expect(t.runs).toEqual([])
  expect(t.toasts).toHaveLength(0)
})

test('the next session start, soon after, says it is back', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.command()
  await t.clock.advance(300)
  await t.clock.advance(60_000)
  await t.start()
  expect(t.toasts.at(-1)).toBe('restart: back via "claude -c"')
  // Once consumed, a later start says nothing.
  await t.start()
  expect(t.toasts.filter(x => x.includes('back via'))).toHaveLength(1)
})

test('help says what it does', async ($, on) => {
  const t = world($, on)
  await t.start()
  expect((await t.command('help')).text).toContain('/exit')
  expect(t.spawned).toHaveLength(0)
})

test('readConfig and relaunchCommand', () => {
  const cfg = readConfig({})
  expect(cfg).toEqual({ python: 'python.exe', command: 'claude -c', settleMs: 400 })
  expect(readConfig({ settleMs: '900', command: ' claude --continue ' }).command).toBe('claude --continue')
  expect(readConfig({ settleMs: 99_999 }).settleMs).toBe(10_000)
  expect(relaunchCommand(undefined, cfg)).toBe('claude -c')
  expect(relaunchCommand('FRESH', cfg)).toBe('claude')
  expect(relaunchCommand('--model opus', cfg)).toBe('claude --model opus')
})
