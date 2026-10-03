import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput, Timer } from 'claude-code'

import type { BoosterCard, BoosterCatalog, BoosterLoading, BoosterOwned, BoosterPack, BoosterSet, BoosterSource, BoosterView } from '../types'
import {
  fetchPtcgCards, fetchPtcgCatalog, fetchTcgdexCards, fetchTcgdexCatalog, failureNote, matchPtcgSet,
  type CardsResult, type CatalogResult, type Io, type Reply,
} from './api'
import {
  artSize, backCells, cacheDir, catalogPath, cellsArgv, cellsKey, cellsPath, clearArgv, collectionPath, MIN_COLUMNS, parseCellsFile,
  setCachePath, type ArtMode,
} from './art'
import { BENCH, fillSlot, inSlot, slotOf } from './bench'
import {
  COLLECTION_WARN_BYTES, addPack, collectionText, emptyCollection, ownedFor, parseCollection, serializeCollection, statsText,
  type Collection,
} from './collection'
import { matchSets, parseCommand, searchSets, setLabel, text as words } from './commands'
import { ERA_LABEL, RANDOM_ERAS, TIER_COLOR, TIER_LABEL, eraOf, isBigHit, isExcluded, packSize, tierOf } from './eras'
import { buildPack, seedFor } from './pack'

const PANE = 'booster-pane'
const TITLE = 'Booster'
const COMMAND = 'booster'
const FALLBACK_COMMAND = 'booster-pane'
const DESCRIPTION = 'Open pretend Pokémon TCG booster packs by set, with card art and a collection'
const CATALOG_TTL_MS = 7 * 86_400_000
const ART_JOBS = 2
const CELLS_KEPT = 24

const EMPTY_CATALOG: BoosterCatalog = { sets: [], fetchedAt: 0, isLoading: false }
const EMPTY_VIEW: BoosterView = { screen: 'sets', query: '', recent: [] }
const EMPTY_LOADING: BoosterLoading = { art: {} }

const catalog = atom({ plugin: 'booster-pane', key: 'catalog' } as const, EMPTY_CATALOG)
const view = atom({ plugin: 'booster-pane', key: 'view' } as const, EMPTY_VIEW)
const pack = atom({ plugin: 'booster-pane', key: 'pack' } as const, null as BoosterPack | null)
const loading = atom({ plugin: 'booster-pane', key: 'loading' } as const, EMPTY_LOADING)
const owned = atom({ plugin: 'booster-pane', key: 'owned' } as const, null as BoosterOwned | null)

type Settings = { apiKey: string; artMode: ArtMode; source: 'auto' | BoosterSource; python: string }
let settings: Settings = { apiKey: '', artMode: 'card', source: 'auto', python: 'python' }

// Module variables: they start over on a hot reload; everything that matters is in state or in run/.
let collection: Collection | undefined
const setCards = new Map<string, { cards: BoosterCard[]; source: BoosterSource }>()
const cellsHeld = new Map<string, string>()
const backHeld = new Map<string, string>()
let ptcgSets: BoosterSet[] | undefined
let artWanted: { cols: number; rows: number; mode: ArtMode } | undefined
let jobs: { key: string; cardId: string; url: string; cols: number; rows: number; mode: ArtMode }[] = []
let running = 0
let ticker: Timer | undefined
let isFetchingCatalog = false
let isToastedThisEpisode = false
let isPythonToasted = false
let artNotedFor = ''

// ---------- small helpers ----------

/** Runs a detached job: a failure after the session moved on is dropped, never unhandled. */
const bg = (job: Promise<unknown>): void => {
  job.catch(() => undefined)
}

const hasText = (value: unknown): value is string => typeof value === 'string' && value !== ''

function readSettings(options: Record<string, unknown>): Settings {
  const source = options.source === 'pokemontcg' || options.source === 'tcgdex' ? options.source : 'auto'
  return {
    apiKey: hasText(options.apiKey) ? options.apiKey : '',
    artMode: options.artMode === 'art' ? 'art' : 'card',
    source,
    python: hasText(options.python) ? options.python : 'python',
  }
}

function rememberCells(key: string, cells: string) {
  cellsHeld.delete(key)
  cellsHeld.set(key, cells)
  while (cellsHeld.size > CELLS_KEPT) cellsHeld.delete(cellsHeld.keys().next().value as string)
}

