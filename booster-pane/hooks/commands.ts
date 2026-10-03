// The /booster command's arguments, set search and message texts. Pure: no `$`.

import type { BoosterSet } from '../types'

export const USAGE = '/booster [set <name|id> | open | random [series] | collection [set] | stats | clear-cache]'

export type Parsed =
  | { kind: 'pane' }
  | { kind: 'set'; query: string }
  | { kind: 'open' }
  | { kind: 'random'; series: string }
  | { kind: 'collection'; query: string }
  | { kind: 'stats' }
  | { kind: 'clear-cache' }
  | { kind: 'error'; text: string }

export function parseCommand(args: string): Parsed {
  const text = args.trim()
  if (text === '') return { kind: 'pane' }
  const [word = '', ...rest] = text.split(/\s+/)
  const tail = rest.join(' ')
  switch (word.toLowerCase()) {
    case 'set':
      return tail === '' ? { kind: 'error', text: `Which set? ${USAGE}` } : { kind: 'set', query: tail }
    case 'open':
      return { kind: 'open' }
    case 'random':
      return { kind: 'random', series: tail }
    case 'collection':
      return { kind: 'collection', query: tail }
    case 'stats':
      return { kind: 'stats' }
    case 'clear-cache':
      return { kind: 'clear-cache' }
    default:
      return { kind: 'error', text: `Unknown booster command "${word}". Usage: ${USAGE}` }
  }
}

const norm = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Newest first. */
export const newestFirst = (sets: readonly BoosterSet[]): BoosterSet[] =>
  sets.slice().sort((a, b) => b.releaseDate.localeCompare(a.releaseDate) || a.name.localeCompare(b.name))

/** Every set whose id or name holds all the words of `query`, newest first; all sets for an empty query. */
export function matchSets(sets: readonly BoosterSet[], query: string): BoosterSet[] {
  const words = norm(query).split(' ').filter(Boolean)
  if (words.length === 0) return newestFirst(sets)
  return newestFirst(sets.filter(set => {
    const hay = `${norm(set.id)} ${norm(set.name)} ${norm(set.series)}`
    return words.every(w => hay.includes(w))
  }))
}

export type SetSearch = { kind: 'one'; set: BoosterSet } | { kind: 'many'; sets: BoosterSet[] } | { kind: 'none' }

/** An exact id wins; then an exact name; then the sets whose name or id holds every word. */
export function searchSets(sets: readonly BoosterSet[], query: string): SetSearch {
  const q = query.trim().toLowerCase()
  if (q === '') return { kind: 'none' }
  const byId = sets.find(set => set.id.toLowerCase() === q)
  if (byId) return { kind: 'one', set: byId }
  const byName = sets.filter(set => norm(set.name) === norm(q))
  if (byName.length === 1) return { kind: 'one', set: byName[0] as BoosterSet }
  const found = matchSets(sets, query)
  if (found.length === 1) return { kind: 'one', set: found[0] as BoosterSet }
  return found.length === 0 ? { kind: 'none' } : { kind: 'many', sets: found }
}

export const year = (set: Pick<BoosterSet, 'releaseDate'>): string => set.releaseDate.slice(0, 4)

/** `Name · 1999 · 102`. */
export const setLabel = (set: BoosterSet): string => `${set.name} · ${year(set)} · ${set.total}`

export const text = {
  open: 'Booster is open. Pick a set: type to search, or /booster set <name>.',
  unique: (set: BoosterSet, fetching: boolean): string =>
    `${set.name} (${set.id}) · ${set.series} · ${year(set)} · ${set.total} cards. Press p or /booster open to open a pack.${fetching ? ' Fetching the card list…' : ''}`,
  many: (query: string, sets: readonly BoosterSet[]): string =>
    `${sets.length} sets match "${query}": ${sets.slice(0, 8).map(s => `${s.name} (${s.id})`).join(', ')}${sets.length > 8 ? ', …' : ''}. Type more of the name or the id.`,
  none: (query: string): string => `No set matches "${query}". Ids look like base1, sv3pt5; the pane lists them all.`,
  noSet: 'Pick a set first: /booster set <name>.',
  opened: (set: BoosterSet, size: number, isPromo: boolean): string =>
    isPromo
      ? `A promo envelope: 1 card from ${set.name}. Flip it in the pane: e.`
      : `Opened a ${set.name} pack (${size} cards). Flip them in the pane: e one at a time, f all.`,
  fetching: (set: BoosterSet): string => `Still fetching the ${set.name} card list; try again in a moment.`,
  noCatalog: 'The set list is still loading; try again in a moment.',
  noSource: 'Could not reach any card source. Cached sets still work.',
  noPython: 'Card art needs Python 3 with Pillow (python -m pip install pillow). Drawing text cards instead.',
  cleared: 'Cleared the image and card-list cache (run/cache). Your collection is kept.',
  needSets: 'No sets yet: the set list has not loaded. Try again in a moment.',
}
