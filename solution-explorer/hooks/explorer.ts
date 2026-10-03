import type {
  ExEntry,
  ExFilter,
  ExFlags,
  ExGit,
  ExGitMark,
  ExListing,
  ExProject,
  ExRules,
  ExSolution,
  GitCode,
} from '../types'

// Pure logic of the explorer: paths, ignore rules, .sln/.slnx and git parsing,
// the flattened tree, commands. Nothing here touches `$`; the two walkers that
// need the disk take an Io of closures that register.tsx builds.

export const MAX_ROWS = 1500
export const FIND_MAX_DIRS = 60
export const FIND_MAX_DEPTH = 10
export const USAGE = '/explorer [refresh | root <path> | find <text> | collapse | show <relative path>]'

/** The disk, as closures over `$` made in register.tsx. */
export type Io = {
  list: (abs: string) => Promise<ExEntry[]>
  read: (abs: string) => Promise<string>
}

// ---------------------------------------------------------------- paths

/** Forward slashes, repeats collapsed (a leading `//` kept), no trailing slash except at a root. */
export function slash(p: string): string {
  let s = p.split('\\').join('/')
  const unc = s.startsWith('//')
  s = s.replace(/\/{2,}/g, '/')
  if (unc) s = `/${s}`
  if (s.length > 1 && s.endsWith('/') && !/^[A-Za-z]:\/$/.test(s)) s = s.slice(0, -1)
  return s
}

export const isWin = (root: string): boolean => /^[A-Za-z]:\//.test(slash(root))

/** The key every map lookup uses: Windows paths are case-insensitive. */
export const keyOf = (p: string): string => slash(p).toLowerCase()

const isAbsolute = (p: string): boolean => /^[A-Za-z]:\//.test(p) || p.startsWith('/')

/** Resolves `.` and `..`; null when the path climbs out of the root. */
export function normRel(p: string): string | null {
  const out: string[] = []
  for (const part of slash(p).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return null
      out.pop()
    } else {
      out.push(part)
    }
  }
  return out.join('/')
}

/** `p` relative to `root` (original spelling kept), '' for the root itself, null when outside. */
export function toRel(root: string, p: string): string | null {
  const s = slash(p)
  if (isAbsolute(s)) {
    const k = keyOf(s)
    const r = keyOf(root)
    if (k === r) return ''
    const base = r.endsWith('/') ? r : `${r}/`
    return k.startsWith(base) ? s.slice(base.length) : null
  }
  return normRel(s)
}

export const join = (root: string, rel: string): string => (rel ? `${slash(root).replace(/\/$/, '')}/${rel}` : slash(root))
export const parentOf = (rel: string): string => rel.slice(0, Math.max(0, rel.lastIndexOf('/')))
export const baseName = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1)

/** Every folder above `rel`, shallowest first, '' left out. */
export function ancestorsOf(rel: string): string[] {
  const parts = rel.split('/')
  const out: string[] = []
  for (let i = 1; i < parts.length; i += 1) out.push(parts.slice(0, i).join('/'))
  return out
}

// ---------------------------------------------------------------- ignore rules

const DEFAULT_NAMES = ['.git', 'node_modules', 'bin', 'obj', '.vs', 'dist', 'build', 'out']
const DEFAULT_PATHS = ['.claude-plugin/types']

/** Folds one .gitignore line or `hide` item into `rules`. */
function parseIgnoreLine(raw: string, rules: ExRules) {
  let line = raw.trim()
  if (line === '' || line.startsWith('#')) return
  if (line.startsWith('!')) {
    rules.unsupported += 1
    return
  }
  let isDirOnly = false
  let isAnchored = false
  if (line.endsWith('/')) {
    isDirOnly = true
    line = line.slice(0, -1)
  }
  if (line.startsWith('/')) {
    isAnchored = true
    line = line.slice(1)
  }
  if (line.startsWith('**/')) line = line.slice(3)
  if (line === '') return
  const lower = line.toLowerCase()
  if (/^\*\.[A-Za-z0-9_.-]+$/.test(line)) rules.exts.push(lower.slice(1))
  else if (/[*?[\]]/.test(line)) rules.unsupported += 1
  else if (line.includes('/') || isAnchored) rules.paths.push(lower)
  else if (isDirOnly) rules.dirNames.push(lower)
  else rules.names.push(lower)
}

