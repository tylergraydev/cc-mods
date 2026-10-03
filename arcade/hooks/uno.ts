import type { UnoCard, UnoColor, UnoFace, UnoState } from '../types'
import { CELL, cellAtX, rowOfCells } from './cards'
import { defineGame, seg } from './game'
import type { GameControl, Key, Seg } from './game'
import { shuffle } from './rng'

// UNO against two or three computer players: 108 cards, you start. No
// stacking, no challenge, no points: the first empty hand wins the game. The
// computer plays a fixed policy and calls UNO on its own. Turn-based like
// tic-tac-toe (no pause, no ticks): after each of your moves the computer
// seats play out at once and the last three plays are kept as a log.

export const COLORS: UnoColor[] = ['R', 'G', 'B', 'Y']
const COLOR_NAME: Record<UnoColor | 'W', string> = { R: 'red', G: 'green', B: 'blue', Y: 'yellow', W: 'magenta' }
const COLOR_WORD: Record<UnoColor, string> = { R: 'RED', G: 'GREEN', B: 'BLUE', Y: 'YELLOW' }
const COLOR_KEYS: Record<string, UnoColor> = { 'c:r': 'R', 'c:g': 'G', 'c:b': 'B', 'c:y': 'Y' }
const SHORT: Record<string, string> = { skip: 'Sk', reverse: 'Rv', draw2: '+2' }
const PER_ROW = 6
const TOP_Y = 1
const HAND_Y = 6

