import { expect, test } from 'claude-code/testing'

import type { PokerState } from '../types'
import type { Card, Suit } from '../hooks/cards'
import { blackjackGame } from '../hooks/blackjack'
import { SHELL_CONTROLS, mapClientKey } from '../hooks/game'
import type { Key } from '../hooks/game'
import { PAID, PAYTABLE, evaluate, pokerGame, tapToCard } from '../hooks/poker'
import { unoGame } from '../hooks/uno'

const c = (rank: number, suit: Suit): Card => ({ rank, suit })
const hand = (spec: string): Card[] => spec.split(' ').map(t => c(Number(t.slice(0, -1)), t.slice(-1) as Suit))
const text = (rows: { text: string }[][]) => rows.map(r => r.map(s => s.text).join(''))
const fresh = (chips = 100): PokerState => ({ ...pokerGame.init(7, {}, 0), chips })
const press = (s: PokerState, ...keys: Key[]): PokerState => keys.reduce((a, k) => pokerGame.onKey(a, k, 0), s)

test('every hand rank is told apart', () => {
  expect(evaluate(hand('10S 11S 12S 13S 1S'))).toBe('royal')
  expect(evaluate(hand('5H 6H 7H 8H 9H'))).toBe('straightFlush')
  expect(evaluate(hand('9S 9H 9D 9C 2S'))).toBe('four')
  expect(evaluate(hand('9S 9H 9D 2C 2S'))).toBe('fullHouse')
  expect(evaluate(hand('2S 5S 9S 11S 13S'))).toBe('flush')
  expect(evaluate(hand('5S 6H 7D 8C 9S'))).toBe('straight')
  expect(evaluate(hand('1S 2H 3D 4C 5S'))).toBe('straight')
  expect(evaluate(hand('1S 2S 3S 4S 5S'))).toBe('straightFlush')
  expect(evaluate(hand('10S 11H 12D 13C 1S'))).toBe('straight')
  expect(evaluate(hand('12S 13H 1D 2C 3S'))).toBe('nothing')
  expect(evaluate(hand('7S 7H 7D 2C 9S'))).toBe('three')
  expect(evaluate(hand('7S 7H 4D 4C 9S'))).toBe('twoPair')
  expect(evaluate(hand('11S 11H 4D 5C 9S'))).toBe('jacks')
  expect(evaluate(hand('1S 1H 4D 5C 9S'))).toBe('jacks')
  expect(evaluate(hand('10S 10H 4D 5C 9S'))).toBe('nothing')
  expect(evaluate(hand('2S 5H 4D 12C 9S'))).toBe('nothing')
})

test('the paytable is 9/6 and five coins on a royal flush pay 4000', () => {
  expect(PAID).toHaveLength(9)
  expect(PAYTABLE.royal).toEqual([250, 500, 750, 1000, 4000])
  expect(PAYTABLE.fullHouse[0]).toBe(9)
  expect(PAYTABLE.flush[0]).toBe(6)
  expect(PAYTABLE.jacks).toEqual([1, 2, 3, 4, 5])
  for (const r of PAID) expect(PAYTABLE[r]).toHaveLength(5)
})

test('the bet cycles 1 to 5 and back, steps with the arrows and is clamped to the chips', () => {
  let s = fresh()
  expect(press(s, 'c:b').bet).toBe(2)
  expect(press(s, 'c:b', 'c:b', 'c:b', 'c:b').bet).toBe(5)
  expect(press(s, 'c:b', 'c:b', 'c:b', 'c:b', 'c:b').bet).toBe(1)
  expect(press(s, 'down').bet).toBe(1)
  expect(press(s, 'up', 'up', 'up', 'up', 'up', 'up').bet).toBe(5)
  s = fresh(3)
  expect(press(s, 'up', 'up', 'up', 'up').bet).toBe(3)
  expect(press(s, 'c:b', 'c:b', 'c:b').bet).toBe(1)
})

test('a deal debits the bet and holds five cards; max bet deals at once', () => {
  const s = press(fresh(), 'c:b', 'c:b', 'c: ')
  expect(s.phase).toBe('hold')
  expect(s.bet).toBe(3)
  expect(s.chips).toBe(97)
  expect(s.hand).toHaveLength(5)
  expect(s.deck).toHaveLength(47)
  const m = press(fresh(), 'c:m')
  expect(m.phase).toBe('hold')
  expect(m.bet).toBe(5)
  expect(m.chips).toBe(95)
  const low = press(fresh(2), 'c:m')
  expect(low.bet).toBe(2)
  expect(low.chips).toBe(0)
})

test('cards are held by digit, by tap on the hand and HELD rows, and by the cursor', () => {
  let s = press(fresh(), 'c: ')
  s = press(s, 'c:1', 'c:3')
  expect(s.held).toEqual([true, false, true, false, false])
  s = press(s, 'c:1')
  expect(s.held[0]).toBe(false)
  s = press(s, 'tap:7:2')
  expect(s.held[1]).toBe(true)
  s = press(s, 'tap:13:3')
  expect(s.held[2]).toBe(false)
  expect(tapToCard(13, 2)).toBe(2)
  expect(tapToCard(13, 3)).toBe(2)
  expect(tapToCard(13, 4)).toBeUndefined()
  expect(tapToCard(6, 2)).toBeUndefined()
  const before = s.held
  expect(press(s, 'tap:6:2').held).toEqual(before)
  s = press(s, 'right', 'right', 'right', 'a')
  expect(s.cursor).toBe(4)
  expect(s.held[4]).toBe(true)
  s = press(s, 'left', 'left', 'left', 'left', 'left', 'left')
  expect(s.cursor).toBe(0)
})

