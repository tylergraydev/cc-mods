import type { PokerRank, PokerState } from '../types'
import { START_CHIPS, backCell, cardCell, cellAtX, deal as dealCards, deck, fmtChips, rankCounts, rebuy, rowOfCells, shuffleDeck } from './cards'
import type { Card } from './cards'
import { defineGame, seg } from './game'
import type { GameControl, Key, Seg } from './game'

// Video poker, Jacks or Better on the 9/6 paytable: bet 1 to 5 coins, hold up
// to five cards, draw once. Turn-based like tic-tac-toe (no pause, no ticks):
// a finished hand is `done`, the next deal starts the next one. The chips are
// the shared bankroll the shell writes into `chips`.

type Paid = Exclude<PokerRank, 'nothing'>

/** The credits a hand returns for coins 1 to 5 ("for one"). Five coins on a royal flush pay the jackpot. */
export const PAYTABLE: Record<Paid, readonly number[]> = {
  royal: [250, 500, 750, 1000, 4000],
  straightFlush: [50, 100, 150, 200, 250],
  four: [25, 50, 75, 100, 125],
  fullHouse: [9, 18, 27, 36, 45],
  flush: [6, 12, 18, 24, 30],
  straight: [4, 8, 12, 16, 20],
  three: [3, 6, 9, 12, 15],
  twoPair: [2, 4, 6, 8, 10],
  jacks: [1, 2, 3, 4, 5],
}

/** The paying hands, best first (the row order of the table). */
export const PAID: Paid[] = ['royal', 'straightFlush', 'four', 'fullHouse', 'flush', 'straight', 'three', 'twoPair', 'jacks']

export const NAME: Record<PokerRank, string> = {
  royal: 'Royal Flush', straightFlush: 'Straight Flush', four: 'Four of a Kind', fullHouse: 'Full House', flush: 'Flush',
  straight: 'Straight', three: 'Three of a Kind', twoPair: 'Two Pair', jacks: 'Jacks or Better', nothing: 'Nothing',
}

const MAX_BET = 5
const NAME_W = 15
const HAND_Y = 2
const HELD_Y = 3

/** The rank of a five-card hand. Aces are low or high in a straight; wrap-arounds (Q-K-A-2-3) are not straights. */
export function evaluate(hand: readonly Card[]): PokerRank {
  const counts = rankCounts(hand)
  const flush = hand.every(c => c.suit === hand[0]?.suit)
  const ranks = hand.map(c => c.rank)
  const lo = Math.min(...ranks)
  const hi = Math.max(...ranks)
  const distinct = new Set(ranks).size === 5
  const broadway = [1, 10, 11, 12, 13].every(r => counts[r] === 1)
  const straight = distinct && (hi - lo === 4 || broadway)
  const groups = counts.slice(1).filter(n => n > 0).sort((a, b) => b - a)
  if (straight && flush) return broadway ? 'royal' : 'straightFlush'
  if (groups[0] === 4) return 'four'
  if (groups[0] === 3 && groups[1] === 2) return 'fullHouse'
  if (flush) return 'flush'
  if (straight) return 'straight'
  if (groups[0] === 3) return 'three'
  if (groups[0] === 2 && groups[1] === 2) return 'twoPair'
  if (groups[0] === 2) {
    const pair = counts.findIndex((n, r) => r > 0 && n === 2)
    return pair === 1 || pair >= 11 ? 'jacks' : 'nothing'
  }
  return 'nothing'
}

/** The card cell under a tap at region cell (x, y): the hand row and the HELD row. */
export const tapToCard = (x: number, y: number): number | undefined => (y === HAND_Y || y === HELD_Y ? cellAtX(x) : undefined)

/** The most coins the table takes now: 5, or what is left. */
const capOf = (s: PokerState): number => Math.min(MAX_BET, Math.max(1, s.chips))

