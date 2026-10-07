import { expect, test } from 'claude-code/testing'

import {
  cellWidth,
  clean,
  clipCells,
  composeLine,
  ENGINE_PREFIX,
  labelOf,
  LABELS,
  orderOf,
  parseCommand,
  parseList,
  readConfig,
  record,
  resolvePrefs,
  segmentOf,
  USAGE,
  visible,
} from '../hooks/bar'
import type { Seg } from '../hooks/bar'

const cfg = readConfig({})

/** The six lines of the screenshot, by plugin. */
const SIX: Record<string, string> = {
  'agent-deck': 'agents 3 running · 2 done',
  arcade: '🎮',
  'claim-check': 'claims: 1 unverified',
  'goal-anchor': 'goal: ship the status bar · on track · 2 open Qs',
  guardrail: 'guard: dry-run ✓ a, b +2 · 3 blocked · allow armed',
  'usage-tracker': 'CC 5h 19% 7d 40% · Codex 7d 12%',
}
const sixAt = (at = 1) => Object.fromEntries(Object.entries(SIX).map(([plugin, text]) => [plugin, { plugin, text, at }]))
const prefs = resolvePrefs(undefined, cfg)

test('labels: every table entry, unknown names keep themselves', () => {
  for (const [plugin, label] of Object.entries(LABELS)) expect(labelOf(plugin)).toBe(label)
  expect(Object.keys(LABELS)).toHaveLength(11)
  expect(labelOf('arcade')).toBe('arcade')
})

test('dedupe: a text that already says who it is keeps its words', () => {
  const full = (plugin: string, text: string) => {
    const s = segmentOf(plugin, text, 40)
    return s.label ? `${s.label}: ${s.body}` : s.body
  }
  expect(full('claim-check', 'claims: 1 unverified')).toBe('claims: 1 unverified')
  expect(full('agent-deck', 'agents 3 running')).toBe('agents 3 running')
  expect(full('mod-menu', 'mods: profile x')).toBe('mods: profile x')
  expect(full('usage-tracker', 'CC 5h 19%')).toBe('usage: CC 5h 19%')
  expect(full('arcade', '🎮')).toBe('arcade: 🎮')
})

test('cellWidth: ascii 1, emoji and wide scripts 2, joiners and marks 0', () => {
  expect(cellWidth('abc')).toBe(3)
  expect(cellWidth('🎮')).toBe(2)
  expect(cellWidth('🔇 off')).toBe(6)
  expect(cellWidth('✓')).toBe(1)
  expect(cellWidth('日本')).toBe(4)
  expect(cellWidth('é')).toBe(1)
  expect(cellWidth('👨‍👩‍👧‍👦')).toBeLessThanOrEqual(8)
})

test('clipCells: fits as is, else a prefix and an ellipsis within the budget, never half a pair', () => {
  expect(clipCells('abc', 5)).toBe('abc')
  expect(clipCells('abcde', 5)).toBe('abcde')
  const cut = clipCells('abcdefgh', 5)
  expect(cut).toBe('abcd…')
  expect(cellWidth(cut)).toBeLessThanOrEqual(5)
  expect(clipCells('🎮🎮🎮', 4)).toBe('🎮…')
  expect(clipCells('日本語', 4)).toBe('日…')
})

test('clean: line breaks and controls out, empty means cleared', () => {
  expect(clean('  a\r\n\tb \u0007c ')).toBe('a b c')
  expect(clean(undefined)).toBe('')
  expect(clean(' \n ')).toBe('')
})

const lineAt = (width: number) => composeLine(visible(sixAt(), prefs, cfg), width)

test('composeLine: all six at 400, a +N at 160, more at 80, a clipped first at 30; always within the width', () => {
  const wide = lineAt(400)!
  expect(wide).not.toMatch(/ │ \+\d+$/)
  expect(wide.split(' │ ')).toHaveLength(6)
  expect(wide.startsWith('agents 3 running')).toBe(true)

  const mid = lineAt(160)!
  expect(mid).toMatch(/ │ \+\d$/)
  const mids = Number(/\+(\d+)$/.exec(mid)?.[1])
  expect(mids).toBeGreaterThanOrEqual(1)

  const narrow = lineAt(80)!
  expect(Number(/\+(\d+)$/.exec(narrow)?.[1])).toBeGreaterThanOrEqual(3)

  const tiny = lineAt(30)!
  expect(tiny.endsWith('…')).toBe(true)

  for (const width of [30, 80, 160, 400]) expect(cellWidth(lineAt(width)!)).toBeLessThanOrEqual(width - ENGINE_PREFIX)
  expect(composeLine([], 160)).toBeUndefined()
})

