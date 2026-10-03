import { expect, test } from 'claude-code/testing'

import {
  TCGDEX_QUERY, failureNote, fetchPtcgCards, fetchTcgdexCards, fetchTcgdexCatalog, matchPtcgSet, mergePages, normDate, pagesNeeded,
  parsePtcgCards, parsePtcgSets, parseTcgdexBrief, parseTcgdexSets, ptcgCardsUrl, ptcgHeaders, shouldRetry, tcgdexCardsUrl,
  tcgdexRarityUrl, withRetry, type Io, type Reply,
} from '../hooks/api'
import { cellsArgv, cellsKey, cellsPath, parseCellsFile, pngPath, safeName, setCachePath, artSize, backCells, packCells } from '../hooks/art'
import { parseCommand, searchSets } from '../hooks/commands'
import type { BoosterSet } from '../types'

/** An Io over a script of replies; waits are recorded, never slept. */
function io(replies: Reply[] | ((url: string) => Reply)) {
  const calls: { url: string; headers?: Record<string, string>; body?: string }[] = []
  const waits: number[] = []
  let at = 0
  const next = (url: string): Reply => (typeof replies === 'function' ? replies(url) : (replies[Math.min(at++, replies.length - 1)] as Reply))
  const kit: Io = {
    get: async (url, headers) => {
      calls.push({ url, ...(headers ? { headers } : {}) })
      return next(url)
    },
    post: async (url, body, headers) => {
      calls.push({ url, body, ...(headers ? { headers } : {}) })
      return next(url)
    },
    wait: async ms => {
      waits.push(ms)
    },
  }
  return { kit, calls, waits }
}

const ok = (value: unknown): Reply => ({ status: 200, text: JSON.stringify(value) })

test('pokemontcg parsing: dates, missing rarity, paging and the exact URLs', () => {
  const sets = parsePtcgSets(JSON.stringify({ data: [
    { id: 'base1', name: 'Base', series: 'Base', printedTotal: 102, total: 102, releaseDate: '1999/01/09' },
    { id: 'bad' },
    { name: 'no id' },
  ] }))
  expect(sets[0]).toEqual({ id: 'base1', name: 'Base', series: 'Base', releaseDate: '1999-01-09', total: 102, printedTotal: 102, source: 'pokemontcg' })
  expect(sets.map(s => s.id)).toEqual(['base1', 'bad'])
  expect(normDate('2020/02/14')).toBe('2020-02-14')
  expect(parsePtcgSets('not json')).toEqual([])

  const parsed = parsePtcgCards(JSON.stringify({ totalCount: 3, data: [
    { id: 'x-1', name: 'Testmon', number: '1', rarity: 'Rare', supertype: 'Pokémon', images: { small: 'https://images.pokemontcg.io/x/1.png' } },
    { id: 'x-2', name: 'Sample Energy', number: '2', supertype: 'Energy' },
  ] }))
  expect(parsed?.totalCount).toBe(3)
  expect(parsed?.cards[0]?.image).toBe('https://images.pokemontcg.io/x/1.png')
  expect(parsed?.cards[1]).toEqual({ id: 'x-2', name: 'Sample Energy', number: '2', rarity: '', supertype: 'Energy' })
  expect(parsePtcgCards('{}')).toBeUndefined()

  expect(pagesNeeded(258)).toBe(2)
  expect(pagesNeeded(250)).toBe(1)
  expect(pagesNeeded(0)).toBe(1)
  expect(pagesNeeded(99999)).toBe(10)
  const a = { id: 'a', name: 'A', number: '1', rarity: '', supertype: '' }
  const b = { ...a, id: 'b' }
  expect(mergePages([[a, b], [b, { ...a, id: 'c' }]]).map(c => c.id)).toEqual(['a', 'b', 'c'])

  expect(ptcgCardsUrl('base1', 2)).toBe('https://api.pokemontcg.io/v2/cards?q=set.id:base1&pageSize=250&page=2&select=id,name,number,rarity,supertype,subtypes,images')
  expect(ptcgHeaders('')).toEqual({})
  expect(ptcgHeaders('  ')).toEqual({})
  expect(ptcgHeaders('abc')).toEqual({ 'X-Api-Key': 'abc' })
})

