import type { GameScore, TetrisPiece, TetrisState } from '../types'
import { defineGame, fmtNum, mergeSegs, seg } from './game'
import type { GameControl, Key, Seg } from './game'
import { shuffle } from './rng'

// Tetris: SRS spawn orientations with SRS-lite rotation (no kick tables, a
// short list of sideways nudges), a 7-bag, hold, a ghost, a lock delay of one
// gravity tick and the guideline's scoring. Pure: the shell owns the timer.

export const W = 10
export const H = 20
export const PIECES = 'IOTSZJL'
const COLORS = ['cyan', 'yellow', 'magenta', 'green', 'red', 'blue', 'white']
/** Sideways offsets a rotation tries, in order. */
export const KICKS = [0, -1, 1, -2, 2]
/** Gravity in ms per row for levels 1-10; deeper levels stay at the cap. */
export const GRAVITY = [1000, 793, 618, 473, 355, 262, 190, 135, 100, 80]
export const MIN_GRAVITY = 80

type Cell = [number, number]

const BASE: Cell[][] = [
  [[0, 1], [1, 1], [2, 1], [3, 1]], // I
  [[1, 0], [2, 0], [1, 1], [2, 1]], // O
  [[1, 0], [0, 1], [1, 1], [2, 1]], // T
  [[1, 0], [2, 0], [0, 1], [1, 1]], // S
  [[0, 0], [1, 0], [1, 1], [2, 1]], // Z
  [[0, 0], [0, 1], [1, 1], [2, 1]], // J
  [[2, 0], [0, 1], [1, 1], [2, 1]], // L
]

/** The four rotation states of each kind as cells in their 3x3 (I: 4x4) box. */
export const SHAPES: Cell[][][] = BASE.map((cells, kind) => {
  if (kind === 1) return [cells, cells, cells, cells]
  const n = kind === 0 ? 4 : 3
  const out: Cell[][] = [cells]
  for (let r = 1; r < 4; r++) out.push((out[r - 1] as Cell[]).map(([x, y]): Cell => [n - 1 - y, x]))
  return out
})

export const cellsOf = (p: TetrisPiece): Cell[] => (SHAPES[p.kind] as Cell[][])[p.rot % 4]!.map(([x, y]): Cell => [p.x + x, p.y + y])

/** Whether a piece fits in the well: inside the walls and floor, on no filled cell. */
export function fits(well: readonly number[], p: TetrisPiece): boolean {
  return cellsOf(p).every(([x, y]) => x >= 0 && x < W && y >= 0 && y < H && well[y * W + x] === 0)
}

export const levelFor = (lines: number) => 1 + Math.floor(lines / 10)

/** Gravity in ms per row at a level. */
export const gravityMs = (level: number, mode: 'normal' | 'zen') =>
  mode === 'zen' ? 1000 : Math.max(MIN_GRAVITY, GRAVITY[Math.min(level, GRAVITY.length) - 1] as number)

const LINE_POINTS = [0, 100, 300, 500, 800]
export const lineScore = (cleared: number, level: number) => (LINE_POINTS[cleared] ?? 0) * level
const CLEAR_NAMES = ['', 'single', 'double', 'triple', 'TETRIS']

/** The next kind from a 7-bag, refilled (shuffled) when empty. */
export function pull(bag: readonly number[], rng: number): { kind: number; bag: number[]; rng: number } {
  let b = bag.slice()
  let s = rng
  if (b.length === 0) {
    const sh = shuffle([0, 1, 2, 3, 4, 5, 6], s)
    b = sh.items
    s = sh.s
  }
  const kind = b.shift() as number
  return { kind, bag: b, rng: s }
}

/** The well without full rows, and how many there were. */
export function clearLines(well: readonly number[]): { well: number[]; cleared: number } {
  const keep: number[][] = []
  for (let y = 0; y < H; y++) {
    const row = well.slice(y * W, y * W + W)
    if (!row.every(v => v !== 0)) keep.push(row)
  }
  const cleared = H - keep.length
  return { well: [...Array<number>(cleared * W).fill(0), ...keep.flat()], cleared }
}

const spawn = (kind: number): TetrisPiece => ({ kind, rot: 0, x: 3, y: 0 })

function topUp(s: TetrisState): TetrisState {
  let { bag, next, rng } = s
  next = next.slice()
  while (next.length < 4) {
    const p = pull(bag, rng)
    bag = p.bag
    rng = p.rng
    next.push(p.kind)
  }
  return { ...s, bag, next, rng }
}

/** The state after the next piece spawns (a blocked spawn ends the game). */
function spawnNext(s: TetrisState, kind?: number): TetrisState {
  let t = s
  let k = kind
  if (k === undefined) {
    t = topUp(s)
    k = t.next[0] as number
    t = { ...t, next: t.next.slice(1) }
    t = topUp(t)
  }
  const piece = spawn(k)
  return { ...t, piece, grounded: 0, over: !fits(t.well, piece) }
}

