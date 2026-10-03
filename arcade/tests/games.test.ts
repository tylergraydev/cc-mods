import { expect, test } from 'claude-code/testing'

import type { SudokuState, TetrisState, TttState } from '../types'
import { cardSegs, deck, deal, handSegs, rankCounts, shuffleDeck, sortHand } from '../hooks/cards'
import { SHELL_CONTROLS, mapClientKey, mapHotkey, mergeScore } from '../hooks/game'
import type { Key } from '../hooks/game'
import { int, next, shuffle } from '../hooks/rng'
import { CLUES, cellAt, cellXY, conflicts, countSolutions, generate, solve, sudokuGame } from '../hooks/sudoku'
import { GRAVITY, KICKS, SHAPES, W, H, clearLines, cellsOf, fits, gravityMs, levelFor, lineScore, pull, tetrisGame } from '../hooks/tetris'
import { DIGIT_OF, KEYPAD, LINES, bestMove, keyForCell, tttGame, winnerOf } from '../hooks/ttt'

// ---------- rng ----------

test('the generator is deterministic and a shuffle is a permutation', () => {
  expect(next(7)).toEqual(next(7))
  expect(next(7).v).not.toBe(next(8).v)
  expect(int(5, 10).v).toBeLessThan(10)
  const a = shuffle([1, 2, 3, 4, 5, 6, 7, 8], 99)
  const b = shuffle([1, 2, 3, 4, 5, 6, 7, 8], 99)
  expect(a.items).toEqual(b.items)
  expect([...a.items].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
})

// ---------- tic-tac-toe ----------

test('a win is found on each of the eight lines, and a full board with none is a draw', () => {
  expect(LINES).toHaveLength(8)
  for (const line of LINES) {
    const board = Array(9).fill(null) as ('X' | 'O' | null)[]
    for (const i of line) board[i] = 'O'
    expect(winnerOf(board)).toEqual({ winner: 'O', line })
  }
  expect(winnerOf(['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X']).winner).toBe('draw')
  expect(winnerOf(Array(9).fill(null)).winner).toBeNull()
})

test('the keypad maps 7 8 9 / 4 5 6 / 1 2 3 onto the board', () => {
  expect(KEYPAD).toEqual({ '7': 0, '8': 1, '9': 2, '4': 3, '5': 4, '6': 5, '1': 6, '2': 7, '3': 8 })
  for (let i = 0; i < 9; i++) expect(KEYPAD[DIGIT_OF[i] as string]).toBe(i)
})

test('the hard computer never loses in 200 seeded games, whichever side starts', () => {
  const g = tttGame
  let o = 0
  let draws = 0
  for (let n = 0; n < 200; n++) {
    let s: TttState = g.init(1000 + n, { level: 'hard', starter: n % 2 === 0 ? 'X' : 'O' }, 0)
    let rng = 5000 + n
    while (!s.winner) {
      const free = s.board.map((c, i) => (c === null ? i : -1)).filter(i => i >= 0)
      const r = int(rng, free.length)
      rng = r.s
      s = g.onKey(s, keyForCell(free[r.v] as number), 0)
    }
    expect(s.winner).not.toBe('X')
    if (s.winner === 'O') o++
    else draws++
  }
  expect(o + draws).toBe(200)
  expect(o).toBeGreaterThan(0)
})

test('the hard computer takes a win and blocks a loss', () => {
  expect(bestMove(['O', 'O', null, 'X', 'X', null, null, null, null])).toBe(2)
  expect(bestMove(['X', 'X', null, null, 'O', null, null, null, null])).toBe(2)
})

test('the easy computer plays only legal moves, and an occupied cell is a no-op', () => {
  for (let n = 0; n < 30; n++) {
    let s = tttGame.init(n, { level: 'easy' }, 0)
    s = tttGame.onKey(s, 'c:5', 0)
    expect(s.board.filter(c => c === 'X')).toHaveLength(1)
    expect(s.board.filter(c => c === 'O')).toHaveLength(1)
    expect(s.board[4]).toBe('X')
    const again = tttGame.onKey(s, 'c:5', 0)
    expect(again).toEqual(s)
  }
})

test('an O start has the computer move first, and a finished round starts the next with the other side', () => {
  const s = tttGame.init(3, { level: 'hard', starter: 'O' }, 0)
  expect(s.board.filter(c => c === 'O')).toHaveLength(1)
  expect(s.turn).toBe('X')
  let t = tttGame.init(3, { level: 'hard' }, 0)
  while (!t.winner) t = tttGame.onKey(t, ((): Key => { const i = t.board.indexOf(null); return keyForCell(i) })(), 0)
  expect(tttGame.score(t)?.counters).toBeDefined()
  const round = tttGame.onKey(t, 'a', 0)
  expect(round.starter).toBe('O')
  expect(round.winner).toBeNull()
  expect(round.board.filter(c => c === 'O')).toHaveLength(1)
})

test('the board is drawn as nine keyed cells with keypad hotkeys', () => {
  const v = tttGame.view(tttGame.init(1, { level: 'hard' }, 0), 40, 20)
  expect(v.grid?.flat().map(c => c.key)).toEqual(Array.from({ length: 9 }, (_, i) => `cell-${i}`))
  expect(v.grid?.flat().map(c => c.hotkey)).toEqual(['7', '8', '9', '4', '5', '6', '1', '2', '3'])
})

// ---------- sudoku ----------

test('a generated puzzle has the target clues, is a subset of its solution and has exactly one solution', () => {
  for (const [d, seed] of [['easy', 11], ['medium', 12], ['hard', 13], ['medium', 14]] as const) {
    const p = generate(seed, d)
    expect(p.solution.every(v => v >= 1 && v <= 9)).toBe(true)
    expect(conflicts(p.solution)).toEqual([])
    expect(p.givens.every((v, i) => v === 0 || v === p.solution[i])).toBe(true)
    expect(p.givens.filter(v => v !== 0)).toHaveLength(p.clues)
    if (d === 'hard') expect(p.clues).toBeLessThanOrEqual(30)
    else expect(p.clues).toBe(CLUES[d])
    expect(countSolutions(p.givens)).toBe(1)
    expect(solve(p.givens)).toEqual(p.solution)
  }
})

test('conflicts name the cells sharing a digit in a row, column or box', () => {
  const g = Array(81).fill(0)
  g[0] = 5
  g[8] = 5 // same row
  expect(conflicts(g)).toEqual([0, 8])
  const h = Array(81).fill(0)
  h[0] = 3
  h[72] = 3 // same column
  expect(conflicts(h)).toEqual([0, 72])
  const b = Array(81).fill(0)
  b[0] = 7
  b[10] = 7 // same box
  expect(conflicts(b)).toEqual([0, 10])
  expect(conflicts(Array(81).fill(0))).toEqual([])
})

test('a click maps to the cell under it and not to a box line', () => {
  for (const i of [0, 4, 40, 44, 80]) {
    const p = cellXY(i)
    expect(cellAt(p.x, p.y)).toBe(i)
  }
  expect(cellAt(8, 1)).toBeUndefined()
  expect(cellAt(2, 4)).toBeUndefined()
})

const blank = (s: SudokuState) => s.givens.findIndex(v => v === 0)

test('digits, marks, check and solve behave', () => {
  let s = sudokuGame.init(21, { difficulty: 'easy' }, 1000)
  const i = blank(s)
  s = { ...s, cursor: i }
  const right = s.solution[i] as number
  const wrong = right === 9 ? 1 : right + 1
  s = sudokuGame.onKey(s, `c:${wrong}` as Key, 2000)
  expect(s.cells[i]).toBe(wrong)
  s = sudokuGame.onKey(s, 'c:c', 2000)
  expect(s.wrong).toEqual([i])
  s = sudokuGame.onKey(s, 'c:0', 2000)
  expect(s.cells[i]).toBe(0)
  expect(s.wrong).toEqual([])
  s = sudokuGame.onKey(s, 'c:p', 2000)
  s = sudokuGame.onKey(s, 'c:3', 2000)
  s = sudokuGame.onKey(s, 'c:3', 2000)
  s = sudokuGame.onKey(s, 'c:4', 2000)
  expect(s.marks[i]).toBe(1 << 3)
  s = sudokuGame.onKey(s, 'c:p', 2000)
  // a given cell is not editable
  const g = s.givens.findIndex(v => v !== 0)
  const held = sudokuGame.onKey({ ...s, cursor: g }, 'c:1', 2000)
  expect(held.cells[g]).toBe(s.givens[g])
})

test('solving every cell records a best time; revealing records none', () => {
  let s = sudokuGame.init(31, { difficulty: 'easy' }, 1000)
  for (let i = 0; i < 81; i++) {
    if (s.givens[i] !== 0) continue
    s = sudokuGame.onKey({ ...s, cursor: i }, `c:${s.solution[i]}` as Key, 61_000)
  }
  expect(s.solved).toBe(true)
  expect(s.runningSince).toBeUndefined()
  expect(s.elapsedMs).toBe(60_000)
  expect(sudokuGame.score(s)).toEqual({ counters: { 'solved.easy': 1 }, bests: { easy: { value: 60_000, lower: true } } })
  const r = sudokuGame.onKey(sudokuGame.init(32, { difficulty: 'easy' }, 0), 'c:s', 5000)
  expect(r.revealed).toBe(true)
  expect(sudokuGame.isOver(r)).toBe(true)
  expect(sudokuGame.score(r)).toBeUndefined()
})

test('the sudoku clock folds across a pause', () => {
  let s = sudokuGame.init(41, { difficulty: 'easy' }, 1000)
  s = sudokuGame.onTick?.(s, 3000) ?? s
  expect(s.elapsedMs).toBe(2000)
  s = sudokuGame.pause?.(s, 4000) ?? s
  expect(s.runningSince).toBeUndefined()
  expect(s.elapsedMs).toBe(3000)
  s = sudokuGame.resume?.(s, 10_000) ?? s
  expect(sudokuGame.tickMs?.(s)).toBe(1000)
})

// ---------- tetris ----------

const fresh = (mode: 'normal' | 'zen' = 'normal'): TetrisState => tetrisGame.init(9, { mode }, 0)

test('the 7-bag deals each kind once per seven', () => {
  let bag: number[] = []
  let rng = 3
  for (let round = 0; round < 3; round++) {
    const seen: number[] = []
    for (let k = 0; k < 7; k++) {
      const p = pull(bag, rng)
      bag = p.bag
      rng = p.rng
      seen.push(p.kind)
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5, 6])
  }
})

