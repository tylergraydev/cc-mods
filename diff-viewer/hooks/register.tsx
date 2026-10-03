import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { DvChange, DvGit, DvGitFile, DvMode, DvTool, DvView } from '../types'
import { codeChunks, parseGitDiff, parseHunks } from './diff'
import type { Hunk } from './diff'
import {
  EMPTY_TEXT,
  earlierTurns,
  enforceCaps,
  fileList,
  fileRef,
  findFile,
  fitPath,
  gitLine,
  groupFiles,
  isWin,
  makeChange,
  netDiff,
  parseCommand,
  rowWidths,
  sessionLine,
  shownTurn,
  slash,
  statText,
  totals,
  turnLine,
  visibleRowIds,
} from './view'
import type { BeforeRead, FileGroup, Net } from './view'
import { BENCH, fillSlot, inSlot, slotOf } from './bench'

const PANE = 'diff-viewer'
const TITLE = 'Diff'
const NAMES = ['diff', 'diff-viewer'] as const
const GIT_TIMEOUT_MS = 10_000
const DESCRIPTION = 'Diff pane: what Claude changed this turn / this session, per file; git diff on demand'
const HINT = '[turn [N] | session | git | file <path> | clear]'
const OPEN_BUDGET = 120_000

const INITIAL_VIEW: DvView = { mode: 'turn', turn: null, open: null, expandedTurns: [], wrap: false }

const changesAtom = atom({ plugin: 'diff-viewer', key: 'changes' } as const, [] as DvChange[])
const closedTurnsAtom = atom({ plugin: 'diff-viewer', key: 'closedTurns' } as const, 0)
const nextIdAtom = atom({ plugin: 'diff-viewer', key: 'nextId' } as const, 1)
const viewAtom = atom({ plugin: 'diff-viewer', key: 'view' } as const, INITIAL_VIEW)
const gitAtom = atom({ plugin: 'diff-viewer', key: 'git' } as const, null as DvGit | null)

// Module variables: a reload starts them over, the atoms and the store stay.
let cfg = { contextLines: 3, maxChanges: 60, wrap: false }
let gitRunning = false
const diffCache = new Map<string, Net>()

/** Hunks at no fewer than 3 context lines are kept for large files, so a later change of the setting still has them. */
const patchContext = () => Math.max(cfg.contextLines, 3)

/** The net diff of a file group, remembered by its changes' ids and kinds. */
function netCached(group: FileGroup): Net {
  const key = `${group.changes.map(c => `${c.id}${c.kind[0]}`).join(',')}|${cfg.contextLines}`
  let net = diffCache.get(key)
  if (!net) {
    net = netDiff(group, cfg.contextLines)
    if (diffCache.size >= 200) diffCache.clear()
    diffCache.set(key, net)
  }
  return net
}

/** What the file holds now; never throws. */
async function readBefore($: EngineInterface, path: string): Promise<BeforeRead> {
  try {
    return { state: 'ok', text: await $.fs.read(path) }
  } catch {
    return (await $.fs.exists(path).catch(() => false)) ? { state: 'unreadable' } : { state: 'missing' }
  }
}

/** Reads the file after a tool ran and records the change, unless nothing changed. */
async function capture($: EngineInterface, tool: DvTool, path: string, agentId: string | undefined, before: BeforeRead, contentFallback?: string) {
  let after: string | null
  try {
    after = await $.fs.read(path)
  } catch {
    after = contentFallback ?? null
  }
  if (before.state === 'ok' && after === before.text) return
  const root = slash(await $.session.root())
  const turn = (await read($, closedTurnsAtom)) + 1
  let id = 0
  await update($, nextIdAtom, n => {
    id = n
    return n + 1
  })
  const at = await $.clock.now()
  const change = makeChange({ id, path, root, tool, turn, agentId, at, before, after }, patchContext())
  await update($, changesAtom, list => enforceCaps([...list, change], cfg.maxChanges, patchContext()))
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
  return $.ui.open({ id: PANE, title: TITLE, focus: true })
}

async function setMode($: EngineInterface, mode: DvMode) {
  await update($, viewAtom, v => ({ ...v, mode, open: null }))
  await $.store.set('mode', mode)
}