test('order: listed names first, the rest alphabetical, whatever order they arrived in', () => {
  const names = ['usage-tracker', 'arcade', 'guardrail', 'agent-deck']
  expect(orderOf(names, ['usage-tracker', 'guardrail'])).toEqual(['usage-tracker', 'guardrail', 'agent-deck', 'arcade'])
  expect(orderOf([...names].reverse(), ['usage-tracker', 'guardrail'])).toEqual(['usage-tracker', 'guardrail', 'agent-deck', 'arcade'])
  const list = visible(sixAt(), prefs, readConfig({ order: 'usage-tracker,guardrail' }))
  expect(list.map(s => s.plugin).slice(0, 3)).toEqual(['usage-tracker', 'guardrail', 'agent-deck'])
})

test('hide: lists are trimmed, lower-cased and deduped; hidden plugins are dropped', () => {
  expect(parseList(' A, b,,a ')).toEqual(['a', 'b'])
  const list: Seg[] = visible(sixAt(), { ...prefs, hidden: ['arcade', 'guardrail'] }, cfg)
  expect(list.map(s => s.plugin)).toEqual(['agent-deck', 'claim-check', 'goal-anchor', 'usage-tracker'])
})

test('record: sets, updates, and clears with undefined or blank text', () => {
  let segs = record({}, 'a', 'one', 1)
  expect(segs.a).toEqual({ plugin: 'a', text: 'one', at: 1 })
  segs = record(segs, 'a', 'two', 2)
  expect(segs.a?.text).toBe('two')
  expect(Object.keys(record(segs, 'a', undefined, 3))).toEqual([])
  expect(Object.keys(record(segs, 'a', '   ', 3))).toEqual([])
  expect(segs.a?.text).toBe('two')
})

test('parseCommand: each form, and usage for the rest', () => {
  expect(parseCommand('')).toEqual({ kind: 'report' })
  expect(parseCommand(undefined)).toEqual({ kind: 'report' })
  expect(parseCommand('mode band')).toEqual({ kind: 'mode', mode: 'band' })
  expect(parseCommand('mode status')).toEqual({ kind: 'mode', mode: 'status' })
  expect(parseCommand('on')).toEqual({ kind: 'on' })
  expect(parseCommand('OFF')).toEqual({ kind: 'off' })
  expect(parseCommand('hide Arcade')).toEqual({ kind: 'hide', plugin: 'arcade' })
  expect(parseCommand('show arcade')).toEqual({ kind: 'show', plugin: 'arcade' })
  for (const bad of ['mode', 'mode wide', 'hide', 'show', 'on now', 'frob']) {
    expect(parseCommand(bad)).toEqual({ kind: 'error', text: USAGE })
  }
})

test('resolvePrefs: a stored field wins over the options, a wrong type counts as unset', () => {
  const c = readConfig({ mode: 'band', hide: 'arcade' })
  expect(resolvePrefs(undefined, c)).toEqual({ mode: 'band', isOn: true, hidden: ['arcade'] })
  expect(resolvePrefs({ mode: 'status', isOn: false, hidden: [] }, c)).toEqual({ mode: 'status', isOn: false, hidden: [] })
  expect(resolvePrefs({ mode: 'wide' as never, isOn: 'no' as never }, c)).toEqual({ mode: 'band', isOn: true, hidden: ['arcade'] })
})

test('readConfig: clamps the numbers, an invalid mode falls back to status', () => {
  expect(readConfig({ maxSegment: 2, width: 5 })).toMatchObject({ maxSegment: 8, width: 40 })
  expect(readConfig({ maxSegment: 999, width: 99999 })).toMatchObject({ maxSegment: 200, width: 1000 })
  expect(readConfig({ maxSegment: 'x' })).toMatchObject({ maxSegment: 40, width: 160 })
  expect(readConfig({ mode: 'sideways' }).mode).toBe('status')
  expect(readConfig({ mode: 'band' }).mode).toBe('band')
})
