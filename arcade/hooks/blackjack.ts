import type { BjHand, BlackjackState } from '../types'
import { START_CHIPS, cardSegs, fmtChips, handSegs, rebuy, shoe as newShoe, shuffleDeck } from './cards'
import type { Card } from './cards'
import { defineGame, seg } from './game'
import type { GameControl, Key, Seg } from './game'

// Blackjack from a 6-deck shoe against a dealer who stands on soft 17 and
// peeks for a natural. One split (same rank), double on any two cards, 3:2
// naturals; no insurance, even money, surrender or re-split. Turn-based like
// tic-tac-toe (no pause, no ticks). The chips are the shared bankroll the
// shell writes into `chips`.

export const DECKS = 6
/** The shoe is reshuffled before a deal when fewer cards than this are left (a quarter of it). */
export const CUT = 78
export const BET_STEPS = [10, 20, 50, 100, 200]
export const MIN_BET = 10

const worth = (c: Card): number => Math.min(10, c.rank)

/** The best total of a hand: aces count 1, plus 10 once when that stays at or under 21 (a soft total). */
export function handValue(cards: readonly Card[]): { total: number; soft: boolean } {
  let total = 0
  let aces = 0
  for (const c of cards) {
    total += worth(c)
    if (c.rank === 1) aces++
  }
  return aces > 0 && total + 10 <= 21 ? { total: total + 10, soft: true } : { total, soft: false }
}

/** The largest bet step that is at most `bet` and at most the chips. */
export const stepFor = (bet: number, chips: number): number => BET_STEPS.filter(x => x <= Math.min(bet, chips)).pop() ?? MIN_BET

/** The bet steps the chips can cover (the smallest always). */
const affordable = (chips: number): number[] => BET_STEPS.filter(x => x <= Math.max(chips, MIN_BET))

/** Cards off the front of the shoe, one at a time; `rest()` is what is left. */
function drawer(pile: readonly Card[]) {
  let at = 0
  return { take: (): Card => pile[at++] ?? { rank: 10, suit: 'S' }, rest: (): Card[] => pile.slice(at) }
}

const signed = (n: number): string => (n > 0 ? `+${n}` : String(n))

const FACTOR = { win: 2, blackjack: 2.5, push: 1, lose: 0, bust: 0 }
const payout = (h: BjHand): number => (h.outcome ? h.bet * FACTOR[h.outcome] : 0)

const WORD = { win: 'Win', blackjack: 'Blackjack!', push: 'Push', lose: 'Lose', bust: 'Bust' }

/** The round is over: pay every hand, reveal the hole card and write the result line. */
function conclude(s: BlackjackState, hands: BjHand[], prefix = ''): BlackjackState {
  const paid = hands.reduce((a, h) => a + payout(h), 0)
  const net = paid - hands.reduce((a, h) => a + h.bet, 0)
  const words = hands.map((h, i) => `${hands.length > 1 ? `H${i + 1} ` : ''}${h.outcome ? WORD[h.outcome] : ''}`).join(' · ')
  return {
    ...s, hands, phase: 'done', holeShown: true, chips: s.chips + paid, net, natural: hands.some(h => h.outcome === 'blackjack'),
    message: `${prefix}${words}  ${signed(net)}`,
  }
}

function dealRound(s: BlackjackState): BlackjackState {
  if (s.chips < MIN_BET) return { ...s, message: 'Out of chips: r rebuys 500' }
  const bet = stepFor(s.bet, s.chips)
  let pile = s.shoe
  let rng = s.rng
  let reshuffled = false
  if (pile.length < CUT) {
    const sh = shuffleDeck(newShoe(DECKS), rng)
    pile = sh.cards
    rng = sh.rng
    reshuffled = true
  }
  const d = drawer(pile)
  const p1 = d.take()
  const up = d.take()
  const p2 = d.take()
  const hole = d.take()
  const hand: BjHand = { cards: [p1, p2], bet, done: false, doubled: false, fromSplit: false }
  const base: BlackjackState = {
    ...s, phase: 'play', bet, chips: s.chips - bet, shoe: d.rest(), dealer: [up, hole], holeShown: false, hands: [hand], active: 0,
    net: 0, natural: false, message: '', reshuffled, rng, recorded: false,
  }
  const playerNat = handValue(hand.cards).total === 21
  const tenUp = up.rank === 1 || up.rank >= 10
  if (tenUp && handValue([up, hole]).total === 21) {
    return conclude(base, [{ ...hand, done: true, outcome: playerNat ? 'push' : 'lose' }], 'Dealer has blackjack. ')
  }
  if (playerNat) return conclude(base, [{ ...hand, done: true, outcome: 'blackjack' }])
  return base
}

const replaceAt = (hands: readonly BjHand[], i: number, h: BjHand): BjHand[] => hands.map((x, k) => (k === i ? h : x))

