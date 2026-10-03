import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { UsageSnapshot, UsageSource, UsageWindow } from '../types'
import {
  current,
  duration,
  elapsed,
  fromClaude,
  fromCodexLog,
  percentText,
  project,
  record,
  sparkline,
} from './usage'
import { BENCH, fillSlot, inSlot, slotOf } from './bench'

const PANE = 'usage-tracker'
const TITLE = 'Usage'
const POLL_MS = 60_000
const TAIL_BYTES = 1_500_000
const READ_LIMIT = 4_000_000
const ALERT_AT = 90

const EMPTY: UsageSnapshot = { cc: null, codex: null, history: {}, now: 0 }
const snapshot = atom({ plugin: 'usage-tracker', key: 'snapshot' } as const, EMPTY)

const SOURCES = [
  { key: 'cc', name: 'CLAUDE CODE', short: 'CC', accent: '#D97757' },
  { key: 'codex', name: 'CODEX', short: 'Codex', accent: '#10A37F' },
] as const

type Style = { color?: string; dimColor?: boolean; bold?: boolean }
type Run = Style & { text: string }

let isRefreshing = false
let codexSeen: { path: string; mtimeMs: number; size: number; source: UsageSource | null } | undefined
const alerted = new Map<string, number>()

/** The newest Codex rollout files, newest first. */
async function codexFiles($: EngineInterface): Promise<{ path: string; mtimeMs: number; size: number }[]> {
  const home = (await $.env.get('CODEX_HOME')) ?? `${(await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''}/.codex`
  const root = `${home}/sessions`
  if (!(await $.fs.exists(root))) return []
  const dirsOf = async (path: string) =>
    (await $.fs.list(path).catch(() => []))
      .filter(one => one.kind === 'dir')
      .map(one => one.name)
      .sort()
      .reverse()
  const days: string[] = []
  for (const year of await dirsOf(root)) {
    for (const month of await dirsOf(`${root}/${year}`)) {
      for (const day of await dirsOf(`${root}/${year}/${month}`)) {
        days.push(`${root}/${year}/${month}/${day}`)
        if (days.length >= 3) break
      }
      if (days.length >= 3) break
    }
    if (days.length >= 3) break
  }
  const files: { path: string; mtimeMs: number; size: number }[] = []
  for (const day of days) {
    for (const one of await $.fs.list(day).catch(() => [])) {
      if (one.kind === 'file' && one.name.endsWith('.jsonl')) {
        files.push({ path: `${day}/${one.name}`, mtimeMs: one.mtimeMs, size: one.size })
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 5)
}

/** The end of a file, whole when it is small enough to read at once. */
async function tail($: EngineInterface, file: { path: string; size: number }): Promise<string> {
  if (file.size < READ_LIMIT) return $.fs.read(file.path)
  const isWindows = /^[A-Za-z]:/.test(file.path)
  const argv = isWindows
    ? [
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$f=[IO.File]::Open($env:USAGE_TRACKER_FILE,'Open','Read','ReadWrite');$n=[Math]::Min($f.Length,${TAIL_BYTES});[void]$f.Seek(-$n,'End');$b=New-Object byte[] $n;$r=$f.Read($b,0,$n);$f.Close();[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b,0,$r))`,
      ]
    : ['tail', '-c', String(TAIL_BYTES), file.path]
  const ran = await $.process.run(argv, { env: { USAGE_TRACKER_FILE: file.path }, timeoutMs: 15_000 })
  return ran.stdout
}

async function readCodex($: EngineInterface): Promise<UsageSource | null> {
  for (const file of await codexFiles($)) {
    if (codexSeen && codexSeen.path === file.path && codexSeen.mtimeMs === file.mtimeMs && codexSeen.size === file.size) {
      if (codexSeen.source) return codexSeen.source
      continue
    }
    const text = await tail($, file).catch(() => '')
    const source = fromCodexLog(text)
    if (codexSeen === undefined || source) codexSeen = { ...file, source }
    if (source) return source
  }
  return null
}

function alertCrossings($: EngineInterface, short: string, source: UsageSource | null, now: number) {
  for (const raw of source?.windows ?? []) {
    const win = current(raw, now)
    const id = `${short}:${win.label}`
    const before = alerted.get(id)
    alerted.set(id, win.percent)
    if (before !== undefined && before < ALERT_AT && win.percent >= ALERT_AT) {
      $.ui.toast(`${short} ${win.label} usage is at ${percentText(win.percent)}`)
    }
  }
}

function statusText(snap: UsageSnapshot): string | undefined {
  const parts = SOURCES.flatMap(({ key, short }) => {
    const source = snap[key]
    if (!source) return []
    const windows = source.windows.map(raw => {
      const win = current(raw, snap.now)
      return `${win.label} ${percentText(win.percent)}`
    })
    return [`${short} ${windows.join(' ')}`]
  })
  return parts.length > 0 ? parts.join(' · ') : undefined
}

async function refresh($: EngineInterface) {
  if (isRefreshing) return
  isRefreshing = true
  try {
    const now = await $.clock.now()
    const usage = await $.session.usage().catch(() => undefined)
    const cc = usage ? fromClaude(usage.rateLimits, now) : null
    let codexNote: string | undefined
    const codex = await readCodex($).catch(error => {
      codexNote = `could not read ~/.codex: ${String(error).slice(0, 80)}`
      return null
    })
    const held = await read($, snapshot)
    const next: UsageSnapshot = {
      cc: cc ?? held.cc,
      codex: codex ?? held.codex,
      history: { ...held.history },
      now,
      codexNote: codex || held.codex ? undefined : (codexNote ?? 'no Codex sessions found yet'),
    }
    for (const { key } of SOURCES) {
      const fresh = key === 'cc' ? cc : codex
      for (const win of fresh?.windows ?? []) {
        const id = `${key}:${win.label}`
        next.history[id] = record(next.history[id], { t: fresh!.seenAt || now, p: win.percent })
      }
    }
    alertCrossings($, 'CC', next.cc, now)
    alertCrossings($, 'Codex', next.codex, now)
    await update($, snapshot, () => next)
    $.ui.status(statusText(next))
    await $.store.set('snapshot', { ...next, codexNote: undefined })
  } finally {
    isRefreshing = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'usage-tracker',
      description: 'Show 5h and 7d usage for Claude Code and Codex',
    })
    const stored = (await $.store.get('snapshot')) as UsageSnapshot | undefined
    if (stored && typeof stored === 'object' && stored.history) {
      await update($, snapshot, () => ({ ...EMPTY, ...stored }))
    }
    void refresh($)
    $.clock.every(POLL_MS, () => void refresh($))
    void $.ui.open({ id: PANE, title: TITLE })

    return started
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) void refresh($)

    return next(e)
  })

  on('command.run', { command: 'usage-tracker' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    void refresh($)

    return { text: 'Usage pane opened.' }
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
  const { Box, Text } = $.ui.resolve(e)
  const snap = await read($, snapshot)
  const now = snap.now
  const width = Math.max(28, Math.min(64, (e.viewport?.columns ?? 48) - 2))
  const barWidth = Math.max(10, width - 12)

  const runs = (list: Run[], key: string) => (
    <Box key={key} flexDirection="row">
      {list.map((run, i) => (
        <Text key={String(i)} color={run.color} dimColor={run.dimColor} bold={run.bold} wrap="truncate">
          {run.text}
        </Text>
      ))}
    </Box>
  )

  const bar = (win: UsageWindow, color: string): Run[] => {
    const filled = Math.round((Math.min(100, win.percent) / 100) * barWidth)
    const pace = elapsed(win, now)
    const paceAt = pace === undefined ? -1 : Math.min(barWidth - 1, Math.round(pace * barWidth))
    const list: Run[] = []
    for (let i = 0; i < barWidth; i += 1) {
      const run: Run =
        i === paceAt ? { text: '┃', bold: true }
        : i < filled ? { text: '█', color }
        : { text: '░', dimColor: true }
      const last = list[list.length - 1]
      if (last && last.color === run.color && last.dimColor === run.dimColor && last.bold === run.bold) {
        last.text += run.text
      } else {
        list.push(run)
      }
    }
    return list
  }

  const windowRows = (sourceKey: string, raw: UsageWindow) => {
    const win = current(raw, now)
    const series = snap.history[`${sourceKey}:${win.label}`]
    const pace = elapsed(win, now)
    const isAhead = pace !== undefined && win.percent > pace * 100 + 5
    const color = win.percent >= ALERT_AT ? 'red' : isAhead ? 'yellow' : 'green'
    const forecast = win.isReset ? { kind: 'none' as const } : project(win, series, now)
    const reset =
      win.isReset ? 'reset · opens on next use'
      : win.resetsAt !== undefined ? `resets in ${duration(win.resetsAt - now)}`
      : ''
    const forecastRun: Run =
      forecast.kind === 'cap' ? { text: `⚠ hits 100% in ${duration(forecast.inMs)}`, color: 'red', bold: true }
      : forecast.kind === 'land' ? { text: `pace → ~${percentText(forecast.percent)} at reset`, dimColor: true }
      : pace !== undefined && !win.isReset ? { text: isAhead ? 'ahead of even pace' : 'under even pace', dimColor: true }
      : { text: '', dimColor: true }
    const spark = sparkline(series, win.lengthMs || 7 * 86_400_000, now, Math.max(8, Math.min(24, barWidth - 4)))

    return (
      <Box key={`${sourceKey}:${win.label}`} flexDirection="column" marginBottom={1}>
        {runs(
          [
            { text: `${win.label.padEnd(3)} `, bold: true },
            ...bar(win, color),
            { text: ` ${percentText(win.percent).padStart(4)}`, color, bold: true },
          ],
          'bar',
        )}
        {runs([{ text: '    ' }, { text: reset, dimColor: true }], 'reset')}
        {runs([{ text: '    ' }, { text: spark, color }, { text: ' ' }, forecastRun], 'trend')}
      </Box>
    )
  }

  const section = (source: (typeof SOURCES)[number]) => {
    const data = snap[source.key]
    const seen = data
      ? `${data.plan ? `${data.plan} · ` : ''}${data.seenAt ? `read ${duration(now - data.seenAt)} ago`.replace('read now ago', 'live') : ''}`
      : ''
    return (
      <Box key={source.key} flexDirection="column" marginBottom={1}>
        {runs(
          [
            { text: '● ', color: source.accent },
            { text: source.name, bold: true, color: source.accent },
            { text: seen ? `  ${seen}` : '', dimColor: true },
          ],
          'head',
        )}
        {data ? (
          data.windows.map(win => windowRows(source.key, win))
        ) : (
          <Text key="empty" dimColor>
            {source.key === 'cc'
              ? '  waiting for the first response with rate limits'
              : `  ${snap.codexNote ?? 'looking for Codex sessions…'}`}
          </Text>
        )}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {SOURCES.map(section)}
      <Text key="legend" dimColor>
        ┃ even pace · ▁▇ history · refreshes every minute
      </Text>
    </Box>
  )
}
