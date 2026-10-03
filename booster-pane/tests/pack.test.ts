import { expect, test } from 'claude-code/testing'

import type { BoosterCard } from '../types'
import { SHAPES, TIER_COLOR, eraOf, isBigHit, isHit, isExcluded, tierColor, tierOf } from '../hooks/eras'
import { buildPack, fnv1a, seedFor } from '../hooks/pack'

const set = (id: string, series: string, name = 'Testmon Set', date = '2020-01-01', total = 100) => ({ id, name, series, releaseDate: date, total })

/** Synthetic cards: `n` of each rarity, ids `<tag>-<i>`. */
function cards(spec: Record<string, number>): BoosterCard[] {
  const out: BoosterCard[] = []
  let i = 0
  for (const [rarity, n] of Object.entries(spec)) {
    for (let k = 0; k < n; k++) {
      i += 1
      out.push({ id: `t-${i}`, name: `Testmon ${i}`, number: String(i), rarity, supertype: 'Pokémon', image: `https://assets.tcgdex.net/t/${i}` })
    }
  }
  return out
}

test('eraOf by series, year, promo and mini rules', () => {
  expect(eraOf(set('base1', 'Base', 'Base Set', '1999-01-09', 102))).toBe('classic')
  expect(eraOf(set('neo1', 'Neo'))).toBe('classic')
  expect(eraOf(set('ecard1', 'E-Card'))).toBe('classic')
  expect(eraOf(set('ex1', 'EX'))).toBe('ex-dp')
  expect(eraOf(set('dp1', 'Diamond & Pearl'))).toBe('ex-dp')
  expect(eraOf(set('col1', 'Call of Legends'))).toBe('ex-dp')
  expect(eraOf(set('bw1', 'Black & White'))).toBe('bw-xy')
  expect(eraOf(set('xy1', 'XY'))).toBe('bw-xy')
  expect(eraOf(set('sm1', 'Sun & Moon'))).toBe('sm-swsh')
  expect(eraOf(set('swsh1', 'Sword & Shield'))).toBe('sm-swsh')
  expect(eraOf(set('sv01', 'Scarlet & Violet'))).toBe('sv')
  expect(eraOf(set('me01', 'Mega Evolution'))).toBe('sv')
  // unknown series fall back by year
  expect(eraOf(set('x1', 'Mystery', 'X', '2001-05-01'))).toBe('classic')
  expect(eraOf(set('x2', 'Mystery', 'X', '2008-05-01'))).toBe('ex-dp')
  expect(eraOf(set('x3', 'Mystery', 'X', '2014-05-01'))).toBe('bw-xy')
  expect(eraOf(set('x4', 'Mystery', 'X', '2020-05-01'))).toBe('sm-swsh')
  expect(eraOf(set('x5', 'Mystery', 'X', '2024-05-01'))).toBe('sv')
  // promos by name or by rarity
  expect(eraOf(set('svp', 'Scarlet & Violet', 'SVP Black Star Promos', '2023-03-31', 200))).toBe('promo')
  expect(eraOf(set('zz', 'Other', 'Odd Set'), cards({ Promo: 10 }))).toBe('promo')
  expect(eraOf(set('zz', 'Sword & Shield', 'Odd Set'), cards({ Promo: 9, Common: 1 }))).toBe('promo')
  expect(eraOf(set('zz', 'Sword & Shield', 'Odd Set'), cards({ Promo: 8, Common: 2 }))).toBe('sm-swsh')
  // mini by size, series or id
  expect(eraOf(set('sm9', 'Sun & Moon', 'Tiny', '2018-01-01', 12))).toBe('mini')
  expect(eraOf(set('pop1', 'POP', 'POP Series 1', '2004-01-01', 17))).toBe('mini')
  expect(eraOf(set('swsh12pt5gg', 'Sword & Shield', 'Crown Zenith Galarian Gallery', '2023-01-20', 70))).toBe('mini')
  expect(eraOf(set('tk-1', 'Other', 'Trainer Kit', '2008-01-01', 60))).toBe('mini')
  expect(isExcluded({ series: 'Pokémon TCG Pocket', name: 'Genetic Apex' })).toBe(true)
  expect(isExcluded({ series: 'Base', name: 'Base Set' })).toBe(false)
})