/** The dealer plays out (unless every hand busted) and the hands are settled. */
function finish(s: BlackjackState): BlackjackState {
  const allBust = s.hands.every(h => h.outcome === 'bust')
  const d = drawer(s.shoe)
  const dealer = s.dealer.slice()
  if (!allBust) while (handValue(dealer).total < 17) dealer.push(d.take())
  const dt = handValue(dealer).total
  const hands = s.hands.map((h): BjHand => {
    if (h.outcome) return h
    const pt = handValue(h.cards).total
    return { ...h, outcome: dt > 21 || pt > dt ? 'win' : pt === dt ? 'push' : 'lose' }
  })
  return conclude({ ...s, dealer, shoe: d.rest() }, hands, dt > 21 && !allBust ? 'Dealer busts. ' : '')
}

/** On to the next hand still to play, or the dealer's turn when there is none. */
function advance(s: BlackjackState): BlackjackState {
  const next = s.hands.findIndex(h => !h.done)
  return next >= 0 ? { ...s, active: next } : finish(s)
}

const current = (s: BlackjackState): BjHand => s.hands[s.active] as BjHand

/** A hand with its card added: over 21 it is bust, on 21 it stands. */
function withCard(h: BjHand, card: Card, stand = false): BjHand {
  const cards = [...h.cards, card]
  const total = handValue(cards).total
  if (total > 21) return { ...h, cards, done: true, outcome: 'bust' }
  return { ...h, cards, done: stand || total === 21 }
}

export function canDouble(s: BlackjackState): boolean {
  const h = s.hands[s.active]
  return s.phase === 'play' && !!h && !h.done && h.cards.length === 2 && s.chips >= h.bet
}

export function canSplit(s: BlackjackState): boolean {
  const h = s.hands[s.active]
  return s.phase === 'play' && s.hands.length === 1 && !!h && h.cards.length === 2 && h.cards[0]?.rank === h.cards[1]?.rank && s.chips >= h.bet
}

function hit(s: BlackjackState): BlackjackState {
  const d = drawer(s.shoe)
  const h = withCard(current(s), d.take())
  return advanceIf({ ...s, shoe: d.rest(), hands: replaceAt(s.hands, s.active, h) })
}

const advanceIf = (s: BlackjackState): BlackjackState => (current(s).done ? advance(s) : s)

function stand(s: BlackjackState): BlackjackState {
  return advance({ ...s, hands: replaceAt(s.hands, s.active, { ...current(s), done: true }) })
}

function double(s: BlackjackState): BlackjackState {
  if (!canDouble(s)) return { ...s, message: 'Cannot double now' }
  const d = drawer(s.shoe)
  const h = current(s)
  const doubled = withCard({ ...h, bet: h.bet * 2, doubled: true }, d.take(), true)
  return advance({ ...s, chips: s.chips - h.bet, shoe: d.rest(), hands: replaceAt(s.hands, s.active, doubled) })
}

function split(s: BlackjackState): BlackjackState {
  if (!canSplit(s)) return { ...s, message: 'Cannot split now' }
  const d = drawer(s.shoe)
  const h = current(s)
  const [c1, c2] = h.cards as [Card, Card]
  const aces = c1.rank === 1
  const one = withCard({ cards: [c1], bet: h.bet, done: false, doubled: false, fromSplit: true }, d.take(), aces)
  const two = withCard({ cards: [c2], bet: h.bet, done: false, doubled: false, fromSplit: true }, d.take(), aces)
  return advance({ ...s, chips: s.chips - h.bet, shoe: d.rest(), hands: [one, two], active: 0, message: '' })
}

function onKey(s: BlackjackState, key: Key): BlackjackState {
  if (s.phase === 'play') {
    if (key === 'a' || key === 'c:h') return hit(s)
    if (key === 'b' || key === 'c:s') return stand(s)
    if (key === 'select' || key === 'c:x') return double(s)
    if (key === 'right' || key === 'c:p') return split(s)
    return s
  }
  // bet and done
  if (key === 'a' || key === 'c: ' || key === 'c:d') return dealRound(s)
  if (key === 'c:b' || key === 'up' || key === 'down') {
    const steps = affordable(s.chips)
    const at = Math.max(0, steps.indexOf(s.bet))
    const to = key === 'c:b' ? (at + 1) % steps.length : Math.min(steps.length - 1, Math.max(0, at + (key === 'up' ? 1 : -1)))
    const bet = steps[to] as number
    return bet === s.bet ? s : { ...s, bet }
  }
  if (key === 'c:r' && s.chips < MIN_BET) return { ...s, chips: rebuy(), bet: stepFor(s.bet, START_CHIPS), message: `Rebought ${START_CHIPS}` }
  return s
}

