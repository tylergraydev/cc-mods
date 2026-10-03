import type { GameScore, TttCell, TttState } from '../types'
import { defineGame, seg } from './game'
import type { GridCell, Key } from './game'
import { int } from './rng'

// Tic-tac-toe against the computer: the person is X, the computer O. Hard is a
// full minimax (it never loses); easy plays a random legal move.

export const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
]

/** Cell index for each keypad digit: 7 8 9 over 4 5 6 over 1 2 3. */
export const KEYPAD: Record<string, number> = { '7': 0, '8': 1, '9': 2, '4': 3, '5': 4, '6': 5, '1': 6, '2': 7, '3': 8 }
/** The keypad digit of each cell (the inverse of KEYPAD). */
export const DIGIT_OF = ['7', '8', '9', '4', '5', '6', '1', '2', '3']

// Centre, then corners, then edges: the order ties are broken in.
const ORDER = [4, 0, 2, 6, 8, 1, 3, 5, 7]

export function winnerOf(board: readonly TttCell[]): { winner: 'X' | 'O' | 'draw' | null; line?: number[] } {
  for (const line of LINES) {
    const [a, b, c] = line as [number, number, number]
    const v = board[a]
    if (v && v === board[b] && v === board[c]) return { winner: v, line }
  }
  return board.every(c => c !== null) ? { winner: 'draw' } : { winner: null }
}

/** The score of `board` for O with `turn` to move; wins sooner and losses later score higher. */
function minimax(board: TttCell[], turn: 'X' | 'O', depth: number): number {
  const w = winnerOf(board).winner
  if (w === 'O') return 10 - depth
  if (w === 'X') return depth - 10
  if (w === 'draw') return 0
  let best = turn === 'O' ? -Infinity : Infinity
  for (const i of ORDER) {
    if (board[i] !== null) continue
    board[i] = turn
    const s = minimax(board, turn === 'O' ? 'X' : 'O', depth + 1)
    board[i] = null
    best = turn === 'O' ? Math.max(best, s) : Math.min(best, s)
  }
  return best
}

/** The hard computer's move for O: the best score, ties broken centre, corners, edges. */
export function bestMove(board: readonly TttCell[]): number {
  if (board.every(c => c === null)) return 4
  const work = board.slice()
  let best = -Infinity
  let move = -1
  for (const i of ORDER) {
    if (work[i] !== null) continue
    work[i] = 'O'
    const s = minimax(work, 'X', 1)
    work[i] = null
    if (s > best) {
      best = s
      move = i
    }
  }
  return move
}

function settle(state: TttState): TttState {
  const r = winnerOf(state.board)
  return r.winner ? { ...state, winner: r.winner, ...(r.line ? { line: r.line } : {}) } : state
}

/** The computer's reply, when it is O's turn and the game is still going. */
function reply(state: TttState): TttState {
  if (state.winner || state.turn !== 'O') return state
  const free = state.board.map((c, i) => (c === null ? i : -1)).filter(i => i >= 0)
  let move: number
  let rng = state.rng
  if (state.level === 'hard') move = bestMove(state.board)
  else {
    const r = int(rng, free.length)
    rng = r.s
    move = free[r.v] as number
  }
  const board = state.board.slice()
  board[move] = 'O'
  return settle({ ...state, board, turn: 'X', rng })
}

function place(state: TttState, i: number): TttState {
  if (state.winner || state.turn !== 'X' || state.board[i] !== null) return state
  const board = state.board.slice()
  board[i] = 'X'
  return reply(settle({ ...state, board, turn: 'O', cursor: i }))
}

function newRound(state: TttState): TttState {
  const starter = state.starter === 'X' ? 'O' : 'X'
  const fresh: TttState = {
    board: Array<TttCell>(9).fill(null), turn: starter, starter, cursor: 4, level: state.level,
    winner: null, rng: state.rng, recorded: false,
  }
  return reply(fresh)
}

const MOVES: Record<string, number> = { left: -1, right: 1, up: -3, down: 3 }

function onKey(state: TttState, key: Key): TttState {
  if (key === 'a') return state.winner ? newRound(state) : place(state, state.cursor)
  if (key in MOVES) {
    const step = MOVES[key] as number
    const col = state.cursor % 3
    if ((step === -1 && col === 0) || (step === 1 && col === 2)) return state
    const to = state.cursor + step
    return to < 0 || to > 8 ? state : { ...state, cursor: to }
  }
  if (key.startsWith('c:')) {
    const cell = KEYPAD[key.slice(2)]
    return cell === undefined ? state : place(state, cell)
  }
  return state
}

export const tttGame = defineGame<TttState>({
  id: 'ttt',
  title: 'Tic-tac-toe',
  blurb: 'You are X. The computer never loses on hard.',
  minColumns: 16,
  init(seed, opts) {
    const starter = opts.starter === 'O' ? 'O' : 'X'
    const level = opts.level === 'easy' ? 'easy' : 'hard'
    return reply({
      board: Array<TttCell>(9).fill(null), turn: starter, starter, cursor: 4, level,
      winner: null, rng: seed | 0, recorded: false,
    })
  },
  onKey: (state, key) => onKey(state, key),
  repeatable: [],
  isOver: s => s.winner !== null,
  score(s) {
    if (!s.winner || s.recorded) return undefined
    const k = s.winner === 'X' ? 'w' : s.winner === 'O' ? 'l' : 'd'
    return { counters: { [`${s.level}.${k}`]: 1 } }
  },
  controls: [],
  view(s, _cols, _rows, score?: GameScore) {
    const c = score?.counters ?? {}
    const rec = `W ${c[`${s.level}.w`] ?? 0} · L ${c[`${s.level}.l`] ?? 0} · D ${c[`${s.level}.d`] ?? 0}`
    const grid: GridCell[][] = [0, 1, 2].map(r =>
      [0, 1, 2].map(col => {
        const i = r * 3 + col
        const v = s.board[i]
        return {
          key: `cell-${i}`,
          label: v ?? (DIGIT_OF[i] as string),
          hotkey: DIGIT_OF[i] as string,
          highlight: i === s.cursor || (s.line?.includes(i) ?? false),
          press: `c:${DIGIT_OF[i]}` as Key,
        }
      }),
    )
    const status = s.winner === 'X' ? 'You win!   a: next round' : s.winner === 'O' ? 'The computer wins.   a: next round'
      : s.winner === 'draw' ? 'A draw.   a: next round' : 'Your move (1-9 or click).'
    const board = grid.map(row => row.map(cell => seg(` ${cell.label} `, { bold: cell.highlight })))
    return { header: [seg(' TIC-TAC-TOE ', { bold: true, color: 'cyan' }), seg(` ${s.level}   ${rec}`, { dim: true })], board, grid, status }
  },
})

/** A keypad digit (as a Key) for a cell index, for tests and the controller. */
export const keyForCell = (i: number): Key => `c:${DIGIT_OF[i]}` as Key