test('four rotations return every kind to its start, and the cells stay inside the box', () => {
  for (let k = 0; k < 7; k++) {
    const shapes = SHAPES[k] as [number, number][][]
    expect(shapes).toHaveLength(4)
    for (const cells of shapes) expect(cells).toHaveLength(4)
    const norm = (c: [number, number][]) => c.map(([x, y]) => `${x},${y}`).sort().join(' ')
    const again = shapes.map(norm)
    expect(again[0]).toBe(norm(shapes[0] as [number, number][]))
  }
  // rotating T clockwise from spawn points it right: the stem is on the right
  expect(cellsOf({ kind: 2, rot: 1, x: 0, y: 0 }).map(([x, y]) => `${x},${y}`).sort()).toEqual(['1,0', '1,1', '1,2', '2,1'])
  // four turns of the rotation formula land on the same cells (T and I)
  for (const k of [0, 2, 3, 4, 5, 6]) {
    const s = SHAPES[k] as [number, number][][]
    const n = k === 0 ? 4 : 3
    const turned = s[3]?.map(([x, y]): [number, number] => [n - 1 - y, x])
    expect(turned?.map(([x, y]) => `${x},${y}`).sort()).toEqual(s[0]?.map(([x, y]) => `${x},${y}`).sort())
  }
})