function backFor(cols: number, rows: number): string {
  const key = `${cols}x${rows}`
  let held = backHeld.get(key)
  if (!held) {
    held = backCells(cols, rows)
    backHeld.set(key, held)
  }
  return held
}

/** Network through the host: never throws, a failure or a 30 s silence is status 0. */
function makeIo($: EngineInterface): Io {
  const call = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Reply> => {
    let timer: Timer | undefined
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = $.clock.after(30_000, () => reject(new Error('timeout')))
      })
      const reply = await Promise.race([$.http.fetch(url, init), timeout])
      return { status: reply.status, text: reply.text }
    } catch {
      return { status: 0, text: '' }
    } finally {
      timer?.cancel()
    }
  }
  return {
    get: (url, headers) => call(url, headers ? { headers } : {}),
    post: (url, body, headers) => call(url, { method: 'POST', body, ...(headers ? { headers } : {}) }),
    wait: ms => new Promise<void>(resolve => void $.clock.after(ms, () => resolve())),
  }
}

async function setNote($: EngineInterface, note: string | undefined) {
  const at = await $.clock.now()
  await update($, loading, l => ({ ...l, ...(note === undefined ? { note: undefined, noteAt: undefined } : { note, noteAt: at }) }))
}

/** At most one toast per episode of failures. */
function toastOnce($: EngineInterface, message: string) {
  if (isToastedThisEpisode) return
  isToastedThisEpisode = true
  $.ui.toast(message)
}

async function setView($: EngineInterface, change: (v: BoosterView) => BoosterView) {
  await update($, view, change)
  await $.store.set('view', await read($, view)).catch(() => undefined)
}

// ---------- catalog and card lists ----------

const sourcesFor = (): BoosterSource[] => (settings.source === 'auto' ? ['tcgdex', 'pokemontcg'] : [settings.source])

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  try {
    if (!(await $.fs.exists(path))) return undefined
    return JSON.parse(await $.fs.read(path))
  } catch {
    return undefined
  }
}

const isSetList = (value: unknown): value is BoosterSet[] =>
  Array.isArray(value) && value.every(s => typeof s === 'object' && s !== null && typeof (s as BoosterSet).id === 'string')

/** The catalog from run/cache (stale or not); undefined when there is none. */
async function loadCatalogCache($: EngineInterface): Promise<BoosterCatalog | undefined> {
  const raw = (await readJson($, catalogPath($.plugin.root))) as { v?: number; source?: BoosterSource; fetchedAt?: number; sets?: unknown } | undefined
  if (!raw || raw.v !== 1 || !isSetList(raw.sets) || raw.sets.length === 0) return undefined
  const found: BoosterCatalog = { sets: raw.sets, fetchedAt: Number(raw.fetchedAt) || 0, isLoading: false, ...(raw.source ? { source: raw.source } : {}) }
  await update($, catalog, () => found)
  return found
}

/** Makes the set list available: the cache when fresh, else the sources in turn. */
async function loadCatalog($: EngineInterface, force = false): Promise<BoosterSet[]> {
  const held = await read($, catalog)
  const now = await $.clock.now()
  if (!force && held.sets.length > 0 && now - held.fetchedAt < CATALOG_TTL_MS) return held.sets
  if (isFetchingCatalog) return held.sets
  isFetchingCatalog = true
  try {
    let sets = held.sets
    if (!force && sets.length === 0) {
      const cached = await loadCatalogCache($)
      if (cached) {
        sets = cached.sets
        if (now - cached.fetchedAt < CATALOG_TTL_MS) return sets
      }
    }
    await update($, catalog, c => ({ ...c, isLoading: true }))
    const io = makeIo($)
    let note = ''
    let result: CatalogResult | undefined
    const order = sourcesFor()
    for (const [i, source] of order.entries()) {
      const tried = source === 'tcgdex' ? await fetchTcgdexCatalog(io) : await fetchPtcgCatalog(io, settings.apiKey)
      if (tried.ok) {
        result = tried
        break
      }
      const next = order[i + 1]
      note = next
        ? failureNote(source, 'the set list', tried.status, 3, `using ${next === 'tcgdex' ? 'tcgdex.net' : 'api.pokemontcg.io'}`)
        : note && tried.status !== 429
          ? `${note} ${tried.note}`
          : tried.note
    }
    if (result?.ok) {
      isToastedThisEpisode = false
      const fresh: BoosterCatalog = { sets: result.sets, source: result.source, fetchedAt: now, isLoading: false }
      await update($, catalog, () => fresh)
      if (result.source === 'pokemontcg') ptcgSets = result.sets
      await $.fs.write(catalogPath($.plugin.root), JSON.stringify({ v: 1, source: result.source, fetchedAt: now, sets: result.sets })).catch(() => undefined)
      if (note) await setNote($, note)
      return result.sets
    }
    await update($, catalog, c => ({ ...c, isLoading: false }))
    await setNote($, sets.length > 0 ? `${note} Cached sets still work.` : note || words.noSource)
    toastOnce($, note || words.noSource)
    return sets
  } finally {
    isFetchingCatalog = false
  }
}