/** Defaults, the root .gitignore and the `hide` config merged, deduplicated. */
export function buildRules(gitignoreText: string | undefined, hideConfig: string): ExRules {
  const rules: ExRules = { names: [...DEFAULT_NAMES], dirNames: [], paths: [...DEFAULT_PATHS], exts: [], unsupported: 0 }
  for (const line of (gitignoreText ?? '').split(/\r?\n/)) parseIgnoreLine(line, rules)
  for (const item of hideConfig.split(',')) parseIgnoreLine(item, rules)
  const uniq = (xs: string[]) => [...new Set(xs)]
  return { names: uniq(rules.names), dirNames: uniq(rules.dirNames), paths: uniq(rules.paths), exts: uniq(rules.exts), unsupported: rules.unsupported }
}

export function isHidden(rel: string, name: string, kind: ExEntry['kind'], rules: ExRules): boolean {
  const lower = name.toLowerCase()
  if (rules.names.includes(lower)) return true
  if (kind === 'dir' && rules.dirNames.includes(lower)) return true
  if (rules.paths.includes(keyOf(rel))) return true
  return kind !== 'dir' && rules.exts.some(ext => lower.endsWith(ext))
}

// ---------------------------------------------------------------- solutions

const SOLUTION_FOLDER = '2150e333-8fdd-42a3-9474-1a3956d46de8'
const PROJ_EXT = /\.[A-Za-z]*proj$/i

function projectOf(name: string, rawPath: string, slnDirRel: string): ExProject | undefined {
  if (!PROJ_EXT.test(rawPath)) return undefined
  const slashed = slash(rawPath)
  const file = normRel(slnDirRel ? `${slnDirRel}/${slashed}` : slashed)
  return { name, file, dir: file === null ? '' : parentOf(file), rawPath }
}

const byName = (a: ExProject, b: ExProject) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())

export function parseSln(text: string, slnDirRel: string): ExProject[] {
  const re = /^Project\("\{([0-9A-Fa-f-]+)\}"\)\s*=\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"\{[0-9A-Fa-f-]+\}"/gm
  const out: ExProject[] = []
  for (const m of text.replace(/^\uFEFF/, '').matchAll(re)) {
    if ((m[1] ?? '').toLowerCase() === SOLUTION_FOLDER) continue
    const project = projectOf(m[2] ?? '', m[3] ?? '', slnDirRel)
    if (project) out.push(project)
  }
  return out.sort(byName)
}

export function parseSlnx(text: string, slnDirRel: string): ExProject[] {
  const out: ExProject[] = []
  for (const m of text.replace(/^\uFEFF/, '').matchAll(/<Project\b[^>]*?\bPath\s*=\s*"([^"]+)"/g)) {
    const rawPath = m[1] ?? ''
    const project = projectOf(baseName(slash(rawPath)).replace(/\.[^.]*$/, ''), rawPath, slnDirRel)
    if (project) out.push(project)
  }
  return out.sort(byName)
}

/** The .sln or .slnx in the root, else one level down; null when there is none. */
export async function findSolution(io: Io, rootAbs: string): Promise<ExSolution | null> {
  const defaults = buildRules(undefined, '')
  const isSln = (e: ExEntry) => e.kind === 'file' && /\.slnx?$/i.test(e.name)
  const sorted = (xs: string[]) => [...xs].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  const top = await io.list(rootAbs).catch(() => [] as ExEntry[])
  let found = sorted(top.filter(isSln).map(e => e.name))
  if (found.length === 0) {
    const dirs = top.filter(e => e.kind === 'dir' && !isHidden(e.name, e.name, 'dir', defaults)).slice(0, 30)
    const below: string[] = []
    for (const dir of dirs) {
      for (const e of await io.list(join(rootAbs, dir.name)).catch(() => [] as ExEntry[])) {
        if (isSln(e)) below.push(`${dir.name}/${e.name}`)
      }
    }
    found = sorted(below)
  }
  const first = found[0]
  if (first === undefined) return null
  // X.sln and X.slnx side by side: the newer format wins
  const twin = found.find(one => one.toLowerCase() === `${first.replace(/\.slnx?$/i, '')}.slnx`.toLowerCase())
  const file = twin ?? first
  const name = baseName(file).replace(/\.slnx?$/i, '')
  const others = found.length - 1
  try {
    const text = await io.read(join(rootAbs, file))
    const dir = parentOf(file)
    return { file, name, projects: /\.slnx$/i.test(file) ? parseSlnx(text, dir) : parseSln(text, dir), others }
  } catch {
    return { file, name, projects: [], others, error: 'unreadable' }
  }
}