function lock(s: TetrisState): TetrisState {
  const well = s.well.slice()
  for (const [x, y] of cellsOf(s.piece)) well[y * W + x] = s.piece.kind + 1
  const r = clearLines(well)
  const lines = s.lines + r.cleared
  const score = s.score + lineScore(r.cleared, s.level)
  const next: TetrisState = {
    ...s, well: r.well, lines, score, level: levelFor(lines), canHold: true,
    ...(r.cleared ? { lastClear: CLEAR_NAMES[r.cleared] as string } : {}),
  }
  return spawnNext(next)
}

function dropY(well: readonly number[], p: TetrisPiece): number {
  let q = p
  while (fits(well, { ...q, y: q.y + 1 })) q = { ...q, y: q.y + 1 }
  return q.y
}

function move(s: TetrisState, dx: number): TetrisState {
  const p = { ...s.piece, x: s.piece.x + dx }
  return fits(s.well, p) ? { ...s, piece: p } : s
}

function rotate(s: TetrisState, dir: 1 | 3): TetrisState {
  const rot = (s.piece.rot + dir) % 4
  for (const dx of KICKS) {
    const p = { ...s.piece, rot, x: s.piece.x + dx }
    if (fits(s.well, p)) return { ...s, piece: p }
  }
  return s
}

function hold(s: TetrisState): TetrisState {
  if (!s.canHold) return s
  const current = s.piece.kind
  const swapped = s.hold
  const base = { ...s, hold: current, canHold: false }
  return swapped === null ? spawnNext(base) : spawnNext(base, swapped)
}

function hardDrop(s: TetrisState): TetrisState {
  const y = dropY(s.well, s.piece)
  return lock({ ...s, piece: { ...s.piece, y }, score: s.score + 2 * (y - s.piece.y) })
}

function onKey(s: TetrisState, key: Key): TetrisState {
  if (s.over) return s
  switch (key) {
    case 'left': return move(s, -1)
    case 'right': return move(s, 1)
    case 'down': {
      const p = { ...s.piece, y: s.piece.y + 1 }
      return fits(s.well, p) ? { ...s, piece: p, score: s.score + 1, grounded: 0 } : s
    }
    case 'a': case 'c:x': return rotate(s, 1)
    case 'b': case 'c:z': return rotate(s, 3)
    case 'up': case 'c: ': return hardDrop(s)
    case 'select': case 'c:c': return hold(s)
    default: return s
  }
}

function onTick(s: TetrisState): TetrisState {
  if (s.over) return s
  const p = { ...s.piece, y: s.piece.y + 1 }
  if (fits(s.well, p)) return { ...s, piece: p, grounded: 0 }
  return s.grounded >= 1 ? lock(s) : { ...s, grounded: 1 }
}

// ---------- drawing ----------

const colorOf = (kind: number) => COLORS[kind] as string

/** What each well cell shows: 0 empty, kind + 1 filled, -(kind + 1) the ghost. */
function paint(s: TetrisState): number[] {
  const grid = s.well.slice()
  if (!s.over) {
    const gy = dropY(s.well, s.piece)
    for (const [x, y] of cellsOf({ ...s.piece, y: gy })) if (grid[y * W + x] === 0) grid[y * W + x] = -(s.piece.kind + 1)
  }
  for (const [x, y] of cellsOf(s.piece)) if (y >= 0) grid[y * W + x] = s.piece.kind + 1
  return grid
}

const full = (v: number): Seg => {
  if (v > 0) return seg('██', { color: colorOf(v - 1) })
  if (v < 0) return seg('░░', { color: colorOf(-v - 1), dim: true })
  return seg('  ')
}

/** One text row of the half-block drawing: two well rows, upper in the glyph, lower behind it. */
function halfRow(up: readonly number[], low: readonly number[]): Seg[] {
  const out: Seg[] = []
  for (let x = 0; x < W; x++) {
    const a = up[x] as number
    const b = low[x] as number
    const ua = a > 0 ? colorOf(a - 1) : a < 0 ? colorOf(-a - 1) : undefined
    const ub = b > 0 ? colorOf(b - 1) : b < 0 ? colorOf(-b - 1) : undefined
    const dim = (a < 0 && b <= 0) || (b < 0 && a <= 0) || (a < 0 && b < 0)
    if (ua && ub) out.push(ua === ub ? seg('█', { color: ua, dim }) : seg('▀', { color: ua, bg: ub, dim }))
    else if (ua) out.push(seg('▀', { color: ua, dim }))
    else if (ub) out.push(seg('▄', { color: ub, dim }))
    else out.push(seg(' '))
  }
  return out
}

const mini = (kind: number | null): Seg[][] => {
  if (kind === null) return [[seg('')], [seg('')]]
  const cells = (SHAPES[kind] as Cell[][])[0] as Cell[]
  return [0, 1].map(y => {
    const row: Seg[] = []
    for (let x = 0; x < 4; x++) row.push(cells.some(([cx, cy]) => cx === x && cy === y) ? seg('██', { color: colorOf(kind) }) : seg('  '))
    return row
  })
}

