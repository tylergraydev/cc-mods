// Card art: the size ladder, cache paths, the helper's argv and the card back. Pure: no `$`.

export type ArtMode = 'card' | 'art'

/** Columns a card may be drawn at; the pane takes the largest that fits. */
export const LADDER = [20, 24, 30, 36, 44, 52, 60] as const

/** The cells a card of `cols` columns takes: the whole card (aspect 245/342) or its illustration window. */
export const rowsFor = (cols: number, mode: ArtMode): number => Math.round(cols / (mode === 'art' ? 2.94 : 1.43))

/** Below this many body columns the pane asks for more room. */
export const MIN_COLUMNS = 16

/** The art size for a pane body; undefined when no step fits (a text card is drawn instead). */
export function artSize(bodyColumns: number, bodyRows: number, mode: ArtMode): { cols: number; rows: number } | undefined {
  const usable = bodyColumns - 2
  let best: { cols: number; rows: number } | undefined
  for (const cols of LADDER) {
    const rows = rowsFor(cols, mode)
    if (cols <= usable && rows <= bodyRows - 7) best = { cols, rows }
  }
  return best
}

// ---------- paths ----------

export const safeName = (text: string): string => text.replace(/[^A-Za-z0-9._-]/g, '_')

export const runDir = (root: string): string => `${root}/run`
export const cacheDir = (root: string): string => `${root}/run/cache`
export const collectionPath = (root: string): string => `${root}/run/collection.json`
export const catalogPath = (root: string): string => `${root}/run/cache/catalog.json`
export const setCachePath = (root: string, setId: string): string => `${root}/run/cache/sets/${safeName(setId)}.json`
export const pngPath = (root: string, cardId: string): string => `${root}/run/cache/img/${safeName(cardId)}.png`
export const cellsPath = (root: string, cardId: string, cols: number, rows: number, mode: ArtMode): string =>
  `${root}/run/cache/cells/${safeName(cardId)}-${cols}x${rows}-${mode}.json`

/** The key a card's cells are held under in memory and in `loading.art`. */
export const cellsKey = (cardId: string, cols: number, rows: number, mode: ArtMode): string => `${cardId}|${cols}x${rows}|${mode}`

/** The helper's command line. */
export function cellsArgv(python: string, root: string, url: string, cols: number, rows: number, mode: ArtMode, cardId: string): string[] {
  return [
    python, `${root}/scripts/card_cells.py`, url, String(cols), String(rows), '--mode', mode, '--png', pngPath(root, cardId),
    cellsPath(root, cardId, cols, rows, mode),
  ]
}

export const clearArgv = (python: string, root: string): string[] => [python, `${root}/scripts/card_cells.py`, '--clear-cache', cacheDir(root)]

// ---------- cells ----------

/** Standard padded base64 of little-endian u32 words. */
export function packCells(words: Uint32Array): string {
  const bytes = new Uint8Array(words.buffer, words.byteOffset, words.byteLength) as Uint8Array & { toBase64(): string }
  return bytes.toBase64()
}

/** The base64 text a helper file holds, when it is a whole grid of this size; otherwise undefined. */
export function parseCellsFile(text: string, cols: number, rows: number): string | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const file = raw as { v?: unknown; cols?: unknown; rows?: unknown; cells?: unknown }
  if (file.v !== 1 || file.cols !== cols || file.rows !== rows || typeof file.cells !== 'string') return undefined
  return file.cells.length === Math.ceil((cols * rows * 12) / 3) * 4 ? file.cells : undefined
}

const NAVY = 0x1f3f8c
const EDGE = 0x0e1e46
const RED = 0xe3350d
const WHITE = 0xf2f2f2
const BAND = 0x1a1a1a
const FIELD = 0x2a55b0

/** The back of a card: a navy field, a darker border and a red-over-white disc with a dark band. */
export function backCells(cols: number, rows: number): string {
  const words = new Uint32Array(cols * rows * 3)
  const cx = cols / 2
  const cy = rows / 2
  const radius = Math.min(cols, rows * 2) * 0.3
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const at = (y * cols + x) * 3
      let glyph = 0x20
      let color = NAVY
      if (x === 0 || y === 0 || x === cols - 1 || y === rows - 1) color = EDGE
      else {
        const dx = x + 0.5 - cx
        const dy = (y + 0.5 - cy) * 2
        const d = Math.hypot(dx, dy)
        if (d <= radius) {
          glyph = 0x2588
          color = Math.abs(dy) < radius * 0.12 ? BAND : dy < 0 ? RED : WHITE
        } else if (d <= radius * 1.25) color = FIELD
      }
      words[at] = glyph
      words[at + 1] = color
      words[at + 2] = color
    }
  }
  return packCells(words)
}