// ---------------------------------------------------------------- git

export type GitStatus = { byPath: Record<string, ExGitMark>; untrackedDirs: string[] }

function codeOf(xy: string): GitCode | undefined {
  const x = xy[0] ?? ' '
  const y = xy[1] ?? ' '
  if (xy === '!!') return undefined
  if (xy === '??') return 'untracked'
  if (x === 'U' || y === 'U' || xy === 'AA' || xy === 'DD') return 'conflict'
  if (x === 'R' || y === 'R') return 'renamed'
  if (x === 'C') return 'added'
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'A') return 'added'
  return 'modified'
}

/** `git status --porcelain=v1 -z` (or its newline form) as marks relative to the explorer root. */
export function parsePorcelain(stdout: string, prefix: string): GitStatus {
  const out: GitStatus = { byPath: {}, untrackedDirs: [] }
  const pre = prefix.toLowerCase()
  const take = (xy: string, rawPath: string, from?: string) => {
    const code = codeOf(xy)
    if (code === undefined) return
    let path = slash(rawPath)
    const isDir = rawPath.endsWith('/')
    if (pre) {
      if (!`${path}${isDir ? '/' : ''}`.toLowerCase().startsWith(pre)) return
      path = path.slice(pre.length)
    }
    if (isDir) {
      out.untrackedDirs.push(path.replace(/\/$/, ''))
      return
    }
    const mark: ExGitMark = { code, rel: path }
    if (from !== undefined) mark.from = slash(from)
    out.byPath[keyOf(path)] = mark
  }
  if (stdout.includes('\0')) {
    const fields = stdout.split('\0')
    for (let i = 0; i < fields.length; i += 1) {
      const f = fields[i] ?? ''
      if (f.length < 4) continue
      const xy = f.slice(0, 2)
      // under -z a rename is `R  new` then the old path as its own field
      const hasOrig = /[RC]/.test(xy)
      const orig = hasOrig ? fields[i + 1] : undefined
      if (hasOrig) i += 1
      take(xy, f.slice(3), orig)
    }
  } else {
    for (const line of stdout.split('\n')) {
      const f = line.replace(/\r$/, '')
      if (f.length < 4) continue
      const xy = f.slice(0, 2)
      const unq = (s: string) => s.replace(/^"(.*)"$/, '$1')
      const rest = f.slice(3)
      const arrow = /[RC]/.test(xy) ? rest.indexOf(' -> ') : -1
      if (arrow >= 0) take(xy, unq(rest.slice(arrow + 4)), unq(rest.slice(0, arrow)))
      else take(xy, unq(rest))
    }
  }
  return out
}

/** The mark of `rel`: its own entry, else untracked when inside an untracked folder. */
export function gitMarkOf(rel: string, git: Pick<ExGit, 'byPath' | 'untrackedDirs'>): ExGitMark | undefined {
  const k = keyOf(rel)
  const own = git.byPath[k]
  if (own) return own
  const inside = git.untrackedDirs.some(u => {
    const uk = keyOf(u)
    return uk === '' || uk === k || k.startsWith(`${uk}/`)
  })
  return inside ? { code: 'untracked', rel } : undefined
}

// ---------------------------------------------------------------- rows

export type RowKind = 'sln' | 'project' | 'bucket' | 'dir' | 'file' | 'link' | 'more' | 'note'
export type Row = {
  id: string
  depth: number
  kind: RowKind
  label: string
  rel?: string
  isOpen?: boolean
  touched: boolean
  git?: GitCode
  folderMark?: 'touched' | 'git'
  isHidden?: boolean
  isGone?: boolean
  isDim?: boolean
}