/** One `git diff HEAD` at a time, only when asked for. Failures become the pane's note, never a toast. */
async function runGit($: EngineInterface) {
  if (gitRunning) return
  gitRunning = true
  const closed = await read($, closedTurnsAtom)
  try {
    await update($, gitAtom, prev => ({ files: [], isTruncated: false, ranAtTurn: closed, ...prev, isRunning: true }))
    const root = slash(await $.session.root())
    const exe = isWin(root) ? 'git.exe' : 'git'
    const fail = (note: string) => update($, gitAtom, () => ({ files: [], note, isTruncated: false, ranAtTurn: closed, isRunning: false }))
    try {
      const ran = await $.process.run(
        [exe, '--no-optional-locks', '-c', 'core.quotepath=off', 'diff', 'HEAD', '--no-color', '--no-ext-diff', '--relative', `--unified=${cfg.contextLines}`, '--'],
        { cwd: root, timeoutMs: GIT_TIMEOUT_MS },
      )
      if (ran.exitCode === 0) {
        const files = parseGitDiff(ran.stdout, isWin(root))
        await update($, gitAtom, () => ({ files, isTruncated: ran.isStdoutTruncated, ranAtTurn: closed, isRunning: false }))
      } else if (/ambiguous argument 'HEAD'|unknown revision/.test(ran.stderr)) {
        await fail('no commits yet (HEAD missing)')
      } else if (/not a git repository/i.test(ran.stderr)) {
        await fail('not a git repository')
      } else {
        await fail(`git exited ${ran.exitCode}: ${(ran.stderr.split('\n')[0] ?? '').slice(0, 80)}`)
      }
    } catch {
      await fail('git not found or timed out')
    }
  } finally {
    gitRunning = false
  }
}

/** Appends `@path` to the prompt draft; never replaces it. */
async function fillRef($: EngineInterface, rel: string) {
  const box = await $.prompt.read()
  const filled = await $.prompt.fill({ text: fileRef(rel, box.text), mode: 'append' })
  if (!filled.isFilled) $.ui.toast('diff-viewer: the prompt box could not take the reference')
}

/** Opens a row's hunks, or closes it when it is the open one. */
async function toggleOpen($: EngineInterface, rowId: string) {
  const wasOpen = (await read($, viewAtom)).open === rowId
  await update($, viewAtom, v => ({ ...v, open: wasOpen ? null : rowId }))
  if (!wasOpen) void $.ui.scroll({ to: { key: `row:${rowId}` }, block: 'start' }).catch(() => {})
}

/** The state a command or a drawing works from. */
async function snapshot($: EngineInterface) {
  const changes = await read($, changesAtom)
  const view = await read($, viewAtom)
  const git = await read($, gitAtom)
  const closed = await read($, closedTurnsAtom)
  return { changes, view, git, closed, ids: visibleRowIds({ mode: view.mode, changes, view, git: git?.files ?? [] }) }
}

/** Opens the next or previous file row, wrapping round. */
async function step($: EngineInterface, dir: 1 | -1) {
  const s = await snapshot($)
  const n = s.ids.length
  if (n === 0) return
  const at = s.view.open === null ? -1 : s.ids.indexOf(s.view.open)
  const next = at < 0 ? (s.ids[dir === 1 ? 0 : n - 1] as string) : (s.ids[(at + dir + n) % n] as string)
  await toggleOpenOnly($, next)
}

/** Opens `rowId` whether or not it was open. */
async function toggleOpenOnly($: EngineInterface, rowId: string) {
  await update($, viewAtom, v => ({ ...v, open: rowId }))
  void $.ui.scroll({ to: { key: `row:${rowId}` }, block: 'start' }).catch(() => {})
}

async function clearAll($: EngineInterface) {
  await update($, changesAtom, () => [])
  await update($, closedTurnsAtom, () => 0)
  await update($, nextIdAtom, () => 1)
  await update($, gitAtom, () => null)
  await update($, viewAtom, v => ({ ...v, open: null, turn: null, expandedTurns: [] }))
  diffCache.clear()
}