function dealHand(s: PokerState): PokerState {
  if (s.chips < 1) return { ...s, note: 'Out of chips: r rebuys 500' }
  const bet = Math.min(s.bet, s.chips)
  const sh = shuffleDeck(deck(), s.rng)
  const d = dealCards(sh.cards, 5)
  return {
    ...s, phase: 'hold', chips: s.chips - bet, bet, deck: d.rest, hand: d.hand, held: Array<boolean>(5).fill(false), cursor: 0,
    result: undefined, won: 0, note: undefined, rng: sh.rng, recorded: false,
  }
}

function drawCards(s: PokerState): PokerState {
  let next = 0
  const hand = s.hand.map((c, i) => (s.held[i] ? c : (s.deck[next++] as Card)))
  const result = evaluate(hand)
  const won = result === 'nothing' ? 0 : (PAYTABLE[result][s.bet - 1] as number)
  return { ...s, phase: 'done', hand, deck: s.deck.slice(next), result, won, chips: s.chips + won, held: s.held.slice() }
}

function toggle(s: PokerState, i: number): PokerState {
  if (i < 0 || i > 4) return s
  const held = s.held.slice()
  held[i] = !held[i]
  return { ...s, held, cursor: i }
}

function onKey(s: PokerState, key: Key): PokerState {
  if (s.phase === 'hold') {
    if (key === 'left' || key === 'right') {
      const to = Math.min(4, Math.max(0, s.cursor + (key === 'left' ? -1 : 1)))
      return to === s.cursor ? s : { ...s, cursor: to }
    }
    if (key === 'a') return toggle(s, s.cursor)
    if (key === 'c: ' || key === 'select' || key === 'c:d') return drawCards(s)
    if (key.startsWith('tap:')) {
      const [, x, y] = key.split(':')
      const i = tapToCard(Number(x), Number(y))
      return i === undefined ? s : toggle(s, i)
    }
    if (key.startsWith('c:')) {
      const n = Number(key.slice(2))
      return n >= 1 && n <= 5 ? toggle(s, n - 1) : s
    }
    return s
  }
  // bet and done
  if (key === 'a' || key === 'c: ' || key === 'select' || key === 'c:d') return dealHand(s)
  if (key === 'c:m') return dealHand({ ...s, bet: capOf(s) })
  if (key === 'c:b') {
    const cap = capOf(s)
    return { ...s, bet: s.bet >= cap ? 1 : s.bet + 1 }
  }
  if (key === 'up' || key === 'down') {
    const bet = Math.min(capOf(s), Math.max(1, s.bet + (key === 'up' ? 1 : -1)))
    return bet === s.bet ? s : { ...s, bet }
  }
  if (key === 'c:r' && s.chips < 1) return { ...s, chips: rebuy(), note: `Rebought ${START_CHIPS}` }
  return s
}

const holdControl = (n: number): GameControl => ({
  label: String(n), key: `c:${n}` as Key, hotkey: String(n),
  kb: n === 1 ? '1-5 hold a card (or click it)' : n === 2 ? '←/→ move the cursor, Enter holds it' : '',
  ...(n === 1 ? { pad: 'a holds at the cursor, d-pad ←/→ moves it' } : {}),
})
const dealControl: GameControl = { label: 'deal', key: 'c:d', hotkey: 'd', kb: 'd or Space deal / draw (Enter deals between hands)', pad: 'x or back deal / draw, a deals between hands' }
const betControl: GameControl = { label: 'bet', key: 'c:b', hotkey: 'b', kb: 'b bet one more, or ↑/↓', pad: 'd-pad ↑/↓ bet' }
const maxControl: GameControl = { label: 'max', key: 'c:m', hotkey: 'm', kb: 'm max bet and deal' }
const rebuyControl: GameControl = { label: 'rebuy', key: 'c:r', hotkey: 'r', kb: 'r rebuy 500 when out of chips' }

const HOLDS = [1, 2, 3, 4, 5].map(holdControl)