export type FlattenInput = {
  solution: ExSolution | null
  listings: Record<string, ExListing>
  expanded: ReadonlySet<string>
  git: Pick<ExGit, 'byPath' | 'untrackedDirs'>
  /** touched files as rels under the root */
  touched: readonly string[]
  flags: ExFlags
  filterText: string
  rules: ExRules
  maxEntries: number
}

type Item = { rel: string; name: string; kind: 'dir' | 'file' | 'link'; isGone?: boolean; isHidden?: boolean }

const byDirsFirst = (a: Item, b: Item) =>
  (a.kind === 'dir' ? 0 : 1) - (b.kind === 'dir' ? 0 : 1) || a.name.toLowerCase().localeCompare(b.name.toLowerCase())

const entryKind = (e: ExEntry): Item['kind'] => (e.kind === 'dir' ? 'dir' : e.kind === 'other' && e.isLink ? 'link' : 'file')

export function flatten(inp: FlattenInput): Row[] {
  const { solution, listings, expanded, git, flags, rules } = inp
  const touchedKeys = new Set(inp.touched.map(keyOf))
  const touchedAnc = new Set<string>()
  const changedAnc = new Set<string>()
  for (const rel of inp.touched) for (const a of ancestorsOf(rel)) touchedAnc.add(keyOf(a))
  const changedRels = [...Object.values(git.byPath).map(m => m.rel), ...git.untrackedDirs]
  for (const rel of changedRels) {
    for (const a of ancestorsOf(rel)) changedAnc.add(keyOf(a))
    if (git.untrackedDirs.includes(rel)) changedAnc.add(keyOf(rel))
  }
  const anyTouched = touchedKeys.size > 0
  const anyChanged = changedRels.length > 0
  const markOfDir = (rel: string): Row['folderMark'] => {
    if (rel === '') return anyTouched ? 'touched' : anyChanged ? 'git' : undefined
    const k = keyOf(rel)
    return touchedAnc.has(k) ? 'touched' : changedAnc.has(k) ? 'git' : undefined
  }
  const rows: Row[] = []
  const itemRow = (it: Item, depth: number, isOpen?: boolean): Row => {
    const id = `${it.kind === 'dir' ? 'd' : it.kind === 'link' ? 'l' : 'f'}:${it.rel}`
    const mark = gitMarkOf(it.rel, git)
    const row: Row = {
      id, depth, kind: it.kind, label: it.name, rel: it.rel,
      touched: it.kind === 'file' && touchedKeys.has(keyOf(it.rel)),
      ...(mark ? { git: mark.code } : {}),
      ...(it.kind === 'dir' && !mark ? { folderMark: markOfDir(it.rel) } : {}),
      ...(it.kind === 'dir' ? { isOpen } : {}),
      ...(it.isHidden ? { isHidden: true, isDim: true } : {}),
      ...(it.isGone ? { isGone: true, isDim: true } : {}),
    }
    if (it.kind === 'link') row.isDim = true
    return row
  }
  const note = (id: string, depth: number, label: string): Row => ({ id, depth, kind: 'note', label, touched: false, isDim: true })

  const isPathSet = flags.changesOnly || inp.filterText !== ''
  if (!isPathSet) {
    const projectDirs = new Set((solution?.projects ?? []).filter(p => p.file !== null).map(p => keyOf(p.dir)))
    const children = (dir: string, depth: number, parentId: string, exclude?: Set<string>) => {
      const listing = listings[dir]
      if (!listing) {
        rows.push(note(`w:${parentId}`, depth, '… (press r)'))
        return
      }
      if (listing.error) {
        rows.push(note(`u:${parentId}`, depth, 'unreadable'))
        return
      }
      const listedNames = new Set(listing.entries.map(e => e.name.toLowerCase()))
      const items: Item[] = []
      for (const e of listing.entries) {
        const rel = dir ? `${dir}/${e.name}` : e.name
        if (exclude?.has(keyOf(rel))) continue
        const hidden = isHidden(rel, e.name, e.kind, rules)
        if (hidden && !flags.showHidden) continue
        items.push({ rel, name: e.name, kind: entryKind(e), ...(hidden ? { isHidden: true } : {}) })
      }
      for (const m of Object.values(git.byPath)) {
        if (m.code === 'deleted' && keyOf(parentOf(m.rel)) === keyOf(dir) && !listedNames.has(baseName(m.rel).toLowerCase())) {
          items.push({ rel: m.rel, name: baseName(m.rel), kind: 'file', isGone: true })
        }
      }
      items.sort(byDirsFirst)
      for (const it of items.slice(0, inp.maxEntries)) {
        if (it.kind === 'dir') {
          const isOpen = expanded.has(`d:${it.rel}`)
          rows.push(itemRow(it, depth, isOpen))
          if (isOpen) children(it.rel, depth + 1, `d:${it.rel}`, exclude)
        } else {
          rows.push(itemRow(it, depth))
        }
      }
      if (items.length > inp.maxEntries) {
        rows.push({ id: `m:${parentId}`, depth, kind: 'more', label: `… +${items.length - inp.maxEntries} more`, touched: false, isDim: true })
      }
    }
    if (!solution) {
      children('', 0, 'r')
    } else {
      const slnOpen = expanded.has('sln')
      rows.push({
        id: 'sln', depth: 0, kind: 'sln', isOpen: slnOpen, touched: false, folderMark: markOfDir(''),
        label: `Solution '${solution.name}' (${solution.projects.length} projects)`,
      })
      if (slnOpen) {
        let hasRootBucket = true
        for (const p of solution.projects) {
          if (p.file === null) {
            rows.push({ id: `p:out:${p.name}`, depth: 1, kind: 'note', label: `${p.name} (outside root)`, touched: false, isDim: true })
            continue
          }
          if (p.dir === '') hasRootBucket = false
          const id = `p:${p.dir}`
          const isOpen = expanded.has(id)
          rows.push({ id, depth: 1, kind: 'project', rel: p.dir, label: p.name, isOpen, touched: false, folderMark: markOfDir(p.dir) })
          if (isOpen) children(p.dir, 2, id)
        }
        if (hasRootBucket) {
          const isOpen = expanded.has('r')
          rows.push({ id: 'r', depth: 1, kind: 'bucket', label: '(root)', isOpen, touched: false, folderMark: markOfDir('') })
          if (isOpen) children('', 2, 'r', projectDirs)
        }
      }
    }
  } else {
    flattenPathSet(inp, rows, itemRow, note, markOfDir)
  }
  if (rows.length > MAX_ROWS) {
    const more = rows.length - MAX_ROWS
    rows.length = MAX_ROWS
    rows.push(note('m:cap', 0, `… ${more} more rows: use find or collapse`))
  }
  return rows
}

