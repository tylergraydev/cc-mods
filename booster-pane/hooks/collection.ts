// The collection: what every pack has pulled, kept in run/collection.json. Pure: no `$`.

import type { BoosterOwned, BoosterPack } from '../types'

export type CollectionCard = { n: number; rev: number; first: number; setId: string; name: string; number: string; rarity: string }

export type Collection = {
  v: 1
  cards: Record<string, CollectionCard>
  packs: Record<string, number>
  rarities: Record<string, number>
  pulled: number
  updatedAt: number
}

export const emptyCollection = (): Collection => ({ v: 1, cards: {}, packs: {}, rarities: {}, pulled: 0, updatedAt: 0 })

/** A size above which the pane warns that the file has grown large. */
export const COLLECTION_WARN_BYTES = 3_500_000

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0)

/** The collection a file holds; undefined when the text is not one (corrupt). */
export function parseCollection(text: string): Collection | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.cards) || !isRecord(raw.packs) || !isRecord(raw.rarities)) return undefined
  const col = emptyCollection()
  for (const [id, one] of Object.entries(raw.cards)) {
    if (!isRecord(one)) continue
    col.cards[id] = {
      n: count(one.n), rev: count(one.rev), first: count(one.first), setId: String(one.setId ?? ''),
      name: String(one.name ?? ''), number: String(one.number ?? ''), rarity: String(one.rarity ?? ''),
    }
  }
  for (const [id, n] of Object.entries(raw.packs)) col.packs[id] = count(n)
  for (const [id, n] of Object.entries(raw.rarities)) col.rarities[id] = count(n)
  col.pulled = count(raw.pulled)
  col.updatedAt = count(raw.updatedAt)
  return col
}

export const serializeCollection = (col: Collection): string => JSON.stringify(col)

/** The collection after one more pack: every card counted when the pack opens. */
export function addPack(col: Collection, pack: Pick<BoosterPack, 'setId' | 'cards'>, now: number): Collection {
  const next: Collection = { ...col, cards: { ...col.cards }, packs: { ...col.packs }, rarities: { ...col.rarities } }
  next.packs[pack.setId] = (next.packs[pack.setId] ?? 0) + 1
  for (const card of pack.cards) {
    const held = next.cards[card.id]
    next.cards[card.id] = held
      ? { ...held, n: held.n + 1, rev: held.rev + (card.isReverse ? 1 : 0) }
      : { n: 1, rev: card.isReverse ? 1 : 0, first: now, setId: pack.setId, name: card.name, number: card.number, rarity: card.rarity }
    const label = card.rarity || 'Common'
    next.rarities[label] = (next.rarities[label] ?? 0) + 1
    next.pulled += 1
  }
  next.updatedAt = now
  return next
}

/** Numeric-aware: "4" before "10" before "GG01". */
export function compareNumber(a: string, b: string): number {
  const na = /^\d+/.exec(a)
  const nb = /^\d+/.exec(b)
  if (na && nb) {
    const d = Number(na[0]) - Number(nb[0])
    return d !== 0 ? d : a.localeCompare(b)
  }
  if (na) return -1
  if (nb) return 1
  return a.localeCompare(b, 'en', { numeric: true })
}

/** What one set holds, in number order. */
export function ownedFor(col: Collection, setId: string): BoosterOwned {
  const cards = Object.entries(col.cards)
    .filter(([, c]) => c.setId === setId)
    .map(([id, c]) => ({ id, name: c.name, number: c.number, rarity: c.rarity, n: c.n, rev: c.rev }))
    .sort((a, b) => compareNumber(a.number, b.number))
  return { setId, packs: col.packs[setId] ?? 0, pulled: cards.reduce((sum, c) => sum + c.n, 0), cards }
}

/** The `stats` command's text. `names` maps set ids to their names. */
export function statsText(col: Collection, names: Readonly<Record<string, string>> = {}): string {
  const opened = Object.entries(col.packs).sort((a, b) => b[1] - a[1])
  const total = opened.reduce((sum, [, n]) => sum + n, 0)
  if (total === 0) return 'No packs opened yet. /booster set <name>, then /booster open.'
  const list = opened.slice(0, 6).map(([id, n]) => `${names[id] ?? id} ${n}`).join(', ')
  const hits = Object.entries(col.rarities)
    .filter(([rarity]) => !/^(common|uncommon|none)$/i.test(rarity))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([rarity, n]) => `${rarity} ${n}`)
  return [
    `Packs opened: ${total} (${list}${opened.length > 6 ? ', …' : ''})`,
    `Cards pulled: ${col.pulled} · ${Object.keys(col.cards).length} distinct`,
    `Hits: ${hits.length > 0 ? hits.join(' · ') : 'none yet'}`,
  ].join('\n')
}

/** The `collection` command's text for one set, at most 80 card lines. */
export function collectionText(owned: BoosterOwned, setName: string, setTotal?: number): string {
  if (owned.cards.length === 0) return `${setName}: nothing pulled yet.`
  const head = `${setName}: ${owned.cards.length}${setTotal ? `/${setTotal}` : ''} · ${owned.pulled} pulled · ${owned.packs} ${owned.packs === 1 ? 'pack' : 'packs'}`
  const lines = owned.cards.slice(0, 80).map(c => `#${c.number} ${c.name}${c.rarity ? ` (${c.rarity})` : ''}${c.n > 1 ? ` ×${c.n}` : ''}`)
  const more = owned.cards.length - lines.length
  return [head, ...lines, ...(more > 0 ? [`…and ${more} more`] : [])].join('\n')
}