test('tierOf covers both sources lists and the fallbacks', () => {
  const table: Record<string, string> = {
    Common: 'common', None: 'common', '': 'common', Uncommon: 'uncommon', Rare: 'rare', 'Rare Holo': 'holo', 'Holo Rare': 'holo',
    'Rare Holo EX': 'ex', 'Rare Holo GX': 'ex', 'Rare Holo V': 'ex', 'Holo Rare V': 'ex', 'Rare Holo LV.X': 'ex', 'Rare PRIME': 'ex',
    'Double rare': 'ex', 'Double Rare': 'ex', 'Rare BREAK': 'ex', LEGEND: 'ex', 'Rare ACE': 'ex',
    'Rare Holo VMAX': 'vmax', 'Rare Holo VSTAR': 'vmax', 'Holo Rare VMAX': 'vmax', 'Holo Rare VSTAR': 'vmax',
    'Rare Ultra': 'ultra', 'Ultra Rare': 'ultra', 'Full Art Trainer': 'ultra', MEGA_ATTACK_RARE: 'ultra',
    'Illustration Rare': 'illustration', 'Illustration rare': 'illustration', 'Trainer Gallery Rare Holo': 'illustration',
    'Amazing Rare': 'special', 'Radiant Rare': 'special', 'ACE SPEC Rare': 'special', 'Rare Prism Star': 'special',
    'Rare Shining': 'special', 'Rare Shiny': 'special', 'Shiny rare': 'special', 'Shiny rare V': 'special', 'Shiny rare VMAX': 'special',
    'Classic Collection': 'special', 'Black White Rare': 'special', 'Pikachu Rare': 'special', 'Futuristic Rare': 'special',
    'Special Illustration Rare': 'sir', 'Special illustration rare': 'sir',
    'Rare Secret': 'secret', 'Secret Rare': 'secret', 'Rare Rainbow': 'secret', 'Hyper Rare': 'secret', 'Hyper rare': 'secret',
    'Mega Hyper Rare': 'secret', 'Rare Shiny GX': 'secret', 'Shiny Ultra Rare': 'secret', 'Rare Holo Star': 'secret',
    Promo: 'promo',
  }
  for (const [rarity, tier] of Object.entries(table)) expect(tierOf(rarity), rarity).toBe(tier)
  expect(tierOf('Brand New Secret Thing')).toBe('secret')
  expect(tierOf('Mystery Illustration')).toBe('illustration')
  expect(tierOf('Mystery Ultra')).toBe('ultra')
  expect(tierOf('Mystery Holo')).toBe('holo')
  expect(tierOf('Mystery Rare')).toBe('rare')
  expect(tierOf('???')).toBe('common')
  expect(tierOf(null)).toBe('common')
  expect(tierOf(undefined)).toBe('common')
})

test('colours, hits and big hits', () => {
  expect(tierColor('common')).toBe('#9AA0A6')
  expect(tierColor('secret')).toBe('#FFD700')
  expect(Object.keys(TIER_COLOR)).toHaveLength(12)
  expect(isHit('uncommon')).toBe(false)
  expect(isHit('rare')).toBe(true)
  expect(isHit('promo')).toBe(true)
  expect(isBigHit('holo')).toBe(false)
  expect(isBigHit('ex')).toBe(true)
  expect(isBigHit('secret')).toBe(true)
})

const CLASSIC = cards({ Common: 20, Uncommon: 15, Rare: 10, 'Rare Holo': 16 })

test('a classic pack is 7 commons, 3 uncommons and a rare slot; the same seed gives the same pack', () => {
  const a = buildPack({ id: 'base1' }, CLASSIC, 'classic', 42)
  expect(a.cards).toHaveLength(11)
  expect(a.cards.slice(0, 7).every(c => c.slot === 'common' && c.tier === 'common')).toBe(true)
  expect(a.cards.slice(7, 10).every(c => c.slot === 'uncommon' && c.tier === 'uncommon')).toBe(true)
  expect(a.cards[10]?.slot).toBe('rare')
  expect(['rare', 'holo']).toContain(a.cards[10]?.tier)
  expect(new Set(a.cards.slice(0, 7).map(c => c.id)).size).toBe(7)
  expect(buildPack({ id: 'base1' }, CLASSIC, 'classic', 42)).toEqual(a)
  expect(buildPack({ id: 'base1' }, CLASSIC, 'classic', 43).cards.map(c => c.id)).not.toEqual(a.cards.map(c => c.id))
})

test('the classic holo rate over 3,000 seeds is near a third', () => {
  let holos = 0
  for (let seed = 1; seed <= 3000; seed++) {
    if (buildPack({ id: 'base1' }, CLASSIC, 'classic', seed * 7919).cards[10]?.tier === 'holo') holos++
  }
  const rate = holos / 3000
  expect(rate).toBeGreaterThan(0.28)
  expect(rate).toBeLessThan(0.39)
})

const SV = cards({
  Common: 30, Uncommon: 25, Rare: 12, 'Double rare': 10, 'Ultra Rare': 6, 'Illustration rare': 8, 'Special illustration rare': 6,
  'Hyper rare': 4, 'ACE SPEC Rare': 3,
})

