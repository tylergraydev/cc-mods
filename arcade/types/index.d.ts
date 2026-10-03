/** The games the picker offers; pack 2 adds its own. */
export type GameId = 'ttt' | 'sudoku' | 'tetris'

/** Which screen the pane shows and whether the current game is running. */
export type ArcadeSession = {
  screen: 'picker' | 'play' | 'scores'
  current?: GameId
  showHelp: boolean
  paused: boolean
  /** Why it is paused, shown in the status line. */
  pauseNote?: string
  /** The pane is open (a closed pane never ticks). */
  isOpen: boolean
  /** When the last key arrived, ms since the epoch (the idle pause reads it). */
  lastInputAt: number
  /** The picker's highlighted row, moved by the controller. */
  pickCursor: number
}

export type TttCell = 'X' | 'O' | null
export type TttState = {
  board: TttCell[]
  turn: 'X' | 'O'
  starter: 'X' | 'O'
  cursor: number
  level: 'easy' | 'hard'
  winner: 'X' | 'O' | 'draw' | null
  line?: number[]
  rng: number
  recorded: boolean
}

export type SudokuDifficulty = 'easy' | 'medium' | 'hard'
export type SudokuState = {
  difficulty: SudokuDifficulty
  /** 81 cells, 0 = blank. */
  givens: number[]
  solution: number[]
  /** The grid as played: givens plus the person's digits. */
  cells: number[]
  /** Pencil marks: a 9-bit mask per cell. */
  marks: number[]
  cursor: number
  markMode: boolean
  runningSince?: number
  elapsedMs: number
  /** Cells the last check found wrong, cleared by the next edit. */
  wrong: number[]
  solved: boolean
  revealed: boolean
  clues: number
  recorded: boolean
}

export type TetrisPiece = { kind: number; rot: number; x: number; y: number }
export type TetrisState = {
  /** 10 x 20, row-major; 0 empty, else kind + 1. */
  well: number[]
  piece: TetrisPiece
  /** What is left of the current 7-bag. */
  bag: number[]
  /** The preview queue. */
  next: number[]
  hold: number | null
  canHold: boolean
  score: number
  lines: number
  level: number
  /** Ticks the piece has rested on something (one tick of slide grace). */
  grounded: number
  over: boolean
  rng: number
  mode: 'normal' | 'zen'
  lastClear?: string
  recorded: boolean
}

export type ArcadeSaves = { ttt?: TttState; sudoku?: SudokuState; tetris?: TetrisState }

export type GameScore = { played: number; counters: Record<string, number>; bests: Record<string, number> }
export type ArcadeScores = Record<string, GameScore>

export type ArcadePad = { status: 'off' | 'missing' | 'waiting' | 'connected' | 'failed'; slot?: number }

declare module 'claude-code' {
  interface PluginState {
    arcade: { session: ArcadeSession; saves: ArcadeSaves; scores: ArcadeScores; pad: ArcadePad }
  }
}
