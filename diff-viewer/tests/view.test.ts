import { expect, test } from 'claude-code/testing'

import type { DvChange, DvView } from '../types'
import {
  USAGE,
  enforceCaps,
  fileRef,
  findFile,
  fitPath,
  groupFiles,
  keyOf,
  makeChange,
  netDiff,
  parseCommand,
  relOf,
  rowWidths,
  turnLine,
  visibleRowIds,
} from '../hooks/view'
import type { MakeInput } from '../hooks/view'

const input = (over: Partial<MakeInput> = {}): MakeInput => ({
  id: 1,
  path: 'C:\\repo\\a.ts',
  root: 'C:/repo',
  tool: 'Edit',
  turn: 1,
  agentId: undefined,
  at: 0,
  before: { state: 'ok', text: 'a\n' },
  after: 'b\n',
  ...over,
})

const change = (id: number, turn: number, key: string, before: string, after: string, extra: Partial<DvChange> = {}): DvChange => ({
  id,
  path: `/repo/${key}`,
  key,
  rel: key,
  tool: 'Edit',
  turn,
  at: 0,
  isNew: false,
  kind: 'text',
  before,
  after,
  add: 1,
  del: 1,
  ...extra,
})

test('paths: keys fold case on Windows, display keeps the spelling', async () => {
  expect(keyOf('C:/Repo', 'c:\\repo\\Src\\A.ts')).toBe('src/a.ts')
  expect(relOf('C:/Repo', 'c:\\repo\\Src\\A.ts')).toBe('Src/A.ts')
  expect(keyOf('/repo', '/other/X.ts')).toBe('/other/X.ts')
  expect(keyOf('/repo', '/repo/X.ts')).toBe('X.ts')
})

