import type { SudokuDifficulty, SudokuState } from '../types'
import { clock, defineGame, seg } from './game'
import type { GameControl, Key, Seg } from './game'
import { shuffle } from './rng'

// Sudoku: a generated puzzle with exactly one solution, pencil marks, a check
// that marks wrong entries and a timer that survives pauses and reloads.

const FULL = 0x1ff
export const CLUES: Record<SudokuDifficulty, number> = { easy: 40, medium: 32, hard: 26 }
const NODE_CAP = 50_000

const bit = (d: number) => 1 << (d - 1)
const boxOf = (i: number) => Math.floor(i / 27) * 3 + Math.floor((i % 9) / 3)

type Masks = { row: number[]; col: number[]; box: number[] }

function masksOf(grid: readonly number[]): Masks | undefined {
  const m: Masks = { row: Array(9).fill(0), col: Array(9).fill(0), box: Array(9).fill(0) }
  for (let i = 0; i < 81; i++) {
    const d = grid[i] as number
    if (d === 0) continue
    const r = Math.floor(i / 9), c = i % 9, b = boxOf(i)
    const bt = bit(d)
    if (((m.row[r] as number) & bt) || ((m.col[c] as number) & bt) || ((m.box[b] as number) & bt)) return undefined
    put(m, i, d, true)
  }
  return m
}

const candidates = (m: Masks, i: number) => FULL & ~((m.row[Math.floor(i / 9)] as number) | (m.col[i % 9] as number) | (m.box[boxOf(i)] as number))
const popcount = (x: number) => {
  let n = 0
  for (; x; x &= x - 1) n++
  return n
}

/** The cell with the fewest candidates (MRV), -1 when the grid is full, -2 when a cell has none. */
function pick(grid: number[], m: Masks): number {
  let best = -1
  let bestN = 10
  for (let i = 0; i < 81; i++) {
    if (grid[i] !== 0) continue
    const n = popcount(candidates(m, i))
    if (n === 0) return -2
    if (n < bestN) {
      best = i
      bestN = n
      if (n === 1) break
    }
  }
  return best
}

function put(m: Masks, i: number, d: number, on: boolean) {
  const r = Math.floor(i / 9), c = i % 9, b = boxOf(i)
  const bt = bit(d)
  if (on) {
    m.row[r] = (m.row[r] as number) | bt
    m.col[c] = (m.col[c] as number) | bt
    m.box[b] = (m.box[b] as number) | bt
  } else {
    m.row[r] = (m.row[r] as number) & ~bt
    m.col[c] = (m.col[c] as number) & ~bt
    m.box[b] = (m.box[b] as number) & ~bt
  }
}

/** How many solutions `grid` has, counting no further than `limit`; a search past `nodeCap` nodes answers `limit` (not provably unique). */
export function countSolutions(grid: readonly number[], limit = 2, nodeCap = NODE_CAP): number {
  const g = grid.slice()
  const m = masksOf(g)
  if (!m) return 0
  let nodes = 0
  let found = 0
  const go = (): void => {
    if (found >= limit || nodes > nodeCap) return
    nodes++
    const i = pick(g, m)
    if (i === -2) return
    if (i === -1) {
      found++
      return
    }
    let cand = candidates(m, i)
    while (cand && found < limit && nodes <= nodeCap) {
      const lowest = cand & -cand
      cand &= cand - 1
      const d = Math.log2(lowest) + 1
      g[i] = d
      put(m, i, d, true)
      go()
      put(m, i, d, false)
      g[i] = 0
    }
  }
  go()
  return nodes > nodeCap ? limit : found
}

/** The first solution found, or undefined. */
export function solve(grid: readonly number[]): number[] | undefined {
  const g = grid.slice()
  const m = masksOf(g)
  if (!m) return undefined
  const go = (): boolean => {
    const i = pick(g, m)
    if (i === -2) return false
    if (i === -1) return true
    let cand = candidates(m, i)
    while (cand) {
      const lowest = cand & -cand
      cand &= cand - 1
      const d = Math.log2(lowest) + 1
      g[i] = d
      put(m, i, d, true)
      if (go()) return true
      put(m, i, d, false)
      g[i] = 0
    }
    return false
  }
  return go() ? g : undefined
}

/** A full valid grid, its candidates tried in a seeded order. */
function fill(seed: number): { grid: number[]; s: number } {
  const g = Array<number>(81).fill(0)
  const m = masksOf(g) as Masks
  let s = seed
  const go = (): boolean => {
    const i = pick(g, m)
    if (i === -2) return false
    if (i === -1) return true
    const ds: number[] = []
    const cand = candidates(m, i)
    for (let d = 1; d <= 9; d++) if (cand & bit(d)) ds.push(d)
    const sh = shuffle(ds, s)
    s = sh.s
    for (const d of sh.items) {
      g[i] = d
      put(m, i, d, true)
      if (go()) return true
      put(m, i, d, false)
      g[i] = 0
    }
    return false
  }
  go()
  return { grid: g, s }
}

