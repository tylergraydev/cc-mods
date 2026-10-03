import type { DvChange, DvGitFile, DvMode, DvTool, DvView } from '../types'
import { diffTexts, unified } from './diff'
import type { FileDiff, Hunk } from './diff'

// Pure logic for the records: what a change is, the caps on keeping them, how
// they group into turns and files, row ids, commands and text that fits a
// narrow pane. No `$`; register.tsx does the engine work.

export const MAX_CHANGE_TEXT = 204800
export const MAX_DIFF_LINES = 50_000
export const MAX_TOTAL_TEXT = 4_194_304
export const MAX_TURNS_SHOWN = 10

export const USAGE = 'Usage: /diff [turn [N] | session | git | file <path> | clear]'
export const EMPTY_TEXT = "No changes recorded yet. Claude's Write, Edit and NotebookEdit calls show here; g runs git diff."

export type BeforeRead = { state: 'ok'; text: string } | { state: 'missing' } | { state: 'unreadable' }

export type MakeInput = {
  id: number
  path: string
  root: string
  tool: DvTool
  turn: number
  agentId: string | undefined
  at: number
  before: BeforeRead
  after: string | null
}

// ---- paths ----

export const slash = (p: string): string => p.replace(/\\/g, '/')
export const isWin = (p: string): boolean => /^[A-Za-z]:\//.test(p)
const isAbs = (p: string): boolean => /^([A-Za-z]:\/|\/)/.test(p)

/** `abs` relative to `root` when under it, else the slashed absolute path; spelling as given. */
export function relOf(root: string, abs: string): string {
  const r = slash(root).replace(/\/+$/, '')
  let s = slash(abs)
  if (!isAbs(s)) s = `${r}/${s}`
  const win = isWin(r)
  const under = win ? s.toLowerCase().startsWith(`${r.toLowerCase()}/`) : s.startsWith(`${r}/`)
  return under ? s.slice(r.length + 1) : s
}

/** The identity of a file: relpath, lowercased when the root is a Windows path. */
export function keyOf(root: string, abs: string): string {
  const rel = relOf(root, abs)
  return isWin(slash(root)) ? rel.toLowerCase() : rel
}

/** What a click on a path appends to the prompt (never replacing the draft). */
export function fileRef(rel: string, draft: string): string {
  const ref = /\s/.test(rel) ? `@"${rel}"` : `@${rel}`
  return `${draft && !/\s$/.test(draft) ? ' ' : ''}${ref} `
}

// ---- making and capping changes ----

const lineCount = (text: string): number => {
  let n = 0
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n += 1
  return n + 1
}

/** One recorded change from what the file held before and after a tool ran. */
export function makeChange(input: MakeInput, patchContext: number): DvChange {
  const { id, path, root, tool, turn, agentId, at, before, after } = input
  const base: DvChange = {
    id,
    path: slash(path),
    key: keyOf(root, path),
    rel: relOf(root, path),
    tool,
    turn,
    at,
    isNew: before.state === 'missing',
    kind: 'text',
    add: 0,
    del: 0,
  }
  if (agentId !== undefined) base.agentId = agentId
  if (before.state === 'unreadable' || after === null) {
    return { ...base, kind: 'unreadable', add: -1, del: -1, note: 'over 4 MiB or unreadable' }
  }
  const beforeText = before.state === 'ok' ? before.text : ''
  if (beforeText.includes('\u0000') || after.includes('\u0000')) return { ...base, kind: 'binary', add: -1, del: -1, note: 'binary' }
  if (beforeText.length + after.length <= MAX_CHANGE_TEXT) {
    const d = diffTexts(beforeText, after, patchContext)
    const out: DvChange = { ...base, before: beforeText, after, add: d.add, del: d.del }
    if (d.note) out.note = d.note
    return out
  }
  if (lineCount(beforeText) > MAX_DIFF_LINES || lineCount(after) > MAX_DIFF_LINES) {
    return { ...base, kind: 'too-large', add: -1, del: -1, note: 'too large to show' }
  }
  const d = diffTexts(beforeText, after, patchContext)
  const patch = unified(d.hunks)
  if (patch.length <= MAX_CHANGE_TEXT) return { ...base, kind: 'patch', patch, add: d.add, del: d.del, ...(d.note ? { note: d.note } : {}) }
  return { ...base, kind: 'too-large', add: d.add, del: d.del, note: 'too large to show' }
}

const textSize = (c: DvChange): number => (c.kind === 'text' ? (c.before?.length ?? 0) + (c.after?.length ?? 0) : 0)

