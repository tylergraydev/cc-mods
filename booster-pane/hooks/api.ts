// URL builders, parsers, paging and the retry policy for the two card sources. Pure: no `$`;
// the network arrives as an Io of closures. The API key appears only in the headers a builder returns.

import type { BoosterCard, BoosterSet, BoosterSource } from '../types'
import { isExcluded } from './eras'

export type Reply = { status: number; text: string }

/** What the register module hands over: a request that never throws (status 0 is a network failure or a timeout). */
export type Io = {
  get: (url: string, headers?: Record<string, string>) => Promise<Reply>
  post: (url: string, body: string, headers?: Record<string, string>) => Promise<Reply>
  wait: (ms: number) => Promise<void>
}

export const TCGDEX_GRAPHQL = 'https://api.tcgdex.net/v2/graphql'
export const TCGDEX_QUERY = '{ sets { id name releaseDate serie { id name } cardCount { total official } } }'
export const PTCG_SETS_URL =
  'https://api.pokemontcg.io/v2/sets?pageSize=250&orderBy=releaseDate&select=id,name,series,printedTotal,total,releaseDate'
export const PTCG_PAGE_SIZE = 250
export const PTCG_MAX_PAGES = 10
export const USER_AGENT = 'booster-pane/0.1 (personal card viewer)'

/** TCGdex's rarity names (Pocket rarities left out), commonest first so a set is complete early. */
export const TCGDEX_RARITIES = [
  'Common', 'Uncommon', 'Rare', 'Rare Holo', 'Holo Rare', 'None', 'Double rare', 'Ultra Rare', 'Illustration rare',
  'Special illustration rare', 'Hyper rare', 'Secret Rare', 'Promo', 'Holo Rare V', 'Holo Rare VMAX', 'Holo Rare VSTAR',
  'Rare Holo LV.X', 'Rare PRIME', 'LEGEND', 'ACE SPEC Rare', 'Amazing Rare', 'Radiant Rare', 'Shiny rare', 'Shiny rare V',
  'Shiny rare VMAX', 'Shiny Ultra Rare', 'Full Art Trainer', 'Classic Collection', 'Black White Rare', 'Pikachu Rare',
  'Futuristic Rare', 'Mega Hyper Rare',
]

// ---------- URLs and headers ----------

export const ptcgCardsUrl = (setId: string, page: number): string =>
  `https://api.pokemontcg.io/v2/cards?q=set.id:${encodeURIComponent(setId)}&pageSize=${PTCG_PAGE_SIZE}&page=${page}&select=id,name,number,rarity,supertype,subtypes,images`

export const tcgdexCardsUrl = (setId: string): string => `https://api.tcgdex.net/v2/en/cards?set.id=eq:${encodeURIComponent(setId)}`

export const tcgdexRarityUrl = (setId: string, rarity: string): string =>
  `${tcgdexCardsUrl(setId)}&rarity=eq:${encodeURIComponent(rarity)}`

/** The headers of a pokemontcg.io request: the key goes here and nowhere else. */
export const ptcgHeaders = (key: string): Record<string, string> => (key.trim() === '' ? {} : { 'X-Api-Key': key.trim() })

// ---------- parsing ----------

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