test('TCGdex parsing: sets, brief cards, images and the exact URLs', () => {
  const sets = parseTcgdexSets(JSON.stringify({ data: { sets: [
    { id: 'base1', name: 'Base Set', releaseDate: '1999-01-09', serie: { id: 'base', name: 'Base' }, cardCount: { total: 102, official: 102 } },
    { id: 'A1', name: 'Genetic Apex', releaseDate: '2024-10-30', serie: { id: 'tcgp', name: 'Pokémon TCG Pocket' }, cardCount: { total: 286, official: 286 } },
  ] } }))
  expect(sets).toHaveLength(1)
  expect(sets[0]).toEqual({ id: 'base1', name: 'Base Set', series: 'Base', releaseDate: '1999-01-09', total: 102, printedTotal: 102, source: 'tcgdex' })
  expect(parseTcgdexSets('{"errors":[]}')).toEqual([])

  const cards = parseTcgdexBrief(JSON.stringify([
    { id: 't-1', localId: '1', name: 'Testmon', image: 'https://assets.tcgdex.net/en/t/t/1' },
    { id: 't-2', localId: '2', name: 'Fire Energy' },
  ]), 'Rare')
  expect(cards?.[0]).toEqual({ id: 't-1', name: 'Testmon', number: '1', rarity: 'Rare', supertype: '', image: 'https://assets.tcgdex.net/en/t/t/1/low.png' })
  expect(cards?.[1]?.image).toBeUndefined()
  expect(cards?.[1]?.supertype).toBe('Energy')
  expect(parseTcgdexBrief('{}')).toBeUndefined()
  expect(tcgdexCardsUrl('base1')).toBe('https://api.tcgdex.net/v2/en/cards?set.id=eq:base1')
  expect(tcgdexRarityUrl('base1', 'Rare Holo')).toBe('https://api.tcgdex.net/v2/en/cards?set.id=eq:base1&rarity=eq:Rare%20Holo')
  expect(TCGDEX_QUERY).toContain('cardCount')
})

test('a TCGdex set stops asking for rarities once every card has one', async () => {
  const brief = (rows: object[]) => ok(rows)
  const all = [
    { id: 't-1', localId: '1', name: 'A', image: 'https://assets.tcgdex.net/t/1' },
    { id: 't-2', localId: '2', name: 'B', image: 'https://assets.tcgdex.net/t/2' },
    { id: 't-3', localId: '3', name: 'C' },
  ]
  const r = io(url => {
    if (url.endsWith('rarity=eq:Common')) return brief(all.slice(0, 1))
    if (url.endsWith('rarity=eq:Uncommon')) return brief(all.slice(1, 2))
    if (url.endsWith('rarity=eq:Rare')) return brief(all.slice(2, 3))
    if (url.includes('rarity=')) return brief([])
    return brief(all)
  })
  const got = await fetchTcgdexCards(r.kit, 'tt1')
  expect(got.ok).toBe(true)
  if (!got.ok) return
  expect(got.cards.map(c => c.rarity)).toEqual(['Common', 'Uncommon', 'Rare'])
  // one list call, then one batch of four rarities and no more
  expect(r.calls).toHaveLength(5)
  expect(r.calls[0]?.url).toBe(tcgdexCardsUrl('tt1'))
})

test('the TCGdex catalog posts the GraphQL query', async () => {
  const r = io([ok({ data: { sets: [{ id: 'base1', name: 'Base Set', releaseDate: '1999-01-09', serie: { id: 'base', name: 'Base' }, cardCount: { total: 102, official: 102 } }] } })])
  const got = await fetchTcgdexCatalog(r.kit)
  expect(got.ok).toBe(true)
  expect(r.calls[0]?.url).toBe('https://api.tcgdex.net/v2/graphql')
  expect(JSON.parse(r.calls[0]?.body ?? '{}').query).toBe(TCGDEX_QUERY)
})

test('pokemontcg pages: 260 cards take two requests and merge', async () => {
  const row = (i: number) => ({ id: `x-${i}`, name: `Testmon ${i}`, number: String(i), rarity: 'Common', supertype: 'Pokémon' })
  const r = io(url => ok({ totalCount: 260, data: Array.from({ length: url.includes('page=1') ? 250 : 10 }, (_, i) => row(url.includes('page=1') ? i : 250 + i)) }))
  const got = await fetchPtcgCards(r.kit, 'x', 'k')
  expect(got.ok && got.cards.length).toBe(260)
  expect(r.calls.map(c => c.url.match(/page=\d+/)?.[0])).toEqual(['page=1', 'page=2'])
  expect(r.calls.every(c => c.headers?.['X-Api-Key'] === 'k')).toBe(true)
})

