import type { GbaLatch, GbaRomEntry, GbaRomSource } from '../types'

// The pure half of gba-pane: commands, the control file's text, frame and
// status lines, the key tables, ROM lookup and sizing. Nothing here touches
// `$`; register.tsx does.

export type GbaButton = 'up' | 'down' | 'left' | 'right' | 'a' | 'b' | 'start' | 'select' | 'l' | 'r'
export type Action = { press: GbaButton } | { latch: GbaLatch } | { clear: 'dir' }

/** Key events kept in the control file: the helper applies those it has not seen. */
export const MAX_EVENTS = 32
/** Rows under the picture: the key-catcher line and the controls (they wrap). */
export const CONTROL_ROWS = 4

// ---------- commands ----------

export type Command =
  | { kind: 'open'; rom?: string }
  | { kind: 'list' }
  | { kind: 'hd'; on: boolean }
  | { kind: 'window'; on: boolean }
  | { kind: 'save' | 'load'; slot: number }
  | { kind: 'quit' }
  | { kind: 'bad'; text: string }

/** A path, not a name to search for: it has a slash or says `.gba` or `.zip`. */
export function isPathLike(arg: string): boolean {
  return /[\\/]/.test(arg) || /\.(gba|zip)/i.test(arg)
}

/** `/gba <args>` as one command. Anything not a keyword is a ROM to open. */
export function parseCommand(args: string): Command {
  const text = args.trim()
  if (!text) return { kind: 'open' }
  if (isPathLike(text)) return { kind: 'open', rom: text }
  const [word = '', ...rest] = text.split(/\s+/)
  const tail = rest.join(' ').toLowerCase()
  switch (word.toLowerCase()) {
    case 'list':
      if (!tail) return { kind: 'list' }
      break
    case 'hd':
      if (tail === 'on' || tail === 'off') return { kind: 'hd', on: tail === 'on' }
      return { kind: 'bad', text: 'Use /gba hd on or /gba hd off.' }
    case 'window':
      if (!tail || tail === 'on' || tail === 'off') return { kind: 'window', on: tail !== 'off' }
      return { kind: 'bad', text: 'Use /gba window or /gba window off.' }
    case 'save':
    case 'load': {
      const kind = word.toLowerCase() as 'save' | 'load'
      if (!tail) return { kind, slot: 1 }
      if (/^[1-9]$/.test(tail)) return { kind, slot: Number(tail) }
      return { kind: 'bad', text: `Save slots are 1 to 9: /gba ${kind} 3.` }
    }
    case 'quit':
      if (!tail) return { kind: 'quit' }
      break
  }
  return { kind: 'open', rom: text }
}

// ---------- the control file ----------

export type Control = {
  size: { columns: number; rows: number }
  mode: 'play' | 'pause'
  hd: boolean
  window: boolean
  events: readonly string[]
  quit: boolean
}

/** The control file's text, as the helper reads it: settings, events, `end`. */
export function controlText(c: Control): string {
  const lines = [
    `size ${c.size.columns} ${c.size.rows}`,
    `mode ${c.mode}`,
    `hd ${c.hd ? 'on' : 'off'}`,
    `window ${c.window ? 'on' : 'off'}`,
    ...c.events.slice(-MAX_EVENTS),
  ]
  if (c.quit) lines.push('quit')

  return [...lines, 'end', ''].join('\n')
}

// ---------- the helper's output ----------

export type Frame = { columns: number; rows: number; cells: string }

/** A frame line is whole when its cells are exactly columns * rows * 12 bytes. */
export function parseFrame(line: string): Frame | undefined {
  const [columns, rows, cells] = line.split(' ')
  const next = { columns: Number(columns), rows: Number(rows), cells: cells?.trim() ?? '' }
  if (!next.columns || !next.rows) return undefined
  if (next.cells.length !== ((next.columns * next.rows * 12) / 3) * 4) return undefined

  return next
}

export type HelperStatus =
  | { kind: 'ready'; code: string }
  | { kind: 'error'; text: string }
  | { kind: 'play' }
  | { kind: 'input' }
  | { kind: 'windowOff' }
  | { kind: 'saved' | 'loaded' | 'nostate'; slot: number }
  | { kind: 'stateError'; slot: number; text: string }