/** The card list of a set: memory, then run/cache, else null (a fetch has not happened). */
async function cachedCards($: EngineInterface, set: BoosterSet): Promise<BoosterCard[] | null> {
  const held = setCards.get(set.id)
  if (held) return held.cards
  const raw = (await readJson($, setCachePath($.plugin.root, set.id))) as { v?: number; source?: BoosterSource; cards?: unknown } | undefined
  if (raw && raw.v === 1 && Array.isArray(raw.cards) && raw.cards.length > 0) {
    setCards.set(set.id, { cards: raw.cards as BoosterCard[], source: raw.source ?? set.source })
    return raw.cards as BoosterCard[]
  }
  return null
}

async function fetchFrom(io: Io, source: BoosterSource, set: BoosterSet): Promise<CardsResult> {
  if (source === 'tcgdex') return fetchTcgdexCards(io, set.id)
  let id = set.id
  if (set.source !== 'pokemontcg') {
    if (!ptcgSets) {
      const sets = await fetchPtcgCatalog(io, settings.apiKey)
      if (!sets.ok) return sets
      ptcgSets = sets.sets
    }
    const match = matchPtcgSet(set, ptcgSets)
    if (!match) return { ok: false, status: 404, note: `api.pokemontcg.io has no set that matches ${set.name}.` }
    id = match.id
  }
  return fetchPtcgCards(io, id, settings.apiKey)
}

/** Fetches a set's card list (primary source, then the fallback) and caches it whole. */
async function ensureCards($: EngineInterface, set: BoosterSet): Promise<BoosterCard[] | null> {
  const have = await cachedCards($, set)
  if (have) return have
  if ((await read($, loading)).setId === set.id) return null
  await update($, loading, l => ({ ...l, setId: set.id }))
  try {
    const io = makeIo($)
    const order: BoosterSource[] = settings.source === 'auto' ? [set.source, set.source === 'tcgdex' ? 'pokemontcg' : 'tcgdex'] : [settings.source]
    let note = ''
    for (const [i, source] of order.entries()) {
      const got = await fetchFrom(io, source, set)
      if (got.ok) {
        isToastedThisEpisode = false
        setCards.set(set.id, { cards: got.cards, source: got.source })
        const at = await $.clock.now()
        await $.fs.write(setCachePath($.plugin.root, set.id), JSON.stringify({ v: 1, source: got.source, fetchedAt: at, set, cards: got.cards })).catch(() => undefined)
        await setNote($, note || undefined)
        return got.cards
      }
      const next = order[i + 1]
      note = next ? failureNote(source, '', got.status, 3, `using ${next === 'tcgdex' ? 'tcgdex.net' : 'api.pokemontcg.io'}`) : note ? `${note} ${got.note}` : got.note
    }
    await setNote($, note)
    toastOnce($, note)
    return null
  } finally {
    await update($, loading, l => ({ ...l, setId: undefined }))
  }
}

// ---------- collection ----------

/** Reads run/collection.json fresh (merge before write); a corrupt file is kept aside and a new one started. */
async function loadCollection($: EngineInterface): Promise<Collection> {
  const path = collectionPath($.plugin.root)
  try {
    if (!(await $.fs.exists(path))) return (collection = collection ?? emptyCollection())
    const raw = await $.fs.read(path)
    const parsed = parseCollection(raw)
    if (parsed) {
      collection = parsed
      if (raw.length > COLLECTION_WARN_BYTES) await setNote($, 'The collection file is over 3.5 MB; run/collection.json can be trimmed by hand.')
      return parsed
    }
    await $.fs.write(`${$.plugin.root}/run/collection.bad-${await $.clock.now()}.json`, raw)
  } catch {
    // unreadable: start from what is held
  }
  return (collection = emptyCollection())
}