/** Keeps the newest `maxChanges`, then squeezes the oldest whole texts into patches while over the total cap. */
export function enforceCaps(changes: DvChange[], maxChanges: number, ctx: number): DvChange[] {
  const list = changes.slice(-maxChanges)
  let total = list.reduce((sum, c) => sum + textSize(c), 0)
  for (let i = 0; i < list.length && total > MAX_TOTAL_TEXT; i++) {
    const c = list[i] as DvChange
    if (c.kind !== 'text') continue
    total -= textSize(c)
    const patch = unified(diffTexts(c.before ?? '', c.after ?? '', ctx).hunks)
    const { before: _b, after: _a, ...rest } = c
    list[i] = patch.length > MAX_CHANGE_TEXT ? { ...rest, kind: 'too-large', note: 'too large to show' } : { ...rest, kind: 'patch', patch }
  }
  return list
}

// ---- grouping ----

export type FileGroup = { key: string; rel: string; changes: DvChange[]; agents: string[] }

export const turnsOf = (changes: DvChange[]): number[] => [...new Set(changes.map(c => c.turn))].sort((a, b) => b - a)
export const latestTurn = (changes: DvChange[]): number | null => (changes.length === 0 ? null : Math.max(...changes.map(c => c.turn)))

/** One group per file, ordered by path. */
export function groupFiles(changes: DvChange[]): FileGroup[] {
  const by = new Map<string, FileGroup>()
  for (const c of [...changes].sort((a, b) => a.id - b.id)) {
    let g = by.get(c.key)
    if (!g) {
      g = { key: c.key, rel: c.rel, changes: [], agents: [] }
      by.set(c.key, g)
    }
    g.rel = c.rel
    g.changes.push(c)
    if (c.agentId !== undefined && !g.agents.includes(c.agentId)) g.agents.push(c.agentId)
  }
  return [...by.values()].sort((a, b) => a.rel.toLowerCase().localeCompare(b.rel.toLowerCase()))
}

export type Section = { label: string; hunks: Hunk[] | null; patch?: string; note?: string }
export type Net = { diff: FileDiff | null; sections: Section[]; add: number; del: number; tag?: 'new' | 'bin' | 'big' | '?'; notes: string[] }

/** A file's change over a set of changes: the net diff when it can be had, else one section per change. */
export function netDiff(group: FileGroup, ctx: number): Net {
  const list = group.changes
  const first = list[0] as DvChange
  const last = list[list.length - 1] as DvChange
  const notes: string[] = []
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1] as DvChange
    const next = list[i] as DvChange
    if (prev.kind === 'text' && next.kind === 'text' && prev.after !== next.before) {
      notes.push('edited outside Claude between changes')
      break
    }
  }
  let tag: Net['tag']
  if (first.isNew) tag = 'new'
  else if (list.some(c => c.kind === 'binary')) tag = 'bin'
  else if (list.some(c => c.kind === 'patch' || c.kind === 'too-large')) tag = 'big'
  else if (list.some(c => c.kind === 'unreadable')) tag = '?'

  if (first.kind === 'text' && last.kind === 'text') {
    const diff = diffTexts(first.before ?? '', last.after ?? '', ctx)
    if (diff.note) notes.push(diff.isSame ? 'only line endings changed' : diff.note)
    if (diff.isApprox) notes.push('approximate diff')
    return { diff, sections: [{ label: '', hunks: diff.hunks }], add: diff.add, del: diff.del, tag, notes }
  }
  let add = 0
  let del = 0
  let unknown = false
  const sections: Section[] = list.map(c => {
    const label = `#${c.id} · ${c.tool} · turn ${c.turn}`
    if (c.add < 0) unknown = true
    else {
      add += c.add
      del += c.del
    }
    if (c.kind === 'text') return { label, hunks: diffTexts(c.before ?? '', c.after ?? '', ctx).hunks }
    if (c.kind === 'patch') return { label, hunks: null, patch: c.patch ?? '' }
    return { label, hunks: null, note: c.kind === 'too-large' ? 'too large to show' : c.kind === 'binary' ? 'binary file' : 'over 4 MiB or unreadable' }
  })
  return { diff: null, sections, add: unknown ? -1 : add, del: unknown ? -1 : del, tag, notes }
}

// ---- rows ----

export type VisibleModel = { mode: DvMode; changes: DvChange[]; view: DvView; git: DvGitFile[] }

/** The turn the turn view shows: the chosen one, else the latest with changes. */
export const shownTurn = (changes: DvChange[], view: DvView): number | null => view.turn ?? latestTurn(changes)

/** The earlier turns listed under the shown one, newest first. */
export const earlierTurns = (changes: DvChange[], shown: number | null): number[] => turnsOf(changes).filter(t => t !== shown).slice(0, MAX_TURNS_SHOWN)

