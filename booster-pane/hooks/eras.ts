// Eras, rarity tiers and the approximate slot odds of a pack. Pure: no `$`.

import type { BoosterEra, BoosterSet, BoosterTier } from '../types'

// ---------- eras ----------

type SetLike = Pick<BoosterSet, 'id' | 'name' | 'series' | 'releaseDate' | 'total'>

/** TCG Pocket sets are digital only: the mod leaves them out of the catalog. */
export function isExcluded(set: Pick<BoosterSet, 'series' | 'name'>): boolean {
  return /pocket/i.test(set.series)
}

const MINI_IDS = new Set(['swsh9tg', 'swsh12pt5gg', 'swsh45sv', 'cel25c', 'sve', 'si1', 'ru1', 'fut20', 'bp'])
const MINI_SERIES = /^(pop|other|miscellaneous|trainer kits?|mcdonald.*)$/i

const SERIES: [RegExp, BoosterEra][] = [
  [/^(base|gym|neo|e-?card|legendary collection)$/i, 'classic'],
  [/^(ex|diamond (&|and) pearl|platinum|heartgold (&|and) soulsilver|call of legends)$/i, 'ex-dp'],
  [/^(black (&|and) white|xy)$/i, 'bw-xy'],
  [/^(sun (&|and) moon|sword (&|and) shield)$/i, 'sm-swsh'],
  [/^(scarlet (&|and) violet|mega evolution)$/i, 'sv'],
]

/** The era a set's packs are built in. `cards` (when known) lets a set of mostly promos be spotted by its rarities. */
export function eraOf(set: SetLike, cards?: readonly { rarity: string }[]): BoosterEra {
  if (/promos?/i.test(set.name)) return 'promo'
  if (cards && cards.length > 0 && cards.filter(c => c.rarity.trim().toLowerCase() === 'promo').length / cards.length >= 0.9) return 'promo'
  if (set.total < 40 || MINI_IDS.has(set.id) || /^tk/i.test(set.id) || MINI_SERIES.test(set.series)) return 'mini'
  if (set.id === 'col1' || set.id === 'base6') return set.id === 'col1' ? 'ex-dp' : 'classic'
  for (const [pattern, era] of SERIES) if (pattern.test(set.series.trim())) return era
  const year = Number.parseInt(set.releaseDate.slice(0, 4), 10)
  if (!Number.isFinite(year)) return 'sv'
  if (year < 2003) return 'classic'
  if (year < 2011) return 'ex-dp'
  if (year < 2017) return 'bw-xy'
  if (year < 2023) return 'sm-swsh'
  return 'sv'
}

export const ERA_LABEL: Record<BoosterEra, string> = {
  classic: 'WotC',
  'ex-dp': 'EX–HGSS',
  'bw-xy': 'BW–XY',
  'sm-swsh': 'SM–SWSH',
  sv: 'SV–ME',
  mini: 'mini set',
  promo: 'promo',
}

/** The eras the Sets screen offers a random pick from. */
export const RANDOM_ERAS: BoosterEra[] = ['classic', 'ex-dp', 'bw-xy', 'sm-swsh', 'sv']

// ---------- tiers ----------

const TIER_OF: Record<string, BoosterTier> = {}
const add = (tier: BoosterTier, names: string[]) => {
  for (const name of names) TIER_OF[name] = tier
}
add('common', ['common', 'none', ''])
add('uncommon', ['uncommon'])
add('rare', ['rare'])
add('holo', ['rare holo', 'holo rare'])
add('ex', [
  'rare holo ex', 'rare holo gx', 'rare holo v', 'holo rare v', 'rare holo lv.x', 'rare prime',
  'double rare', 'rare break', 'legend', 'rare ace',
])
add('vmax', ['rare holo vmax', 'rare holo vstar', 'holo rare vmax', 'holo rare vstar'])
add('ultra', ['rare ultra', 'ultra rare', 'full art trainer', 'mega_attack_rare'])
add('illustration', ['illustration rare', 'trainer gallery rare holo'])
add('special', [
  'amazing rare', 'radiant rare', 'ace spec rare', 'rare prism star', 'rare shining', 'rare shiny', 'shiny rare',
  'shiny rare v', 'shiny rare vmax', 'classic collection', 'black white rare', 'pikachu rare', 'futuristic rare',
])
add('sir', ['special illustration rare'])
add('secret', [
  'rare secret', 'secret rare', 'rare rainbow', 'hyper rare', 'mega hyper rare', 'rare shiny gx', 'shiny ultra rare',
  'rare holo star',
])
add('promo', ['promo'])