// ---------- the pack ----------

async function openPack($: EngineInterface): Promise<string> {
  const v = await read($, view)
  const sets = (await read($, catalog)).sets
  const set = sets.find(s => s.id === v.setId)
  if (!set) return words.noSet
  const cards = await cachedCards($, set)
  if (!cards) {
    bg(ensureCards($, set))
    return words.fetching(set)
  }
  const era = eraOf(set, cards)
  const now = await $.clock.now()
  const before = await loadCollection($)
  const packNo = (before.packs[set.id] ?? 0) + 1
  const built = buildPack(set, cards, era, seedFor(now, set.id, packNo))
  if (built.cards.length === 0) return `${set.name} has no cards to open.`
  const opened: BoosterPack = { setId: set.id, setName: set.name, era, seed: built.seed, cards: built.cards, shown: 0, openedAt: now, packNo }
  collection = addPack(before, opened, now)
  await $.fs.write(collectionPath($.plugin.root), serializeCollection(collection)).catch(() => undefined)
  await update($, pack, () => opened)
  await update($, owned, () => ownedFor(collection as Collection, set.id))
  await setView($, x => ({ ...x, screen: 'pack' }))
  await setNote($, undefined)
  bg(queueArt($))
  return words.opened(set, built.cards.length, era === 'promo')
}

async function flip($: EngineInterface, all: boolean) {
  const p = await read($, pack)
  if (!p || p.shown >= p.cards.length) return
  await update($, pack, x => (x ? { ...x, shown: all ? x.cards.length : x.shown + 1 } : x))
  if (!all) bg(queueArt($))
}

// ---------- art ----------

/** Queues the art of every card still to draw: the next face first. */
async function queueArt($: EngineInterface) {
  const p = await read($, pack)
  const want = artWanted
  if (!p || !want) return
  const l = await read($, loading)
  const order = [...p.cards.slice(p.shown), ...p.cards.slice(0, p.shown)]
  const fresh: Record<string, 'queued'> = {}
  const added: typeof jobs = []
  for (const card of order) {
    if (!card.image) continue
    const key = cellsKey(card.id, want.cols, want.rows, want.mode)
    if (cellsHeld.has(key) || l.art[key] !== undefined || fresh[key] !== undefined) continue
    fresh[key] = 'queued'
    added.push({ key, cardId: card.id, url: card.image, cols: want.cols, rows: want.rows, mode: want.mode })
  }
  const nextCard = p.cards[p.shown]
  if (nextCard) {
    const nextKey = cellsKey(nextCard.id, want.cols, want.rows, want.mode)
    const at = jobs.findIndex(j => j.key === nextKey)
    if (at > 0) jobs.unshift(...jobs.splice(at, 1))
  }
  if (added.length > 0) {
    jobs = [...jobs, ...added]
    await update($, loading, x => ({ ...x, art: { ...x.art, ...fresh } }))
  }
  bg(pump($))
}

async function markArt($: EngineInterface, key: string, state: 'running' | 'ready' | 'failed') {
  await update($, loading, l => ({ ...l, art: { ...l.art, [key]: state } }))
}

async function pump($: EngineInterface) {
  await Promise.resolve()
  while (running < ART_JOBS && jobs.length > 0) {
    const job = jobs.shift() as (typeof jobs)[number]
    running += 1
    bg(runJob($, job))
  }
  if (jobs.length > 0 || running > 0) {
    if (!ticker) ticker = $.clock.every(1000, () => bg(pump($)))
  } else {
    ticker?.cancel()
    ticker = undefined
  }
}

async function failArt($: EngineInterface, key: string, why: 'python' | 'image' | 'other') {
  await markArt($, key, 'failed')
  const p = await read($, pack)
  const id = p ? `${p.setId}#${p.packNo}` : ''
  if (why === 'python') {
    await setNote($, words.noPython)
    if (!isPythonToasted) {
      isPythonToasted = true
      $.ui.toast(words.noPython)
    }
  } else if (artNotedFor !== id) {
    artNotedFor = id
    await setNote($, why === 'image' ? 'Could not fetch a card image; drawing text cards for those.' : 'Card art failed for a card; drawing text cards for those.')
  }
}