const num = fmtNum

function sidePanel(s: TetrisState, best: number | undefined): Seg[][] {
  const [a, b] = mini(s.next[0] as number)
  const [c, d] = mini(s.hold)
  const then: Seg[] = [seg('then ', { dim: true })]
  for (const k of s.next.slice(1, 3)) then.push(seg(`${PIECES[k]} `, { color: colorOf(k) }))
  return [
    [seg('NEXT', { dim: true })], a as Seg[], b as Seg[], then,
    [seg('HOLD', { dim: true })], c as Seg[], d as Seg[],
    [seg('SCORE ', { dim: true }), seg(num(s.score), { bold: true })],
    [seg('LINES ', { dim: true }), seg(String(s.lines))],
    [seg('LEVEL ', { dim: true }), seg(String(s.level))],
    [seg('BEST  ', { dim: true }), seg(best ? num(best) : '-')],
  ]
}

const SIDE_COLS = 12

const controls: GameControl[] = [
  { label: '◀', key: 'left', hotkey: 'h', kb: '←/→ move', pad: 'd-pad ←/→ (held repeats)' },
  { label: '▶', key: 'right', hotkey: 'l', kb: '' },
  { label: '▼', key: 'down', hotkey: 'j', kb: '↓ soft drop', pad: 'd-pad ↓' },
  { label: 'rot', key: 'a', hotkey: 'k', kb: '↑ or x rotate, z the other way', pad: 'a rotates, b the other way' },
  { label: 'ccw', key: 'b', hotkey: 'u', kb: '' },
  { label: 'drop', key: 'c: ', hotkey: 'd', kb: 'Space hard drop', pad: 'd-pad ↑ hard drop' },
  { label: 'hold', key: 'c:c', hotkey: 'c', kb: 'c hold', pad: 'x or back holds' },
  { label: 'pause', key: 'start', hotkey: 'p', kb: 'p pause', pad: 'start pauses' },
]

export const tetrisGame = defineGame<TetrisState>({
  id: 'tetris',
  title: 'Tetris',
  blurb: 'Seven-bag, hold, ghost and the guideline scoring.',
  minColumns: 22,
  keyboard: { up: 'a', k: 'a', x: 'a', z: 'b', j: 'down' },
  repeatable: ['left', 'right', 'down'],
  pauseOnReload: true,
  init(seed, opts) {
    const first = pull([], seed | 0)
    let s: TetrisState = {
      well: Array<number>(W * H).fill(0), piece: spawn(first.kind), bag: first.bag, next: [], hold: null, canHold: true,
      score: 0, lines: 0, level: 1, grounded: 0, over: false, rng: first.rng, mode: opts.mode === 'zen' ? 'zen' : 'normal', recorded: false,
    }
    s = topUp(s)
    return s
  },
  onKey: (s, key) => onKey(s, key),
  onTick: s => onTick(s),
  tickMs: s => (s.over ? undefined : gravityMs(s.level, s.mode)),
  isOver: s => s.over,
  score(s) {
    if (!s.over || s.recorded) return undefined
    return { bests: { score: { value: s.score }, lines: { value: s.lines }, level: { value: s.level } } }
  },
  controls,
  view(s, cols, rows, score?: GameScore) {
    const best = score?.bests.score
    const grid = paint(s)
    const isFull = rows >= 21
    const wall = seg('│', { dim: true })
    const body: Seg[][] = []
    const nRows = isFull ? H : H / 2
    for (let r = 0; r < nRows; r++) {
      const cells = isFull ? mergeSegs(Array.from({ length: W }, (_, x) => full(grid[r * W + x] as number))) : mergeSegs(halfRow(grid.slice(2 * r * W, 2 * r * W + W), grid.slice((2 * r + 1) * W, (2 * r + 1) * W)))
      body.push([wall, ...cells, wall])
    }
    const width = (isFull ? 2 * W : W) + 2
    body.push([seg(`└${'─'.repeat(width - 2)}┘`, { dim: true })])
    const showSide = cols >= width + 1 + SIDE_COLS
    const board = showSide
      ? body.map((row, i) => {
          const side = sidePanel(s, best)[i]
          return side ? [...row, seg(' '), ...side] : row
        })
      : body
    const header: Seg[] = [seg(' TETRIS ', { bold: true, color: 'magenta' })]
    header.push(seg(showSide ? ` L${s.level}` : ` L${s.level}  ★ ${num(s.score)}  ${s.lines} lines${s.hold !== null ? `  hold ${PIECES[s.hold]}` : ''}  next ${s.next.slice(0, 3).map(k => PIECES[k]).join('')}`, { dim: true }))
    const status = s.over
      ? `GAME OVER  ★ ${num(s.score)}   n: new game  q: games`
      : s.lastClear
        ? `${s.lastClear}!   ←→ move ↓ soft ␣ drop ↑ rotate c hold p pause`
        : '←→ move  ↓ soft  ␣ drop  ↑/x rotate  z ccw  c hold  p pause'
    return { header, board, status }
  },
})