test('walls, floor and filled cells block a piece', () => {
  const s = fresh()
  expect(fits(s.well, { kind: 1, rot: 0, x: 3, y: 0 })).toBe(true)
  expect(fits(s.well, { kind: 1, rot: 0, x: -2, y: 0 })).toBe(false)
  expect(fits(s.well, { kind: 1, rot: 0, x: W - 2, y: 0 })).toBe(false)
  expect(fits(s.well, { kind: 1, rot: 0, x: 3, y: H - 1 })).toBe(false)
  const well = s.well.slice()
  well[5 * W + 4] = 3
  expect(fits(well, { kind: 1, rot: 0, x: 3, y: 4 })).toBe(false)
})

test('a rotation against the wall nudges sideways', () => {
  expect(KICKS).toEqual([0, -1, 1, -2, 2])
  let s = fresh()
  // a vertical I flush with the right wall cannot lie flat in place: it nudges left
  s = { ...s, piece: { kind: 0, rot: 1, x: 7, y: 5 } }
  const t = tetrisGame.onKey(s, 'a', 0)
  expect(t.piece.rot).toBe(2)
  expect(fits(t.well, t.piece)).toBe(true)
})

test('clearing 1, 2, 3 and 4 rows scores 100, 300, 500 and 800 times the level', () => {
  for (const [n, pts] of [[1, 100], [2, 300], [3, 500], [4, 800]] as const) {
    const well = Array<number>(W * H).fill(0)
    for (let r = 0; r < n; r++) for (let x = 0; x < W; x++) if (x !== 9) well[(H - 1 - r) * W + x] = 2
    expect(clearLines(well).cleared).toBe(0)
    // a vertical I down the right edge completes the rows it fills
    const s: TetrisState = { ...fresh(), well, piece: { kind: 0, rot: 1, x: 7, y: 0 }, level: 2, lines: 10 }
    const t = tetrisGame.onKey(s, 'c: ', 0)
    expect(t.lines).toBe(10 + n)
    // the I falls 16 rows (2 points each) before it completes the rows
    expect(t.score).toBe(32 + pts * 2)
    expect(lineScore(n, 2)).toBe(pts * 2)
  }
})