export const pokerGame = defineGame<PokerState>({
  id: 'poker',
  title: 'Video poker',
  blurb: 'Jacks or Better 9/6, five coins, play chips.',
  minColumns: 32,
  init(seed, opts) {
    const bet = Math.min(MAX_BET, Math.max(1, Math.floor(Number(opts.bet)) || 1))
    return { phase: 'bet', chips: 0, bet, deck: [], hand: [], held: Array<boolean>(5).fill(false), cursor: 0, won: 0, rng: seed | 0, recorded: false }
  },
  onKey: (s, key) => onKey(s, key),
  repeatable: ['left', 'right'],
  isOver: s => s.phase === 'done',
  score(s) {
    if (s.phase !== 'done' || s.recorded) return undefined
    const paid = s.result !== undefined && s.result !== 'nothing'
    return { counters: paid ? { [s.result as string]: 1 } : {}, ...(s.won > 0 ? { bests: { win: { value: s.won } } } : {}) }
  },
  bank: { get: s => s.chips, set: (s, chips) => ({ ...s, chips }) },
  controls: [...HOLDS, dealControl, betControl, maxControl, rebuyControl],
  view(s, cols) {
    const holding = s.phase === 'hold'
    const dealt = s.hand.length === 5
    const cells = dealt
      ? s.hand.map((c, i) => {
          const cell = cardCell(c)
          return holding && i === s.cursor ? cell.map(x => ({ ...x, inverse: true })) : cell
        })
      : Array.from({ length: 5 }, () => backCell())
    const marks = s.held.map(h => [seg(dealt && h ? 'HELD ' : '     ', h && dealt ? { bold: true, color: 'yellow' } : {})])
    const result: Seg[] =
      s.phase === 'done' ? (s.result === 'nothing' || !s.result ? [seg(' No win', { dim: true })] : [seg(` ${NAME[s.result].toUpperCase()}  +${s.won}`, { bold: true, color: 'green' })])
        : holding ? [seg(' Choose the cards to keep', { dim: true })] : [seg(' Ready to deal', { dim: true })]
    const board: Seg[][] = [
      [seg(` Credits ${fmtChips(s.chips)}  Bet ${s.bet}`, { bold: true })],
      [],
      rowOfCells(cells),
      rowOfCells(marks),
      s.note ? [seg(` ${s.note}`, { color: 'yellow' })] : [],
      result,
    ]
    const wide = cols >= 46
    for (const r of PAID) {
      const isResult = s.phase === 'done' && s.result === r
      const pays = PAYTABLE[r]
      const row: Seg[] = [seg(' ', { inverse: isResult }), seg(NAME[r].padEnd(NAME_W), { inverse: isResult })]
      if (wide) pays.forEach((v, k) => row.push(seg(String(v).padStart(6), { bold: k === s.bet - 1, dim: k !== s.bet - 1, inverse: isResult })))
      else row.push(seg(String(pays[s.bet - 1]).padStart(6), { bold: true, inverse: isResult }))
      board.push(row)
    }
    const status = s.note ?? (s.phase === 'bet' ? 'd deals · ↑/↓ or b changes the bet · m max' : holding ? '1-5 or click to hold · d draws' : s.chips < 1 ? 'Out of chips: r rebuys 500' : s.won > 0 ? `Paid ${s.won}.   d: next hand` : 'No win.   d: next hand')
    const deal: GameControl = holding ? { ...dealControl, label: 'draw' } : dealControl
    const controls = holding ? [...HOLDS, deal] : [betControl, maxControl, deal, ...(s.chips < 1 ? [rebuyControl] : [])]
    const header: Seg[] = [seg(' VIDEO POKER ', { bold: true, color: 'yellow' })]
    if (cols >= 34) header.push(seg(' Jacks or Better 9/6', { dim: true }))
    return { header, board, status, controls }
  },
})
