// Builds a pack from a set's cards: slots by era, rarity odds approximate. Pure: no `$`.

import type { BoosterCard, BoosterEra, BoosterPackCard, BoosterSet, BoosterSlot, BoosterTier } from '../types'
import { SHAPES, TIER_RANK, isHit, tierOf, type Band } from './eras'
import { int, next } from './rng'

type Tiered = BoosterCard & { tier: BoosterTier }

/** FNV-1a of a string, 32 bits. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** The seed a pack is built from: the time, the set and which pack of the session it is. */
export const seedFor = (now: number, setId: string, packNo: number): number =>
  (now ^ fnv1a(setId) ^ Math.imul(packNo, 0x9e3779b1)) >>> 0

type Out = { card: Tiered; slot: BoosterSlot; isReverse: boolean }

/** A draw context: the generator state moves with every draw. */
class Draw {
  s: number
  constructor(seed: number) {
    this.s = seed | 0
  }
  /** A number in [0, 1). */
  roll(): number {
    const r = next(this.s)
    this.s = r.s
    return r.v
  }
  /** One of `pool`, not in `used` unless all of it is; the pick joins `used`. */
  take(pool: readonly Tiered[], used: Set<string>): Tiered | undefined {
    if (pool.length === 0) return undefined
    let open = pool.filter(c => !used.has(c.id))
    if (open.length === 0) {
      for (const c of pool) used.delete(c.id)
      open = pool.slice()
    }
    const r = int(this.s, open.length)
    this.s = r.s
    const card = open[r.v] as Tiered
    used.add(card.id)
    return card
  }
}

/** Which band of a slot a roll lands in; undefined for the base outcome. */
export function bandFor(bands: readonly Band[], v: number): BoosterTier | undefined {
  let edge = 0
  for (const band of bands) {
    edge += band.p
    if (v < edge) return band.tier
  }
  return undefined
}

/**
 * A pack of `set`'s cards for `era`, from `seed`: the same seed gives the same pack.
 * Missing tiers fold into the slot's base outcome; empty pools fall back to commons, then any card.
 */
export function buildPack(
  _set: Pick<BoosterSet, 'id'>,
  cards: readonly BoosterCard[],
  era: BoosterEra,
  seed: number,
): { cards: BoosterPackCard[]; seed: number } {
  const tiered: Tiered[] = cards.map(c => ({ ...c, tier: tierOf(c.rarity) }))
  const draw = new Draw(seed)
  const out: Out[] = []
  const finish = (): { cards: BoosterPackCard[]; seed: number } => ({
    seed,
    cards: out.map(({ card, slot, isReverse }) => ({ ...card, slot, isReverse, isHit: isHit(card.tier) })),
  })
  if (tiered.length === 0) return finish()

  const by = (...tiers: BoosterTier[]) => tiered.filter(c => tiers.includes(c.tier))

  if (era === 'promo') {
    const card = draw.take(tiered, new Set())
    if (card) out.push({ card, slot: 'any', isReverse: false })
    return finish()
  }

  if (era === 'mini') {
    const n = Math.min(4, tiered.length)
    const used = new Set<string>()
    const hits = tiered.filter(c => TIER_RANK[c.tier] >= 2)
    const wantHit = hits.length > 0 && draw.roll() < 1 / 3
    const picks: Tiered[] = []
    if (wantHit) {
      const hit = draw.take(hits, used)
      if (hit) picks.push(hit)
    }
    while (picks.length < n) {
      const card = draw.take(tiered, used)
      if (!card) break
      picks.push(card)
    }
    // the hit is revealed last
    const ordered = wantHit ? [...picks.slice(1), picks[0] as Tiered] : picks
    for (const card of ordered) out.push({ card, slot: 'any', isReverse: false })
    return finish()
  }

  const shape = SHAPES[era]
  const commons = by('common')
  const uncommons = by('uncommon')
  const base = by('rare')
  const fallback = (...pools: Tiered[][]): Tiered[] => pools.find(p => p.length > 0) ?? tiered
  const reversePool = by('common', 'uncommon', 'rare', 'holo')

  const commonPool = fallback(commons, uncommons, base, tiered)
  const commonUsed = new Set<string>()
  for (let i = 0; i < shape.commons; i++) {
    const card = draw.take(commonPool, commonUsed)
    if (card) out.push({ card, slot: 'common', isReverse: false })
  }
  const uncommonPool = fallback(uncommons, commons, base, tiered)
  const uncommonUsed = new Set<string>()
  for (let i = 0; i < shape.uncommons; i++) {
    const card = draw.take(uncommonPool, uncommonUsed)
    if (card) out.push({ card, slot: 'uncommon', isReverse: false })
  }

  const reverseUsed = new Set<string>()
  const reverse = (): void => {
    const card = draw.take(fallback(reversePool, commons, tiered), reverseUsed)
    if (card) out.push({ card, slot: 'reverse', isReverse: true })
  }
  for (let i = 0; i < shape.reverses; i++) {
    const specials = by('special')
    if (shape.reverseSpecial > 0 && specials.length > 0 && draw.roll() < shape.reverseSpecial) {
      const card = draw.take(specials, new Set())
      if (card) out.push({ card, slot: 'reverse', isReverse: false })
    } else reverse()
  }
  if (shape.hitReverse.length > 0) {
    const tier = bandFor(shape.hitReverse, draw.roll())
    const pool = tier ? by(tier) : []
    const card = pool.length > 0 ? draw.take(pool, new Set()) : undefined
    if (card) out.push({ card, slot: 'hitReverse', isReverse: false })
    else {
      const plain = draw.take(fallback(reversePool, commons, tiered), reverseUsed)
      if (plain) out.push({ card: plain, slot: 'hitReverse', isReverse: true })
    }
  }

  const rareTier = bandFor(shape.rare, draw.roll())
  const rarePool = rareTier ? by(rareTier) : []
  const baseRare = fallback(base, by('holo'), uncommons, commons, tiered)
  const rare = draw.take(rarePool.length > 0 ? rarePool : baseRare, new Set())
  if (rare) out.push({ card: rare, slot: 'rare', isReverse: false })
  return finish()
}
