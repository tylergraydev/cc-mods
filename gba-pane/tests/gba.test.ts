import { describe, expect, test } from 'claude-code/testing'

import {
  CLIENT_KEYS,
  CONTROL_ROWS,
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
} from '../hooks/gba'
import type { RomIo } from '../hooks/gba'

describe('commands', () => {
  test('keywords, slots and ROM names', async () => {
    expect(parseCommand('')).toEqual({ kind: 'open' })
    expect(parseCommand('golden sun')).toEqual({ kind: 'open', rom: 'golden sun' })
    expect(parseCommand('C:\\roms\\a b.gba')).toEqual({ kind: 'open', rom: 'C:\\roms\\a b.gba' })
    expect(parseCommand('list')).toEqual({ kind: 'list' })
    expect(parseCommand('list.gba')).toEqual({ kind: 'open', rom: 'list.gba' })
    expect(parseCommand('hd off')).toEqual({ kind: 'hd', on: false })
    expect(parseCommand('window')).toEqual({ kind: 'window', on: true })
    expect(parseCommand('window off')).toEqual({ kind: 'window', on: false })
    expect(parseCommand('save')).toEqual({ kind: 'save', slot: 1 })
    expect(parseCommand('load 3')).toEqual({ kind: 'load', slot: 3 })
    expect(parseCommand('save 0')).toEqual({ kind: 'bad', text: 'Save slots are 1 to 9: /gba save 3.' })
    expect(parseCommand('quit')).toEqual({ kind: 'quit' })
    expect(parseCommand('game.zip')).toEqual({ kind: 'open', rom: 'game.zip' })
  })

  test('a .nes name is not a path: it is searched for by name', async () => {
    expect(isPathLike('x.nes')).toBe(false)
    expect(isPathLike('x.gba')).toBe(true)
    expect(parseCommand('x.nes')).toEqual({ kind: 'open', rom: 'x.nes' })
  })
})