function json(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** `1999/01/09` and `1999-01-09` both become `1999-01-09`. */
export const normDate = (text: string): string => text.trim().slice(0, 10).replace(/\//g, '-')

export function parsePtcgSets(text: string): BoosterSet[] {
  const data = asRecord(json(text))?.data
  if (!Array.isArray(data)) return []
  const sets: BoosterSet[] = []
  for (const raw of data) {
    const row = asRecord(raw)
    if (!row || !str(row.id)) continue
    const set: BoosterSet = {
      id: str(row.id), name: str(row.name), series: str(row.series), releaseDate: normDate(str(row.releaseDate)),
      total: num(row.total) || num(row.printedTotal), source: 'pokemontcg',
    }
    if (num(row.printedTotal)) set.printedTotal = num(row.printedTotal)
    sets.push(set)
  }
  return sets
}

export function parsePtcgCards(text: string): { cards: BoosterCard[]; totalCount: number } | undefined {
  const body = asRecord(json(text))
  if (!body || !Array.isArray(body.data)) return undefined
  const cards: BoosterCard[] = []
  for (const raw of body.data) {
    const row = asRecord(raw)
    if (!row || !str(row.id)) continue
    const card: BoosterCard = { id: str(row.id), name: str(row.name), number: str(row.number), rarity: str(row.rarity), supertype: str(row.supertype) }
    const image = str(asRecord(row.images)?.small)
    if (image) card.image = image
    cards.push(card)
  }
  return { cards, totalCount: num(body.totalCount) || cards.length }
}

export const pagesNeeded = (totalCount: number): number => Math.min(PTCG_MAX_PAGES, Math.max(1, Math.ceil(totalCount / PTCG_PAGE_SIZE)))

/** Pages merged in order, a repeated id kept once. */
export function mergePages(pages: readonly (readonly BoosterCard[])[]): BoosterCard[] {
  const seen = new Set<string>()
  const merged: BoosterCard[] = []
  for (const page of pages) {
    for (const card of page) {
      if (seen.has(card.id)) continue
      seen.add(card.id)
      merged.push(card)
    }
  }
  return merged
}

export function parseTcgdexSets(text: string): BoosterSet[] {
  const sets = asRecord(asRecord(asRecord(json(text))?.data))?.sets
  if (!Array.isArray(sets)) return []
  const out: BoosterSet[] = []
  for (const raw of sets) {
    const row = asRecord(raw)
    if (!row || !str(row.id)) continue
    const serie = asRecord(row.serie)
    const count = asRecord(row.cardCount)
    const set: BoosterSet = {
      id: str(row.id), name: str(row.name), series: str(serie?.name), releaseDate: normDate(str(row.releaseDate)),
      total: num(count?.total), source: 'tcgdex',
    }
    if (num(count?.official)) set.printedTotal = num(count?.official)
    if (isExcluded(set) || str(serie?.id) === 'tcgp') continue
    out.push(set)
  }
  return out
}

/** A TCGdex brief card list; `rarity` is the one the query filtered by ('' for the unfiltered list). */
export function parseTcgdexBrief(text: string, rarity = ''): BoosterCard[] | undefined {
  const rows = json(text)
  if (!Array.isArray(rows)) return undefined
  const cards: BoosterCard[] = []
  for (const raw of rows) {
    const row = asRecord(raw)
    if (!row || !str(row.id)) continue
    const name = str(row.name)
    const card: BoosterCard = {
      id: str(row.id), name, number: str(row.localId), rarity, supertype: /\benergy\b/i.test(name) ? 'Energy' : '',
    }
    const image = str(row.image)
    if (image) card.image = `${image}/low.png`
    cards.push(card)
  }
  return cards
}

// ---------- matching a TCGdex set to a pokemontcg.io one ----------

const words = (name: string): string[] => name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)

/** The pokemontcg.io set that is `set`: the same release date, then the best name overlap. */
export function matchPtcgSet(set: Pick<BoosterSet, 'id' | 'name' | 'releaseDate'>, ptcgSets: readonly BoosterSet[]): BoosterSet | undefined {
  const same = ptcgSets.find(p => p.id === set.id && p.releaseDate === set.releaseDate)
  if (same) return same
  const dated = ptcgSets.filter(p => p.releaseDate === set.releaseDate)
  const mine = new Set(words(set.name))
  let best: BoosterSet | undefined
  let bestScore = 0
  for (const p of dated) {
    const theirs = words(p.name)
    const score = theirs.filter(w => mine.has(w)).length / Math.max(1, Math.max(mine.size, theirs.length))
    if (score > bestScore) {
      best = p
      bestScore = score
    }
  }
  return bestScore > 0 ? best : dated.length === 1 ? dated[0] : undefined
}

// ---------- retry policy ----------

/** Network failures (status 0) and server errors are tried again; a refusal, a missing page or a rate limit is not. */
export const shouldRetry = (status: number): boolean => status === 0 || status >= 500

export const RETRY_WAITS = [1000, 3000]

export type Fetched = { ok: true; text: string; tries: number } | { ok: false; status: number; tries: number }

/** Up to 3 attempts, waiting 1 s then 3 s between them; only retryable failures are repeated. */
export async function withRetry(io: Io, call: () => Promise<Reply>): Promise<Fetched> {
  let last = 0
  for (let tries = 1; tries <= 3; tries++) {
    const reply = await call()
    if (reply.status >= 200 && reply.status < 300) return { ok: true, text: reply.text, tries }
    last = reply.status
    if (!shouldRetry(reply.status) || tries === 3) return { ok: false, status: last, tries }
    await io.wait(RETRY_WAITS[tries - 1] ?? 3000)
  }
  return { ok: false, status: last, tries: 3 }
}

export const sourceHost = (source: BoosterSource): string => (source === 'tcgdex' ? 'tcgdex.net' : 'api.pokemontcg.io')

/** The note for a failed source: status codes only, never a header. */
export function failureNote(source: BoosterSource, what: string, status: number, tries: number, then?: string): string {
  const host = sourceHost(source)
  if (status === 429) {
    return source === 'pokemontcg'
      ? 'api.pokemontcg.io rate limit reached (without a key: 1,000 a day, 30 a minute).'
      : 'tcgdex.net rate limit reached; try again in a minute.'
  }
  const how = status === 0 ? 'did not answer' : `did not answer (HTTP ${status})`
  const base = `${host} ${how} after ${tries} ${tries === 1 ? 'try' : 'tries'}`
  return then ? `${base}; ${then}.` : `${base}${what ? ` for ${what}` : ''}.`
}

// ---------- fetch runners ----------

export type CatalogResult = { ok: true; sets: BoosterSet[]; source: BoosterSource } | { ok: false; note: string; status: number }
export type CardsResult = { ok: true; cards: BoosterCard[]; source: BoosterSource } | { ok: false; note: string; status: number }

export async function fetchPtcgCatalog(io: Io, key: string): Promise<CatalogResult> {
  const got = await withRetry(io, () => io.get(PTCG_SETS_URL, ptcgHeaders(key)))
  if (!got.ok) return { ok: false, status: got.status, note: failureNote('pokemontcg', 'the set list', got.status, got.tries) }
  const sets = parsePtcgSets(got.text)
  return sets.length > 0 ? { ok: true, sets, source: 'pokemontcg' } : { ok: false, status: 200, note: 'api.pokemontcg.io sent no sets.' }
}

export async function fetchTcgdexCatalog(io: Io): Promise<CatalogResult> {
  const got = await withRetry(io, () => io.post(TCGDEX_GRAPHQL, JSON.stringify({ query: TCGDEX_QUERY }), { 'content-type': 'application/json' }))
  if (!got.ok) return { ok: false, status: got.status, note: failureNote('tcgdex', 'the set list', got.status, got.tries) }
  const sets = parseTcgdexSets(got.text)
  return sets.length > 0 ? { ok: true, sets, source: 'tcgdex' } : { ok: false, status: 200, note: 'tcgdex.net sent no sets.' }
}

export async function fetchPtcgCards(io: Io, setId: string, key: string): Promise<CardsResult> {
  const headers = ptcgHeaders(key)
  const first = await withRetry(io, () => io.get(ptcgCardsUrl(setId, 1), headers))
  if (!first.ok) return { ok: false, status: first.status, note: failureNote('pokemontcg', 'the card list', first.status, first.tries) }
  const page1 = parsePtcgCards(first.text)
  if (!page1) return { ok: false, status: 200, note: 'api.pokemontcg.io sent an unreadable card list.' }
  const pages = [page1.cards]
  for (let page = 2; page <= pagesNeeded(page1.totalCount); page++) {
    const more = await withRetry(io, () => io.get(ptcgCardsUrl(setId, page), headers))
    if (!more.ok) return { ok: false, status: more.status, note: failureNote('pokemontcg', 'the card list', more.status, more.tries) }
    const parsed = parsePtcgCards(more.text)
    if (!parsed) return { ok: false, status: 200, note: 'api.pokemontcg.io sent an unreadable card list.' }
    pages.push(parsed.cards)
  }
  const cards = mergePages(pages)
  return cards.length > 0 ? { ok: true, cards, source: 'pokemontcg' } : { ok: false, status: 200, note: 'api.pokemontcg.io has no cards for that set.' }
}

/**
 * A TCGdex set: the whole brief list in one call, then a query per rarity (brief cards carry none)
 * in batches of 4, stopping once every card has a rarity.
 */
export async function fetchTcgdexCards(io: Io, setId: string): Promise<CardsResult> {
  const all = await withRetry(io, () => io.get(tcgdexCardsUrl(setId)))
  if (!all.ok) return { ok: false, status: all.status, note: failureNote('tcgdex', 'the card list', all.status, all.tries) }
  const list = parseTcgdexBrief(all.text)
  if (!list || list.length === 0) return { ok: false, status: 200, note: 'tcgdex.net has no cards for that set.' }
  const rarityOf = new Map<string, string>()
  const batch = 4
  for (let at = 0; at < TCGDEX_RARITIES.length && rarityOf.size < list.length; at += batch) {
    const names = TCGDEX_RARITIES.slice(at, at + batch)
    const results = await Promise.all(names.map(async name => ({ name, got: await withRetry(io, () => io.get(tcgdexRarityUrl(setId, name))) })))
    for (const { name, got } of results) {
      if (!got.ok) return { ok: false, status: got.status, note: failureNote('tcgdex', 'the card list', got.status, got.tries) }
      for (const card of parseTcgdexBrief(got.text, name) ?? []) rarityOf.set(card.id, name)
    }
  }
  const cards = list.map(card => ({ ...card, rarity: rarityOf.get(card.id) ?? '' }))
  return { ok: true, cards, source: 'tcgdex' }
}