type PathNode = { rel: string; name: string; kind: Item['kind']; isGone: boolean; kids: Map<string, PathNode> }

function flattenPathSet(
  inp: FlattenInput,
  rows: Row[],
  itemRow: (it: Item, depth: number, isOpen?: boolean) => Row,
  note: (id: string, depth: number, label: string) => Row,
  markOfDir: (rel: string) => Row['folderMark'],
) {
  const { solution, listings, git, flags, rules } = inp
  const text = inp.filterText.toLowerCase()
  const hasFilter = inp.filterText !== ''
  type Entry = { rel: string; kind: Item['kind']; isGone: boolean }
  const changes = new Map<string, Entry>()
  for (const rel of inp.touched) changes.set(keyOf(rel), { rel, kind: 'file', isGone: false })
  for (const m of Object.values(git.byPath)) changes.set(keyOf(m.rel), { rel: m.rel, kind: 'file', isGone: m.code === 'deleted' })
  for (const rel of git.untrackedDirs) if (rel !== '') changes.set(keyOf(rel), { rel, kind: 'dir', isGone: false })
  const nameHas = (rel: string) => baseName(rel).toLowerCase().includes(text)

  let set: Map<string, Entry>
  if (hasFilter) {
    const matches = new Map<string, Entry>()
    for (const [dir, listing] of Object.entries(listings)) {
      for (const e of listing.entries) {
        const rel = dir ? `${dir}/${e.name}` : e.name
        if (!e.name.toLowerCase().includes(text)) continue
        if (!flags.showHidden && isHidden(rel, e.name, e.kind, rules)) continue
        matches.set(keyOf(rel), { rel, kind: entryKind(e), isGone: false })
      }
    }
    for (const [k, c] of changes) if (nameHas(c.rel)) matches.set(k, c)
    if (flags.changesOnly) {
      set = new Map()
      for (const [k, c] of matches) if (changes.has(k)) set.set(k, changes.get(k) ?? c)
    } else {
      set = matches
    }
  } else {
    set = changes
  }
  if (set.size === 0) {
    rows.push(note('e:empty', 0, hasFilter ? `No names contain "${inp.filterText}".` : 'No changes yet: nothing touched this session, git clean.'))
    return
  }

  // group each path under the deepest project folder holding it
  const projects = (solution?.projects ?? []).filter(p => p.file !== null)
  const groupOf = (rel: string): string | null => {
    let best: ExProject | undefined
    for (const p of projects) {
      const inside = p.dir === '' || keyOf(rel).startsWith(`${keyOf(p.dir)}/`)
      if (inside && (!best || p.dir.length > best.dir.length)) best = p
    }
    return best ? best.dir : null
  }
  const groups = new Map<string | null, Entry[]>()
  for (const entry of set.values()) {
    const g = groupOf(entry.rel)
    if (g !== null && keyOf(entry.rel) === keyOf(g)) continue
    groups.set(g, [...(groups.get(g) ?? []), entry])
  }

  const emit = (entries: Entry[], baseDir: string, depth: number) => {
    const root: PathNode = { rel: baseDir, name: '', kind: 'dir', isGone: false, kids: new Map() }
    const nodes = new Map<string, PathNode>([[keyOf(baseDir), root]])
    const ensure = (rel: string, kind: Item['kind'], isGone: boolean): PathNode => {
      const k = keyOf(rel)
      const had = nodes.get(k)
      if (had) {
        if (kind !== 'dir') {
          had.kind = kind
          had.isGone = isGone
        }
        return had
      }
      const parent = keyOf(parentOf(rel)) === keyOf(baseDir) ? root : ensure(parentOf(rel), 'dir', false)
      const node: PathNode = { rel, name: baseName(rel), kind, isGone, kids: new Map() }
      nodes.set(k, node)
      parent.kids.set(k, node)
      return node
    }
    for (const entry of entries) ensure(entry.rel, entry.kind, entry.isGone)
    const walk = (node: PathNode, d: number) => {
      const kids = [...node.kids.values()].sort((a, b) => byDirsFirst(a, b))
      for (const kid of kids) {
        const it: Item = { rel: kid.rel, name: kid.name, kind: kid.kind, ...(kid.isGone ? { isGone: true } : {}) }
        const row = itemRow(it, d, kid.kids.size > 0)
        if (kid.kind === 'file' && git.byPath[keyOf(kid.rel)]?.code === 'deleted') row.isGone = true
        if (kid.kind === 'dir' && !row.git && !row.folderMark) row.folderMark = markOfDir(kid.rel)
        rows.push(row)
        walk(kid, d + 1)
      }
    }
    walk(root, depth)
  }

  if (!solution) {
    emit(groups.get(null) ?? [], '', 0)
    return
  }
  rows.push({ id: 'sln', depth: 0, kind: 'sln', isOpen: true, touched: false, folderMark: markOfDir(''), label: `Solution '${solution.name}' (${solution.projects.length} projects)` })
  for (const p of projects) {
    const entries = groups.get(p.dir)
    if (!entries || entries.length === 0) continue
    rows.push({ id: `p:${p.dir}`, depth: 1, kind: 'project', rel: p.dir, label: p.name, isOpen: true, touched: false, folderMark: markOfDir(p.dir) })
    emit(entries, p.dir, 2)
  }
  const rest = groups.get(null)
  if (rest && rest.length > 0) {
    rows.push({ id: 'r', depth: 1, kind: 'bucket', label: '(root)', isOpen: true, touched: false, folderMark: markOfDir('') })
    emit(rest, '', 2)
  }
}

