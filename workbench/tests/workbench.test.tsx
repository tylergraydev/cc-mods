import { expect, mock, test } from 'claude-code/testing'

import type { WorkbenchLayout } from '../types'
import { EMPTY_LAYOUT, move, parseCommand, seat, show, visible, widths } from '../hooks/layout'
import { dropAt } from '../hooks/tabs'

const M = (id: string) => ({ id, title: id })
const PROPS = { title: 'Workbench', isFocused: false, bodyColumns: 101, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const

test('new panes fill the emptier side; a known pane goes back where it was', () => {
  let l = seat(EMPTY_LAYOUT, 'a', [M('a')])
  l = seat(l, 'b', [M('a'), M('b')])
  expect([l.left, l.right]).toEqual([['a'], ['b']])
  l = move(l, 'b', 'left')
  expect([l.left, l.right]).toEqual([['a', 'b'], []])
  expect(seat(l, 'b', [M('a'), M('b')]).left).toEqual(['a', 'b'])
})

test('moving the shown pane away shows the next one on its old side', () => {
  let l: WorkbenchLayout = { ...EMPTY_LAYOUT, left: ['a', 'b'], shown: { left: 'a' } }
  l = move(l, 'a', 'right')
  expect(l.shown).toEqual({ left: 'b', right: 'a' })
  expect(show(l, 'b').shown.left).toBe('b')
  const v = visible(l, [M('a'), M('b')])
  expect([v.left.shown?.id, v.right.shown?.id]).toEqual(['b', 'a'])
})

test('widths split the pane, and keep a drop zone when a side is empty', () => {
  expect(widths(101, 50, true, true)).toEqual({ left: 50, right: 50, divider: 50 })
  expect(widths(101, 70, true, true).left).toBe(70)
  expect(widths(80, 50, true, false)).toEqual({ left: 80, right: 0, divider: 67 })
  expect(widths(80, 50, false, true)).toEqual({ left: 0, right: 80, divider: 12 })
})

test('a tab dropped past the divider lands on that side, between the tabs it fell between', () => {
  const strip = {
    width: 60,
    divider: 30,
    left: [{ id: 'a', title: 'Alpha', shown: true }],
    right: [{ id: 'b', title: 'Beta', shown: true }, { id: 'c', title: 'Gamma', shown: false }],
  }
  expect(dropAt(strip, 'a', 45)).toEqual({ side: 'right', index: 2 })
  expect(dropAt(strip, 'a', 32)).toEqual({ side: 'right', index: 0 })
  expect(dropAt(strip, 'b', 5)).toEqual({ side: 'left', index: 1 })
})

test('/workbench arguments', () => {
  expect(parseCommand('')).toEqual({ kind: 'open' })
  expect(parseCommand('move agent-deck right')).toEqual({ kind: 'move', id: 'agent-deck', side: 'right' })
  expect(parseCommand('split 65')).toEqual({ kind: 'split', percent: 65 })
  expect(parseCommand('add x My Pane')).toEqual({ kind: 'add', id: 'x', title: 'My Pane' })
  expect(parseCommand('split 5').kind).toBe('error')
  expect(parseCommand('move x up').kind).toBe('error')
})

test('the frame leaves a keyed slot per shown pane, and its buttons and drags move panes', async ($, on) => {
  mock.store(on)
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  // the engine fills origin and presentation on a test's own command
  const run = (args: string) => $.command.run({ command: 'workbench', args } as Parameters<typeof $.command.run>[0])
  await run('add usage-tracker Usage')
  await run('add agent-deck Agents')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'workbench', surface, component: 'Pane', requestId: 'workbench', props: PROPS })
    expect(await ui.find({ key: 'slot-usage-tracker' })).toBeDefined()
    expect(await ui.find({ key: 'slot-agent-deck' })).toBeDefined()
    expect(await ui.find({ key: 'rule' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'workbench', surface: 'terminal', component: 'Pane', requestId: 'workbench', props: PROPS })
  // usage-tracker sat left, agent-deck right; the move button sends usage right
  await ui.press({ key: 'move-usage-tracker' })
  expect(await ui.find({ key: 'rule' })).toBeUndefined()
  expect(await ui.find({ key: 'col-left' })).toBeUndefined()
  expect(await ui.find({ key: 'slot-usage-tracker' })).toBeDefined()
  // a drag from the tab strip sends it back left
  await ui.post({ kind: 'move', id: 'usage-tracker', side: 'left', index: 0 }, { in: 'tabs' })
  expect(await ui.find({ key: 'slot-usage-tracker' })).toBeDefined()
  expect(await ui.find({ key: 'slot-agent-deck' })).toBeDefined()
  expect(await ui.find({ key: 'rule' })).toBeDefined()
  // and a real drag on the strip: grab the left tab, drop it past the divider
  await ui.pointer({ type: 'down', x: 1, y: 0, button: 'left' })
  await ui.pointer({ type: 'move', x: 40, y: 0, button: 'left' })
  await ui.pointer({ type: 'move', x: 80, y: 0, button: 'left' })
  await ui.pointer({ type: 'up', x: 80, y: 0, button: 'left' })
  expect(await ui.find({ key: 'col-left' })).toBeUndefined()
  // a click without moving just shows the tab
  await ui.pointer({ type: 'down', x: 20, y: 0, button: 'left' })
  await ui.pointer({ type: 'up', x: 20, y: 0, button: 'left' })
  expect(await ui.find({ key: 'col-right' })).toBeDefined()
  await ui.unmount()
})