/** A puzzle for `difficulty`: a solution, and givens dug out until the target clue count or no more can go while the solution stays unique. */
export function generate(seed: number, difficulty: SudokuDifficulty): { givens: number[]; solution: number[]; clues: number; rng: number } {
  const f = fill(seed)
  const givens = f.grid.slice()
  const order = shuffle(Array.from({ length: 81 }, (_, i) => i), f.s)
  let clues = 81
  for (const i of order.items) {
    if (clues <= CLUES[difficulty]) break
    const was = givens[i] as number
    givens[i] = 0
    if (countSolutions(givens, 2, NODE_CAP) === 1) clues--
    else givens[i] = was
  }
  return { givens, solution: f.grid, clues, rng: order.s }
}

/** The cells that share a digit with a peer in their row, column or box. */
export function conflicts(cells: readonly number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < 81; i++) {
    const d = cells[i] as number
    if (d === 0) continue
    const r = Math.floor(i / 9), c = i % 9
    for (let j = 0; j < 81; j++) {
      if (j === i || cells[j] !== d) continue
      if (Math.floor(j / 9) === r || j % 9 === c || boxOf(j) === boxOf(i)) {
        out.push(i)
        break
      }
    }
  }
  return out
}

// ---------- layout: 25 columns, box lines every three cells ----------

const ROW_Y = Array.from({ length: 9 }, (_, r) => 1 + r + Math.floor(r / 3))

/** Where a cell's digit sits in the drawn board (region cells). */
export const cellXY = (i: number) => {
  const c = i % 9
  return { x: 2 + 8 * Math.floor(c / 3) + 2 * (c % 3), y: ROW_Y[Math.floor(i / 9)] as number }
}

/** The cell under a click at region cell (x, y), or undefined on a box line. */
export function cellAt(x: number, y: number): number | undefined {
  const r = ROW_Y.indexOf(y)
  if (r < 0 || x < 1 || x > 23 || x % 8 === 0) return undefined
  let best = 0
  for (let c = 1; c < 9; c++) if (Math.abs(x - cellXY(c).x) < Math.abs(x - cellXY(best).x)) best = c
  return r * 9 + best
}

const BOX_TOP = '┌───────┬───────┬───────┐'
const BOX_MID = '├───────┼───────┼───────┤'
const BOX_BOT = '└───────┴───────┴───────┘'

const marksOf = (mask: number) => Array.from({ length: 9 }, (_, k) => k + 1).filter(d => mask & bit(d))

function fold(s: SudokuState, now: number): SudokuState {
  if (s.runningSince === undefined) return s
  const { runningSince, ...rest } = s
  return { ...rest, elapsedMs: s.elapsedMs + Math.max(0, now - runningSince) }
}

function setDigit(s: SudokuState, d: number, now: number): SudokuState {
  const i = s.cursor
  if (s.givens[i] !== 0) return s
  if (s.markMode) {
    if (s.cells[i] !== 0) return s
    const marks = s.marks.slice()
    marks[i] = (marks[i] as number) ^ bit(d)
    return { ...s, marks, wrong: [] }
  }
  const cells = s.cells.slice()
  cells[i] = d
  const marks = s.marks.slice()
  marks[i] = 0
  const next = { ...s, cells, marks, wrong: [] }
  return cells.every((v, k) => v === s.solution[k]) ? fold({ ...next, solved: true }, now) : next
}

function clear(s: SudokuState): SudokuState {
  const i = s.cursor
  if (s.givens[i] !== 0) return s
  const cells = s.cells.slice()
  cells[i] = 0
  const marks = s.marks.slice()
  marks[i] = 0
  return { ...s, cells, marks, wrong: [] }
}

const STEPS: Record<string, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }

function onKey(s: SudokuState, key: Key, now: number): SudokuState {
  if (key in STEPS) {
    const [dx, dy] = STEPS[key] as [number, number]
    const x = Math.min(8, Math.max(0, (s.cursor % 9) + dx))
    const y = Math.min(8, Math.max(0, Math.floor(s.cursor / 9) + dy))
    return { ...s, cursor: y * 9 + x }
  }
  if (key.startsWith('tap:')) {
    const [, x, y] = key.split(':')
    const i = cellAt(Number(x), Number(y))
    return i === undefined ? s : { ...s, cursor: i }
  }
  if (s.solved || s.revealed) return s
  if (key === 'a') {
    if (s.givens[s.cursor] !== 0) return s
    const d = ((s.cells[s.cursor] as number) + 1) % 10
    return d === 0 ? clear(s) : setDigit({ ...s, markMode: false }, d, now)
  }
  if (key === 'b' || key === 'c:0' || key === 'c:x') return clear(s)
  if (key === 'select' || key === 'c:p') return { ...s, markMode: !s.markMode }
  if (key === 'c:c') {
    return { ...s, wrong: s.cells.map((v, i) => (v !== 0 && v !== s.solution[i] ? i : -1)).filter(i => i >= 0) }
  }
  if (key === 'c:s') return fold({ ...s, cells: s.solution.slice(), marks: Array(81).fill(0), wrong: [], revealed: true }, now)
  if (key.startsWith('c:')) {
    const d = Number(key.slice(2))
    return d >= 1 && d <= 9 ? setDigit(s, d, now) : s
  }
  return s
}

