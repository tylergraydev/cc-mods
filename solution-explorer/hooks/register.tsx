import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { ExEntry, ExFilter, ExFlags, ExGit, ExListing, ExRules, ExSolution, ExTouch, ExView, GitCode } from '../types'
import {
  FIND_MAX_DEPTH,
  FIND_MAX_DIRS,
  USAGE,
  baseName,
  buildRules,
  fileRef,
  findSolution,
  fitName,
  flatten,
  isWin,
  join,
  keyOf,
  parentOf,
  parseCommand,
  parsePorcelain,
  resolveAbs,
  slash,
  summary,
  toRel,
  ancestorsOf,
  walkForFind,
} from './explorer'
import type { Io, Row } from './explorer'
import { BENCH, fillSlot, inSlot, slotOf } from './bench'

const PANE = 'solution-explorer'
const TITLE = 'Explorer'
const NAMES = ['explorer', 'solution-explorer'] as const
const GIT_TIMEOUT_MS = 5000
const DESCRIPTION = 'Solution Explorer-style file tree: projects, git status, files Claude touched'

const EMPTY_RULES: ExRules = { names: [], dirNames: [], paths: [], exts: [], unsupported: 0 }
const EMPTY_GIT: ExGit = { byPath: {}, untrackedDirs: [], at: 0, isRunning: false }

const rootAtom = atom({ plugin: 'solution-explorer', key: 'root' } as const, '')
const listingsAtom = atom({ plugin: 'solution-explorer', key: 'listings' } as const, {} as Record<string, ExListing>)
const expandedAtom = atom({ plugin: 'solution-explorer', key: 'expanded' } as const, ['sln'] as string[])
const gitAtom = atom({ plugin: 'solution-explorer', key: 'git' } as const, EMPTY_GIT)
const touchedAtom = atom({ plugin: 'solution-explorer', key: 'touched' } as const, {} as Record<string, ExTouch>)
const filterAtom = atom({ plugin: 'solution-explorer', key: 'filter' } as const, null as ExFilter | null)
const flagsAtom = atom({ plugin: 'solution-explorer', key: 'flags' } as const, { showHidden: false, changesOnly: false } as ExFlags)
const solutionAtom = atom({ plugin: 'solution-explorer', key: 'solution' } as const, null as ExSolution | null)
const rulesAtom = atom({ plugin: 'solution-explorer', key: 'rules' } as const, EMPTY_RULES)
const revealAtom = atom({ plugin: 'solution-explorer', key: 'reveal' } as const, null as string | null)

// Module variables: a reload starts them over, the atoms and the store stay.
let cfg = { hide: '', gitStatus: true, maxEntries: 400 }
let booted: string | undefined
let gitRunning = false
let gitQueued = false
let wasOpened = false
const prefixCache = new Map<string, string | null>()

const GIT_COLORS: Record<GitCode, { letter: string; color: string }> = {
  modified: { letter: 'M', color: 'yellow' },
  added: { letter: 'A', color: 'green' },
  untracked: { letter: '?', color: 'green' },
  deleted: { letter: 'D', color: 'red' },
  renamed: { letter: 'R', color: 'cyan' },
  conflict: { letter: '!', color: 'red' },
}

/** The disk as closures over `$`, for the pure walkers in explorer.ts. */
const io = ($: EngineInterface): Io => ({
  list: async abs => (await $.fs.list(abs)).map(({ name, kind, isLink }): ExEntry => ({ name, kind, isLink })),
  read: abs => $.fs.read(abs),
})

/** The listing for `rel` whatever its casing, if any. */
function listingFor(listings: Record<string, ExListing>, rel: string): string | undefined {
  if (listings[rel]) return rel
  const k = keyOf(rel)
  return Object.keys(listings).find(one => keyOf(one) === k)
}

