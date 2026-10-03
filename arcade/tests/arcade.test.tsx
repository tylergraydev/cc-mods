import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import { cellXY } from '../hooks/sudoku'

const PROPS = { title: 'Arcade', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const
const NARROW = { ...PROPS, bodyColumns: 18 } as const

type World = { clock: ReturnType<typeof mock.clock>; spawned: string[][]; statuses: (string | undefined)[]; toasts: string[]; opened: string[] }

/** The engine beneath the mod: memory for time, store and env, stubs for everything the mod calls out to. */
function world(on: On, o: { exe?: boolean; out?: string; os?: string; workbench?: boolean } = {}): World {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  mock.store(on)
  mock.env(on, { OS: o.os ?? 'Windows_NT' })
  const w: World = { clock, spawned: [], statuses: [], toasts: [], opened: [] }
  on('ui.open', async (_, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', async () => ({ value: undefined }))
  on('ui.toast', async (_, e) => {
    w.toasts.push(String((e as { text?: unknown }).text))
    return { value: undefined }
  })
  on('ui.status', async (_, e) => {
    w.statuses.push((e as { text?: string }).text)
    return { value: undefined }
  })
  on('command.register', async () => ({ value: undefined }) as never)
  on('command.list', async () => ({ value: o.workbench ? [{ name: 'workbench' }] : [] }) as never)
  on('fs.exists', async () => ({ value: o.exe === true }))
  // A child that says what the test gave it, then stays quiet like a controller with nothing pressed.
  on('process.spawn', async function* (_, e) {
    w.spawned.push([...e.argv])
    if (o.out) yield { stream: 'stdout' as const, text: o.out }
    return { code: 0, signal: null } as never
  })
  return w
}

const run = ($: Parameters<TestBody>[0], args: string) =>
  $.command.run({ command: 'arcade', args } as Parameters<typeof $.command.run>[0])

const mountPane = ($: Parameters<TestBody>[0], surface: 'terminal' | 'desktop' | 'vscode' | 'mobile' = 'terminal', props: typeof PROPS | typeof NARROW = PROPS) =>
  $.ui.mount({ plugin: 'arcade', surface, component: 'Pane', requestId: 'arcade', props })

test('/arcade opens the pane on the picker, one button per game', async ($, on) => {
  const w = world(on)
  const out = await run($, '')
  expect(String(out.text)).toContain('Arcade is open')
  expect(w.opened).toEqual(['arcade'])
  const ui = await mountPane($)
  for (const id of ['ttt', 'sudoku', 'tetris']) expect(await ui.find({ key: `pick-${id}` })).toBeDefined()
  await ui.unmount()
})

test('with the workbench loaded /arcade opens it first, then its own pane', async ($, on) => {
  const w = world(on, { workbench: true })
  await run($, 'ttt')
  expect(w.opened).toEqual(['workbench', 'arcade'])
})

test('tic-tac-toe: a click on the centre puts an X there and the computer answers with one O', async ($, on) => {
  world(on)
  await run($, '')
  const ui = await mountPane($)
  await ui.press({ key: 'pick-ttt' })
  await ui.press({ key: 'cell-4' })
  const labels: string[] = []
  for (let i = 0; i < 9; i++) labels.push(((await ui.find({ key: `cell-${i}` }))?.text ?? '').trim())
  expect(labels[4]).toContain('X')
  expect(labels.filter(l => l.includes('O'))).toHaveLength(1)
  expect(labels.filter(l => l.includes('X'))).toHaveLength(1)
  await ui.unmount()
})

