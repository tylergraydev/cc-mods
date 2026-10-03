export type BoosterSource = 'pokemontcg' | 'tcgdex'
export type BoosterEra = 'classic' | 'ex-dp' | 'bw-xy' | 'sm-swsh' | 'sv' | 'mini' | 'promo'
export type BoosterTier =
  | 'common' | 'uncommon' | 'rare' | 'holo' | 'ex' | 'vmax' | 'special'
  | 'illustration' | 'ultra' | 'sir' | 'secret' | 'promo'

export type BoosterSet = {
  id: string
  name: string
  series: string
  /** YYYY-MM-DD */
  releaseDate: string
  total: number
  printedTotal?: number
  source: BoosterSource
}

export type BoosterCard = {
  id: string
  name: string
  number: string
  /** The source's own text; '' when it has none. */
  rarity: string
  supertype: string
  /** The small PNG's URL. */
  image?: string
}

export type BoosterSlot = 'common' | 'uncommon' | 'reverse' | 'hitReverse' | 'rare' | 'any'

export type BoosterPackCard = BoosterCard & {
  tier: BoosterTier
  slot: BoosterSlot
  isReverse: boolean
  isHit: boolean
}

export type BoosterPack = {
  setId: string
  setName: string
  era: BoosterEra
  seed: number
  cards: BoosterPackCard[]
  /** How many cards are face up. */
  shown: number
  openedAt: number
  packNo: number
}

export type BoosterCatalog = { sets: BoosterSet[]; source?: BoosterSource; fetchedAt: number; isLoading: boolean }

export type BoosterView = {
  screen: 'sets' | 'pack' | 'collection'
  query: string
  setId?: string
  /** At most 6 set ids, newest first. */
  recent: string[]
}

export type BoosterLoading = {
  /** The set whose card list is being fetched. */
  setId?: string
  art: Record<string, 'queued' | 'running' | 'ready' | 'failed'>
  note?: string
  noteAt?: number
}

export type BoosterOwned = {
  setId: string
  packs: number
  pulled: number
  cards: { id: string; name: string; number: string; rarity: string; n: number; rev: number }[]
}

declare module 'claude-code' {
  interface PluginState {
    'booster-pane': {
      catalog: BoosterCatalog
      view: BoosterView
      pack: BoosterPack | null
      loading: BoosterLoading
      owned: BoosterOwned | null
    }
  }
}