/** The one-line summary and file list of what the current mode and turn show. */
async function summaryOf($: EngineInterface) {
  const s = await snapshot($)
  if (s.view.mode === 'git') {
    const files = s.git?.files ?? []
    if (!s.git || s.git.note) return { line: s.git?.note ? `git: ${s.git.note}` : null, items: [] }
    const t = totals(files)
    return { line: gitLine(files.length, t.add, t.del, s.git.ranAtTurn), items: files }
  }
  if (s.view.mode === 'session') {
    if (s.changes.length === 0) return { line: null, items: [] }
    const nets = groupFiles(s.changes).map(g => ({ rel: g.rel, ...netCached(g) }))
    const t = totals(nets)
    return { line: sessionLine(nets.length, s.changes.length, t.add, t.del), items: nets }
  }
  const shown = shownTurn(s.changes, s.view)
  if (shown === null) return { line: null, items: [] }
  const nets = groupFiles(s.changes.filter(c => c.turn === shown)).map(g => ({ rel: g.rel, ...netCached(g) }))
  const t = totals(nets)
  return { line: turnLine(shown, shown === s.closed + 1, nets.length, t.add, t.del), items: nets }
}

async function runCommand($: EngineInterface, args: string): Promise<{ text: string }> {
  const cmd = parseCommand(args)
  if (cmd.kind === 'error') return { text: cmd.text }
  let text = ''
  let isOpening = true
  switch (cmd.kind) {
    case 'open': {
      const sum = await summaryOf($)
      text = sum.line === null ? `Diff opened. ${EMPTY_TEXT}` : `Diff opened: ${sum.line}.`
      break
    }
    case 'turn': {
      await setMode($, 'turn')
      await update($, viewAtom, v => ({ ...v, turn: cmd.turn }))
      const sum = await summaryOf($)
      if (sum.line === null) text = cmd.turn === null ? EMPTY_TEXT : `No changes in turn ${cmd.turn}.`
      else text = `Diff · ${sum.line}\n${fileList(sum.items)}`
      break
    }
    case 'session': {
      await setMode($, 'session')
      const sum = await summaryOf($)
      text = sum.line === null ? EMPTY_TEXT : `Diff · ${sum.line}\n${fileList(sum.items)}`
      break
    }
    case 'git': {
      await setMode($, 'git')
      await runGit($)
      const sum = await summaryOf($)
      text = sum.line === null ? 'Diff · git: nothing yet' : `Diff · ${sum.line}${sum.items.length > 0 ? `\n${fileList(sum.items)}` : ''}`
      break
    }
    case 'file': {
      const s = await snapshot($)
      const root = slash(await $.session.root())
      const key = findFile(
        s.changes.map(c => c.key),
        root,
        cmd.path,
      )
      if (key !== null) {
        const group = groupFiles(s.changes.filter(c => c.key === key))[0] as FileGroup
        const net = netCached(group)
        await setMode($, 'session')
        await update($, viewAtom, v => ({ ...v, open: `s:${key}` }))
        const turns = [...new Set(group.changes.map(c => c.turn))].join(', ')
        const k = group.changes.length
        const stat = statText(net.add, net.del)
        text = `Diff · ${group.rel}: ${stat.plus} ${stat.minus} in ${k} change${k === 1 ? '' : 's'} (turn${turns.includes(',') ? 's' : ''} ${turns}).`
        break
      }
      const gitKey = findFile(
        (s.git?.files ?? []).map(f => f.key),
        root,
        cmd.path,
      )
      if (gitKey !== null) {
        await setMode($, 'git')
        await update($, viewAtom, v => ({ ...v, open: `g:${gitKey}` }))
        text = `Diff · ${gitKey}: from the git record.`
        break
      }
      isOpening = false
      text = `No recorded change to ${cmd.path}. Try /diff git.`
      break
    }
    case 'clear': {
      const n = (await read($, changesAtom)).length
      await clearAll($)
      isOpening = false
      text = `Diff record cleared (${n} changes forgotten).`
      break
    }
  }
  if (isOpening) {
    const placed = await openPane($)
    if (!placed.isPlaced) text += `\nThe pane is waiting: ${placed.reason ?? 'no room for it yet'}. Try /workbench first.`
  }
  return { text }
}