/** One `\x01S` line's text (the mark taken off). */
export function parseStatusLine(line: string): HelperStatus | undefined {
  const text = line.replace(/\r$/, '').trim()
  let m = /^ready code (\S+)$/.exec(text)
  if (m) return { kind: 'ready', code: m[1] ?? '' }
  m = /^error (.+)$/.exec(text)
  if (m) return { kind: 'error', text: m[1] ?? '' }
  if (text === 'play') return { kind: 'play' }
  if (text === 'input') return { kind: 'input' }
  if (text === 'window off') return { kind: 'windowOff' }
  m = /^(saved|loaded|nostate) (\d)$/.exec(text)
  if (m) return { kind: m[1] as 'saved' | 'loaded' | 'nostate', slot: Number(m[2]) }
  m = /^stateerror (\d) (.+)$/.exec(text)
  if (m) return { kind: 'stateError', slot: Number(m[1]), text: m[2] ?? '' }

  return undefined
}

/** The last stderr line that reads like an error, for the pane's note. */
export function lastErrorLine(stderr: string): string | undefined {
  return stderr
    .trim()
    .split('\n')
    .map(l => l.replace(/\r$/, '').replace(/^gba-cc: /, ''))
    .filter(l => /error|fail/i.test(l))
    .pop()
}

// ---------- sizing ----------

/** Vertical sampling reaches the GBA's 160 lines at 80 rows; wider adds no detail, only bytes. */
export const MAX_SCREEN_COLUMNS = 240

/** The picture's size in cells for a pane body: 3:2 in half-block pixels (a cell is 1 wide, 2 tall). */
export function screenSize(bodyColumns: number, bodyRows: number) {
  const roomRows = Math.max(4, bodyRows - CONTROL_ROWS)
  const columns = Math.max(8, Math.min(bodyColumns, MAX_SCREEN_COLUMNS, roomRows * 3))
  const rows = Math.max(4, Math.min(256, Math.round(columns / 3)))

  return { columns, rows }
}

// One black half-block cell, [0x2580, 0, 0], is 12 bytes: 16 base64 characters
// that repeat whole for a row of them.
const BLACK_CELL = 'gCUAAAAAAAAAAAAA'

export function blackCells(columns: number, rows: number): string {
  return BLACK_CELL.repeat(columns * rows)
}

// ---------- keys ----------

/**
 * Keys the key catcher (a clicked Client) maps to buttons. A key typed there may
 * also press the hotkey Button with that letter, so every letter in both tables
 * means the same button, and no latch hotkey (q, e, r) is here.
 */
export const CLIENT_KEYS: Readonly<Record<string, GbaButton>> = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  w: 'up',
  a: 'left',
  s: 'down',
  d: 'right',
  z: 'b',
  j: 'b',
  x: 'a',
  k: 'a',
  u: 'l',
  i: 'r',
  return: 'start',
  backspace: 'select',
  '`': 'select',
}

export type KeyEvent = { key: string; ctrl?: boolean; shift?: boolean; meta?: boolean }

/** A key from the key catcher as what it does; undefined for chords and unknown keys. */
export function keyAction(ev: KeyEvent): Action | undefined {
  if (ev.ctrl || ev.meta) return undefined
  const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key
  if (ev.shift && (key === 'left' || key === 'right')) return { latch: key }
  if (ev.shift && (key === 'up' || key === 'down')) return { clear: 'dir' }
  const press = CLIENT_KEYS[key]

  return press ? { press } : undefined
}

export type Hotkey = { hotkey: string; label: string; action: Action }

/** The pane's Buttons: their one-letter hotkeys press them while the pane holds the keyboard. */
export const HOTKEYS: readonly Hotkey[] = [
  { hotkey: 'w', label: '↑', action: { press: 'up' } },
  { hotkey: 'a', label: '←', action: { press: 'left' } },
  { hotkey: 's', label: '↓', action: { press: 'down' } },
  { hotkey: 'd', label: '→', action: { press: 'right' } },
  { hotkey: 'j', label: 'B', action: { press: 'b' } },
  { hotkey: 'k', label: 'A', action: { press: 'a' } },
  { hotkey: 'u', label: 'L', action: { press: 'l' } },
  { hotkey: 'i', label: 'R', action: { press: 'r' } },
  { hotkey: 'p', label: 'start', action: { press: 'start' } },
  { hotkey: 'o', label: 'select', action: { press: 'select' } },
  { hotkey: 'q', label: 'hold ←', action: { latch: 'left' } },
  { hotkey: 'e', label: 'hold →', action: { latch: 'right' } },
  { hotkey: 'r', label: 'hold B (run)', action: { latch: 'b' } },
]

/** What the key catcher posts: its instance id and the keys not yet acknowledged. */
export type PadEntry = { n: number; k: string; ctrl?: true; shift?: true; meta?: true }
export type PadMessage = { iid: string; keys: PadEntry[] }