/** The file row ids in draw order; `j` and `k` walk this list. */
export function visibleRowIds(m: VisibleModel): string[] {
  if (m.mode === 'git') return m.git.map(f => `g:${f.key}`)
  if (m.mode === 'session') return groupFiles(m.changes).map(g => `s:${g.key}`)
  const shown = shownTurn(m.changes, m.view)
  const ids: string[] = []
  if (shown !== null) for (const g of groupFiles(m.changes.filter(c => c.turn === shown))) ids.push(`t${shown}:${g.key}`)
  for (const t of earlierTurns(m.changes, shown)) {
    if (!m.view.expandedTurns.includes(t)) continue
    for (const g of groupFiles(m.changes.filter(c => c.turn === t))) ids.push(`t${t}:${g.key}`)
  }
  return ids
}

// ---- commands ----

export type Command =
  | { kind: 'open' }
  | { kind: 'turn'; turn: number | null }
  | { kind: 'session' }
  | { kind: 'git' }
  | { kind: 'file'; path: string }
  | { kind: 'clear' }
  | { kind: 'error'; text: string }

export function parseCommand(args: string): Command {
  const text = args.trim()
  if (text === '') return { kind: 'open' }
  const [word = '', ...rest] = text.split(/\s+/)
  const tail = text.slice(word.length).trim()
  switch (word.toLowerCase()) {
    case 'turn': {
      if (rest.length === 0) return { kind: 'turn', turn: null }
      return rest.length === 1 && /^\d+$/.test(tail) ? { kind: 'turn', turn: Number(tail) } : { kind: 'error', text: USAGE }
    }
    case 'session':
      return rest.length === 0 ? { kind: 'session' } : { kind: 'error', text: USAGE }
    case 'git':
      return rest.length === 0 ? { kind: 'git' } : { kind: 'error', text: USAGE }
    case 'clear':
      return rest.length === 0 ? { kind: 'clear' } : { kind: 'error', text: USAGE }
    case 'file': {
      const path = tail.replace(/^(["'])(.*)\1$/, '$2')
      return path === '' ? { kind: 'error', text: 'Usage: /diff file <path>' } : { kind: 'file', path }
    }
    default:
      return { kind: 'error', text: USAGE }
  }
}

/** The key of the recorded file a path names: exact, else a unique tail or base-name match. */
export function findFile(keys: string[], root: string, path: string): string | null {
  const win = isWin(slash(root))
  const exact = keyOf(root, path)
  if (keys.includes(exact)) return exact
  const want = (win ? slash(path).toLowerCase() : slash(path)).replace(/^\.\//, '')
  const hits = keys.filter(k => k.endsWith(`/${want}`) || k.split('/').pop() === want)
  return hits.length === 1 ? (hits[0] as string) : null
}

// ---- fitting and messages ----

export const statText = (add: number, del: number): { plus: string; minus: string } => ({ plus: add < 0 ? '+?' : `+${add}`, minus: del < 0 ? '−?' : `−${del}` })

/** `rel` cut to `w` columns: its tail, led by `…`, cut at a `/` when one lies in it. */
export function fitPath(rel: string, w: number): string {
  if (rel.length <= w) return rel
  let tail = rel.slice(-(w - 1))
  const slashAt = tail.indexOf('/')
  if (slashAt >= 0 && slashAt < tail.length - 1 && rel.slice(rel.lastIndexOf('/') + 1).length <= w - 1) tail = tail.slice(slashAt)
  return `…${tail}`
}

/** Columns left for the path in a file row. */
export const rowWidths = (width: number, plus: string, minus: string, tag: string): { pathW: number } => ({
  pathW: Math.max(8, width - 2 - plus.length - 1 - minus.length - 1 - (tag ? tag.length + 1 : 0)),
})

const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`
const stats = (add: number, del: number) => {
  const s = statText(add, del)
  return `${s.plus} ${s.minus}`
}

/** Sums the known counts of a set of files. */
export const totals = (items: { add: number; del: number }[]): { add: number; del: number } => ({
  add: items.reduce((n, i) => n + Math.max(0, i.add), 0),
  del: items.reduce((n, i) => n + Math.max(0, i.del), 0),
})

export const turnLine = (n: number, isOpen: boolean, count: number, add: number, del: number): string => `turn ${n}${isOpen ? ' (open)' : ''}: ${files(count)} ${stats(add, del)}`
export const sessionLine = (count: number, changes: number, add: number, del: number): string => `session: ${files(count)} in ${changes} change${changes === 1 ? '' : 's'} ${stats(add, del)}`
export const gitLine = (count: number, add: number, del: number, turn: number): string => `git: ${files(count)} vs HEAD ${stats(add, del)} (as of turn ${turn})`

export function fileList(items: { rel: string; add: number; del: number }[], max = 15): string {
  const lines = items.slice(0, max).map(i => `  ${i.rel} ${stats(i.add, i.del)}`)
  if (items.length > max) lines.push(`  … +${items.length - max} more`)
  return lines.join('\n')
}
