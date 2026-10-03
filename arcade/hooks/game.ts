import type { ArcadeScores, GameScore } from '../types'

// What every game module shares: the key vocabulary, the plain-data view a game
// returns for drawing, the Game interface the shell drives, the keyboard map
// and the score merge. Pure: no `$`, so nothing here touches the engine.

/** What a controller or a mapped key means to a game. */
export type GameKey = 'left' | 'right' | 'up' | 'down' | 'a' | 'b' | 'start' | 'select'
/** A GameKey, a character (`c:5`, `c: ` for Space) or a click at a region cell (`tap:x:y`). */
export type Key = GameKey | `c:${string}` | `tap:${number}:${number}`

/** A run of text in one style; fields are left out, never undefined, so it is plain JSON. */
export type Seg = {
  text: string
  color?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  inverse?: boolean
  underline?: boolean
}

/** One cell of a game drawn as Buttons (tic-tac-toe). */
export type GridCell = { key: string; label: string; hotkey?: string; highlight: boolean; press: Key }

export type GameControl = { label: string; key: Key; hotkey?: string; kb: string; pad?: string }

export type View = {
  header: Seg[]
  /** The board as lines of runs; a Client draws them and keys/clicks come back. */
  board: Seg[][]
  /** When present the pane draws these as Buttons instead of `board`. */
  grid?: GridCell[][]
  status: string
  /** The Buttons this phase offers (a subset of `Game.controls`); absent: the shell draws all of them. */
  controls?: GameControl[]
}

export type ScoreDelta = {
  counters?: Record<string, number>
  bests?: Record<string, { value: number; lower?: boolean }>
}

export interface Game<S extends { recorded: boolean }, O = Record<string, string>> {
  id: string
  title: string
  blurb: string
  minColumns: number
  init(seed: number, opts: O, now: number): S
  onKey(state: S, key: Key, now: number): S
  onTick?(state: S, now: number): S
  /** Gravity or clock period in ms while the game runs; undefined = no ticking. */
  tickMs?(state: S): number | undefined
  /** Raw Client key to Key, tried before the global map. */
  keyboard?: Record<string, Key>
  /** Which controller `repeat` lines count. */
  repeatable?: GameKey[]
  view(state: S, cols: number, rows: number, score?: GameScore): View
  isOver(state: S): boolean
  score(state: S): ScoreDelta | undefined
  controls: GameControl[]
  pause?(state: S, now: number): S
  resume?(state: S, now: number): S
  /** A reload comes back paused. */
  pauseOnReload?: boolean
  /** Any key resumes a pause and is then applied (no dedicated pause key). */
  softPause?: boolean
  /** Games that bet from the shared bankroll: the shell writes it in on start/resume and reads it back after every step. */
  bank?: { get(state: S): number; set(state: S, chips: number): S }
}

export const defineGame = <S extends { recorded: boolean }, O = Record<string, string>>(g: Game<S, O>): Game<S, O> => g

/** The shell's own keys, drawn as Buttons under every game. */
export const SHELL_CONTROLS: GameControl[] = [
  { label: 'new', key: 'c:n', hotkey: 'n', kb: 'n' },
  { label: 'games', key: 'c:q', hotkey: 'q', kb: 'q' },
  { label: 'help', key: 'c:i', hotkey: 'i', kb: 'i or ?' },
]

/** A run with only the fields that have a value. */
export function seg(text: string, style: Omit<Seg, 'text'> = {}): Seg {
  const out: Seg = { text }
  for (const k of Object.keys(style) as (keyof Omit<Seg, 'text'>)[]) {
    const v = style[k]
    if (v !== undefined && v !== false) (out as Record<string, unknown>)[k] = v
  }
  return out
}

/** Plain text as one run per line. */
export const segsOf = (text: string, style: Omit<Seg, 'text'> = {}): Seg[] => [seg(text, style)]