export const register: Register = (on, options) => {
  // a reload starts over: nothing from the previous load is trusted
  gitRunning = false
  diffCache.clear()
  const ctx = typeof options.contextLines === 'number' && Number.isFinite(options.contextLines) ? Math.round(options.contextLines) : 3
  const max = typeof options.maxChanges === 'number' && Number.isFinite(options.maxChanges) ? Math.round(options.maxChanges) : 60
  cfg = { contextLines: Math.min(10, Math.max(0, ctx)), maxChanges: Math.min(500, Math.max(5, max)), wrap: options.wrap === true }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // `diff` may be a built-in's name and refused; /diff-viewer is always registered too.
    for (const name of NAMES) {
      try {
        await $.command.register({ name, description: DESCRIPTION, argumentHint: HINT, immediate: true })
      } catch {
        // refused: the other name stands in
      }
    }
    const stored = await $.store.get('mode')
    const view = await read($, viewAtom)
    const isFresh = JSON.stringify(view) === JSON.stringify(INITIAL_VIEW)
    const mode: DvMode = stored === 'turn' || stored === 'session' || stored === 'git' ? stored : view.mode
    await update($, viewAtom, v => ({ ...v, mode, ...(isFresh ? { wrap: cfg.wrap } : {}) }))

    return started
  })

  for (const command of NAMES) {
    on('command.run', { command }, async ($, e) => runCommand($, e.args ?? ''))
  }

  // Read the file before and after the tool runs, so the diff is of what really landed. Subagent edits count too.
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const before = await readBefore($, e.file_path)
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      try {
        await capture($, 'Write', e.file_path, e.agentId, before, e.content)
      } catch {
        // never break the tool
      }
    }
    return ran
  })
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const before = await readBefore($, e.file_path)
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      try {
        await capture($, 'Edit', e.file_path, e.agentId, before)
      } catch {
        // never break the tool
      }
    }
    return ran
  })
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const before = await readBefore($, e.notebook_path)
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      try {
        await capture($, 'NotebookEdit', e.notebook_path, e.agentId, before)
      } catch {
        // never break the tool
      }
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) await update($, closedTurnsAtom, n => n + 1)
    return done
  })

  // /clear starts a new conversation: the record starts over.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    if (e.reason === 'clear') await clearAll($)
    return ended
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e, false))

  // Inside the workbench: fill this pane's slot in its frame.
  on('ui.render', { component: 'Pane', requestId: BENCH }, async ($, e, next) => {
    const frame = await next(e)
    const slot = slotOf(frame, PANE)
    return slot ? fillSlot(frame, PANE, await drawPane($, inSlot(e, slot.columns), true)) : frame
  })
}

type Entry = {
  id: string
  rel: string
  add: number
  del: number
  tag?: string
  extra?: string
  net?: Net
  git?: DvGitFile
}

const GIT_BADGE: Record<DvGitFile['status'], string> = { modified: '', added: 'A', deleted: 'D', renamed: 'R', binary: 'bin' }