/** The 108 cards: per colour one 0, two each of 1-9, skip, reverse and draw2, plus 4 wild and 4 wild4. */
export function unoDeck(): UnoCard[] {
  const out: UnoCard[] = []
  const faces: UnoFace[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2']
  for (const color of COLORS) {
    out.push({ color, face: '0' })
    for (const face of faces) out.push({ color, face }, { color, face })
  }
  for (let i = 0; i < 4; i++) out.push({ color: 'W', face: 'wild' }, { color: 'W', face: 'wild4' })
  return out
}

/** Seat names: seat 0 is you. */
export const seatNames = (opponents: number): string[] => ['You', ...(opponents >= 3 ? ['West', 'North', 'East'] : opponents === 2 ? ['West', 'East'] : ['North'])]

const isNumber = (c: UnoCard | undefined): boolean => !!c && c.color !== 'W' && c.face.length === 1

/** `[R5]`, `[GSk]`, `[Y+2]`, `[W]`, `[W+4]`. */
export const unoLabel = (c: UnoCard): string => (c.face === 'wild' ? '[W]' : c.face === 'wild4' ? '[W+4]' : `[${c.color}${SHORT[c.face] ?? c.face}]`)

/** One card padded to 5 columns, so a hand shares the cell grid of the other card games. */
export function unoCell(c: UnoCard, style: { dim?: boolean; inverse?: boolean; underline?: boolean } = {}): Seg[] {
  return [seg(unoLabel(c).padEnd(CELL - 1), { color: COLOR_NAME[c.color], bold: c.color === 'W', ...style })]
}

const SORT_COLOR: Record<string, number> = { R: 0, G: 1, B: 2, Y: 3, W: 4 }
const FACE_ORDER: UnoFace[] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2', 'wild', 'wild4']
const sortUno = (cards: readonly UnoCard[]): UnoCard[] =>
  cards.slice().sort((a, b) => (SORT_COLOR[a.color] as number) - (SORT_COLOR[b.color] as number) || FACE_ORDER.indexOf(a.face) - FACE_ORDER.indexOf(b.face))

export const topOf = (s: UnoState): UnoCard => s.discard[s.discard.length - 1] as UnoCard

/** A wild is always legal; otherwise the colour in force or the same face. */
export const canPlay = (s: UnoState, c: UnoCard): boolean => c.color === 'W' || c.color === s.color || c.face === topOf(s).face

/** Whether you may play card `i` of your hand now: after a draw only the drawn card. */
export function legal(s: UnoState, i: number): boolean {
  const c = s.hands[0]?.[i]
  if (!c) return false
  return s.drawn !== null ? i === s.drawn && canPlay(s, c) : canPlay(s, c)
}

const stepFrom = (s: UnoState, from: number, k: number, dir: number): number => (((from + dir * k) % s.seats) + s.seats) % s.seats
const pushLog = (log: readonly string[], line: string): string[] => [...log, line].slice(-3)

export function initUno(seed: number, opponents: number): UnoState {
  const count = Math.min(3, Math.max(1, Math.floor(opponents) || 3))
  const seats = count + 1
  const sh = shuffle(unoDeck(), seed | 0)
  let draw = sh.items
  let rng = sh.s
  const hands = Array.from({ length: seats }, (_, i) => sortUno(draw.slice(i * 7, i * 7 + 7)))
  draw = draw.slice(seats * 7)
  // The first flip is a number card: anything else goes back and the pile is reshuffled.
  for (let guard = 0; guard < 50 && !isNumber(draw[0]); guard++) {
    const r = shuffle(draw, rng)
    draw = r.items
    rng = r.s
  }
  if (!isNumber(draw[0])) {
    const k = draw.findIndex(c => isNumber(c))
    draw = [draw[k] as UnoCard, ...draw.filter((_, i) => i !== k)]
  }
  const first = draw[0] as UnoCard
  return {
    seats, opponents: count, hands, draw: draw.slice(1), discard: [first], color: first.color as UnoColor, turn: 0, dir: 1, phase: 'play',
    cursor: 0, colorCursor: 0, drawn: null, passes: 0, winner: null, log: [], rng, recorded: false,
  }
}

/** One card off the draw pile; an empty pile is refilled from the discard (the top card stays). Nothing when both are empty. */
export function draw1(s: UnoState): { s: UnoState; card?: UnoCard } {
  let t = s
  if (t.draw.length === 0 && t.discard.length > 1) {
    const sh = shuffle(t.discard.slice(0, -1), t.rng)
    t = { ...t, draw: sh.items, discard: [topOf(t)], rng: sh.s }
  }
  const card = t.draw[0]
  return card ? { s: { ...t, draw: t.draw.slice(1) }, card } : { s: t }
}

function give(s: UnoState, seat: number, n: number): UnoState {
  let t = s
  for (let i = 0; i < n; i++) {
    const r = draw1(t)
    t = r.s
    if (!r.card) break
    const card = r.card
    t = { ...t, hands: t.hands.map((h, k) => (k === seat ? [...h, card] : h)) }
  }
  return t
}

/** The game ends with nobody able to move: fewest cards wins, ties to the lower seat. */
export function stalemate(s: UnoState): UnoState {
  let winner = 0
  s.hands.forEach((h, i) => {
    if (h.length < (s.hands[winner] as UnoCard[]).length) winner = i
  })
  return { ...s, phase: 'done', winner, log: pushLog(s.log, 'Stalemate: fewest cards wins') }
}

/** The turn passes on; `nothing` marks a pass with nothing left to draw (the stalemate guard counts those). */
function pass(s: UnoState, seat: number, nothing: boolean): UnoState {
  const t = { ...s, passes: nothing ? s.passes + 1 : 0, drawn: null, turn: stepFrom(s, seat, 1, s.dir) }
  return t.passes >= t.seats ? stalemate(t) : t
}

/** What a card does once its colour is settled: the draw penalty, the direction and who is next. */
function effect(s: UnoState, seat: number, face: UnoFace): UnoState {
  const names = seatNames(s.opponents)
  let dir = s.dir
  let steps = 1
  let victim = -1
  let count = 0
  if (face === 'skip') steps = 2
  else if (face === 'reverse') {
    dir = s.dir === 1 ? -1 : 1
    steps = s.seats === 2 ? 2 : 1
  } else if (face === 'draw2' || face === 'wild4') {
    victim = stepFrom(s, seat, 1, dir)
    count = face === 'draw2' ? 2 : 4
    steps = 2
  }
  let t: UnoState = { ...s, dir, turn: stepFrom(s, seat, steps, dir) }
  if (victim >= 0) t = { ...give(t, victim, count), log: pushLog(t.log, `${names[victim]} draw${victim === 0 ? '' : 's'} ${count}`) }
  return t
}

/** `seat` plays card `idx`. Your wild waits for its colour (phase `color`); the computer picks `chosen`. */
export function playFrom(s: UnoState, seat: number, idx: number, chosen: UnoColor = 'R'): UnoState {
  const names = seatNames(s.opponents)
  const card = (s.hands[seat] as UnoCard[])[idx] as UnoCard
  const hands = s.hands.map((h, i) => (i === seat ? h.filter((_, k) => k !== idx) : h))
  const left = (hands[seat] as UnoCard[]).length
  let t: UnoState = { ...s, hands, discard: [...s.discard, card], drawn: null, passes: 0, cursor: seat === 0 ? Math.min(s.cursor, Math.max(0, left - 1)) : s.cursor }
  const wild = card.color === 'W'
  const said = `${names[seat]}: ${unoLabel(card)}${wild && seat !== 0 ? ` ${COLOR_WORD[chosen]}` : ''}`
  // The empty hand is checked before the card's effect, so a last draw2 never bites.
  if (left === 0) return { ...t, phase: 'done', winner: seat, log: pushLog(t.log, `${said} and out of cards!`) }
  t = { ...t, log: pushLog(t.log, said) }
  if (left === 1) t = { ...t, log: pushLog(t.log, `${names[seat]}: UNO!`) }
  if (wild && seat === 0) return { ...t, phase: 'color', pending: card.face as 'wild' | 'wild4', colorCursor: 0 }
  t = { ...t, color: wild ? chosen : (card.color as UnoColor) }
  return effect(t, seat, card.face)
}

/** The colour the computer names: the one it holds most of (ties R, G, B, Y); red with none. */
export function bestColor(cards: readonly UnoCard[]): UnoColor {
  let best: UnoColor = 'R'
  let most = 0
  for (const c of COLORS) {
    const n = cards.filter(x => x.color === c).length
    if (n > most) {
      most = n
      best = c
    }
  }
  return best
}

/** How much the computer wants to play a card: draw2, skip, reverse, the highest number, wild, wild4 last. */
const want = (c: UnoCard): number => (c.face.length === 1 ? 100 + Number(c.face) : ({ draw2: 600, skip: 500, reverse: 400, wild: 50, wild4: 10 } as Record<string, number>)[c.face] ?? 0)

export function aiPick(s: UnoState, hand: readonly UnoCard[]): number {
  let best = -1
  let top = -1
  hand.forEach((c, i) => {
    if (canPlay(s, c) && want(c) > top) {
      top = want(c)
      best = i
    }
  })
  return best
}

/** One computer turn: play the preferred legal card, else draw one and play it if it fits, else pass. */
export function aiTurn(s: UnoState): UnoState {
  const seat = s.turn
  const name = seatNames(s.opponents)[seat] as string
  const hand = s.hands[seat] as UnoCard[]
  const pick = aiPick(s, hand)
  if (pick >= 0) return playFrom(s, seat, pick, bestColor(hand.filter((_, i) => i !== pick)))
  const r = draw1(s)
  if (!r.card) return pass({ ...r.s, log: pushLog(s.log, `${name} cannot draw`) }, seat, true)
  const card = r.card
  const t = { ...r.s, hands: r.s.hands.map((h, i) => (i === seat ? [...h, card] : h)) }
  if (canPlay(t, card)) return playFrom(t, seat, hand.length, bestColor(hand))
  return pass({ ...t, log: pushLog(t.log, `${name} draws and passes`) }, seat, false)
}

/** The computer seats play until it is your turn again (or the game ends). */
export function runAi(s: UnoState): UnoState {
  let t = s
  for (let guard = 0; guard < 500 && t.phase === 'play' && t.turn !== 0; guard++) t = aiTurn(t)
  return t
}

function youPlay(s: UnoState, idx: number): UnoState {
  if (!legal(s, idx)) return { ...s, cursor: Math.max(0, Math.min(idx, (s.hands[0] as UnoCard[]).length - 1)), log: pushLog(s.log, 'That card cannot be played') }
  return runAi(playFrom(s, 0, idx))
}

function youDraw(s: UnoState): UnoState {
  if (s.drawn !== null) return runAi(pass({ ...s, log: pushLog(s.log, 'You pass') }, 0, false))
  const r = draw1(s)
  if (!r.card) return runAi(pass({ ...r.s, log: pushLog(s.log, 'Nothing left to draw: you pass') }, 0, true))
  const card = r.card
  const hand = [...(s.hands[0] as UnoCard[]), card]
  const t = { ...r.s, hands: r.s.hands.map((h, i) => (i === 0 ? hand : h)) }
  if (canPlay(t, card)) return { ...t, drawn: hand.length - 1, cursor: hand.length - 1, log: pushLog(t.log, `You draw ${unoLabel(card)}: play it or pass`) }
  return runAi(pass({ ...t, log: pushLog(t.log, `You draw ${unoLabel(card)}: no play`) }, 0, false))
}

function pickColor(s: UnoState, color: UnoColor): UnoState {
  if (s.phase !== 'color') return s
  const face = s.pending ?? 'wild'
  const t: UnoState = { ...s, color, phase: 'play', pending: undefined, log: pushLog(s.log, `You: ${COLOR_WORD[color]}`) }
  return runAi(effect(t, 0, face))
}

/** What a click at region cell (x, y) means: a card of your hand, the deck or a colour of the picker. */
export type UnoTarget = { kind: 'card'; index: number } | { kind: 'draw' } | { kind: 'color'; color: UnoColor }

/** The column where `[draw]` starts on the top row. */
const drawX = (s: UnoState): number => ` Top ${unoLabel(topOf(s))} ${COLOR_WORD[s.color]}  Deck ${s.draw.length} `.length

const handRows = (s: UnoState): number => Math.max(1, Math.ceil((s.hands[0] as UnoCard[]).length / PER_ROW))

export function unoTap(x: number, y: number, s: UnoState): UnoTarget | undefined {
  if (s.phase === 'done') return undefined
  if (y === TOP_Y) return s.phase === 'play' && x >= drawX(s) ? { kind: 'draw' } : undefined
  if (y < HAND_Y) return undefined
  const col = cellAtX(x)
  if (col === undefined || col >= PER_ROW) return undefined
  const row = y - HAND_Y
  if (row < handRows(s)) {
    const index = row * PER_ROW + col
    return s.phase === 'play' && index < (s.hands[0] as UnoCard[]).length ? { kind: 'card', index } : undefined
  }
  return row === handRows(s) && s.phase === 'color' && col < 4 ? { kind: 'color', color: COLORS[col] as UnoColor } : undefined
}

function onKey(s: UnoState, key: Key): UnoState {
  if (s.phase === 'done') return key === 'a' || key === 'c:d' || key === 'c: ' ? initUno(s.rng, s.opponents) : s
  if (key.startsWith('tap:')) {
    const [, x, y] = key.split(':')
    const hit = unoTap(Number(x), Number(y), s)
    if (!hit) return s
    if (hit.kind === 'card') return youPlay({ ...s, cursor: hit.index }, hit.index)
    return hit.kind === 'draw' ? youDraw(s) : pickColor(s, hit.color)
  }
  if (s.phase === 'color') {
    if (key === 'left' || key === 'right') return { ...s, colorCursor: Math.min(3, Math.max(0, s.colorCursor + (key === 'left' ? -1 : 1))) }
    if (key === 'a' || key === 'c: ') return pickColor(s, COLORS[s.colorCursor] as UnoColor)
    const c = COLOR_KEYS[key]
    return c ? pickColor(s, c) : s
  }
  const n = (s.hands[0] as UnoCard[]).length
  if (key === 'left' || key === 'right') {
    const cursor = Math.min(n - 1, Math.max(0, s.cursor + (key === 'left' ? -1 : 1)))
    return cursor === s.cursor ? s : { ...s, cursor }
  }
  if (key === 'a' || key === 'c: ') return youPlay(s, s.cursor)
  if (key === 'c:d' || key === 'select') return youDraw(s)
  return s
}

const leftControl: GameControl = { label: '◀', key: 'left', hotkey: 'h', kb: '←/→ or h/l choose a card, click a card to play it', pad: 'd-pad ←/→ choose' }
const rightControl: GameControl = { label: '▶', key: 'right', hotkey: 'l', kb: '' }
const playControl: GameControl = { label: 'play', key: 'a', hotkey: 'p', kb: 'Enter, Space or p play the chosen card', pad: 'a plays or picks the colour' }
const drawControl: GameControl = { label: 'draw', key: 'c:d', hotkey: 'd', kb: 'd draw a card (again: pass), or click the deck', pad: 'x or back draws, then passes' }
const colorControls: GameControl[] = COLORS.map(c => ({
  label: COLOR_NAME[c], key: `c:${c.toLowerCase()}` as Key, hotkey: c.toLowerCase(), kb: c === 'R' ? 'r g b y name the colour of a wild' : '',
}))

const clip = (text: string, cols: number): string => (text.length > cols ? `${text.slice(0, Math.max(0, cols - 1))}…` : text)

export const unoGame = defineGame<UnoState>({
  id: 'uno',
  title: 'UNO',
  blurb: 'You against two or three computer players.',
  minColumns: 38,
  keyboard: { p: 'a' },
  repeatable: ['left', 'right'],
  init: (seed, opts) => initUno(seed, Number(opts.opponents)),
  onKey: (s, key) => onKey(s, key),
  isOver: s => s.phase === 'done',
  score(s) {
    if (s.phase !== 'done' || s.recorded) return undefined
    return { counters: { [`vs${s.opponents}.${s.winner === 0 ? 'w' : 'l'}`]: 1 } }
  },
  controls: [leftControl, rightControl, playControl, drawControl, ...colorControls],
  view(s, cols) {
    const names = seatNames(s.opponents)
    const mine = s.hands[0] as UnoCard[]
    const playing = s.phase === 'play'
    const seats = names.slice(1).map((name, k) => `${playing && s.turn === k + 1 ? '▶' : ''}${cols >= 56 ? name : name.slice(0, 1)} ${(s.hands[k + 1] as UnoCard[]).length}`)
    const top = topOf(s)
    const board: Seg[][] = [
      [seg(' '), seg(seats.join(' · '))],
      [seg(` Top ${unoLabel(top)} `), seg(COLOR_WORD[s.color], { color: COLOR_NAME[s.color], bold: true }), seg(`  Deck ${s.draw.length} `, { dim: true }), seg('[draw]', { bold: true })],
    ]
    const lines = s.log.slice(-3)
    for (let i = 0; i < 3 - lines.length; i++) board.push([])
    for (const line of lines) board.push([seg(` ${clip(line, cols - 1)}`, { dim: true })])
    board.push([seg(playing && s.turn === 0 ? '▶' : ' '), seg(`Your hand (${mine.length})`, { bold: true })])
    for (let r = 0; r < handRows(s); r++) {
      const cells = mine.slice(r * PER_ROW, r * PER_ROW + PER_ROW).map((c, k) => {
        const i = r * PER_ROW + k
        return unoCell(c, { dim: playing && !legal(s, i), inverse: playing && i === s.cursor, underline: s.drawn === i })
      })
      board.push(cells.length ? rowOfCells(cells) : [])
    }
    if (s.phase === 'color') board.push(rowOfCells(COLORS.map((c, i) => [seg(`[${c}]  `, { color: COLOR_NAME[c], bold: true, inverse: i === s.colorCursor })])))
    const status = s.phase === 'done' ? `${s.winner === 0 ? 'You win!' : `${names[s.winner ?? 0]} wins.`}   a: new game`
      : s.phase === 'color' ? 'Pick a colour: r g b y, or click one'
        : s.drawn !== null ? 'Play the card you drew (p) or pass (d)' : 'Choose a card, p plays · d draws'
    const controls = s.phase === 'color' ? colorControls : s.phase === 'done' ? [{ ...playControl, label: 'again' }] : [leftControl, rightControl, playControl, s.drawn !== null ? { ...drawControl, label: 'pass' } : drawControl]
    return { header: [seg(' UNO ', { bold: true, color: 'red' }), seg(` vs ${s.opponents}`, { dim: true })], board, status, controls }
  },
})