/** Adjacent runs with the same style joined, so a row stays small. */
export function mergeSegs(segs: Seg[]): Seg[] {
  const out: Seg[] = []
  for (const s of segs) {
    const last = out[out.length - 1]
    if (last && last.color === s.color && last.bg === s.bg && last.bold === s.bold && last.dim === s.dim && last.inverse === s.inverse && last.underline === s.underline) {
      last.text += s.text
    } else out.push({ ...s })
  }
  return out
}

const GLOBAL: Record<string, Key> = {
  left: 'left', h: 'left', right: 'right', l: 'right', up: 'up', k: 'up', down: 'down', j: 'down',
  return: 'a', backspace: 'b', delete: 'b', p: 'start', ' ': 'c: ', space: 'c: ',
}

/** A key the Client reports to a Key: the game's own map first, then the global one. */
export function mapClientKey(raw: string, keyboard?: Record<string, Key>): Key | undefined {
  if (raw.length === 0) return undefined
  const own = keyboard?.[raw]
  if (own) return own
  const global = GLOBAL[raw]
  if (global) return global
  return raw.length === 1 ? `c:${raw}` : undefined
}

/** A pressed Button's hotkey as the Key it stands for (`undefined` when no control has it). */
export function mapHotkey(controls: readonly GameControl[], hotkey: string): Key | undefined {
  return controls.find(c => c.hotkey === hotkey)?.key
}

const emptyScore = (): GameScore => ({ played: 0, counters: {}, bests: {} })

/** Scores with one finished game folded in: counters add, bests keep the better. */
export function mergeScore(scores: ArcadeScores, id: string, delta: ScoreDelta): ArcadeScores {
  const old = scores[id] ?? emptyScore()
  const counters = { ...old.counters }
  for (const [k, n] of Object.entries(delta.counters ?? {})) counters[k] = (counters[k] ?? 0) + n
  const bests = { ...old.bests }
  for (const [k, b] of Object.entries(delta.bests ?? {})) {
    const had = bests[k]
    if (had === undefined || (b.lower ? b.value < had : b.value > had)) bests[k] = b.value
  }
  return { ...scores, [id]: { played: old.played + 1, counters, bests } }
}

/** `3:07` or `1:02:03` for a duration in ms. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** `4120` as `4,120`. */
export const fmtNum = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** One key or click the board posted, numbered so a lost post can be resent and acknowledged. */
export type BoardEntry = { n: number; k: string; ctrl?: true; shift?: true; meta?: true; c?: number; r?: number }
export type BoardMessage = { iid: string; keys: BoardEntry[] }

/** The board's post as typed data; undefined when its shape is wrong (it came from code, so it is input, not fact). */
export function parseBoardMessage(data: unknown): BoardMessage | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const m = data as { iid?: unknown; keys?: unknown }
  if (typeof m.iid !== 'string' || m.iid.length > 64 || !Array.isArray(m.keys) || m.keys.length > 64) return undefined
  const keys: BoardEntry[] = []
  for (const raw of m.keys as unknown[]) {
    if (typeof raw !== 'object' || raw === null) return undefined
    const e = raw as Record<string, unknown>
    if (typeof e.n !== 'number' || typeof e.k !== 'string' || e.k.length > 16) return undefined
    const entry: BoardEntry = { n: e.n, k: e.k }
    if (e.ctrl === true) entry.ctrl = true
    if (e.meta === true) entry.meta = true
    if (e.k === 'tap') {
      if (typeof e.c !== 'number' || typeof e.r !== 'number') return undefined
      entry.c = Math.floor(e.c)
      entry.r = Math.floor(e.r)
    }
    keys.push(entry)
  }
  return { iid: m.iid, keys }
}

/** A posted entry as the Key it means for `keyboard`'s game; undefined for ctrl/meta chords and unknown keys. */
export function entryKey(entry: BoardEntry, keyboard?: Record<string, Key>): Key | undefined {
  if (entry.k === 'tap') return `tap:${entry.c ?? 0}:${entry.r ?? 0}`
  if (entry.ctrl || entry.meta) return undefined
  return mapClientKey(entry.k, keyboard)
}
