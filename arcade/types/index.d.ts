/** The games the picker offers. */
export type GameId = 'ttt' | 'sudoku' | 'tetris' | 'poker' | 'blackjack' | 'uno'

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

/** A playing card's suit; J is the joker's. */
export type Suit = 'S' | 'H' | 'D' | 'C' | 'J'
/** 1 = ace .. 13 = king; 0 = a joker. */
export type Card = { rank: number; suit: Suit }

/** The shared chips of poker and blackjack, kept in $.store 'bankroll'. */
export type ArcadeBank = { chips: number; peak: number }

export type PokerRank = 'royal' | 'straightFlush' | 'four' | 'fullHouse' | 'flush' | 'straight' | 'three' | 'twoPair' | 'jacks' | 'nothing'
export type PokerState = {
  phase: 'bet' | 'hold' | 'done'
  /** The bankroll mirror, excluding the bet on the table. */
  chips: number
  /** 1..5 */
  bet: number
  /** The rest of this hand's shuffled 52; draws come from index 0. */
  deck: Card[]
  /** 0 or 5 cards. */
  hand: Card[]
  held: boolean[]
  cursor: number
  result?: PokerRank
  /** Credits paid by the last draw. */
  won: number
  /** "Out of chips", "Rebought 500". */
  note?: string
  rng: number
  recorded: boolean
}

export type BjHand = { cards: Card[]; bet: number; done: boolean; doubled: boolean; fromSplit: boolean; outcome?: 'win' | 'lose' | 'push' | 'blackjack' | 'bust' }
export type BlackjackState = {
  phase: 'bet' | 'play' | 'done'
  chips: number
  /** One of the bet steps. */
  bet: number
  /** Draws from index 0. */
  shoe: Card[]
  dealer: Card[]
  holeShown: boolean
  /** 1 hand, or 2 after the split. */
  hands: BjHand[]
  active: number
  /** The round's net, for the result line and the score. */
  net: number
  natural: boolean
  message: string
  reshuffled: boolean
  rng: number
  recorded: boolean
}

export type UnoColor = 'R' | 'G' | 'B' | 'Y'
export type UnoFace = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'skip' | 'reverse' | 'draw2' | 'wild' | 'wild4'
export type UnoCard = { color: UnoColor | 'W'; face: UnoFace }
export type UnoState = {
  /** 2..4 (seat 0 = you); the UI offers 3 or 4. */
  seats: number
  /** seats - 1 */
  opponents: number
  hands: UnoCard[][]
  /** Draws from index 0. */
  draw: UnoCard[]
  /** The top is the last. */
  discard: UnoCard[]
  /** The colour in force (a wild's chosen colour). */
  color: UnoColor
  turn: number
  dir: 1 | -1
  phase: 'play' | 'color' | 'done'
  /** The wild waiting for its colour. */
  pending?: 'wild' | 'wild4'
  cursor: number
  colorCursor: number
  /** Index of the card you just drew: the only one playable until you pass. */
  drawn: number | null
  /** Consecutive passes with nothing left to draw (the stalemate guard). */
  passes: number
  winner: number | null
  /** The last 3 lines. */
  log: string[]
  rng: number
  recorded: boolean
}

export type ArcadeSaves = { ttt?: TttState; sudoku?: SudokuState; tetris?: TetrisState; poker?: PokerState; blackjack?: BlackjackState; uno?: UnoState }

export type GameScore = { played: number; counters: Record<string, number>; bests: Record<string, number> }
export type ArcadeScores = Record<string, GameScore>

export type ArcadePad = { status: 'off' | 'missing' | 'waiting' | 'connected' | 'failed'; slot?: number }

declare module 'claude-code' {
  interface PluginState {
    arcade: { session: ArcadeSession; saves: ArcadeSaves; scores: ArcadeScores; pad: ArcadePad; bank: ArcadeBank }
  }
}