const dealControl: GameControl = { label: 'deal', key: 'c:d', hotkey: 'd', kb: 'Enter, Space or d deal', pad: 'a deals' }
const hitControl: GameControl = { label: 'hit', key: 'c:h', hotkey: 'h', kb: 'h hit', pad: 'a hits' }
const standControl: GameControl = { label: 'stand', key: 'c:s', hotkey: 's', kb: 's stand', pad: 'b stands' }
const doubleControl: GameControl = { label: 'x2', key: 'c:x', hotkey: 'x', kb: 'x double down (two cards only)', pad: 'x or back doubles' }
const splitControl: GameControl = { label: 'split', key: 'c:p', hotkey: 'p', kb: 'p split a pair (once)', pad: 'd-pad → splits' }
const betControl: GameControl = { label: 'bet', key: 'c:b', hotkey: 'b', kb: 'b or ↑/↓ change the bet (10 to 200)', pad: 'd-pad ↑/↓ bet' }
const rebuyControl: GameControl = { label: 'rebuy', key: 'c:r', hotkey: 'r', kb: 'r rebuy 500 when out of chips' }

const clip = (text: string, cols: number): string => (text.length > cols ? `${text.slice(0, Math.max(0, cols - 1))}…` : text)

/** `soft 17`, `21`, `BUST`: what a hand is worth, as shown. */
function valueText(cards: readonly Card[]): string {
  const v = handValue(cards)
  return v.total > 21 ? 'BUST' : v.soft ? `soft ${v.total}` : String(v.total)
}

export const blackjackGame = defineGame<BlackjackState>({
  id: 'blackjack',
  title: 'Blackjack',
  blurb: 'Six decks, dealer stands on soft 17, 3:2 naturals.',
  minColumns: 30,
  keyboard: { h: 'c:h', p: 'c:p' },
  repeatable: [],
  init(seed, opts) {
    const sh = shuffleDeck(newShoe(DECKS), seed | 0)
    const want = Number(opts.bet)
    return {
      phase: 'bet', chips: 0, bet: BET_STEPS.includes(want) ? want : MIN_BET, shoe: sh.cards, dealer: [], holeShown: false, hands: [], active: 0, net: 0,
      natural: false, message: '', reshuffled: false, rng: sh.rng, recorded: false,
    }
  },
  onKey: (s, key) => onKey(s, key),
  isOver: s => s.phase === 'done',
  score(s) {
    if (s.phase !== 'done' || s.recorded) return undefined
    const counters: Record<string, number> = { [s.net > 0 ? 'w' : s.net < 0 ? 'l' : 'p']: 1 }
    if (s.natural) counters.bj = 1
    return { counters, bests: { chips: { value: s.chips } } }
  },
  bank: { get: s => s.chips, set: (s, chips) => ({ ...s, chips }) },
  controls: [dealControl, hitControl, standControl, doubleControl, splitControl, betControl, rebuyControl],
  view(s, cols) {
    const play = s.phase === 'play'
    const board: Seg[][] = []
    const shown = s.holeShown ? s.dealer : s.dealer.slice(0, 1)
    board.push([seg(' Dealer', { bold: true }), ...(s.holeShown && s.dealer.length ? [seg(`  ${valueText(s.dealer)}`, { dim: true })] : [])])
    if (s.dealer.length) {
      const line = s.holeShown ? (handSegs(shown, cols - 1)[0] as Seg[]) : [...shown.flatMap(c => cardSegs(c)), seg('[??]', { dim: true })]
      board.push([seg(' '), ...line])
    } else board.push([])
    s.hands.forEach((h, i) => {
      board.push([])
      board.push([seg(` ${s.hands.length > 1 ? `Hand ${i + 1}` : 'You'}`, { bold: true }), seg(`  ${valueText(h.cards)}  bet ${h.bet}${play && i === s.active ? ' ◀' : ''}`, { dim: true })])
      board.push([seg(' '), ...(handSegs(h.cards, cols - 1)[0] as Seg[])])
    })
    board.push([])
    board.push([seg(` Chips ${fmtChips(s.chips)}  Bet ${s.bet}`, { bold: true })])
    if (s.message) board.push([seg(` ${clip(s.message, cols - 1)}`, { bold: s.phase === 'done', color: s.phase === 'done' ? (s.net > 0 ? 'green' : s.net < 0 ? 'red' : undefined) : 'yellow' })])
    if (s.reshuffled && s.phase !== 'bet') board.push([seg(' Shoe reshuffled', { dim: true })])
    if (s.phase === 'done') board.push([seg(' d / Enter: next hand', { dim: true })])
    const broke = s.chips < MIN_BET
    const status = play ? ['h hit · s stand', canDouble(s) ? 'x double' : '', canSplit(s) ? 'p split' : ''].filter(Boolean).join(' · ')
      : broke ? 'Out of chips: r rebuys 500' : s.phase === 'bet' ? 'd deals · ↑/↓ or b changes the bet' : 'd: next hand · b changes the bet'
    const controls = play ? [hitControl, standControl, ...(canDouble(s) ? [doubleControl] : []), ...(canSplit(s) ? [splitControl] : [])]
      : [betControl, dealControl, ...(broke ? [rebuyControl] : [])]
    return { header: [seg(' BLACKJACK ', { bold: true, color: 'green' })], board, status, controls }
  },
})