describe('the control file', () => {
  const base = { size: { columns: 42, rows: 14 }, mode: 'play' as const, hd: true, window: false, quit: false }

  test('settings, events, end', async () => {
    expect(controlText({ ...base, events: ['k 1 a'] })).toBe('size 42 14\nmode play\nhd on\nwindow off\nk 1 a\nend\n')
  })

  test('events are capped at 32 and quit comes before end', async () => {
    const events = Array.from({ length: 40 }, (_, i) => `k ${i + 1} a`)
    const text = controlText({ ...base, events, quit: true })
    const lines = text.trim().split('\n')
    expect(lines.filter(l => l.startsWith('k '))).toHaveLength(32)
    expect(lines[4]).toBe('k 9 a')
    expect(lines.slice(-2)).toEqual(['quit', 'end'])
  })

  test('a shoulder latch passes through', async () => {
    expect(controlText({ ...base, events: ['h 3 l 1'] })).toContain('\nh 3 l 1\nend\n')
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
    expect(parseStatusLine('ready code AGB-CCGT')).toEqual({ kind: 'ready', code: 'AGB-CCGT' })
    expect(parseStatusLine('ready mapper 0 battery 0')).toBeUndefined()
    expect(parseStatusLine('error not a GBA ROM (.gba)')).toEqual({ kind: 'error', text: 'not a GBA ROM (.gba)' })
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

describe('sizing', () => {
  test('3:2 in half-block pixels, capped at 240 columns', async () => {
    expect(screenSize(80, 40)).toEqual({ columns: 80, rows: 27 })
    expect(screenSize(120, 21)).toEqual({ columns: 51, rows: 17 })
    expect(screenSize(400, 200)).toEqual({ columns: 240, rows: 80 })
    expect(screenSize(16, 8)).toEqual({ columns: 12, rows: 4 })
  })

  test('the picture always leaves room for the controls and keeps its shape', async () => {
    for (const cols of [20, 33, 57, 80, 101, 160, 239, 300]) {
      for (const bodyRows of [12, 17, 25, 40, 61, 90]) {
        const { columns, rows } = screenSize(cols, bodyRows)
        expect(rows <= bodyRows - CONTROL_ROWS).toBe(true)
        expect(Math.abs(columns - 3 * rows) <= 2).toBe(true)
      }
    }
  })
})

describe('keys', () => {
  test('key catcher keys, the shoulders included', async () => {
    expect(keyAction({ key: 'u' })).toEqual({ press: 'l' })
    expect(keyAction({ key: 'i' })).toEqual({ press: 'r' })
    expect(keyAction({ key: 'U' })).toEqual({ press: 'l' })
    expect(keyAction({ key: 'up' })).toEqual({ press: 'up' })
    expect(keyAction({ key: 'w' })).toEqual({ press: 'up' })
    expect(keyAction({ key: 'z' })).toEqual({ press: 'b' })
    expect(keyAction({ key: 'j' })).toEqual({ press: 'b' })
    expect(keyAction({ key: 'x' })).toEqual({ press: 'a' })
    expect(keyAction({ key: 'k' })).toEqual({ press: 'a' })
    expect(keyAction({ key: 'return' })).toEqual({ press: 'start' })
    expect(keyAction({ key: 'backspace' })).toEqual({ press: 'select' })
    expect(keyAction({ key: '`' })).toEqual({ press: 'select' })
    expect(keyAction({ key: 'q' })).toBeUndefined()
    expect(keyAction({ key: 'e' })).toBeUndefined()
    expect(keyAction({ key: 'left', shift: true })).toEqual({ latch: 'left' })
    expect(keyAction({ key: 'u', ctrl: true })).toBeUndefined()
  })

  test('every hotkey is a distinct letter or digit; u and i are L and R', async () => {
    const keys = HOTKEYS.map(h => h.hotkey)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) expect(key).toMatch(/^[a-z0-9]$/)
    expect(HOTKEYS.find(h => h.hotkey === 'u')).toEqual({ hotkey: 'u', label: 'L', action: { press: 'l' } })
    expect(HOTKEYS.find(h => h.hotkey === 'i')).toEqual({ hotkey: 'i', label: 'R', action: { press: 'r' } })
  })

  test('a letter in both tables means the same button; no key catcher letter is a latch hotkey', async () => {
    for (const h of HOTKEYS) {
      const client = CLIENT_KEYS[h.hotkey]
      if ('press' in h.action) {
        if (client) expect(client).toBe(h.action.press)
      } else {
        expect(client).toBeUndefined()
      }
    }
    for (const latch of ['q', 'e', 'r']) expect(CLIENT_KEYS[latch]).toBeUndefined()
  })
})

describe('ROMs', () => {
  const io = (files: string[], dir = 'C:/roms'): RomIo => ({
    // A name with a drive is a full path; any other is a file in `dir`.
    exists: async p => files.map(f => (f.includes(':') ? f : `${dir}/${f}`)).includes(p),
    list: async d => (d === dir ? files : []),
  })
  const files = ['Golden Sun.gba', 'Puzzle One.gba', 'Puzzle Two.gba', 'notes.txt', 'old.nes']

  test('exact, without extension, prefix, ambiguous and missing', async () => {
    expect(await resolveRom('Golden Sun.gba', 'C:/roms', io(files))).toEqual({ path: 'C:/roms/Golden Sun.gba' })
    expect(await resolveRom('Golden Sun', 'C:/roms', io(files))).toEqual({ path: 'C:/roms/Golden Sun.gba' })
    expect(await resolveRom('gol', 'C:/roms', io(files))).toEqual({ path: 'C:/roms/Golden Sun.gba' })
    expect(await resolveRom('two', 'C:/roms', io(files))).toEqual({ path: 'C:/roms/Puzzle Two.gba' })
    expect(await resolveRom('puzzle', 'C:/roms', io(files))).toEqual({ ambiguous: ['Puzzle One.gba', 'Puzzle Two.gba'] })
    expect(await resolveRom('zelda', 'C:/roms', io(files))).toEqual({ missing: true, tried: ['C:/roms'] })
    expect(await resolveRom('zelda', '', io(files))).toEqual({ missing: true, tried: [] })
  })

  test('a .nes file is never matched', async () => {
    expect(await resolveRom('Zelda', 'C:/roms', io([...files, 'Zelda.nes']))).toEqual({ missing: true, tried: ['C:/roms'] })
    expect(await resolveRom('old.nes', 'C:/roms', io(files))).toEqual({ missing: true, tried: ['C:/roms'] })
  })

  test('a path as given, then under romDir', async () => {
    expect(await resolveRom('D:/x/game.gba', 'C:/roms', io(['D:/x/game.gba']))).toEqual({ path: 'D:/x/game.gba' })
    expect(await resolveRom('sub/game.gba', 'C:/roms', io(['C:/roms/sub/game.gba']))).toEqual({ path: 'C:/roms/sub/game.gba' })
    expect(await resolveRom('sub/none.gba', 'C:/roms', io([]))).toEqual({ missing: true, tried: ['sub/none.gba', 'C:/roms/sub/none.gba'] })
  })

  test('recents: newest first, deduped across slashes and case, at most 8', async () => {
    expect(pushRecent(['C:\\roms\\A.gba', 'b.gba'], 'c:/roms/a.gba')).toEqual(['c:/roms/a.gba', 'b.gba'])
    const many = Array.from({ length: 10 }, (_, i) => `${i}.gba`)
    expect(pushRecent(many, 'new.gba')).toHaveLength(8)
  })
})

describe('the picker', () => {
  test('titles drop the folder and .gba or .zip', async () => {
    expect(romTitle('C:\\roms\\Golden Sun.gba')).toBe('Golden Sun')
    expect(romTitle('C:/x/Pack (USA).ZIP')).toBe('Pack (USA)')
    expect(romTitle('plain')).toBe('plain')
  })

  test('romFilesIn keeps .gba and .zip, sorted, as full paths', async () => {
    expect(romFilesIn('C:/r/', ['b.ZIP', 'notes.txt', 'A.gba', 'x.nes', 'y.gb', 'z.gbc', 'c.gba.bak'])).toEqual(['C:/r/A.gba', 'C:/r/b.ZIP'])
  })

  test('merge keeps source order and drops repeats across slashes and case', async () => {
    const merged = mergeRomSources([
      { source: 'recent', paths: ['C:\\roms\\A.gba', 'D:/z/Z.zip'] },
      { source: 'romDir', paths: ['c:/roms/a.gba', 'C:/roms/B.gba'] },
      { source: 'run', paths: ['C:/mod/run/game.gba', 'C:/roms/b.GBA', 'C:/mod/run/pack.zip'] },
    ])
    expect(merged).toEqual([
      { path: 'C:\\roms\\A.gba', title: 'A', source: 'recent' },
      { path: 'D:/z/Z.zip', title: 'Z', source: 'recent' },
      { path: 'C:/roms/B.gba', title: 'B', source: 'romDir' },
      { path: 'C:/mod/run/game.gba', title: 'game', source: 'run' },
      { path: 'C:/mod/run/pack.zip', title: 'pack', source: 'run' },
    ])
    expect(mergeRomSources([])).toEqual([])
  })

  test('middle truncation keeps both ends', async () => {
    expect(middleTruncate('short', 10)).toBe('short')
    expect(middleTruncate('Golden Sun: The Lost Age (USA)', 11)).toBe('Golde…(USA)')
    expect([...middleTruncate('abcdefghijklmnop', 8)]).toHaveLength(8)
  })
})