async function runJob($: EngineInterface, job: (typeof jobs)[number]) {
  try {
    if (cellsHeld.has(job.key)) {
      await markArt($, job.key, 'ready')
      return
    }
    await markArt($, job.key, 'running')
    const root = $.plugin.root
    const out = cellsPath(root, job.cardId, job.cols, job.rows, job.mode)
    const readCells = async () => {
      try {
        return (await $.fs.exists(out)) ? parseCellsFile(await $.fs.read(out), job.cols, job.rows) : undefined
      } catch {
        return undefined
      }
    }
    let cells = await readCells()
    if (!cells) {
      let code = -1
      try {
        const ran = await $.process.run(cellsArgv(settings.python, root, job.url, job.cols, job.rows, job.mode, job.cardId), { cwd: root, timeoutMs: 15_000 })
        code = ran.exitCode
      } catch {
        await failArt($, job.key, 'python')
        return
      }
      if (code === 0) cells = await readCells()
      if (!cells) {
        await failArt($, job.key, code === 5 || code === 9009 || code === 127 ? 'python' : code === 3 ? 'image' : 'other')
        return
      }
    }
    rememberCells(job.key, cells)
    await markArt($, job.key, 'ready')
  } finally {
    running -= 1
    bg(pump($))
  }
}

// ---------- selecting sets ----------

async function selectSet($: EngineInterface, set: BoosterSet): Promise<string> {
  await setView($, v => ({ ...v, setId: set.id, query: '', recent: [set.id, ...v.recent.filter(id => id !== set.id)].slice(0, 6) }))
  await update($, owned, () => (collection ? ownedFor(collection, set.id) : null))
  const have = await cachedCards($, set)
  if (!have) bg(ensureCards($, set))
  await setNote($, undefined)
  return words.unique(set, !have)
}

/** Searches the catalog and selects a unique match; the text says what happened. */
async function pickSet($: EngineInterface, query: string): Promise<string> {
  const sets = await loadCatalog($)
  if (sets.length === 0) return words.noSource
  const found = searchSets(sets, query)
  if (found.kind === 'none') return words.none(query)
  if (found.kind === 'many') {
    await setView($, v => ({ ...v, query }))
    return words.many(query, found.sets)
  }
  return selectSet($, found.set)
}

async function randomSet($: EngineInterface, series: string): Promise<string> {
  const sets = await loadCatalog($)
  const pool = matchSets(sets, series).filter(s => {
    const era = eraOf(s)
    return era !== 'promo' && era !== 'mini' && !isExcluded(s)
  })
  if (pool.length === 0) return words.none(series)
  const at = Math.floor(((seedFor(await $.clock.now(), series, sets.length) % 100_000) / 100_000) * pool.length)
  return selectSet($, pool[at] as BoosterSet)
}

async function randomEra($: EngineInterface, era: (typeof RANDOM_ERAS)[number]): Promise<string> {
  const sets = await loadCatalog($)
  const pool = sets.filter(s => eraOf(s) === era)
  if (pool.length === 0) return words.noSource
  const at = Math.floor(((seedFor(await $.clock.now(), era, pool.length) % 100_000) / 100_000) * pool.length)
  return selectSet($, pool[at] as BoosterSet)
}

async function showCollection($: EngineInterface, setId: string) {
  const col = await loadCollection($)
  await update($, owned, () => ownedFor(col, setId))
  await setView($, v => ({ ...v, screen: 'collection', setId }))
}

// ---------- the command ----------

/** Opens the workbench dock from this dispatch when the workbench mod is loaded; harmless if it already is. */
async function ensureDock($: EngineInterface) {
  try {
    const hasBench = (await $.command.list()).some(one => one.name === BENCH)
    if (hasBench) await $.ui.open({ id: BENCH, title: 'Workbench', focus: true })
  } catch {
    // no command list on this surface, or the dock refused: the hosted open below still runs
  }
}

async function openPane($: EngineInterface): Promise<string> {
  await ensureDock($)
  const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true, columns: 64 })
  bg(loadCatalog($))
  if (opened.isPlaced) return words.open
  return `${words.open} The pane is waiting: ${opened.reason}. Try /workbench first.`
}