test('shouldRetry and the runner: three tries with 1 s and 3 s waits', async () => {
  for (const s of [0, 500, 502, 503]) expect(shouldRetry(s)).toBe(true)
  for (const s of [200, 404, 429, 403]) expect(shouldRetry(s)).toBe(false)
  const bad = io([{ status: 500, text: '' }])
  const got = await withRetry(bad.kit, () => bad.kit.get('u'))
  expect(got).toEqual({ ok: false, status: 500, tries: 3 })
  expect(bad.calls).toHaveLength(3)
  expect(bad.waits).toEqual([1000, 3000])

  const flaky = io([{ status: 502, text: '' }, { status: 200, text: 'fine' }])
  expect(await withRetry(flaky.kit, () => flaky.kit.get('u'))).toEqual({ ok: true, text: 'fine', tries: 2 })
  expect(flaky.waits).toEqual([1000])

  const limited = io([{ status: 429, text: '' }])
  expect((await withRetry(limited.kit, () => limited.kit.get('u'))).ok).toBe(false)
  expect(limited.calls).toHaveLength(1)

  const down = io([{ status: 0, text: '' }])
  const gone = await fetchTcgdexCatalog(down.kit)
  expect(gone.ok).toBe(false)
  if (!gone.ok) expect(gone.note).toBe('tcgdex.net did not answer after 3 tries for the set list.')
  expect(failureNote('tcgdex', 'the set list', 500, 3, 'using api.pokemontcg.io')).toBe('tcgdex.net did not answer (HTTP 500) after 3 tries; using api.pokemontcg.io.')
  expect(failureNote('pokemontcg', '', 429, 1)).toContain('1,000 a day, 30 a minute')
})

const SETS: BoosterSet[] = [
  { id: 'base1', name: 'Base', series: 'Base', releaseDate: '1999-01-09', total: 102, source: 'tcgdex' },
  { id: 'base2', name: 'Jungle', series: 'Base', releaseDate: '1999-06-16', total: 64, source: 'tcgdex' },
  { id: 'swsh1', name: 'Sword & Shield', series: 'Sword & Shield', releaseDate: '2020-02-07', total: 216, source: 'tcgdex' },
  { id: 'swsh2', name: 'Rebel Clash', series: 'Sword & Shield', releaseDate: '2020-05-01', total: 209, source: 'tcgdex' },
  { id: 'sv3pt5', name: '151', series: 'Scarlet & Violet', releaseDate: '2023-09-22', total: 207, source: 'tcgdex' },
]

test('matchPtcgSet by id and date, then by date and name overlap', () => {
  const ptcg: BoosterSet[] = [
    { id: 'sv3pt5', name: 'Scarlet & Violet 151', series: 'Scarlet & Violet', releaseDate: '2023-09-22', total: 207, source: 'pokemontcg' },
    { id: 'other', name: 'Other', series: 'x', releaseDate: '2023-09-22', total: 5, source: 'pokemontcg' },
    { id: 'zz', name: 'Rebel Clash', series: 'Sword & Shield', releaseDate: '2020-05-01', total: 209, source: 'pokemontcg' },
  ]
  expect(matchPtcgSet({ id: 'sv03.5', name: '151', releaseDate: '2023-09-22' }, ptcg)?.id).toBe('sv3pt5')
  expect(matchPtcgSet({ id: 'swsh2', name: 'Rebel Clash', releaseDate: '2020-05-01' }, ptcg)?.id).toBe('zz')
  expect(matchPtcgSet({ id: 'sv3pt5', name: '151', releaseDate: '2023-09-22' }, ptcg)?.id).toBe('sv3pt5')
  expect(matchPtcgSet({ id: 'nope', name: 'Nothing', releaseDate: '2001-01-01' }, ptcg)).toBeUndefined()
})

