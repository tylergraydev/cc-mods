import { describe, expect, test } from 'claude-code/testing'

import {
  HOTKEYS,
  controlText,
  isPathLike,
  keyAction,
  mergeRomSources,
  middleTruncate,
  modelName,
  parseCommand,
  parseFrame,
  parseStatusLine,
  pushRecent,
  resolveRom,
  romFilesIn,
  romKind,
  romTitle,
  screenSize,
} from '../hooks/gb'
import type { RomIo } from '../hooks/gb'

describe('commands', () => {
  test('keywords, slots and ROM names', async () => {
    expect(parseCommand('')).toEqual({ kind: 'open' })
    expect(parseCommand('tetris')).toEqual({ kind: 'open', rom: 'tetris' })
    expect(parseCommand('C:\\roms\\a b.gbc')).toEqual({ kind: 'open', rom: 'C:\\roms\\a b.gbc' })
    expect(parseCommand('list')).toEqual({ kind: 'list' })
    expect(parseCommand('list.gb')).toEqual({ kind: 'open', rom: 'list.gb' })
    // Path-like, so it is looked for as given and fails as a ROM in the helper.
    expect(parseCommand('tetris.gba')).toEqual({ kind: 'open', rom: 'tetris.gba' })
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
    expect(parseStatusLine('ready cgb mbc5 battery 1')).toEqual({ kind: 'ready', model: 'cgb', mbc: 'mbc5', battery: true })
    expect(parseStatusLine('ready dmg rom battery 0')).toEqual({ kind: 'ready', model: 'dmg', mbc: 'rom', battery: false })
    expect(parseStatusLine('ready sgb mbc1 battery 0')).toEqual({ kind: 'ready', model: 'sgb', mbc: 'mbc1', battery: false })
    expect(parseStatusLine('ready nes mapper 4 battery 1')).toBeUndefined()
    expect(parseStatusLine('error unsupported cartridge type 0x22 (MBC7)')).toEqual({
      kind: 'error',
      text: 'unsupported cartridge type 0x22 (MBC7)',
    })
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

  test('models in words', async () => {
    expect(modelName('cgb')).toBe('Game Boy Color')
    expect(modelName('sgb')).toBe('Super Game Boy')
    expect(modelName('dmg')).toBe('Game Boy')
  })
})

describe('sizing and keys', () => {
  test('the picture keeps 10:9 in half-block pixels and leaves room for the controls', async () => {
    expect(screenSize(80, 40)).toEqual({ columns: 80, rows: 36 })
    expect(screenSize(120, 21)).toEqual({ columns: 37, rows: 17 })
    expect(screenSize(16, 8)).toEqual({ columns: 8, rows: 4 })
  })

  test('across pane sizes the picture fits and stays near 10:9', async () => {
    for (const bodyColumns of [24, 40, 63, 80, 101, 160]) {
      for (const bodyRows of [12, 20, 33, 48, 70]) {
        const { columns, rows } = screenSize(bodyColumns, bodyRows)
        expect(rows <= bodyRows - 4).toBe(true)
        expect(columns <= bodyColumns).toBe(true)
        const aspect = columns / (rows * 2)
        expect(Math.abs(aspect - 10 / 9) / (10 / 9) < 0.1).toBe(true)
      }
    }
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
  const files = ['Super Game.gb', 'Puzzle One.gbc', 'Puzzle Two.gbc', 'notes.txt']

  test('exact, without extension, prefix, ambiguous and missing', async () => {
    expect(await resolveRom('Super Game.gb', 'C:/roms', io(files))).toEqual({ path: 'C:/roms/Super Game.gb' })
    expect(await resolveRom('Super Game', 'C:/roms', io(files))).toEqual({ path: 'C:/roms/Super Game.gb' })
    expect(await resolveRom('sup', 'C:/roms', io(files))).toEqual({ path: 'C:/roms/Super Game.gb' })
    expect(await resolveRom('two', 'C:/roms', io(files))).toEqual({ path: 'C:/roms/Puzzle Two.gbc' })
    expect(await resolveRom('puzzle', 'C:/roms', io(files))).toEqual({ ambiguous: ['Puzzle One.gbc', 'Puzzle Two.gbc'] })
    expect(await resolveRom('zelda', 'C:/roms', io(files))).toEqual({ missing: true, tried: ['C:/roms'] })
    expect(await resolveRom('zelda', '', io(files))).toEqual({ missing: true, tried: [] })
  })

  test('a .gb and a .gbc of one name: the bare name is ambiguous, the full name exact', async () => {
    const both = ['Tetris.gb', 'Tetris.gbc']
    expect(await resolveRom('tetris', 'C:/roms', io(both))).toEqual({ ambiguous: ['Tetris.gb', 'Tetris.gbc'] })
    expect(await resolveRom('Tetris.gbc', 'C:/roms', io(both))).toEqual({ path: 'C:/roms/Tetris.gbc' })
  })

  test('a path as given, then under romDir', async () => {
    expect(await resolveRom('D:/x/game.gb', 'C:/roms', io(['D:/x/game.gb']))).toEqual({ path: 'D:/x/game.gb' })
    expect(await resolveRom('sub/game.gbc', 'C:/roms', io(['C:/roms/sub/game.gbc']))).toEqual({ path: 'C:/roms/sub/game.gbc' })
    expect(await resolveRom('sub/none.gb', 'C:/roms', io([]))).toEqual({ missing: true, tried: ['sub/none.gb', 'C:/roms/sub/none.gb'] })
  })

  test('recents: newest first, deduped across slashes and case, at most 8', async () => {
    expect(pushRecent(['C:\\roms\\A.gb', 'b.gbc'], 'c:/roms/a.gb')).toEqual(['c:/roms/a.gb', 'b.gbc'])
    const many = Array.from({ length: 10 }, (_, i) => `${i}.gb`)
    expect(pushRecent(many, 'new.gb')).toHaveLength(8)
  })
})

describe('the picker', () => {
  test('titles drop the folder and .gb, .gbc or .zip', async () => {
    expect(romTitle('C:\\roms\\Super Game.gb')).toBe('Super Game')
    expect(romTitle('C:\\roms\\Color Game.gbc')).toBe('Color Game')
    expect(romTitle('C:/x/Pack (USA).ZIP')).toBe('Pack (USA)')
    expect(romTitle('plain')).toBe('plain')
    expect(isPathLike('game.zip')).toBe(true)
    expect(parseCommand('game.zip')).toEqual({ kind: 'open', rom: 'game.zip' })
  })

  test('romFilesIn keeps .gb, .gbc and .zip, sorted, as full paths', async () => {
    expect(romFilesIn('C:/r/', ['b.ZIP', 'notes.txt', 'A.gb', 'C.GBC', 'ctrl.txt', 'c.gb.bak', 'd.gba'])).toEqual([
      'C:/r/A.gb',
      'C:/r/b.ZIP',
      'C:/r/C.GBC',
    ])
  })

  test('the kind tag tells a .gb from a .gbc', async () => {
    expect(romKind('C:/r/Tetris.gb')).toBe('gb')
    expect(romKind('C:/r/Tetris.GBC')).toBe('gbc')
    expect(romKind('C:/r/pack.zip')).toBe('zip')
  })

  test('merge keeps source order and drops repeats across slashes and case', async () => {
    const merged = mergeRomSources([
      { source: 'recent', paths: ['C:\\roms\\A.gb', 'D:/z/Z.zip'] },
      { source: 'romDir', paths: ['c:/roms/a.gb', 'C:/roms/B.gbc'] },
      { source: 'run', paths: ['C:/mod/run/game.gb', 'C:/roms/b.GBC', 'C:/mod/run/pack.zip'] },
    ])
    expect(merged).toEqual([
      { path: 'C:\\roms\\A.gb', title: 'A', source: 'recent' },
      { path: 'D:/z/Z.zip', title: 'Z', source: 'recent' },
      { path: 'C:/roms/B.gbc', title: 'B', source: 'romDir' },
      { path: 'C:/mod/run/game.gb', title: 'game', source: 'run' },
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