async function runCommand($: EngineInterface, args: string): Promise<{ text: string }> {
  const parsed = parseCommand(args)
  switch (parsed.kind) {
    case 'error':
      return { text: parsed.text }
    case 'pane':
      return { text: await openPane($) }
    case 'set': {
      const have = (await read($, catalog)).sets
      if (have.length > 0) return { text: await pickSet($, parsed.query) }
      bg((async () => {
        const said = await pickSet($, parsed.query)
        if (said !== words.noSource) await setNote($, said)
      })())
      return { text: words.noCatalog }
    }
    case 'open':
      return { text: await openPack($) }
    case 'random':
      return { text: await randomSet($, parsed.series) }
    case 'collection': {
      const col = await loadCollection($)
      const sets = (await read($, catalog)).sets
      if (parsed.query === '') {
        const current = (await read($, view)).setId
        const ids = current ? [current] : Object.keys(col.packs)
        if (ids.length === 0) return { text: 'No packs opened yet. /booster set <name>, then /booster open.' }
        if (current) await showCollection($, current)
        return { text: ids.map(id => collectionText(ownedFor(col, id), sets.find(s => s.id === id)?.name ?? id, sets.find(s => s.id === id)?.total)).join('\n\n') }
      }
      const found = searchSets(sets, parsed.query)
      if (found.kind === 'none') return { text: words.none(parsed.query) }
      if (found.kind === 'many') return { text: words.many(parsed.query, found.sets) }
      await showCollection($, found.set.id)
      return { text: collectionText(ownedFor(col, found.set.id), found.set.name, found.set.total) }
    }
    case 'stats': {
      const col = await loadCollection($)
      const names: Record<string, string> = {}
      for (const s of (await read($, catalog)).sets) names[s.id] = s.name
      return { text: statsText(col, names) }
    }
    case 'clear-cache': {
      jobs = []
      cellsHeld.clear()
      setCards.clear()
      try {
        await $.process.run(clearArgv(settings.python, $.plugin.root), { cwd: $.plugin.root, timeoutMs: 15_000 })
      } catch {
        return { text: words.noPython }
      }
      await update($, loading, l => ({ ...l, art: {} }))
      return { text: words.cleared }
    }
  }
}

// ---------- drawing ----------

type Style = { color?: string; dimColor?: boolean; bold?: boolean }