export function parsePadMessage(data: unknown): PadMessage | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const m = data as { iid?: unknown; keys?: unknown }
  if (typeof m.iid !== 'string' || m.iid.length > 64 || !Array.isArray(m.keys) || m.keys.length > 64) return undefined
  const keys: PadEntry[] = []
  for (const raw of m.keys as unknown[]) {
    if (typeof raw !== 'object' || raw === null) return undefined
    const e = raw as Record<string, unknown>
    if (typeof e.n !== 'number' || typeof e.k !== 'string' || e.k.length > 16) return undefined
    const entry: PadEntry = { n: e.n, k: e.k }
    if (e.ctrl === true) entry.ctrl = true
    if (e.shift === true) entry.shift = true
    if (e.meta === true) entry.meta = true
    keys.push(entry)
  }

  return { iid: m.iid, keys }
}

// ---------- ROMs ----------

export type RomIo = {
  exists: (path: string) => Promise<boolean>
  /** The file names in a folder; [] when it cannot be read. */
  list: (dir: string) => Promise<string[]>
}

export type RomLookup = { path: string } | { missing: true; tried: string[] } | { ambiguous: string[] }

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, '')}/${name}`
}

const baseName = (name: string) => name.replace(/\.(gba|zip)$/i, '').toLowerCase()

/** Finds a ROM: a path as given or under romDir; a name by exact base name, unique prefix or unique substring. */
export async function resolveRom(arg: string, romDir: string, io: RomIo): Promise<RomLookup> {
  if (isPathLike(arg)) {
    const tried = [arg]
    if (await io.exists(arg)) return { path: arg }
    if (romDir && !/^([a-z]:)?[\\/]/i.test(arg)) {
      const under = joinPath(romDir, arg)
      tried.push(under)
      if (await io.exists(under)) return { path: under }
    }
    return { missing: true, tried }
  }
  if (!romDir) return { missing: true, tried: [] }
  const names = (await io.list(romDir)).filter(isRomFile)
  const want = arg.toLowerCase()
  const pick = (found: string[]): RomLookup | undefined => {
    if (found.length === 1) return { path: joinPath(romDir, found[0] as string) }
    if (found.length > 1) return { ambiguous: found }
    return undefined
  }

  return (
    pick(names.filter(n => n.toLowerCase() === want || baseName(n) === want)) ??
    pick(names.filter(n => baseName(n).startsWith(want))) ??
    pick(names.filter(n => baseName(n).includes(want))) ?? { missing: true, tried: [romDir] }
  )
}

const normPath = (p: string) => p.replace(/\\/g, '/').toLowerCase()

/** Same file, whatever the slashes and case (Windows). */
export function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b)
}

/** The recent ROMs with `path` first, duplicates dropped, at most `max`. */
export function pushRecent(list: readonly string[], path: string, max = 8): string[] {
  return [path, ...list.filter(p => !samePath(p, path))].slice(0, max)
}

/** A ROM's file name without its folder or `.gba` / `.zip`. */
export function romTitle(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path

  return name.replace(/\.(gba|zip)$/i, '')
}

/** A file the picker offers: a `.gba` ROM or a `.zip` that may hold one. */
export function isRomFile(name: string): boolean {
  return /\.(gba|zip)$/i.test(name)
}

export function isZip(path: string): boolean {
  return /\.zip$/i.test(path)
}

/** The ROM files among a folder's names, as full paths, sorted by name (case-insensitive). */
export function romFilesIn(dir: string, names: readonly string[]): string[] {
  return names
    .filter(isRomFile)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(n => joinPath(dir, n))
}

export type RomGroup = { source: GbaRomSource; paths: readonly string[] }

/** The picker's list: the groups in order, each file once (slashes and case aside), the first source kept. */
export function mergeRomSources(groups: readonly RomGroup[]): GbaRomEntry[] {
  const seen = new Set<string>()
  const out: GbaRomEntry[] = []
  for (const g of groups) {
    for (const path of g.paths) {
      const key = normPath(path)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ path, title: romTitle(path), source: g.source })
    }
  }

  return out
}

/** `text` cut to `max` characters, the middle replaced by an ellipsis. */
export function middleTruncate(text: string, max: number): string {
  const chars = [...text]
  if (chars.length <= max) return text
  if (max <= 1) return chars.slice(0, Math.max(0, max)).join('')
  const keep = max - 1
  const head = Math.ceil(keep / 2)

  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - (keep - head)).join('')}`
}