// ---------------------------------------------------------------- fitting

/** `name` cut to `w` columns in the middle, keeping the extension. */
export function fitName(name: string, w: number): string {
  if (name.length <= w) return name
  const head = Math.ceil((w - 1) * 0.6)
  const tail = w - 1 - head
  return `${name.slice(0, head)}…${tail > 0 ? name.slice(-tail) : ''}`
}

// ---------------------------------------------------------------- commands

export type Cmd =
  | { kind: 'open' }
  | { kind: 'refresh' }
  | { kind: 'root'; path: string | null }
  | { kind: 'find'; text: string }
  | { kind: 'collapse' }
  | { kind: 'show'; path: string }
  | { kind: 'error'; text: string }

const unquote = (s: string) => s.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')

export function parseCommand(args: string): Cmd {
  const text = args.trim()
  if (text === '') return { kind: 'open' }
  const space = text.search(/\s/)
  const word = (space < 0 ? text : text.slice(0, space)).toLowerCase()
  const rest = space < 0 ? '' : text.slice(space).trim()
  switch (word) {
    case 'refresh': return { kind: 'refresh' }
    case 'collapse': return { kind: 'collapse' }
    case 'root': return { kind: 'root', path: rest === '' ? null : unquote(rest) }
    case 'find': return { kind: 'find', text: rest }
    case 'show': return rest === '' ? { kind: 'error', text: 'Usage: /explorer show <relative path>' } : { kind: 'show', path: unquote(rest) }
    default: return { kind: 'error', text: USAGE }
  }
}