/** The pane's drawing, in its own pane or in a workbench slot. Reads, never writes. */
async function drawPane($: EngineInterface, e: RenderInput<'Pane'>, inBench: boolean) {
  const { Box, Text, Button, Code } = $.ui.resolve(e)
  const s = await snapshot($)
  const { view } = s
  const width = e.props.bodyColumns ?? 40

  const shown = shownTurn(s.changes, view)
  const entriesOf = (changes: DvChange[], prefix: string, isSession: boolean): Entry[] =>
    groupFiles(changes).map(g => {
      const net = netCached(g)
      const tags = [net.tag, g.agents.length > 0 ? 'sub' : undefined].filter(Boolean).join(' ')
      return { id: `${prefix}:${g.key}`, rel: g.rel, add: net.add, del: net.del, tag: tags, extra: isSession && g.changes.length > 1 ? `×${g.changes.length}` : undefined, net }
    })

  const gitEntries: Entry[] = (s.git?.files ?? []).map(f => ({
    id: `g:${f.key}`,
    rel: f.rel,
    add: f.add,
    del: f.del,
    tag: GIT_BADGE[f.status],
    git: f,
  }))

  // the hunks of the open row, as dim notes and Code elements
  const hunksView = (entry: Entry) => {
    const notes: string[] = []
    const parts: Array<{ label?: string; hunks?: Hunk[]; note?: string }> = []
    if (entry.net) {
      notes.push(...entry.net.notes)
      if (entry.net.tag === 'new') notes.unshift('new file')
      for (const sec of entry.net.sections) {
        if (sec.hunks) parts.push({ label: sec.label, hunks: sec.hunks })
        else if (sec.patch !== undefined) parts.push({ label: sec.label, hunks: parseHunks(sec.patch) })
        else parts.push({ label: sec.label, note: sec.note })
      }
      if (entry.net.diff && entry.net.diff.hunks.length === 0 && !notes.includes('only line endings changed')) notes.push('no net change')
    } else if (entry.git) {
      const f = entry.git
      if (f.status === 'renamed') notes.push(`renamed from ${f.from ?? '?'}`)
      if (f.status === 'binary') notes.push('binary file')
      else if (f.isTooLarge) notes.push('too large to show (counts only)')
      else if (f.hunks === '') notes.push('no content changes')
      else parts.push({ hunks: parseHunks(f.hunks) })
    }
    let budget = OPEN_BUDGET
    let dropped = 0
    let n = 0
    const body: unknown[] = []
    parts.forEach((part, si) => {
      if (part.label) {
        body.push(
          <Box key={`sec:${entry.id}:${si}`}>
            <Text dimColor wrap="truncate">
              {part.label}
            </Text>
          </Box>,
        )
      }
      if (part.note) {
        body.push(
          <Box key={`secn:${entry.id}:${si}`}>
            <Text dimColor wrap="truncate">
              {part.note}
            </Text>
          </Box>,
        )
      }
      if (!part.hunks) return
      const chunks = codeChunks(part.hunks, 9000, Math.max(0, budget))
      dropped += chunks.droppedHunks
      for (const src of chunks.sources) {
        budget -= src.length
        body.push(
          <Box key={`hunk:${entry.id}:${n}`}>
            <Code source={src} format="diff" path={entry.rel} wrap={view.wrap ? 'wrap' : 'truncate-end'} />
          </Box>,
        )
        n += 1
      }
    })
    if (dropped > 0) notes.push(`… ${dropped} more hunks not shown`)
    return (
      <Box key={`hunks:${entry.id}`} flexDirection="column" marginBottom={1}>
        <Box key={`hn:${entry.id}`} flexDirection="column">
          {notes.map((note, i) => (
            <Box key={`hn:${entry.id}:${i}`}>
              <Text dimColor wrap="truncate">
                {note}
              </Text>
            </Box>
          ))}
        </Box>
        {body as never}
      </Box>
    )
  }

  const rowView = (entry: Entry) => {
    const isOpen = view.open === entry.id
    const stat = statText(entry.add, entry.del)
    const tagText = [entry.tag, entry.extra].filter(Boolean).join(' ')
    const { pathW } = rowWidths(width, stat.plus, stat.minus, tagText)
    return (
      <Box key={`item:${entry.id}`} flexDirection="column">
        <Box key={`row:${entry.id}`} flexDirection="row">
          <Button key={`f:${entry.id}`} plain label={isOpen ? '▾' : '▸'} onPress={() => void toggleOpen($, entry.id)} />
          <Box key={`st:${entry.id}`}>
            <Text color="green" dimColor={entry.add <= 0}>
              {` ${stat.plus}`}
            </Text>
            <Text color="red" dimColor={entry.del <= 0}>
              {` ${stat.minus} `}
            </Text>
          </Box>
          <Button key={`ref:${entry.id}`} plain label={fitPath(entry.rel, pathW)} onPress={() => void fillRef($, entry.rel)} />
          {tagText ? (
            <Box key={`tag:${entry.id}`}>
              <Text dimColor>{` ${tagText}`}</Text>
            </Box>
          ) : null}
        </Box>
        {isOpen ? hunksView(entry) : null}
      </Box>
    )
  }

  // header and summary
  let title = 'Diff · session'
  let isCurrent = false
  let sum = ''
  let shownEntries: Entry[] = []
  if (view.mode === 'turn') {
    title = shown === null ? 'Diff · turn' : `Diff · turn ${shown}`
    isCurrent = shown !== null && shown === s.closed + 1
    shownEntries = shown === null ? [] : entriesOf(s.changes.filter(c => c.turn === shown), `t${shown}`, false)
    if (shown !== null) {
      const t = totals(shownEntries)
      sum = turnLine(shown, false, shownEntries.length, t.add, t.del)
    }
  } else if (view.mode === 'session') {
    shownEntries = entriesOf(s.changes, 's', true)
    const t = totals(shownEntries)
    sum = sessionLine(shownEntries.length, s.changes.length, t.add, t.del)
  } else {
    title = 'Diff · git'
    shownEntries = gitEntries
    const g = s.git
    if (!g) sum = 'press g to run git diff'
    else if (g.isRunning) sum = 'git diff running…'
    else if (g.note) sum = `git: ${g.note}`
    else {
      const t = totals(gitEntries)
      sum = gitLine(gitEntries.length, t.add, t.del, g.ranAtTurn)
    }
  }
  let note = ''
  if (view.mode === 'git') note = s.git?.isTruncated ? 'git diff cut at 4 MiB' : s.git && !s.git.note && !s.git.isRunning && gitEntries.length === 0 ? 'no changes against HEAD' : ''
  else if (s.changes.length === 0) note = EMPTY_TEXT

  const earlier = view.mode === 'turn' ? earlierTurns(s.changes, shown) : []
  const toggleTurn = (t: number) => update($, viewAtom, v => ({ ...v, expandedTurns: v.expandedTurns.includes(t) ? v.expandedTurns.filter(x => x !== t) : [...v.expandedTurns, t] }))

  return (
    <Box flexDirection="column">
      <Box key="hdr" flexDirection="row">
        <Text bold>{title}</Text>
        {isCurrent ? <Text dimColor> (open)</Text> : null}
      </Box>
      <Box key="sum">
        <Text dimColor wrap="truncate">
          {sum}
        </Text>
      </Box>
      <Box key="tools" flexDirection="row" flexWrap="wrap" gap={1}>
        <Button key="next" plain hotkey="j" label="next" onPress={() => void step($, 1)} />
        <Button key="prev" plain hotkey="k" label="prev" onPress={() => void step($, -1)} />
        <Button key="mode" plain hotkey="u" label={view.mode === 'turn' ? 'session' : 'turn'} onPress={() => void setMode($, view.mode === 'turn' ? 'session' : 'turn')} />
        <Button
          key="git"
          plain
          hotkey="g"
          label="git"
          onPress={() =>
            void (async () => {
              await setMode($, 'git')
              await runGit($)
            })()
          }
        />
        <Button key="wrap" plain hotkey="w" dimColor={!view.wrap} label="wrap" onPress={() => void update($, viewAtom, v => ({ ...v, wrap: !v.wrap }))} />
        {view.open !== null ? <Button key="all" plain hotkey="b" label="all" onPress={() => void update($, viewAtom, v => ({ ...v, open: null }))} /> : null}
        {inBench ? null : <Button key="close" plain role="dismiss" label="close" onPress={() => void $.ui.close({ id: PANE })} />}
      </Box>
      {note ? (
        <Box key="note">
          <Text dimColor wrap="truncate">
            {note}
          </Text>
        </Box>
      ) : null}
      {shownEntries.map(rowView)}
      {earlier.length > 0 ? (
        <Box key="earlier" flexDirection="column">
          <Box key="earlier-h">
            <Text dimColor>earlier turns</Text>
          </Box>
          {earlier.map(t => {
            const isExpanded = view.expandedTurns.includes(t)
            const entries = entriesOf(s.changes.filter(c => c.turn === t), `t${t}`, false)
            const tot = totals(entries)
            const stat = statText(tot.add, tot.del)
            return (
              <Box key={`tg:${t}`} flexDirection="column">
                <Box key={`trow:${t}`} flexDirection="row">
                  <Button key={`turn:${t}`} plain label={`${isExpanded ? '▾' : '▸'} turn ${t} · ${entries.length} file${entries.length === 1 ? '' : 's'}`} onPress={() => void toggleTurn(t)} />
                  <Box key={`tst:${t}`}>
                    <Text color="green" dimColor={tot.add <= 0}>
                      {` ${stat.plus}`}
                    </Text>
                    <Text color="red" dimColor={tot.del <= 0}>
                      {` ${stat.minus}`}
                    </Text>
                  </Box>
                </Box>
                {isExpanded ? entries.map(rowView) : null}
              </Box>
            )
          })}
        </Box>
      ) : null}
    </Box>
  )
}
