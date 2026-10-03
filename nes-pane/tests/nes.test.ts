import { describe, expect, test } from 'claude-code/testing'

import {
  HOTKEYS,
  controlText,
  isPathLike,
  keyAction,
  mergeRomSources,
  middleTruncate,
  parseCommand,
  parseFrame,
  parseStatusLine,
  pushRecent,
  resolveRom,
  romFilesIn,
  romTitle,
  screenSize,
} from '../hooks/nes'
import type { RomIo } from '../hooks/nes'

describe('commands', () => {
  test('keywords, slots and ROM names', async () => {
    expect(parseCommand('')).toEqual({ kind: 'open' })
    expect(parseCommand('smb')).toEqual({ kind: 'open', rom: 'smb' })
    expect(parseCommand('C:\\roms\\a b.nes')).toEqual({ kind: 'open', rom: 'C:\\roms\\a b.nes' })
    expect(parseCommand('list')).toEqual({ kind: 'list' })
    expect(parseCommand('list.nes')).toEqual({ kind: 'open', rom: 'list.nes' })
    expect(parseCommand('hd off')).toEqual({ kind: 'hd', on: false })
    expect(parseCommand('window')).toEqual({ kind: 'window', on: true })
    expect(parseCommand('window off')).toEqual({ kind: 'window', on: false })
    expect(parseCommand('save')).toEqual({ kind: 'save', slot: 1 })
    expect(parseCommand('load 3')).toEqual({ kind: 'load', slot: 3 })
    expect(parseCommand('save 0').kind).toBe('bad')
    expect(parseCommand('quit')).toEqual({ kind: 'quit' })
  })
})

describe('the control file', () => {
  const base = { size: { columns: 40, rows: 15 }, mode: 'play' as const, hd: true, window: false, quit: false }

  test('settings, events, end', async () => {
    expect(controlText({ ...base, events: ['k 1 a'] })).toBe('size 40 15\nmode play\nhd on\nwindow off\nk 1 a\nend\n')
  })

  test('events are capped at 32 and quit comes before end', async () => {
    const events = Array.from({ length: 40 }, (_, i) => `k ${i + 1} a`)
    const text = controlText({ ...base, events, quit: true })
    const lines = text.trim().split('\n')
    expect(lines.filter(l => l.startsWith('k '))).toHaveLength(32)
    expect(lines[4]).toBe('k 9 a')
    expect(lines.slice(-2)).toEqual(['quit', 'end'])
  })
})

describe('helper output', () => {
  test('frames are taken whole, a trailing \\r trimmed, a cut one dropped', async () => {
    const cells = 'gCUAAAAAAAAAAAAA'.repeat(2 * 3)
    expect(parseFrame(`2 3 ${cells}`)?.cells).toBe(cells)
    expect(parseFrame(`2 3 ${cells}\r`)?.cells).toBe(cells)
    expect(parseFrame(`2 3 ${cells.slice(1)}`)).toBeUndefined()
    expect(parseFrame('2 3')).toBeUndefined()
  })

  test('every status line', async () => {
    expect(parseStatusLine('ready mapper 4 battery 1')).toEqual({ kind: 'ready', mapper: 4, battery: true })
    expect(parseStatusLine('error unsupported mapper 5 (x)')).toEqual({ kind: 'error', text: 'unsupported mapper 5 (x)' })
    expect(parseStatusLine('play\r')).toEqual({ kind: 'play' })
    expect(parseStatusLine('input')).toEqual({ kind: 'input' })
    expect(parseStatusLine('window off')).toEqual({ kind: 'windowOff' })
    expect(parseStatusLine('saved 2')).toEqual({ kind: 'saved', slot: 2 })
    expect(parseStatusLine('loaded 3')).toEqual({ kind: 'loaded', slot: 3 })
    expect(parseStatusLine('nostate 9')).toEqual({ kind: 'nostate', slot: 9 })
    expect(parseStatusLine('stateerror 1 state is from another ROM or build')).toEqual({
      kind: 'stateError',
      slot: 1,
      text: 'state is from another ROM or build',
    })
    expect(parseStatusLine('something else')).toBeUndefined()
  })
})

describe('sizing and keys', () => {
  test('the picture keeps 4:3 in half-block pixels and leaves room for the controls', async () => {
    expect(screenSize(80, 40)).toEqual({ columns: 80, rows: 30 })
    expect(screenSize(120, 21)).toEqual({ columns: 45, rows: 17 })
  })

  test('key catcher keys', async () => {
    expect(keyAction({ key: 'up' })).toEqual({ press: 'up' })
    expect(keyAction({ key: 'w' })).toEqual({ press: 'up' })
    expect(keyAction({ key: 'z' })).toEqual({ press: 'b' })
    expect(keyAction({ key: 'j' })).toEqual({ press: 'b' })
    expect(keyAction({ key: 'x' })).toEqual({ press: 'a' })
    expect(keyAction({ key: 'k' })).toEqual({ press: 'a' })
    expect(keyAction({ key: 'return' })).toEqual({ press: 'start' })
    expect(keyAction({ key: 'backspace' })).toEqual({ press: 'select' })
    expect(keyAction({ key: '`' })).toEqual({ press: 'select' })
    expect(keyAction({ key: 'left', shift: true })).toEqual({ latch: 'left' })
    expect(keyAction({ key: 'x', ctrl: true })).toBeUndefined()
  })

  test('every hotkey is a distinct letter or digit', async () => {
    const keys = HOTKEYS.map(h => h.hotkey)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) expect(key).toMatch(/^[a-z0-9]$/)
  })
})