const controls: GameControl[] = [
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(
    (d): GameControl => ({ label: String(d), key: `c:${d}` as Key, hotkey: String(d), kb: d === 1 ? '1-9 enter a digit (or a pencil mark)' : '', ...(d === 1 ? { pad: 'a raises the digit' } : {}) }),
  ),
  { label: '0', key: 'c:0', hotkey: '0', kb: '0 x Backspace clear', pad: 'b clears' },
  { label: '◀', key: 'left', hotkey: 'h', kb: 'arrows or hjkl move (or click a cell)', pad: 'd-pad moves' },
  { label: '▶', key: 'right', hotkey: 'l', kb: '' },
  { label: '▲', key: 'up', hotkey: 'k', kb: '' },
  { label: '▼', key: 'down', hotkey: 'j', kb: '' },
  { label: 'check', key: 'c:c', hotkey: 'c', kb: 'c check for wrong entries' },
  { label: 'solve', key: 'c:s', hotkey: 's', kb: 's reveal the solution (no best time)' },
  { label: 'marks', key: 'c:p', hotkey: 'p', kb: 'p pencil-mark mode', pad: 'select toggles marks' },
]

export const sudokuGame = defineGame<SudokuState>({
  id: 'sudoku',
  title: 'Sudoku',
  blurb: 'One solution, pencil marks, your best times kept.',
  minColumns: 25,
  softPause: true,
  keyboard: { p: 'c:p' },
  repeatable: ['left', 'right', 'up', 'down'],
  init(seed, opts, now) {
    const difficulty: SudokuDifficulty = opts.difficulty === 'easy' || opts.difficulty === 'hard' ? opts.difficulty : 'medium'
    const g = generate(seed, difficulty)
    return {
      difficulty, givens: g.givens, solution: g.solution, cells: g.givens.slice(), marks: Array(81).fill(0), cursor: 40,
      markMode: false, runningSince: now, elapsedMs: 0, wrong: [], solved: false, revealed: false, clues: g.clues, recorded: false,
    }
  },
  onKey,
  tickMs: s => (s.runningSince === undefined ? undefined : 1000),
  onTick(s, now) {
    return s.runningSince === undefined ? s : { ...s, elapsedMs: s.elapsedMs + Math.max(0, now - s.runningSince), runningSince: now }
  },
  pause: (s, now) => fold(s, now),
  resume: (s, now) => (s.solved || s.revealed || s.runningSince !== undefined ? s : { ...s, runningSince: now }),
  isOver: s => s.solved || s.revealed,
  score(s) {
    if (!s.solved || s.revealed || s.recorded) return undefined
    return { counters: { [`solved.${s.difficulty}`]: 1 }, bests: { [s.difficulty]: { value: s.elapsedMs, lower: true } } }
  },
  controls,
  view(s, _cols, _rows, score) {
    const bad = new Set(conflicts(s.cells))
    const wrong = new Set(s.wrong)
    const rowText = (r: number): Seg[] => {
      const out: Seg[] = [seg('│', { dim: true })]
      for (let b = 0; b < 3; b++) {
        for (let k = 0; k < 3; k++) {
          const i = r * 9 + b * 3 + k
          const d = s.cells[i] as number
          const given = s.givens[i] !== 0
          const hasMarks = (s.marks[i] as number) !== 0
          const ch = d ? String(d) : hasMarks ? '·' : ' '
          out.push(
            seg(` ${ch}`, {
              bold: given,
              color: wrong.has(i) || bad.has(i) ? 'red' : given ? undefined : d ? 'cyan' : undefined,
              dim: d === 0 && hasMarks,
              underline: wrong.has(i),
              inverse: i === s.cursor,
            }),
          )
        }
        out.push(seg(' │', { dim: true }))
      }
      return out
    }
    const board: Seg[][] = [[seg(BOX_TOP, { dim: true })]]
    for (let r = 0; r < 9; r++) {
      board.push(rowText(r))
      if (r === 2 || r === 5) board.push([seg(BOX_MID, { dim: true })])
    }
    board.push([seg(BOX_BOT, { dim: true })])
    const best = score?.bests[s.difficulty]
    const marks = marksOf(s.marks[s.cursor] as number)
    const status = s.solved
      ? `Solved in ${clock(s.elapsedMs)}!   n: new puzzle`
      : s.revealed
        ? 'Solution shown.   n: new puzzle'
        : s.wrong.length > 0
          ? `${s.wrong.length} wrong (red). Fix them or keep going.`
          : s.markMode
            ? `Pencil marks${marks.length ? `: ${marks.join(' ')}` : ''}  (p: back to digits)`
            : marks.length
              ? `Marks here: ${marks.join(' ')}`
              : 'Arrows move, 1-9 enter, 0 clears.'
    return {
      header: [
        seg(' SUDOKU ', { bold: true, color: 'cyan' }),
        seg(` ${s.difficulty} ${clock(s.elapsedMs)}${best ? ` best ${clock(best)}` : ''}${s.markMode ? ' ✎' : ''}`, { dim: true }),
      ],
      board,
      status,
    }
  },
})
