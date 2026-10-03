import type { Card, Suit } from '../types'
import { fmtNum, mergeSegs, seg } from './game'
import type { Seg } from './game'
import { shuffle } from './rng'

// Playing cards for the card games (video poker, blackjack, UNO): a deck, a
// seeded shuffle, hand helpers and a compact renderer to Seg runs, plus the
// fixed-width cells the tap geometry stands on.

// The card types live in the contract (../types) with the saved states that hold them.
export type { Card, Suit } from '../types'

const SUITS: Suit[] = ['S', 'H', 'D', 'C']
const GLYPH: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣', J: '★' }
const ASCII: Record<Suit, string> = { S: 's', H: 'h', D: 'd', C: 'c', J: '*' }
const NAMES = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']

/** A fresh ordered deck: 52 cards, plus `jokers` jokers. */
export function deck(jokers = 0): Card[] {
  const out: Card[] = []
  for (const suit of SUITS) for (let rank = 1; rank <= 13; rank++) out.push({ rank, suit })
  for (let i = 0; i < jokers; i++) out.push({ rank: 0, suit: 'J' })
  return out
}

/** A seeded shuffle and the next rng state. */
export function shuffleDeck(cards: readonly Card[], rng: number): { cards: Card[]; rng: number } {
  const r = shuffle(cards, rng)
  return { cards: r.items, rng: r.s }
}

/** `n` cards off the top and what is left. */
export function deal(cards: readonly Card[], n: number): { hand: Card[]; rest: Card[] } {
  return { hand: cards.slice(0, n), rest: cards.slice(n) }
}

const SUIT_ORDER: Record<Suit, number> = { S: 0, H: 1, D: 2, C: 3, J: 4 }

/** A hand by rank (aces high when `acesHigh`), then suit. */
export function sortHand(cards: readonly Card[], acesHigh = true): Card[] {
  const key = (c: Card) => (c.rank === 0 ? 99 : acesHigh && c.rank === 1 ? 14 : c.rank)
  return cards.slice().sort((a, b) => key(a) - key(b) || SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit])
}

/** How many of each rank (index 0 = jokers, 1 = aces .. 13 = kings). */
export function rankCounts(cards: readonly Card[]): number[] {
  const out = Array<number>(14).fill(0)
  for (const c of cards) out[c.rank] = (out[c.rank] as number) + 1
  return out
}

export const cardLabel = (card: Card, opts: { ascii?: boolean } = {}): string =>
  card.suit === 'J' ? '[JK]' : `[${NAMES[card.rank]}${opts.ascii ? ASCII[card.suit] : GLYPH[card.suit]}]`

/** One card as a run: `[A♠]`, red for hearts and diamonds. */
export function cardSegs(card: Card, opts: { ascii?: boolean } = {}): Seg[] {
  const red = card.suit === 'H' || card.suit === 'D'
  return [seg(cardLabel(card, opts), red ? { color: 'red' } : {})]
}

/**
 * A hand as lines of runs that fit `cols`. One line of `[A♠][10♥]...` (no gaps: seven cards take at most 35 columns); with
 * `tall` three framed lines. Hands too wide for the room show a window of the
 * first cards and `‹ n more ›`.
 */
export function handSegs(cards: readonly Card[], cols: number, opts: { ascii?: boolean; tall?: boolean } = {}): Seg[][] {
  const widths = cards.map(c => cardLabel(c, opts).length)
  const total = widths.reduce((a, w) => a + w, 0)
  let shown = cards.length
  if (total > cols) {
    const reserve = 12
    let used = 0
    shown = 0
    for (const w of widths) {
      if (used + w + reserve > cols) break
      used += w
      shown++
    }
  }
  const part = cards.slice(0, shown)
  const more = cards.length - shown
  const tail: Seg[] = more > 0 ? [seg(` ‹ ${more} more ›`, { dim: true })] : []
  if (!opts.tall) {
    const line: Seg[] = []
    for (const c of part) line.push(...cardSegs(c, opts))
    return [mergeSegs([...line, ...tail])]
  }
  const rows: Seg[][] = [[], [], []]
  part.forEach(c => {
    const text = cardLabel(c, opts)
    const inner = text.length - 2
    const style = c.suit === 'H' || c.suit === 'D' ? { color: 'red' } : {}
    const sep = ''
    ;(rows[0] as Seg[]).push(seg(`${sep}┌${'─'.repeat(inner)}┐`, style))
    ;(rows[1] as Seg[]).push(seg(`${sep}│${text.slice(1, -1)}│`, style))
    ;(rows[2] as Seg[]).push(seg(`${sep}└${'─'.repeat(inner)}┘`, style))
  })
  if (tail.length) (rows[1] as Seg[]).push(...tail)
  return rows.map(mergeSegs)
}

// ---------- the card games' shared pieces ----------

/** The play chips a fresh bankroll (and a rebuy) holds. */
export const START_CHIPS = 500

/** `decks` ordered decks in one pile, for a blackjack shoe. */
export function shoe(decks: number): Card[] {
  const out: Card[] = []
  for (let i = 0; i < decks; i++) out.push(...deck())
  return out
}

/** A card cell is 5 columns wide plus a 1-column gap: the stride of every row of cards. */
export const CELL = 6
const CELL_W = CELL - 1

/** One card padded to exactly 5 columns, so a row of cards lines up whatever the cards are. */
export function cardCell(card: Card, opts: { ascii?: boolean } = {}): Seg[] {
  const red = card.suit === 'H' || card.suit === 'D'
  return [seg(cardLabel(card, opts).padEnd(CELL_W), red ? { color: 'red' } : {})]
}

/** The face-down card, as wide as a cell. */
export const backCell = (): Seg[] => [seg('[??] ', { dim: true })]

/** Cells joined by one space after a 1-column indent: cell `i` starts at column `indent + i * CELL`. */
export function rowOfCells(cells: readonly Seg[][], indent = 1): Seg[] {
  const out: Seg[] = [seg(' '.repeat(indent))]
  cells.forEach((cell, i) => {
    if (i > 0) out.push(seg(' '))
    out.push(...cell)
  })
  return mergeSegs(out)
}

/** The cell under column `x` of a row built by `rowOfCells`; undefined on the indent or a gap. */
export function cellAtX(x: number, indent = 1): number | undefined {
  if (x < indent) return undefined
  const off = x - indent
  return off % CELL < CELL_W ? Math.floor(off / CELL) : undefined
}

/** `1234` as `1,234`. */
export const fmtChips = (n: number): string => fmtNum(n)

/** Whether `chips` cover the smallest bet. */
export const bankOk = (chips: number, minBet: number): boolean => chips >= minBet

/** The chips a rebuy hands over. */
export const rebuy = (): number => START_CHIPS