/** Lists each folder and stores the answers in one write; a failure becomes an `unreadable` listing. */
async function listMany($: EngineInterface, rels: string[]) {
  const root = await read($, rootAtom)
  const at = await $.clock.now()
  const got: Record<string, ExListing> = {}
  for (const rel of rels) {
    try {
      got[rel] = { entries: await io($).list(join(root, rel)), at }
    } catch {
      got[rel] = { entries: [], error: 'unreadable', at }
    }
  }
  await update($, listingsAtom, old => ({ ...old, ...got }))
}

/** The folders a view keeps open, as rels; the root is always one. */
function openDirs(expanded: readonly string[]): string[] {
  const rels = new Set<string>([''])
  for (const id of expanded) {
    if (id.startsWith('d:')) rels.add(id.slice(2))
    else if (id.startsWith('p:') && !id.startsWith('p:out:')) rels.add(id.slice(2))
  }
  return [...rels]
}

async function saveView($: EngineInterface) {
  const root = await read($, rootAtom)
  if (!root) return
  const saved: ExView = { expanded: await read($, expandedAtom), ...(await read($, flagsAtom)) }
  await $.store.set(`view:${keyOf(root)}`, saved)
}

/** Takes `root` as the explorer's folder: its saved view, ignore rules, solution and open folders. */
async function loadRoot($: EngineInterface, root: string) {
  const stored = (await $.store.get(`view:${keyOf(root)}`)) as Partial<ExView> | undefined
  const expanded = Array.isArray(stored?.expanded) ? stored.expanded.filter(one => typeof one === 'string') : ['sln']
  let gitignore: string | undefined
  try {
    gitignore = await $.fs.read(join(root, '.gitignore'))
  } catch {
    gitignore = undefined
  }
  await update($, rootAtom, () => root)
  await update($, expandedAtom, () => expanded)
  await update($, flagsAtom, () => ({ showHidden: stored?.showHidden === true, changesOnly: stored?.changesOnly === true }))
  await update($, listingsAtom, () => ({}))
  await update($, gitAtom, () => EMPTY_GIT)
  await update($, filterAtom, () => null)
  await update($, revealAtom, () => null)
  await update($, rulesAtom, () => buildRules(gitignore, cfg.hide))
  const solution = await findSolution(io($), root)
  await update($, solutionAtom, () => solution)
  await listMany($, openDirs(expanded))
}

/** Reads the session's folder (and any saved override) once per session root. */
async function boot($: EngineInterface) {
  const sessionRoot = slash(await $.session.root())
  if (booted === keyOf(sessionRoot)) return
  booted = keyOf(sessionRoot)
  let effective = sessionRoot
  const override = await $.store.get(`root:${keyOf(sessionRoot)}`)
  if (typeof override === 'string' && override !== '') {
    try {
      if ((await $.fs.stat(override)).kind === 'dir') effective = slash(override)
    } catch {
      // the saved folder is gone: fall back to the session's
    }
  }
  await loadRoot($, effective)
}

/** One `git status` run at a time; a request that arrives meanwhile runs once more after it. Never toasts. */
async function runGit($: EngineInterface) {
  if (!cfg.gitStatus) {
    await update($, gitAtom, g => ({ ...g, note: 'git marks off' }))
    return
  }
  if (gitRunning) {
    gitQueued = true
    return
  }
  gitRunning = true
  try {
    do {
      gitQueued = false
      const root = await read($, rootAtom)
      const exe = isWin(root) ? 'git.exe' : 'git'
      const rootKey = keyOf(root)
      const note = async (text: string) => update($, gitAtom, () => ({ ...EMPTY_GIT, note: text }))
      let prefix = prefixCache.get(rootKey)
      if (prefix === undefined) {
        try {
          const ran = await $.process.run([exe, 'rev-parse', '--show-prefix'], { cwd: root, timeoutMs: GIT_TIMEOUT_MS })
          prefix = ran.exitCode === 0 ? slash(ran.stdout.trim()).replace(/([^/])$/, '$1/').replace(/^\/$/, '') : null
          prefixCache.set(rootKey, prefix)
        } catch {
          await note('git not found or timed out')
          continue
        }
      }
      if (prefix === null) {
        await note('not a git repository')
        continue
      }
      try {
        const ran = await $.process.run(
          [exe, '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=normal'],
          { cwd: root, timeoutMs: GIT_TIMEOUT_MS },
        )
        if (ran.exitCode === 0) {
          const at = await $.clock.now()
          await update($, gitAtom, () => ({ ...parsePorcelain(ran.stdout, prefix), at, isRunning: false }))
        } else {
          await note('git status failed')
        }
      } catch {
        await note('git not found or timed out')
      }
    } while (gitQueued)
  } finally {
    gitRunning = false
  }
}