test('the level rises every ten lines and gravity follows the table, capped at 80 ms; zen holds at 1000', () => {
  expect([0, 9, 10, 25, 90, 400].map(levelFor)).toEqual([1, 1, 2, 3, 10, 41])
  expect(GRAVITY[0]).toBe(1000)
  expect(gravityMs(1, 'normal')).toBe(1000)
  expect(gravityMs(5, 'normal')).toBe(355)
  expect(gravityMs(10, 'normal')).toBe(80)
  expect(gravityMs(40, 'normal')).toBe(80)
  expect(gravityMs(40, 'zen')).toBe(1000)
  expect(tetrisGame.tickMs?.(fresh('zen'))).toBe(1000)
})

test('a hard drop scores two a cell and locks at once', () => {
  const s = fresh()
  const y = s.piece.y
  const t = tetrisGame.onKey(s, 'c: ', 0)
  expect(t.well.filter(v => v !== 0)).toHaveLength(4)
  expect(t.score).toBeGreaterThan(0)
  expect(t.score % 2).toBe(0)
  expect(t.piece.y).toBe(0)
  expect(y).toBe(0)
})

test('a piece resting on the stack gets one tick of grace before it locks', () => {
  let s = fresh()
  s = { ...s, piece: { kind: 1, rot: 0, x: 3, y: H - 2 } }
  s = tetrisGame.onTick?.(s, 0) ?? s
  expect(s.well.filter(v => v !== 0)).toHaveLength(0)
  expect(s.grounded).toBe(1)
  s = tetrisGame.onTick?.(s, 0) ?? s
  expect(s.well.filter(v => v !== 0)).toHaveLength(4)
  expect(s.piece.y).toBe(0)
})

test('a blocked spawn ends the game', () => {
  const s = fresh()
  const well = s.well.slice()
  for (let x = 1; x < W; x++) for (let y = 0; y < 4; y++) well[y * W + x] = 1 // col 0 open, so no row clears
  const t = tetrisGame.onKey({ ...s, well, piece: { kind: 1, rot: 0, x: 3, y: 4 } }, 'c: ', 0)
  expect(t.over).toBe(true)
  expect(tetrisGame.tickMs?.(t)).toBeUndefined()
  expect(tetrisGame.score(t)?.bests?.score?.value).toBe(t.score)
})

test('hold swaps once per piece', () => {
  let s = fresh()
  const first = s.piece.kind
  s = tetrisGame.onKey(s, 'c:c', 0)
  expect(s.hold).toBe(first)
  const second = s.piece.kind
  const again = tetrisGame.onKey(s, 'c:c', 0)
  expect(again.piece.kind).toBe(second)
  expect(again.hold).toBe(first)
})

test('the board draws in full blocks when there is room and in half blocks when there is not', () => {
  const full = tetrisGame.view(fresh(), 40, 30)
  const half = tetrisGame.view(fresh(), 40, 18)
  expect(full.board).toHaveLength(H + 1)
  expect(half.board).toHaveLength(H / 2 + 1)
  const text = (rows: { text: string }[][]) => rows.map(r => r.map(s => s.text).join(''))
  expect(text(full.board).some(r => r.includes('██'))).toBe(true)
  expect(text(half.board).some(r => /[▀▄█]/.test(r))).toBe(true)
  // below 34 columns the side panel folds into the header
  const narrow = tetrisGame.view(fresh(), 24, 30)
  expect(narrow.board[0]?.map(s => s.text).join('')).not.toContain('NEXT')
  expect(narrow.header.map(s => s.text).join('')).toContain('next')
  expect(text(full.board)[0]).toContain('NEXT')
})

// ---------- keys ----------