describe('ROMs', () => {
  const io = (files: string[], dir = 'C:/roms'): RomIo => ({
    // A name with a drive is a full path; any other is a file in `dir`.
    exists: async p => files.map(f => (f.includes(':') ? f : `${dir}/${f}`)).includes(p),
    list: async d => (d === dir ? files : []),
  })
  const files = ['Super Game.nes', 'Puzzle One.nes', 'Puzzle Two.nes', 'notes.txt']

  test('exact, without extension, prefix, ambiguous and missing', async () => {
    expect(await resolveRom('Super Game.nes', 'C:/roms', io(files))).toEqual({ path: 'C:/roms/Super Game.nes' })
    expect(await resolveRom('Super Game', 'C:/roms', io(files))).toEqual({ path: 'C:/roms/Super Game.nes' })
    expect(await resolveRom('sup', 'C:/roms', io(files))).toEqual({ path: 'C:/roms/Super Game.nes' })
    expect(await resolveRom('two', 'C:/roms', io(files))).toEqual({ path: 'C:/roms/Puzzle Two.nes' })
    expect(await resolveRom('puzzle', 'C:/roms', io(files))).toEqual({ ambiguous: ['Puzzle One.nes', 'Puzzle Two.nes'] })
    expect(await resolveRom('zelda', 'C:/roms', io(files))).toEqual({ missing: true, tried: ['C:/roms'] })
    expect(await resolveRom('zelda', '', io(files))).toEqual({ missing: true, tried: [] })
  })

  test('a path as given, then under romDir', async () => {
    expect(await resolveRom('D:/x/game.nes', 'C:/roms', io(['D:/x/game.nes']))).toEqual({ path: 'D:/x/game.nes' })
    expect(await resolveRom('sub/game.nes', 'C:/roms', io(['C:/roms/sub/game.nes']))).toEqual({ path: 'C:/roms/sub/game.nes' })
    expect(await resolveRom('sub/none.nes', 'C:/roms', io([]))).toEqual({ missing: true, tried: ['sub/none.nes', 'C:/roms/sub/none.nes'] })
  })

  test('recents: newest first, deduped across slashes and case, at most 8', async () => {
    expect(pushRecent(['C:\\roms\\A.nes', 'b.nes'], 'c:/roms/a.nes')).toEqual(['c:/roms/a.nes', 'b.nes'])
    const many = Array.from({ length: 10 }, (_, i) => `${i}.nes`)
    expect(pushRecent(many, 'new.nes')).toHaveLength(8)
  })
})

describe('the picker', () => {
  test('titles drop the folder and .nes or .zip', async () => {
    expect(romTitle('C:\\roms\\Super Game.nes')).toBe('Super Game')
    expect(romTitle('C:/x/Pack (USA).ZIP')).toBe('Pack (USA)')
    expect(romTitle('plain')).toBe('plain')
    expect(isPathLike('game.zip')).toBe(true)
    expect(parseCommand('game.zip')).toEqual({ kind: 'open', rom: 'game.zip' })
  })

  test('romFilesIn keeps .nes and .zip, sorted, as full paths', async () => {
    expect(romFilesIn('C:/r/', ['b.ZIP', 'notes.txt', 'A.nes', 'ctrl.txt', 'c.nes.bak'])).toEqual(['C:/r/A.nes', 'C:/r/b.ZIP'])
  })

  test('merge keeps source order and drops repeats across slashes and case', async () => {
    const merged = mergeRomSources([
      { source: 'recent', paths: ['C:\\roms\\A.nes', 'D:/z/Z.zip'] },
      { source: 'romDir', paths: ['c:/roms/a.nes', 'C:/roms/B.nes'] },
      { source: 'run', paths: ['C:/mod/run/game.nes', 'C:/roms/b.NES', 'C:/mod/run/pack.zip'] },
    ])
    expect(merged).toEqual([
      { path: 'C:\\roms\\A.nes', title: 'A', source: 'recent' },
      { path: 'D:/z/Z.zip', title: 'Z', source: 'recent' },
      { path: 'C:/roms/B.nes', title: 'B', source: 'romDir' },
      { path: 'C:/mod/run/game.nes', title: 'game', source: 'run' },
      { path: 'C:/mod/run/pack.zip', title: 'pack', source: 'run' },
    ])
    expect(mergeRomSources([])).toEqual([])
  })

  test('middle truncation keeps both ends', async () => {
    expect(middleTruncate('short', 10)).toBe('short')
    expect(middleTruncate('Super Mario Bros. 3 (USA)', 11)).toBe('Super…(USA)')
    expect([...middleTruncate('abcdefghijklmnop', 8)]).toHaveLength(8)
  })
})