async function drawPane($: EngineInterface, e: RenderInput<'Pane'>) {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button } = elements
  const Raster = e.surface === 'terminal' && 'Raster' in elements ? elements.Raster : undefined
  const Input = 'Input' in elements ? elements.Input : undefined
  const v = await read($, view)
  const p = await read($, pack)
  const l = await read($, loading)
  const cat = await read($, catalog)
  const own = await read($, owned)
  const width = Math.max(8, e.props.bodyColumns)
  const bodyRows = e.props.scroll.bodyRows

  const line = (key: string, content: string, style: Style = {}) => (
    <Box key={key}>
      <Text wrap="truncate" {...style}>
        {content}
      </Text>
    </Box>
  )
  const note = l.note ? line('note', l.note, { dimColor: true }) : null
  const nav = (...keys: ('open' | 'flip' | 'flip-all' | 'sets' | 'collection' | 'random')[]) => (
    <Box key="nav" flexDirection="row" flexWrap="wrap" columnGap={1}>
      {keys.includes('flip') && p && p.shown < p.cards.length && <Button key="flip" label="flip" hotkey="e" variant="primary" autoFocus onPress={() => flip($, false)} />}
      {keys.includes('flip-all') && p && p.shown < p.cards.length && <Button key="flip-all" label="flip all" hotkey="f" plain onPress={() => flip($, true)} />}
      {keys.includes('open') && <Button key="open" label="open a pack" hotkey="p" variant={p && p.shown < p.cards.length ? 'secondary' : 'primary'} onPress={async () => { await setNote($, await openPack($)) }} />}
      {keys.includes('sets') && <Button key="sets" label="sets" hotkey="i" plain onPress={() => setView($, x => ({ ...x, screen: 'sets' }))} />}
      {keys.includes('collection') && <Button key="collection" label="collection" hotkey="l" plain onPress={async () => { if (v.setId) await showCollection($, v.setId) }} />}
      {keys.includes('random') && <Button key="random" label="random" hotkey="z" plain onPress={async () => { await setNote($, await randomSet($, '')) }} />}
    </Box>
  )

  if (width < MIN_COLUMNS) return line('narrow', `Widen the pane: Booster needs ${MIN_COLUMNS} columns.`)

  // ----- collection -----
  if (v.screen === 'collection') {
    const set = cat.sets.find(s => s.id === v.setId)
    return (
      <Box flexDirection="column" width={width}>
        {line('head', own && own.cards.length > 0 ? `${set?.name ?? own.setId}: ${own.cards.length}${set ? `/${set.total}` : ''} · ${own.pulled} pulled · ${own.packs} packs` : 'Nothing pulled yet from this set.', { bold: true })}
        {(own?.cards ?? []).slice(0, 200).map(c => (
          <Box key={`own-${c.id}`}>
            <Text wrap="truncate" color={TIER_COLOR[tierOf(c.rarity)]}>
              {`#${c.number} ${c.name}${c.n > 1 ? ` ×${c.n}` : ''}${c.rev > 0 ? ` (${c.rev} rev)` : ''}`}
            </Text>
          </Box>
        ))}
        {nav('sets', 'open')}
      </Box>
    )
  }

  // ----- the pack -----
  if (v.screen === 'pack' && p) {
    const total = p.cards.length
    const done = p.shown >= total
    const current = p.shown > 0 ? p.cards[p.shown - 1] : undefined
    const mode = settings.artMode
    const size = Raster ? artSize(width, bodyRows, mode) : undefined
    if (size && (!artWanted || artWanted.cols !== size.cols || artWanted.rows !== size.rows || artWanted.mode !== mode)) {
      artWanted = { ...size, mode }
      bg(queueArt($))
    }
    const head = line('head', `${p.setName} · pack ${p.packNo} · card ${p.shown}/${total}`, { dimColor: true })

    let art: ReturnType<typeof line> | null = null
    if (Raster && size && (!current || current.image)) {
      const key = current ? cellsKey(current.id, size.cols, size.rows, mode) : ''
      let cells = current ? cellsHeld.get(key) : undefined
      if (current && !cells && l.art[key] === 'ready') {
        try {
          cells = parseCellsFile(await $.fs.read(cellsPath($.plugin.root, current.id, size.cols, size.rows, mode)), size.cols, size.rows)
          if (cells) rememberCells(key, cells)
        } catch {
          cells = undefined
        }
      }
      const failed = current !== undefined && l.art[key] === 'failed'
      if (!failed) {
        art = (
          <Box key="art" flexDirection="column" width={size.cols}>
            <Raster key="booster-card" columns={size.cols} rows={size.rows} cells={cells ?? backFor(size.cols, size.rows)} />
            {current && !cells && line('art-wait', 'loading art…', { dimColor: true })}
          </Box>
        )
      }
    }

    const sparkle = current && isBigHit(current.tier) ? line('sparkle', `✦ ${(current.rarity || TIER_LABEL[current.tier]).toUpperCase()} ✦`, { color: TIER_COLOR[current.tier], bold: true }) : null
    const textCard = current && !art ? (
      <Box key="card" borderStyle="round" borderColor={TIER_COLOR[current.tier]} flexDirection="column" width={Math.min(width, 40)}>
        {line('card-name', current.name, { bold: true })}
        {line('card-number', `#${current.number} · ${p.setName}`)}
        {line('card-rarity', current.rarity || TIER_LABEL[current.tier], { color: TIER_COLOR[current.tier] })}
        {current.isReverse && line('card-reverse', 'reverse holo', { dimColor: true })}
      </Box>
    ) : null
    const waiting = !current && !art ? line('closed', 'The pack is sealed: press e to flip the first card.', { dimColor: true }) : null
    const bar = line('progress', `${'▮'.repeat(p.shown)}${'▯'.repeat(total - p.shown)}`, { dimColor: true })

    if (done) {
      const hits = p.cards.filter(c => c.isHit).length
      return (
        <Box flexDirection="column" width={width}>
          {head}
          {art}
          {sparkle}
          {textCard}
          {bar}
          {line('hits', `${hits} ${hits === 1 ? 'hit' : 'hits'} in this pack`, { bold: true })}
          {p.cards.map((c, i) => (
            <Box key={`pull-${i}`}>
              <Text wrap="truncate" color={TIER_COLOR[c.tier]}>
                {`${i + 1}. ${c.name} · #${c.number}${c.isReverse ? ' · rev' : ''}${c.rarity ? ` · ${c.rarity}` : ''}`}
              </Text>
            </Box>
          ))}
          {note}
          {nav('open', 'sets', 'collection')}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" width={width}>
        {head}
        {sparkle}
        {art}
        {textCard}
        {waiting}
        {bar}
        {note}
        {nav('flip', 'flip-all', 'open', 'sets', 'collection')}
      </Box>
    )
  }

  // ----- the sets -----
  const sets = cat.sets
  const matches = matchSets(sets, v.query)
  const shown = matches.slice(0, Math.max(4, Math.min(30, bodyRows - 14)))
  const selected = sets.find(s => s.id === v.setId)
  return (
    <Box flexDirection="column" width={width}>
      {Input && (
        <Input
          key="search"
          label="Set "
          placeholder="name or id (base1, sv3pt5)"
          value={v.query}
          autoFocus
          onInput={(value: string) => bg(setView($, x => ({ ...x, query: value })))}
          onSubmit={async (value: string) => {
            const found = searchSets(sets, value)
            if (found.kind === 'one') await setNote($, await selectSet($, found.set))
            else if (found.kind === 'many') await setNote($, await selectSet($, found.sets[0] as BoosterSet))
            else if (value.trim() !== '') await setNote($, words.none(value))
          }}
        />
      )}
      {selected && line('selected', `${setLabel(selected)} · ${ERA_LABEL[eraOf(selected)]} · ${packSize(eraOf(selected), selected.total)} cards a pack`, { bold: true })}
      {selected && (
        <Box key="open-row" flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button key="open" label="open a pack" hotkey="p" variant="primary" onPress={async () => { await setNote($, await openPack($)) }} />
          <Button key="random" label="random set" hotkey="z" plain onPress={async () => { await setNote($, await randomSet($, '')) }} />
          {v.setId && <Button key="collection" label="collection" hotkey="l" plain onPress={async () => { await showCollection($, v.setId as string) }} />}
        </Box>
      )}
      {note}
      {sets.length === 0 && (cat.isLoading ? line('loading', 'Loading the set list…', { dimColor: true }) : (
        <Box key="empty" flexDirection="column">
          {line('empty', 'Could not reach any card source.', { dimColor: true })}
          <Button key="retry" label="retry" plain onPress={() => bg(loadCatalog($, true))} />
        </Box>
      ))}
      {sets.length > 0 && v.recent.length > 0 && v.query === '' && (
        <Box key="recent" flexDirection="column">
          {line('recent-head', 'Recent', { dimColor: true })}
          {v.recent.flatMap(id => {
            const set = sets.find(s => s.id === id)
            return set ? [<Button key={`recent-${id}`} label={setLabel(set)} plain onPress={async () => { await setNote($, await selectSet($, set)) }} />] : []
          })}
        </Box>
      )}
      {sets.length > 0 && v.query === '' && (
        <Box key="eras" flexDirection="row" flexWrap="wrap" columnGap={1}>
          {RANDOM_ERAS.map(era => (
            <Button key={`era-${era}`} label={ERA_LABEL[era]} plain onPress={async () => { await setNote($, await randomEra($, era)) }} />
          ))}
        </Box>
      )}
      {shown.map(set => (
        <Button key={`set-${set.id}`} label={setLabel(set)} plain onPress={async () => { await setNote($, await selectSet($, set)) }} />
      ))}
      {matches.length > shown.length && line('more', `…${matches.length - shown.length} more: type to narrow`, { dimColor: true })}
    </Box>
  )
}

