import { expect, test } from 'claude-code/testing'

import type { BoosterPackCard } from '../types'
import { addPack, collectionText, compareNumber, emptyCollection, ownedFor, parseCollection, serializeCollection, statsText } from '../hooks/collection'

const card = (id: string, number: string, rarity: string, isReverse = false): BoosterPackCard => ({
  id, name: `Testmon ${number}`, number, rarity, supertype: 'Pokémon', tier: 'common', slot: 'common', isReverse, isHit: false,
})

const PACK = { setId: 'tt1', cards: [card('tt1-4', '4', 'Rare Holo'), card('tt1-10', '10', 'Common'), card('tt1-GG01', 'GG01', 'Rare'), card('tt1-4', '4', 'Rare Holo', true)] }

test('addPack counts cards, reverses, rarities and the pack', () => {
  const col = addPack(emptyCollection(), PACK, 1000)
  expect(col.packs).toEqual({ tt1: 1 })
  expect(col.pulled).toBe(4)
  expect(col.cards['tt1-4']).toMatchObject({ n: 2, rev: 1, first: 1000, setId: 'tt1', name: 'Testmon 4' })
  expect(col.rarities).toEqual({ 'Rare Holo': 2, Common: 1, Rare: 1 })
  const again = addPack(col, { setId: 'tt1', cards: [card('tt1-10', '10', 'Common')] }, 2000)
  expect(again.cards['tt1-10']).toMatchObject({ n: 2, first: 1000 })
  expect(again.packs.tt1).toBe(2)
  // the first collection is untouched
  expect(col.packs.tt1).toBe(1)
})

test('ownedFor sorts numbers numerically', () => {
  const owned = ownedFor(addPack(emptyCollection(), PACK, 1), 'tt1')
  expect(owned.cards.map(c => c.number)).toEqual(['4', '10', 'GG01'])
  expect(owned).toMatchObject({ setId: 'tt1', packs: 1, pulled: 4 })
  expect(ownedFor(emptyCollection(), 'none').cards).toEqual([])
  expect(['10', 'GG01', '4', 'TG2', 'TG10'].sort(compareNumber)).toEqual(['4', '10', 'GG01', 'TG2', 'TG10'])
})

test('a collection round-trips and a corrupt file is refused', () => {
  const col = addPack(emptyCollection(), PACK, 5)
  expect(parseCollection(serializeCollection(col))).toEqual(col)
  expect(parseCollection('{ nope')).toBeUndefined()
  expect(parseCollection('{"v":2}')).toBeUndefined()
  expect(parseCollection('[]')).toBeUndefined()
})

test('stats and collection text', () => {
  expect(statsText(emptyCollection())).toContain('No packs opened yet')
  let col = addPack(emptyCollection(), PACK, 1)
  col = addPack(col, { setId: 'other', cards: [card('o-1', '1', 'Common')] }, 2)
  col = addPack(col, PACK, 3)
  const stats = statsText(col, { tt1: 'Testmon Set', other: 'Other' }).split('\n')
  expect(stats[0]).toBe('Packs opened: 3 (Testmon Set 2, Other 1)')
  expect(stats[1]).toBe('Cards pulled: 9 · 4 distinct')
  expect(stats[2]).toBe('Hits: Rare Holo 4 · Rare 2')

  const text = collectionText(ownedFor(col, 'tt1'), 'Testmon Set', 102).split('\n')
  expect(text[0]).toBe('Testmon Set: 3/102 · 8 pulled · 2 packs')
  expect(text[1]).toBe('#4 Testmon 4 (Rare Holo) ×4')
  expect(text[3]).toBe('#GG01 Testmon GG01 (Rare) ×2')
  expect(collectionText(ownedFor(emptyCollection(), 'x'), 'X')).toBe('X: nothing pulled yet.')

  // 80 lines at most
  const big = emptyCollection()
  for (let i = 1; i <= 100; i++) big.cards[`s-${i}`] = { n: 1, rev: 0, first: 0, setId: 's', name: `T${i}`, number: String(i), rarity: '' }
  const lines = collectionText(ownedFor(big, 's'), 'S').split('\n')
  expect(lines).toHaveLength(82)
  expect(lines[81]).toBe('…and 20 more')
})