/** The tier of a source's rarity text; unknown text falls back by the words it holds. */
export function tierOf(rarity: string | null | undefined): BoosterTier {
  const key = (rarity ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  const known = TIER_OF[key]
  if (known) return known
  if (/secret|hyper/.test(key)) return 'secret'
  if (/illustration/.test(key)) return 'illustration'
  if (/ultra/.test(key)) return 'ultra'
  if (/holo/.test(key)) return 'holo'
  if (/rare/.test(key)) return 'rare'
  return 'common'
}

export const TIER_RANK: Record<BoosterTier, number> = {
  common: 0, uncommon: 1, rare: 2, promo: 2, holo: 3, ex: 4, vmax: 5, special: 5, illustration: 6, ultra: 6, sir: 7, secret: 8,
}

export const TIER_COLOR: Record<BoosterTier, string> = {
  common: '#9AA0A6', uncommon: '#5FA8D3', rare: '#E6E6E6', holo: '#F2C14E', ex: '#F28C28', vmax: '#E85D75',
  special: '#00C2C7', illustration: '#4CC9A0', ultra: '#C77DFF', sir: '#FF5DA2', secret: '#FFD700', promo: '#B0B7C3',
}

export const TIER_LABEL: Record<BoosterTier, string> = {
  common: 'Common', uncommon: 'Uncommon', rare: 'Rare', holo: 'Rare Holo', ex: 'Holo ex/V', vmax: 'VMAX/VSTAR',
  special: 'Special', illustration: 'Illustration Rare', ultra: 'Ultra Rare', sir: 'Special Illustration Rare',
  secret: 'Secret Rare', promo: 'Promo',
}

export const tierColor = (tier: BoosterTier): string => TIER_COLOR[tier]

/** Rare or better: a card worth a second look. */
export const isHit = (tier: BoosterTier): boolean => TIER_RANK[tier] >= 2

/** Worth the sparkle row. */
export const isBigHit = (tier: BoosterTier): boolean => TIER_RANK[tier] >= 4

// ---------- pack shapes (all odds approximate) ----------

/** A band of the rare slot: the chance of this tier, checked in order, the rest falling to the base tier. */
export type Band = { tier: BoosterTier; p: number }

export type EraShape = {
  commons: number
  uncommons: number
  /** Plain reverse-holo slots, in reveal order. */
  reverses: number
  /** A reverse slot that may hit (illustration, special illustration, hyper). */
  hitReverse: Band[]
  /** The first reverse slot's chance of a `special` card, when the set has one. */
  reverseSpecial: number
  /** The rare slot's bands. */
  rare: Band[]
}

export const SHAPES: Record<'classic' | 'ex-dp' | 'bw-xy' | 'sm-swsh' | 'sv', EraShape> = {
  // https://flipsidegaming.com/blogs/pokemon-blog/a-comprehensive-review-of-rarity-in-the-pokemon-tcg
  classic: { commons: 7, uncommons: 3, reverses: 0, hitReverse: [], reverseSpecial: 0, rare: [{ tier: 'holo', p: 1 / 3 }] },
  'ex-dp': {
    commons: 5, uncommons: 3, reverses: 1, hitReverse: [], reverseSpecial: 0,
    rare: [{ tier: 'ex', p: 1 / 12 }, { tier: 'secret', p: 1 / 72 }, { tier: 'holo', p: 1 / 3 }],
  },
  'bw-xy': {
    commons: 5, uncommons: 3, reverses: 1, hitReverse: [], reverseSpecial: 0,
    rare: [{ tier: 'ex', p: 1 / 9 }, { tier: 'ultra', p: 1 / 36 }, { tier: 'secret', p: 1 / 72 }, { tier: 'holo', p: 1 / 4 }],
  },
  // https://www.digitaltq.com/brilliant-stars-pull-rates-pokemon-tcg
  'sm-swsh': {
    commons: 5, uncommons: 3, reverses: 1, hitReverse: [], reverseSpecial: 1 / 20,
    rare: [{ tier: 'ex', p: 1 / 7 }, { tier: 'vmax', p: 1 / 18 }, { tier: 'ultra', p: 1 / 36 }, { tier: 'secret', p: 1 / 72 }, { tier: 'holo', p: 1 / 4 }],
  },
  // https://www.tcgplayer.com/content/article/Pok%C3%A9mon-TCG-Scarlet-Violet-Pull-Rates/a7702fce-dd64-4a58-beb1-0f871c853215/
  sv: {
    commons: 4, uncommons: 3, reverses: 1, reverseSpecial: 1 / 20,
    hitReverse: [{ tier: 'illustration', p: 1 / 13 }, { tier: 'sir', p: 1 / 32 }, { tier: 'secret', p: 1 / 54 }],
    rare: [{ tier: 'ex', p: 1 / 7 }, { tier: 'ultra', p: 1 / 15 }],
  },
}

/** How many cards a pack of this era holds in a set of `size` cards. */
export function packSize(era: BoosterEra, size: number): number {
  if (era === 'promo') return Math.min(1, size)
  if (era === 'mini') return Math.min(4, size)
  const shape = SHAPES[era]
  return shape.commons + shape.uncommons + shape.reverses + (shape.hitReverse.length > 0 ? 1 : 0) + 1
}
