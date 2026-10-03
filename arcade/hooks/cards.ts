import { mergeSegs, seg } from './game'
import type { Seg } from './game'
import { shuffle } from './rng'

// Playing cards for the card games of pack 2 (video poker, UNO-style hands):
// a deck, a seeded shuffle, hand helpers and a compact renderer to Seg runs.
// Pack 1 does not use it.

export type Suit = 'S' | 'H' | 'D' | 'C' | 'J'
/** 1 = ace .. 13 = king; 0 = a joker. */
export type Card = { rank: number; suit: Suit }

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