test('parseCommand and searchSets', () => {
  expect(parseCommand('')).toEqual({ kind: 'pane' })
  expect(parseCommand('set base1')).toEqual({ kind: 'set', query: 'base1' })
  expect(parseCommand('SET Rebel Clash')).toEqual({ kind: 'set', query: 'Rebel Clash' })
  expect(parseCommand('open')).toEqual({ kind: 'open' })
  expect(parseCommand('random sword shield')).toEqual({ kind: 'random', series: 'sword shield' })
  expect(parseCommand('random')).toEqual({ kind: 'random', series: '' })
  expect(parseCommand('collection base1')).toEqual({ kind: 'collection', query: 'base1' })
  expect(parseCommand('stats')).toEqual({ kind: 'stats' })
  expect(parseCommand('clear-cache')).toEqual({ kind: 'clear-cache' })
  expect(parseCommand('bogus').kind).toBe('error')
  expect(parseCommand('set').kind).toBe('error')

  // an exact id wins over a name that contains it
  expect(searchSets(SETS, 'base1')).toEqual({ kind: 'one', set: SETS[0] })
  expect(searchSets(SETS, 'jungle')).toEqual({ kind: 'one', set: SETS[1] })
  expect(searchSets(SETS, 'rebel')).toEqual({ kind: 'one', set: SETS[3] })
  const many = searchSets(SETS, 'sword')
  expect(many.kind).toBe('many')
  if (many.kind === 'many') expect(many.sets.map(s => s.id)).toEqual(['swsh2', 'swsh1'])
  expect(searchSets(SETS, 'xyz')).toEqual({ kind: 'none' })
  expect(searchSets(SETS, '151')).toEqual({ kind: 'one', set: SETS[4] })
})

test('paths, names and the helper argv', () => {
  expect(safeName('swsh12pt5gg-GG01')).toBe('swsh12pt5gg-GG01')
  expect(safeName('a/b c:d')).toBe('a_b_c_d')
  expect(setCachePath('C:/m', 'base1')).toBe('C:/m/run/cache/sets/base1.json')
  expect(pngPath('C:/m', 'base1-4')).toBe('C:/m/run/cache/img/base1-4.png')
  expect(cellsPath('C:/m', 'swsh12pt5gg-GG01', 36, 25, 'card')).toBe('C:/m/run/cache/cells/swsh12pt5gg-GG01-36x25-card.json')
  expect(cellsKey('a', 36, 25, 'card')).toBe('a|36x25|card')
  expect(cellsArgv('python', 'C:/m', 'https://assets.tcgdex.net/x/low.png', 36, 25, 'card', 'base1-4')).toEqual([
    'python', 'C:/m/scripts/card_cells.py', 'https://assets.tcgdex.net/x/low.png', '36', '25', '--mode', 'card', '--png',
    'C:/m/run/cache/img/base1-4.png', 'C:/m/run/cache/cells/base1-4-36x25-card.json',
  ])
})

test('artSize steps down the ladder and the card back decodes', () => {
  expect(artSize(40, 40, 'card')).toEqual({ cols: 36, rows: 25 })
  expect(artSize(64, 60, 'card')).toEqual({ cols: 60, rows: 42 })
  expect(artSize(20, 40, 'card')).toBeUndefined()
  expect(artSize(22, 40, 'card')).toEqual({ cols: 20, rows: 14 })
  expect(artSize(36, 40, 'art')).toEqual({ cols: 30, rows: 10 })
  expect(artSize(40, 40, 'art')).toEqual({ cols: 36, rows: 12 })
  expect(artSize(64, 30, 'card')).toEqual({ cols: 30, rows: 21 })
  expect(artSize(64, 12, 'card')).toBeUndefined()

  const back = backCells(36, 25)
  const bytes = (Uint8Array as unknown as { fromBase64(text: string): Uint8Array }).fromBase64(back)
  expect(bytes.length).toBe(36 * 25 * 12)
  const words = new Uint32Array(bytes.buffer)
  for (let i = 0; i < 36 * 25; i++) expect([0x2588, 0x20]).toContain(words[i * 3])
  expect(back.length).toBe(Math.ceil((36 * 25 * 12) / 3) * 4)
  expect(packCells(Uint32Array.of(0x2588, 0xff8800, 0x01000000))).toBe('iCUAAACI/wAAAAAB')
  expect(parseCellsFile(JSON.stringify({ v: 1, cols: 36, rows: 25, cells: back }), 36, 25)).toBe(back)
  expect(parseCellsFile(JSON.stringify({ v: 1, cols: 30, rows: 25, cells: back }), 36, 25)).toBeUndefined()
  expect(parseCellsFile('nope', 36, 25)).toBeUndefined()
})