// ---------- hooks ----------

export const register: Register = (on, options) => {
  settings = readSettings(options as Record<string, unknown>)

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: COMMAND, description: DESCRIPTION, argumentHint: '[set <name|id> | open | random [series] | collection [set] | stats | clear-cache]' })
    } catch {
      // The name is taken by something else: the same command under another name.
      await $.command.register({ name: FALLBACK_COMMAND, description: DESCRIPTION })
    }
    const stored = (await $.store.get('view')) as BoosterView | undefined
    if (stored && typeof stored === 'object' && Array.isArray(stored.recent)) await update($, view, () => ({ ...EMPTY_VIEW, ...stored }))
    await loadCatalogCache($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => runCommand($, e.args))
  on('command.run', { command: FALLBACK_COMMAND }, async ($, e) => runCommand($, e.args))

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      ticker?.cancel()
      ticker = undefined
      jobs = []
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    ticker?.cancel()
    ticker = undefined
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e))

  // Inside the workbench: fill this pane's slot in its frame.
  on('ui.render', { component: 'Pane', requestId: BENCH }, async ($, e, next) => {
    const frame = await next(e)
    const slot = slotOf(frame, PANE)
    return slot ? fillSlot(frame, PANE, await drawPane($, inSlot(e, slot.columns))) : frame
  })
}