async function refreshAll($: EngineInterface) {
  const root = await read($, rootAtom)
  const solution = await findSolution(io($), root)
  await update($, solutionAtom, () => solution)
  await listMany($, openDirs(await read($, expandedAtom)))
  await runGit($)
}

async function refreshExpandedListings($: EngineInterface) {
  await listMany($, openDirs(await read($, expandedAtom)))
}

/** The workbench dock first, when it is installed, so the pane seats at any width. Same as mod-menu's. */
async function ensureDock($: EngineInterface) {
  try {
    const hasBench = (await $.command.list()).some(one => one.name === BENCH)
    if (hasBench) await $.ui.open({ id: BENCH, title: 'Workbench', focus: true })
  } catch {
    // no command list on this surface, or the dock refused: the hosted open below still runs
  }
}

async function openPane($: EngineInterface) {
  await ensureDock($)
  wasOpened = true
  return $.ui.open({ id: PANE, title: TITLE, focus: true })
}

/** Remembers that Claude wrote `path`, and re-lists its folder when that folder is on show. */
async function recordTouch($: EngineInterface, path: string | undefined) {
  if (!path) return
  const sessionRoot = slash(await $.session.root())
  const abs = /^([A-Za-z]:[\\/]|\/)/.test(path) ? slash(path) : join(sessionRoot, slash(path))
  const at = await $.clock.now()
  await update($, touchedAtom, old => ({ ...old, [keyOf(abs)]: { abs, at } }))
  const rel = toRel(await read($, rootAtom), abs)
  if (rel === null) return
  const dir = listingFor(await read($, listingsAtom), parentOf(rel))
  if (dir !== undefined) await listMany($, [dir])
}

/** Touched files as rels under the root, and how many fall outside it. */
function touchedRels(root: string, touched: Record<string, ExTouch>): { inside: string[]; outside: number } {
  const inside: string[] = []
  let outside = 0
  for (const one of Object.values(touched)) {
    const rel = toRel(root, one.abs)
    if (rel === null) outside += 1
    else if (rel !== '') inside.push(rel)
  }
  return { inside, outside }
}

/** Everything a drawing or a summary needs, read from the atoms. */
async function look($: EngineInterface) {
  const root = await read($, rootAtom)
  const touched = touchedRels(root, await read($, touchedAtom))
  const state = {
    root,
    listings: await read($, listingsAtom),
    expanded: await read($, expandedAtom),
    git: await read($, gitAtom),
    filter: await read($, filterAtom),
    flags: await read($, flagsAtom),
    solution: await read($, solutionAtom),
    rules: await read($, rulesAtom),
    reveal: await read($, revealAtom),
    touched,
  }
  const rows = flatten({
    solution: state.solution,
    listings: state.listings,
    expanded: new Set(state.expanded),
    git: state.git,
    touched: touched.inside,
    flags: state.flags,
    filterText: state.filter?.text ?? '',
    rules: state.rules,
    maxEntries: cfg.maxEntries,
  })
  return { ...state, rows, summary: summary(touched.inside.length, touched.outside, state.git) }
}

async function collapse($: EngineInterface) {
  const solution = await read($, solutionAtom)
  await update($, expandedAtom, () => (solution ? ['sln'] : []))
  await update($, revealAtom, () => null)
  await saveView($)
}

