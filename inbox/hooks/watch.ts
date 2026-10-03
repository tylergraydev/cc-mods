import type { PluginOptions, SessionMessage } from 'claude-code'

import type { InboxRun, InboxWatch } from '../types'

// The watchdog's pure side: the config, the heartbeat taken from an agent's
// message rows, and the toast-once latch. Nothing here reads the clock.

export type WatchConfig = {
  idleMs: number
  timeoutMs: number
  /** Wall-clock cap in ms; 0 is off. */
  maxRunMs: number
  onTimeout: 'mark' | 'nudge' | 'redeploy'
  lockStaleMs: number
  trailer: string
}

const MINUTE = 60_000
const RANK: Record<InboxWatch, number> = { active: 0, idle: 1, timedOut: 2 }

const minutes = (options: PluginOptions, key: string, fallback: number) => {
  const value = Number(options[key])
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/** The userConfig values as milliseconds, clamped so idle >= 1 minute and timeout > idle. */
export function watchConfig(options: PluginOptions): WatchConfig {
  const idle = Math.max(1, minutes(options, 'idleMinutes', 10))
  const timeout = Math.max(idle + 1, minutes(options, 'timeoutMinutes', 30))
  const on = options.onTimeout
  const trailer = typeof options.commitTrailer === 'string' ? options.commitTrailer.trim() : ''
  return {
    idleMs: idle * MINUTE,
    timeoutMs: timeout * MINUTE,
    maxRunMs: minutes(options, 'maxRunMinutes', 0) * MINUTE,
    onTimeout: on === 'nudge' || on === 'redeploy' ? on : 'mark',
    lockStaleMs: Math.max(1, minutes(options, 'lockStaleMinutes', 20)) * MINUTE,
    trailer: trailer || 'Inbox-Task',
  }
}

/** A short tool label: the tool and the most telling input, as the pane shows it. */
export function toolLabel(tool: string, input: Record<string, unknown>): string {
  const pick = ['file_path', 'pattern', 'command', 'url', 'query', 'path', 'description']
    .map(key => input[key])
    .find((value): value is string => typeof value === 'string' && value.length > 0)
  if (!pick) return tool
  const short = pick.includes('/') || pick.includes('\\') ? (pick.split(/[\\/]/).pop() ?? pick) : pick
  return `${tool} ${short.length > 48 ? `${short.slice(0, 47)}…` : short}`
}

/** Changes whenever the agent's conversation moves: a row, a finished call or a result. */
export function fingerprint(rows: readonly SessionMessage[]): string {
  let answered = 0
  let results = 0
  for (const row of rows) {
    answered += row.toolUses.filter(use => use.text !== undefined).length
    results += row.toolResults?.length ?? 0
  }
  return `${rows.length}:${answered}:${results}`
}

/** Tool calls the agent has made, finished or not. */
export const toolCount = (rows: readonly SessionMessage[]) => rows.reduce((sum, row) => sum + row.toolUses.length, 0)

/** The call in flight, if the last assistant row ends in one nothing has answered. */
export function inFlight(rows: readonly SessionMessage[]): string | undefined {
  const last = [...rows].reverse().find(row => row.role === 'assistant')
  const use = last?.toolUses[last.toolUses.length - 1]
  return use && use.text === undefined ? toolLabel(use.tool, use.input) : undefined
}

/** The run after a poll: the heartbeat moves only when the fingerprint did. */
export function observe(run: InboxRun, now: number, fp: string, waitingOn: string | undefined): InboxRun {
  // the first poll only sets the baseline: startedAt already counts as activity
  const moved = run.seen !== undefined && fp !== run.seen
  const { waitingOn: _before, ...rest } = run
  return { ...rest, seen: fp, ...(moved ? { lastActivityAt: now } : {}), ...(waitingOn ? { waitingOn } : {}) }
}

export function level(run: InboxRun, now: number, cfg: WatchConfig): InboxWatch {
  const idle = now - run.lastActivityAt
  const wall = now - run.startedAt
  if (idle >= cfg.timeoutMs || (cfg.maxRunMs > 0 && wall >= cfg.maxRunMs)) return 'timedOut'
  return idle >= cfg.idleMs ? 'idle' : 'active'
}

/** The toast-once latch: `fire` is set only when the level rose above the one announced. */
export function step(run: InboxRun, now: number, cfg: WatchConfig): { run: InboxRun; fire: InboxWatch | undefined } {
  const lvl = level(run, now, cfg)
  if (lvl === run.watch) return { run, fire: undefined }
  return { run: { ...run, watch: lvl }, fire: RANK[lvl] > RANK[run.watch] ? lvl : undefined }
}

/** 40s, 4m, 1h05m. */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** The heartbeat note beside a live run's row. */
export function beatText(run: InboxRun, now: number, cfg: WatchConfig): { text: string; tone: 'dim' | 'yellow' | 'red' } {
  const idle = shortDuration(now - run.lastActivityAt)
  const lvl = level(run, now, cfg)
  if (lvl === 'timedOut') return { text: `timed out · idle ${idle}`, tone: 'red' }
  const text = run.waitingOn ? `in ${run.waitingOn.split(' ')[0]} ${idle}` : `idle ${idle}`
  return { text, tone: lvl === 'idle' ? 'yellow' : 'dim' }
}

/** How many live runs are idle and how many timed out, for the header and the summary. */
export function stallCounts(runs: readonly InboxRun[], now: number, cfg: WatchConfig) {
  const live = runs.filter(run => run.status === 'running')
  const by = (lvl: InboxWatch) => live.filter(run => level(run, now, cfg) === lvl).length
  return { idle: by('idle'), timedOut: by('timedOut') }
}

/** The last tool the agent called, for the pane's "now" line. */
export function lastTool(rows: readonly SessionMessage[]): string | undefined {
  const last = [...rows].reverse().find(row => row.role === 'assistant' && row.toolUses.length > 0)
  const use = last?.toolUses[last.toolUses.length - 1]
  return use ? toolLabel(use.tool, use.input) : undefined
}

/** Tool calls that came back as errors. */
export const errorCount = (rows: readonly SessionMessage[]) =>
  rows.reduce((sum, row) => sum + row.toolUses.filter(use => use.isError).length, 0)