test('makeChange: a new file, a patch, too large, unreadable and binary', async () => {
  const fresh = makeChange(input({ before: { state: 'missing' }, after: 'x\n' }), 3)
  expect([fresh.isNew, fresh.kind, fresh.add, fresh.del]).toEqual([true, 'text', 1, 0])

  const big = Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`)
  const before = big.join('\n') + '\n'
  const changed = [...big]
  changed[2500] = 'CHANGED'
  const patch = makeChange(input({ before: { state: 'ok', text: before }, after: changed.join('\n') + '\n' }), 3)
  expect(patch.kind).toBe('patch')
  expect(patch.patch?.startsWith('@@')).toBe(true)
  expect([patch.add, patch.del]).toEqual([1, 1])
  expect(patch.before).toBeUndefined()

  const many = 'xxxx\n'.repeat(60000)
  const huge = makeChange(input({ before: { state: 'ok', text: many }, after: many + 'y\n' }), 3)
  expect([huge.kind, huge.add]).toEqual(['too-large', -1])

  expect(makeChange(input({ before: { state: 'unreadable' } }), 3).kind).toBe('unreadable')
  expect(makeChange(input({ after: null }), 3).kind).toBe('unreadable')
  expect(makeChange(input({ after: 'a\u0000b' }), 3).kind).toBe('binary')
})

test('enforceCaps keeps the newest changes and squeezes old whole texts into patches', async () => {
  const many = Array.from({ length: 61 }, (_, i) => change(i + 1, 1, `f${i}.ts`, 'a\n', 'b\n'))
  expect(enforceCaps(many, 60, 3).map(c => c.id)[0]).toBe(2)
  expect(enforceCaps(many, 60, 3).length).toBe(60)

  const mib = Array.from({ length: 5 }, (_, i) => {
    const text = 'x\n'.repeat(262144)
    return change(i + 1, 1, `m${i}.ts`, text, text.replace('x', 'y'))
  })
  const kept = enforceCaps(mib, 60, 3)
  expect(kept[0]?.kind).toBe('patch')
  expect(kept[4]?.kind).toBe('text')
  const total = kept.reduce((n, c) => n + (c.before?.length ?? 0) + (c.after?.length ?? 0), 0)
  expect(total <= 4_194_304).toBe(true)
})

test('netDiff: first before to last after, with notes and fallbacks', async () => {
  const a1 = change(1, 1, 'a.ts', 'one\n', 'two\n')
  const a2 = change(2, 1, 'a.ts', 'two\n', 'three\n')
  const a3 = change(3, 2, 'a.ts', 'three\n', 'four\n', { agentId: 'sub-1' })
  const [group] = groupFiles([a1, a2, a3])
  const net = netDiff(group as never, 3)
  expect(net.diff?.hunks.length).toBe(1)
  expect(net.sections[0]?.hunks?.[0]?.lines).toEqual(['-one', '+four'])
  expect(group?.agents).toEqual(['sub-1'])

  const turn1 = netDiff(groupFiles([a1, a2])[0] as never, 3)
  expect(turn1.sections[0]?.hunks?.[0]?.lines).toEqual(['-one', '+three'])

  const gap = netDiff(groupFiles([a1, change(2, 1, 'a.ts', 'edited elsewhere\n', 'x\n')])[0] as never, 3)
  expect(gap.notes).toContain('edited outside Claude between changes')

  const patch = change(2, 2, 'a.ts', '', '', { kind: 'patch', patch: '@@ -1,1 +1,1 @@\n-x\n+y', before: undefined, after: undefined })
  const mixed = netDiff(groupFiles([a1, patch])[0] as never, 3)
  expect(mixed.diff).toBe(null)
  expect(mixed.sections.map(s => s.label)).toEqual(['#1 · Edit · turn 1', '#2 · Edit · turn 2'])
  expect(mixed.tag).toBe('big')
})

test('visibleRowIds: the shown turn, then expanded earlier turns', async () => {
  const changes = [change(1, 1, 'c.ts', 'a\n', 'b\n'), change(2, 3, 'b.ts', 'a\n', 'b\n'), change(3, 3, 'a.ts', 'a\n', 'b\n'), change(4, 2, 'z.ts', 'a\n', 'b\n')]
  const view: DvView = { mode: 'turn', turn: null, open: null, expandedTurns: [1], wrap: false }
  expect(visibleRowIds({ mode: 'turn', changes, view, git: [] })).toEqual(['t3:a.ts', 't3:b.ts', 't1:c.ts'])
  expect(visibleRowIds({ mode: 'session', changes, view, git: [] })).toEqual(['s:a.ts', 's:b.ts', 's:c.ts', 's:z.ts'])
})

test('parseCommand', async () => {
  expect(parseCommand('')).toEqual({ kind: 'open' })
  expect(parseCommand('turn')).toEqual({ kind: 'turn', turn: null })
  expect(parseCommand('turn 4')).toEqual({ kind: 'turn', turn: 4 })
  expect(parseCommand('TURN 4')).toEqual({ kind: 'turn', turn: 4 })
  expect(parseCommand('turn x')).toEqual({ kind: 'error', text: USAGE })
  expect(parseCommand('session')).toEqual({ kind: 'session' })
  expect(parseCommand('git')).toEqual({ kind: 'git' })
  expect(parseCommand('clear')).toEqual({ kind: 'clear' })
  expect(parseCommand('file src/a.ts')).toEqual({ kind: 'file', path: 'src/a.ts' })
  expect(parseCommand('file "my file.ts"')).toEqual({ kind: 'file', path: 'my file.ts' })
  expect(parseCommand('file')).toEqual({ kind: 'error', text: 'Usage: /diff file <path>' })
  expect(parseCommand('bogus')).toEqual({ kind: 'error', text: USAGE })
})

test('findFile: exact, then a unique tail or base name', async () => {
  const keys = ['src/a.ts', 'lib/b.ts', 'lib/a.ts']
  expect(findFile(keys, 'C:/repo', 'C:\\repo\\src\\a.ts')).toBe('src/a.ts')
  expect(findFile(keys, 'C:/repo', 'b.ts')).toBe('lib/b.ts')
  expect(findFile(keys, 'C:/repo', 'a.ts')).toBe(null)
  expect(findFile(keys, 'C:/repo', 'nope.ts')).toBe(null)
})

test('fileRef appends a space-separated @reference', async () => {
  expect(fileRef('a.ts', '')).toBe('@a.ts ')
  expect(fileRef('a.ts', 'look at')).toBe(' @a.ts ')
  expect(fileRef('my file.ts', '')).toBe('@"my file.ts" ')
})

test('text fits the narrow pane', async () => {
  const cut = fitPath('src/components/VeryLongComponentName.tsx', 20)
  expect(cut.length).toBeLessThanOrEqual(20)
  expect(cut.startsWith('…')).toBe(true)
  expect(cut.endsWith('.tsx')).toBe(true)
  expect(fitPath('src/a.ts', 20)).toBe('src/a.ts')
  const { pathW } = rowWidths(40, '+999', '−999', 'new')
  expect(2 + 4 + 1 + 4 + 1 + 4 + pathW).toBeLessThanOrEqual(40)
  expect(turnLine(4, true, 3, 20, 5)).toBe('turn 4 (open): 3 files +20 −5')
})
