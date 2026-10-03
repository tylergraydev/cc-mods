import { expect, test } from 'claude-code/testing'

import { CELL, START_CHIPS, backCell, bankOk, cardCell, cellAtX, deck, fmtChips, handSegs, rebuy, rowOfCells, shoe, shuffleDeck } from '../hooks/cards'
import type { Card } from '../hooks/cards'

const text = (segs: { text: string }[]): string => segs.map(s => s.text).join('')

test('a shoe is the decks in order, a seeded shuffle repeats and another seed differs', () => {
  const six = shoe(6)
  expect(six).toHaveLength(312)
  const seen = new Map<string, number>()
  for (const c of six) seen.set(`${c.rank}${c.suit}`, (seen.get(`${c.rank}${c.suit}`) ?? 0) + 1)
  expect(seen.size).toBe(52)
  for (const n of seen.values()) expect(n).toBe(6)
  expect(shuffleDeck(six, 5).cards).toEqual(shuffleDeck(six, 5).cards)
  expect(shuffleDeck(six, 5).cards).not.toEqual(shuffleDeck(six, 6).cards)
  expect(shoe(1)).toEqual(deck())
})

test('a card cell is exactly five columns, red only for hearts and diamonds', () => {
  for (const c of deck()) {
    const cell = cardCell(c)
    expect(text(cell)).toHaveLength(5)
    const red = c.suit === 'H' || c.suit === 'D'
    expect(cell[0]?.color).toBe(red ? 'red' : undefined)
  }
  expect(text(cardCell({ rank: 10, suit: 'H' }))).toBe('[10♥]')
  expect(text(cardCell({ rank: 1, suit: 'S' }))).toBe('[A♠] ')
  expect(text(backCell())).toHaveLength(5)
  expect(text(backCell())).toBe('[??] ')
})

test('a row of five cells is 30 columns and cellAtX finds the cell under a column', () => {
  const cells = deck().slice(0, 5).map(c => cardCell(c))
  expect(CELL).toBe(6)
  expect(text(rowOfCells(cells))).toHaveLength(30)
  for (const x of [1, 2, 3, 4, 5]) expect(cellAtX(x)).toBe(0)
  expect(cellAtX(6)).toBeUndefined()
  expect(cellAtX(0)).toBeUndefined()
  expect(cellAtX(7)).toBe(1)
  expect(cellAtX(29)).toBe(4)
  expect(cellAtX(31)).toBe(5)
  expect(cellAtX(2, 3)).toBeUndefined()
  expect(cellAtX(3, 3)).toBe(0)
})

test('a seven-card hand stays inside 40 columns, and the chip helpers behave', () => {
  const hand: Card[] = deck().slice(8, 15)
  expect(text(handSegs(hand, 40)[0] ?? []).length).toBeLessThanOrEqual(40)
  expect(fmtChips(1234)).toBe('1,234')
  expect(bankOk(10, 10)).toBe(true)
  expect(bankOk(9, 10)).toBe(false)
  expect(rebuy()).toBe(START_CHIPS)
  expect(START_CHIPS).toBe(500)
})