async function runCommand($: EngineInterface, args: string): Promise<{ text: string }> {
  await boot($)
  const cmd = parseCommand(args)
  if (cmd.kind === 'error') return { text: cmd.text }
  let text = ''
  switch (cmd.kind) {
    case 'open':
    case 'refresh': {
      await refreshAll($)
      const v = await look($)
      const folders = openDirs(v.expanded).length
      text = cmd.kind === 'open' ? `Explorer opened: ${v.root}. ${v.summary}.` : `Explorer refreshed: ${folders} folders re-listed. ${v.summary}.`
      break
    }
    case 'root': {
      const sessionRoot = slash(await $.session.root())
      const target = cmd.path === null ? sessionRoot : resolveAbs(sessionRoot, cmd.path)
      let isDir = false
      try {
        isDir = (await $.fs.stat(target)).kind === 'dir'
      } catch {
        isDir = false
      }
      if (!isDir) return { text: `Not a folder: ${cmd.path ?? target}` }
      await $.store.set(`root:${keyOf(sessionRoot)}`, cmd.path === null ? '' : target)
      await loadRoot($, target)
      await runGit($)
      text = `Explorer root: ${target}.`
      break
    }
    case 'find': {
      if (cmd.text === '') {
        await update($, filterAtom, () => null)
        text = 'Filter cleared.'
        break
      }
      const root = await read($, rootAtom)
      const found = await walkForFind(io($), root, await read($, listingsAtom), await read($, rulesAtom), { maxDirs: FIND_MAX_DIRS, maxDepth: FIND_MAX_DEPTH }, await $.clock.now())
      await update($, listingsAtom, old => ({ ...old, ...found.added }))
      await update($, filterAtom, () => ({ text: cmd.text, searched: found.searched, isPartial: found.isPartial }))
      const v = await look($)
      const matches = v.rows.filter(row => row.kind === 'file' || row.kind === 'dir' || row.kind === 'link').length
      text = `Showing names containing "${cmd.text}": ${matches} matches (${found.searched} folders searched${found.isPartial ? ', partial' : ''}).`
      break
    }
    case 'collapse': {
      await collapse($)
      text = 'Collapsed.'
      break
    }
    case 'show': {
      const root = await read($, rootAtom)
      const rel = toRel(root, cmd.path)
      const missing = { text: `Not found under the root: ${cmd.path}` }
      if (rel === null || rel === '') return missing
      // list every folder down to the target's parent, then look for the target in it
      const dirs = ['', ...ancestorsOf(rel)]
      for (const dir of dirs) {
        if (listingFor(await read($, listingsAtom), dir) === undefined) await listMany($, [dir])
      }
      const listings = await read($, listingsAtom)
      const parentKey = listingFor(listings, parentOf(rel))
      const hit = parentKey === undefined ? undefined : listings[parentKey]?.entries.find(one => one.name.toLowerCase() === baseName(rel).toLowerCase())
      if (!hit) return missing
      const solution = await read($, solutionAtom)
      const ids = new Set<string>()
      if (solution) {
        ids.add('sln')
        const inside = solution.projects
          .filter(p => p.file !== null && (p.dir === '' || keyOf(rel).startsWith(`${keyOf(p.dir)}/`)))
          .sort((a, b) => b.dir.length - a.dir.length)[0]
        ids.add(inside ? `p:${inside.dir}` : 'r')
      }
      for (const dir of ancestorsOf(rel)) ids.add(`d:${dir}`)
      if (hit.kind === 'dir') ids.add(`d:${rel}`)
      const wasFiltered = (await read($, flagsAtom)).changesOnly || (await read($, filterAtom)) !== null
      await update($, expandedAtom, old => [...new Set([...old, ...ids])])
      await update($, flagsAtom, f => ({ ...f, changesOnly: false }))
      await update($, filterAtom, () => null)
      await update($, revealAtom, () => `${hit.kind === 'dir' ? 'd' : hit.kind === 'other' && hit.isLink ? 'l' : 'f'}:${rel}`)
      await saveView($)
      text = `Revealed ${rel}.${wasFiltered ? ' (changes-only view and filter turned off)' : ''}`
      break
    }
  }
  const placed = await openPane($)
  if (!placed.isPlaced) text += `\nThe pane is waiting: ${placed.reason ?? 'no room for it yet'}. Try /workbench first.`
  return { text }
}