test('a draw keeps the held cards, takes the rest from the deck, pays and finishes the hand once', () => {
  let s = press(fresh(), 'c: ')
  s = { ...s, hand: hand('9S 9H 3D 4C 6S'), deck: hand('9D 9C 2S 2H 12D'), held: [true, true, false, false, false] }
  s = press(s, 'c: ')
  expect(s.hand.map(x => `${x.rank}${x.suit}`)).toEqual(['9S', '9H', '9D', '9C', '2S'])
  expect(s.result).toBe('four')
  expect(s.won).toBe(25)
  expect(s.chips).toBe(99 + 25)
  expect(s.phase).toBe('done')
  expect(s.deck).toHaveLength(2)
  expect(pokerGame.isOver(s)).toBe(true)
  expect(pokerGame.score(s)).toEqual({ counters: { four: 1 }, bests: { win: { value: 25 } } })
  expect(pokerGame.score({ ...s, recorded: true })).toBeUndefined()
  const rigged = { ...s, phase: 'hold' as const, hand: hand('2S 5H 9D 12C 1S'), deck: hand('3D 4D 6D 7C 8H'), held: [false, false, false, false, false], bet: 1, chips: 10, result: undefined, won: 0 }
  const lost = press(rigged, 'c:d')
  expect(lost.result).toBe('nothing')
  expect(pokerGame.score(lost)?.counters).toEqual({})
  const next = press(s, 'c:d')
  expect(next.phase).toBe('hold')
  expect(next.recorded).toBe(false)
})

test('a deal with no chips is refused and a rebuy works only when broke and never mid-hand', () => {
  const broke = fresh(0)
  const refused = press(broke, 'c: ')
  expect(refused.phase).toBe('bet')
  expect(refused.note).toContain('Out of chips')
  expect(press(fresh(10), 'c:r').chips).toBe(10)
  const bought = press(broke, 'c:r')
  expect(bought.chips).toBe(500)
  expect(bought.note).toBe('Rebought 500')
  const hold = { ...broke, phase: 'hold' as const, hand: hand('2S 5H 9D 12C 1S'), held: [false, false, false, false, false] }
  expect(press(hold, 'c:r')).toBe(hold)
})

test('keys with no meaning return the same state', () => {
  const s = fresh()
  for (const k of ['start', 'b', 'c:z', 'c:1', 'tap:3:2', 'left'] as Key[]) expect(press(s, k)).toBe(s)
  const h = press(s, 'c: ')
  for (const k of ['start', 'b', 'c:z', 'c:9', 'up', 'down', 'c:b'] as Key[]) expect(press(h, k)).toBe(h)
})

test('the board fits 32 columns with one paytable column and 60 with five', () => {
  const s = press(fresh(1234), 'c: ')
  const narrow = text(pokerGame.view(s, 32, 30).board)
  for (const line of narrow) expect(line.length).toBeLessThanOrEqual(32)
  expect(narrow[0]).toContain('Credits 1,233')
  expect(narrow[2]).toHaveLength(30)
  expect(narrow.length).toBe(6 + PAID.length)
  const wide = text(pokerGame.view(s, 60, 30).board)
  expect(wide[6]).toContain('4000')
  for (const line of wide) expect(line.length).toBeLessThanOrEqual(46)
  expect(wide[6]).not.toBe(narrow[6])
  const dealt = pokerGame.view({ ...s, held: [true, false, false, false, false] }, 40, 30)
  expect(text(dealt.board)[3]).toContain('HELD')
  expect(dealt.controls?.map(x => x.hotkey)).toEqual(['1', '2', '3', '4', '5', 'd'])
})

test('the finished hand shows its rank on the result row and marks the paytable row', () => {
  let s = press(fresh(), 'c: ')
  s = { ...s, hand: hand('9S 9H 9D 9C 2S'), deck: [], held: [true, true, true, true, true] }
  s = press(s, 'c:d')
  const v = pokerGame.view(s, 60, 30)
  expect(text(v.board)[5]).toContain('FOUR OF A KIND  +25')
  expect(v.board[6 + PAID.indexOf('four')]?.some(x => x.inverse)).toBe(true)
  expect(v.controls?.map(x => x.hotkey)).toEqual(['b', 'm', 'd'])
})

test('the hotkeys of the card games are unique and a typed hotkey maps to its button', () => {
  for (const g of [pokerGame, blackjackGame, unoGame]) {
    const keys = [...g.controls, ...SHELL_CONTROLS].map(x => x.hotkey).filter((k): k is string => !!k)
    for (const k of keys) expect(/^[0-9a-z]$/.test(k)).toBe(true)
    expect(new Set(keys).size).toBe(keys.length)
    for (const ctl of g.controls) if (ctl.hotkey) expect(mapClientKey(ctl.hotkey, g.keyboard)).toBe(ctl.key)
  }
})