/** What goes into the prompt box for a click on a file. */
export function fileRef(rel: string, draft: string): string {
  const ref = /\s/.test(rel) ? `@"${rel}"` : `@${rel}`
  return `${draft && !/\s$/.test(draft) ? ' ' : ''}${ref} `
}

// ---------------------------------------------------------------- find

/** Lists the folders not yet in `listings`, breadth first, for a name filter. */
export async function walkForFind(
  io: Io,
  rootAbs: string,
  listings: Record<string, ExListing>,
  rules: ExRules,
  limits: { maxDirs: number; maxDepth: number },
  now = 0,
): Promise<{ added: Record<string, ExListing>; searched: number; isPartial: boolean }> {
  const added: Record<string, ExListing> = {}
  let searched = 0
  let isPartial = false
  let queue: string[] = ['']
  for (let depth = 0; queue.length > 0; depth += 1) {
    if (depth > limits.maxDepth) {
      isPartial = true
      break
    }
    const nextQueue: string[] = []
    for (const dir of queue) {
      let listing = listings[dir] ?? added[dir]
      if (!listing) {
        if (searched >= limits.maxDirs) {
          isPartial = true
          continue
        }
        searched += 1
        try {
          listing = { entries: await io.list(join(rootAbs, dir)), at: now }
        } catch {
          listing = { entries: [], error: 'unreadable', at: now }
        }
        added[dir] = listing
      }
      for (const e of listing.entries) {
        const rel = dir ? `${dir}/${e.name}` : e.name
        if (e.kind === 'dir' && !isHidden(rel, e.name, 'dir', rules)) nextQueue.push(rel)
      }
    }
    queue = nextQueue
  }
  return { added, searched, isPartial }
}

// ---------------------------------------------------------------- summaries

export function summary(touchedUnderRoot: number, outside: number, git: Pick<ExGit, 'byPath' | 'untrackedDirs' | 'note' | 'at'>): string {
  const touched = `${touchedUnderRoot} touched${outside > 0 ? ` (+${outside} outside root)` : ''}`
  if (git.note) return `${touched} · ${git.note}`
  if (git.at > 0) return `${touched} · ${Object.keys(git.byPath).length + git.untrackedDirs.length} changed`
  return touched
}

export const filterText = (f: ExFilter | null): string => f?.text ?? ''

/** `p` against `base` when it is relative, resolving `.` and `..`; absolute paths pass through. */
export function resolveAbs(base: string, p: string): string {
  const s = slash(p)
  if (isAbsolute(s)) return s
  const b = slash(base)
  const prefix = /^[A-Za-z]:\//.test(b) ? b.slice(0, 3) : b.startsWith('/') ? '/' : ''
  const parts = b.slice(prefix.length).split('/').filter(Boolean)
  for (const part of s.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return slash(prefix + parts.join('/'))
}