export const register: Register = (on, options) => {
  // a reload starts over: nothing from the previous load is trusted
  booted = undefined
  gitRunning = false
  gitQueued = false
  wasOpened = false
  prefixCache.clear()
  const maxEntries = typeof options.maxEntries === 'number' ? options.maxEntries : 400
  cfg = {
    hide: typeof options.hide === 'string' ? options.hide : '',
    gitStatus: options.gitStatus !== false,
    maxEntries: Math.min(5000, Math.max(20, Number.isFinite(maxEntries) ? maxEntries : 400)),
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // `explorer` may be taken: the engine refuses a name that is not free, and /solution-explorer stands in.
    try {
      await $.command.register({ name: NAMES[0], description: DESCRIPTION, argumentHint: USAGE })
    } catch {
      await $.command.register({ name: NAMES[1], description: DESCRIPTION, argumentHint: USAGE })
    }
    try {
      await boot($)
    } catch {
      // the folder is read again on the first /explorer
    }

    return started
  })

  for (const command of NAMES) {
    on('command.run', { command }, async ($, e) => runCommand($, e.args ?? ''))
  }

  // What Claude writes shows as ●; subagent edits count too.
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await recordTouch($, e.file_path)
    return ran
  })
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await recordTouch($, e.file_path)
    return ran
  })
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await recordTouch($, e.notebook_path)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && wasOpened) {
      void (async () => {
        try {
          await refreshExpandedListings($)
          await runGit($)
        } catch {
          // the next turn tries again
        }
      })()
    }

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e))

  // Inside the workbench: fill this pane's slot in its frame.
  on('ui.render', { component: 'Pane', requestId: BENCH }, async ($, e, next) => {
    const frame = await next(e)
    const slot = slotOf(frame, PANE)
    return slot ? fillSlot(frame, PANE, await drawPane($, inSlot(e, slot.columns))) : frame
  })
}