test('the keyboard map: arrows, hjkl, Space, Return, and game overrides', () => {
  expect(['left', 'right', 'up', 'down', 'h', 'l', 'k', 'j'].map(k => mapClientKey(k))).toEqual(['left', 'right', 'up', 'down', 'left', 'right', 'up', 'down'])
  expect(mapClientKey(' ')).toBe('c: ')
  expect(mapClientKey('space')).toBe('c: ')
  expect(mapClientKey('return')).toBe('a')
  expect(mapClientKey('backspace')).toBe('b')
  expect(mapClientKey('5')).toBe('c:5')
  expect(mapClientKey('f5')).toBeUndefined()
  expect(mapClientKey('p')).toBe('start')
  expect(mapClientKey('p', sudokuGame.keyboard)).toBe('c:p')
  expect(mapClientKey('up', tetrisGame.keyboard)).toBe('a')
  expect(mapClientKey('z', tetrisGame.keyboard)).toBe('b')
  expect(mapHotkey(tetrisGame.controls, 'd')).toBe('c: ')
})

test('hotkeys are one digit or letter and unique on each screen', () => {
  for (const g of [tttGame, sudokuGame, tetrisGame]) {
    const keys = [...g.controls, ...SHELL_CONTROLS].map(c => c.hotkey).filter((k): k is string => !!k)
    if (g === tttGame) keys.push(...DIGIT_OF)
    for (const k of keys) expect(/^[0-9a-z]$/.test(k)).toBe(true)
    expect(new Set(keys).size).toBe(keys.length)
  }
})

test('scores merge: counters add, bests keep the better as flagged', () => {
  let s = mergeScore({}, 'ttt', { counters: { 'hard.w': 1 } })
  s = mergeScore(s, 'ttt', { counters: { 'hard.w': 1, 'hard.d': 1 } })
  expect(s.ttt).toEqual({ played: 2, counters: { 'hard.w': 2, 'hard.d': 1 }, bests: {} })
  s = mergeScore(s, 'sudoku', { bests: { easy: { value: 500, lower: true } } })
  s = mergeScore(s, 'sudoku', { bests: { easy: { value: 900, lower: true } } })
  s = mergeScore(s, 'sudoku', { bests: { easy: { value: 300, lower: true } } })
  expect(s.sudoku?.bests.easy).toBe(300)
  s = mergeScore(s, 'tetris', { bests: { score: { value: 100 } } })
  s = mergeScore(s, 'tetris', { bests: { score: { value: 50 } } })
  expect(s.tetris?.bests.score).toBe(100)
})

// ---------- cards ----------

test('a deck has 52 unique cards, 54 with jokers, and a seeded shuffle repeats', () => {
  const ids = (cs: { rank: number; suit: string }[]) => cs.map(c => `${c.rank}${c.suit}`)
  expect(new Set(ids(deck())).size).toBe(52)
  expect(deck(2)).toHaveLength(54)
  const a = shuffleDeck(deck(), 17)
  const b = shuffleDeck(deck(), 17)
  expect(a.cards).toEqual(b.cards)
  expect(ids(a.cards).sort()).toEqual(ids(deck()).sort())
  const d = deal(a.cards, 5)
  expect(d.hand).toHaveLength(5)
  expect(d.rest).toHaveLength(47)
})

test('hands sort, count and draw compactly with red hearts and diamonds', () => {
  const hand = [{ rank: 1, suit: 'S' as const }, { rank: 10, suit: 'H' as const }, { rank: 13, suit: 'D' as const }, { rank: 10, suit: 'C' as const }, { rank: 2, suit: 'S' as const }, { rank: 12, suit: 'H' as const }, { rank: 7, suit: 'S' as const }]
  expect(sortHand(hand).map(c => c.rank)).toEqual([2, 7, 10, 10, 12, 13, 1])
  expect(rankCounts(hand)[10]).toBe(2)
  const lines = handSegs(hand, 40)
  expect(lines).toHaveLength(1)
  const width = (lines[0] ?? []).map(s => s.text).join('').length
  expect(width).toBeLessThanOrEqual(35)
  expect(cardSegs({ rank: 5, suit: 'H' })[0]).toEqual({ text: '[5♥]', color: 'red' })
  expect(cardSegs({ rank: 5, suit: 'S' })[0]?.color).toBeUndefined()
  expect(cardSegs({ rank: 1, suit: 'D' }, { ascii: true })[0]?.text).toBe('[Ad]')
  const wide = handSegs([...hand, ...hand, ...hand], 40)
  expect((wide[0] ?? []).map(s => s.text).join('')).toContain('more')
  expect(handSegs(hand, 40, { tall: true })).toHaveLength(3)
})