test('an SV pack has 10 cards in slot order; double rares and the hit reverse land near their rates', () => {
  const first = buildPack({ id: 'sv01' }, SV, 'sv', 5)
  expect(first.cards.map(c => c.slot)).toEqual([
    'common', 'common', 'common', 'common', 'uncommon', 'uncommon', 'uncommon', 'reverse', 'hitReverse', 'rare',
  ])
  let doubles = 0
  let ir = 0
  let sir = 0
  let hr = 0
  const n = 5000
  for (let seed = 1; seed <= n; seed++) {
    const p = buildPack({ id: 'sv01' }, SV, 'sv', seed * 104729)
    if (p.cards[9]?.tier === 'ex') doubles++
    const h = p.cards[8]
    if (h?.tier === 'illustration') ir++
    if (h?.tier === 'sir') sir++
    if (h?.tier === 'secret') hr++
  }
  expect(Math.abs(doubles / n - 1 / 7)).toBeLessThan(0.03)
  expect(Math.abs(ir / n - 1 / 13)).toBeLessThan(0.02)
  expect(Math.abs(sir / n - 1 / 32)).toBeLessThan(0.015)
  expect(Math.abs(hr / n - 1 / 54)).toBeLessThan(0.012)
})

test('a missing tier folds into the base outcome', () => {
  const plain = cards({ Common: 20, Uncommon: 15, Rare: 10, 'Double rare': 4 })
  for (let seed = 1; seed <= 400; seed++) {
    const p = buildPack({ id: 'sv01' }, plain, 'sv', seed * 31)
    expect(p.cards).toHaveLength(10)
    expect(p.cards[8]?.tier === 'illustration' || p.cards[8]?.tier === 'sir' || p.cards[8]?.tier === 'secret').toBe(false)
    expect(['rare', 'ex']).toContain(p.cards[9]?.tier)
  }
  // no uncommons: the uncommon slots draw commons
  const noU = cards({ Common: 20, Rare: 5 })
  const p = buildPack({ id: 'x' }, noU, 'bw-xy', 9)
  expect(p.cards).toHaveLength(10)
  expect(p.cards.filter(c => c.slot === 'uncommon').every(c => c.tier === 'common')).toBe(true)
  // an SV pack with no hyper rares never has one even over many seeds
  for (let seed = 1; seed <= 400; seed++) {
    expect(buildPack({ id: 'sv01' }, plain, 'sv', seed).cards.some(c => c.tier === 'secret')).toBe(false)
  }
})

test('small sets give a mini pack and promos a single card', () => {
  const energy = cards({ Common: 8 })
  const mini = buildPack({ id: 'tk' }, energy, 'mini', 3)
  expect(mini.cards).toHaveLength(4)
  expect(new Set(mini.cards.map(c => c.id)).size).toBe(4)
  const two = buildPack({ id: 'tk' }, cards({ Common: 2 }), 'mini', 3)
  expect(two.cards).toHaveLength(2)
  const promo = buildPack({ id: 'svp' }, cards({ Promo: 30 }), 'promo', 3)
  expect(promo.cards).toHaveLength(1)
  expect(promo.cards[0]?.isHit).toBe(true)
  expect(buildPack({ id: 'e' }, [], 'sv', 1).cards).toEqual([])
  // a mini pack with hits shows one about a third of the time
  const hits = cards({ Common: 10, 'Rare Holo': 5 })
  let withHit = 0
  for (let seed = 1; seed <= 1500; seed++) {
    if (buildPack({ id: 'm' }, hits, 'mini', seed * 17).cards.some(c => c.isHit)) withHit++
  }
  expect(withHit / 1500).toBeGreaterThan(0.3)
})

test('shape table sizes and the seed function', () => {
  const size = (e: keyof typeof SHAPES) => SHAPES[e].commons + SHAPES[e].uncommons + SHAPES[e].reverses + (SHAPES[e].hitReverse.length > 0 ? 1 : 0) + 1
  expect([size('classic'), size('ex-dp'), size('bw-xy'), size('sm-swsh'), size('sv')]).toEqual([11, 10, 10, 10, 10])
  expect(fnv1a('base1')).toBe(fnv1a('base1'))
  expect(fnv1a('base1')).not.toBe(fnv1a('base2'))
  expect(seedFor(1000, 'base1', 1)).toBe(seedFor(1000, 'base1', 1))
  expect(seedFor(1000, 'base1', 1)).not.toBe(seedFor(1000, 'base1', 2))
  expect(seedFor(1000, 'base1', 1)).toBeGreaterThanOrEqual(0)
})