/** The pane's drawing, in its own pane or in a workbench slot. */
async function drawPane($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const v = await look($)
  const width = e.props.bodyColumns ?? 40
  const maxDepthShown = Math.max(2, Math.floor((width - 14) / 2))

  const clearReveal = () => update($, revealAtom, () => null)

  const toggle = async (row: Row) => {
    const isOpen = (await read($, expandedAtom)).includes(row.id)
    if (!isOpen && row.rel !== undefined && (row.kind === 'dir' || row.kind === 'project')) {
      if (listingFor(await read($, listingsAtom), row.rel) === undefined) await listMany($, [row.rel])
    }
    await update($, expandedAtom, old => (isOpen ? old.filter(one => one !== row.id) : [...old, row.id]))
    await clearReveal()
    await saveView($)
  }

  const pickFile = async (row: Row) => {
    await clearReveal()
    if (row.rel === undefined) return
    const box = await $.prompt.read()
    const filled = await $.prompt.fill({ text: fileRef(row.rel, box.text), mode: 'append' })
    if (!filled.isFilled) $.ui.toast('explorer: the prompt box could not take the reference')
  }

  const toggleFlag = async (name: keyof ExFlags) => {
    await update($, flagsAtom, f => ({ ...f, [name]: !f[name] }))
    await saveView($)
  }

  const rowView = (row: Row) => {
    const isReveal = row.id === v.reveal
    const cols = 2 * Math.min(row.depth, maxDepthShown)
    const indent = row.depth > maxDepthShown ? `…${' '.repeat(Math.max(0, cols - 1))}` : ' '.repeat(cols)
    const hasTwisty = row.kind === 'dir' || row.kind === 'project' || row.kind === 'sln' || row.kind === 'bucket'
    const twisty = hasTwisty ? (row.isOpen ? '▾ ' : '▸ ') : '  '
    const name = fitName(`${row.kind === 'link' ? '↪ ' : ''}${row.label}`, Math.max(6, width - 4 - cols))
    const mark = row.touched || row.folderMark === 'touched' ? '●' : row.folderMark === 'git' ? '•' : ' '
    const gitInfo = row.git ? GIT_COLORS[row.git] : undefined
    const gutter = gitInfo ? gitInfo.letter : row.folderMark === 'git' ? '' : ' '
    return (
      <Box key={`row:${row.id}`} flexDirection="row">
        <Box key={`mark:${row.id}`}>
          <Text color={mark === '•' ? 'yellow' : 'magenta'} dimColor={mark === '•'}>
            {mark}
          </Text>
        </Box>
        <Box key={`git:${row.id}`}>
          <Text color={gitInfo?.color} bold={row.git === 'conflict'} dimColor={row.git === 'deleted'}>
            {gutter === '' ? ' ' : gutter}
          </Text>
        </Box>
        <Box key={`tw:${row.id}`}>
          <Text inverse={isReveal} wrap="truncate">
            {`${indent}${twisty}`}
          </Text>
        </Box>
        {row.isGone ? (
          <Box key={`name:${row.id}`}>
            <Text strikethrough dimColor wrap="truncate">
              {name}
            </Text>
          </Box>
        ) : row.kind === 'more' || row.kind === 'note' || row.kind === 'link' ? (
          <Box key={`name:${row.id}`}>
            <Text dimColor wrap="truncate">
              {name}
            </Text>
          </Box>
        ) : row.kind === 'file' ? (
          <Button key={`n:${row.id}`} plain dimColor={row.isHidden === true} label={name} onPress={() => void pickFile(row)} />
        ) : (
          <Button key={`n:${row.id}`} plain dimColor={row.isHidden === true} label={name} onPress={() => void toggle(row)} />
        )}
        {isReveal ? (
          <Box key={`rev:${row.id}`}>
            <Text dimColor> ◂</Text>
          </Box>
        ) : null}
      </Box>
    )
  }

  const solution = v.solution
  const sub = `${v.summary}${solution ? ` · ${solution.file}${solution.others > 0 ? ` (+${solution.others} more .sln)` : ''}` : ''}`

  return (
    <Box flexDirection="column">
      <Box key="hdr">
        <Text bold wrap="truncate">{`Explorer · ${baseName(v.root) || v.root}`}</Text>
      </Box>
      <Box key="hdr-sum">
        <Text dimColor wrap="truncate">
          {sub}
        </Text>
      </Box>
      <Box key="tools" flexDirection="row" flexWrap="wrap" gap={1}>
        <Button key="refresh" plain hotkey="r" label="refresh" onPress={() => void refreshAll($)} />
        <Button key="hidden" plain hotkey="h" dimColor={!v.flags.showHidden} label="hidden" onPress={() => void toggleFlag('showHidden')} />
        <Button key="changes" plain hotkey="t" dimColor={!v.flags.changesOnly} label="changes" onPress={() => void toggleFlag('changesOnly')} />
        <Button key="collapse" plain hotkey="c" label="collapse" onPress={() => void collapse($)} />
        <Button key="close" plain hotkey="q" label="close" onPress={() => void $.ui.close({ id: PANE })} />
      </Box>
      {v.filter ? (
        <Box key="filter-row" flexDirection="row" gap={1}>
          <Text wrap="truncate">{`find: "${v.filter.text}"`}</Text>
          <Button key="clear-filter" plain label="clear" onPress={() => void update($, filterAtom, () => null)} />
        </Box>
      ) : null}
      {v.rows.map(rowView)}
    </Box>
  )
}
