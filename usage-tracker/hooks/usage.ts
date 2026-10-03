import type { UsagePoint, UsageSource, UsageWindow } from '../types'

export const HOUR = 3_600_000
export const DAY = 24 * HOUR
const HISTORY_MS = 8 * DAY
const HISTORY_MAX = 600

/** Short label and length of a window from its length in minutes. */
export function windowOfMinutes(minutes: number): { label: string; lengthMs: number } {
  const lengthMs = minutes * 60_000
  if (minutes % 1440 === 0) return { label: `${minutes / 1440}d`, lengthMs }
  if (minutes % 60 === 0) return { label: `${minutes / 60}h`, lengthMs }
  return { label: `${minutes}m`, lengthMs }
}

/** Claude Code's rate-limit windows, as `$.session.usage()` reports them. */
export function fromClaude(
  limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[],
  seenAt: number,
): UsageSource | null {
  if (limits.length === 0) return null
  const windows = limits.map((one): UsageWindow => {
    const resetsAt = one.resetsAt ? Date.parse(one.resetsAt) : undefined
    const known =
      one.kind === 'five_hour' ? { label: '5h', lengthMs: 5 * HOUR }
      : one.kind === 'seven_day' ? { label: '7d', lengthMs: 7 * DAY }
      : { label: one.kind.replace(/_/g, ' '), lengthMs: 0 }
    return { ...known, percent: one.percentUsed, resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined }
  })
  return { windows: sortWindows(windows), seenAt }
}

type CodexLimit = { used_percent?: number; window_minutes?: number; resets_at?: number } | null

/**
 * The last `rate_limits` record in a stretch of a Codex rollout file
 * (`~/.codex/sessions/.../rollout-*.jsonl`), or null when none is there.
 * The first line may be cut; it is skipped when it does not parse.
 */
export function fromCodexLog(text: string): UsageSource | null {
  let end = text.length
  while (end > 0) {
    const at = text.lastIndexOf('"rate_limits":{', end)
    if (at < 0) return null
    const start = text.lastIndexOf('\n', at) + 1
    const stop = text.indexOf('\n', at)
    const line = text.slice(start, stop < 0 ? undefined : stop)
    end = start - 1
    let row: { timestamp?: string; payload?: { rate_limits?: Record<string, unknown> } }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const limits = row.payload?.rate_limits
    if (!limits) continue
    const windows: UsageWindow[] = []
    for (const one of [limits.primary, limits.secondary] as CodexLimit[]) {
      if (!one || typeof one.used_percent !== 'number') continue
      const shape = one.window_minutes ? windowOfMinutes(one.window_minutes) : { label: '?', lengthMs: 0 }
      windows.push({
        ...shape,
        percent: one.used_percent,
        resetsAt: typeof one.resets_at === 'number' ? one.resets_at * 1000 : undefined,
      })
    }
    if (windows.length === 0) continue
    const seenAt = row.timestamp ? Date.parse(row.timestamp) : NaN
    const plan = typeof limits.plan_type === 'string' ? limits.plan_type : undefined
    return { windows: sortWindows(windows), seenAt: Number.isFinite(seenAt) ? seenAt : 0, plan }
  }
  return null
}

function sortWindows(windows: UsageWindow[]): UsageWindow[] {
  return [...windows].sort((a, b) => (a.lengthMs || Infinity) - (b.lengthMs || Infinity))
}

/** The window as it stands at `now`: a window past its reset reads 0. */
export function current(win: UsageWindow, now: number): UsageWindow & { isReset: boolean } {
  if (win.resetsAt !== undefined && win.resetsAt <= now) {
    // the next window opens on first use, so its reset is not known yet
    return { ...win, percent: 0, resetsAt: undefined, isReset: true }
  }
  return { ...win, isReset: false }
}

/** Adds a point to a series: on a change, or every 15 minutes; old points drop. */
export function record(series: readonly UsagePoint[] = [], point: UsagePoint): UsagePoint[] {
  const last = series[series.length - 1]
  const isSame = last && last.p === point.p && point.t - last.t < 15 * 60_000
  const kept = isSame ? series : [...series, point]
  return kept.filter(one => point.t - one.t <= HISTORY_MS).slice(-HISTORY_MAX)
}

/** The fraction of the window gone by at `now`, 0 to 1, or undefined. */
export function elapsed(win: UsageWindow, now: number): number | undefined {
  if (win.resetsAt === undefined || win.lengthMs <= 0) return undefined
  const fraction = 1 - (win.resetsAt - now) / win.lengthMs
  return Math.min(1, Math.max(0, fraction))
}

export type Projection =
  | { kind: 'none' }
  | { kind: 'cap'; inMs: number }
  | { kind: 'land'; percent: number }

/**
 * Where this window is headed: the burn rate over the current window's
 * points (at least 10 minutes of them) carried forward to the reset.
 */
export function project(win: UsageWindow, series: readonly UsagePoint[] = [], now: number): Projection {
  if (win.resetsAt === undefined || win.lengthMs <= 0 || win.percent >= 100) return { kind: 'none' }
  const windowStart = win.resetsAt - win.lengthMs
  const lookback = Math.max(windowStart, now - Math.min(win.lengthMs, 2 * DAY))
  const inside = series.filter(one => one.t >= lookback && one.p <= win.percent)
  const first = inside[0]
  if (!first || now - first.t < 10 * 60_000) return { kind: 'none' }
  const rate = (win.percent - first.p) / (now - first.t)
  if (rate <= 0) return { kind: 'land', percent: win.percent }
  const inMs = (100 - win.percent) / rate
  if (now + inMs < win.resetsAt) return { kind: 'cap', inMs }
  return { kind: 'land', percent: Math.min(100, win.percent + rate * (win.resetsAt - now)) }
}

const BLOCKS = '▁▂▃▄▅▆▇█'

/** A sparkline of the series over the window's span, `width` cells. */
export function sparkline(series: readonly UsagePoint[] = [], span: number, now: number, width: number): string {
  if (width <= 0 || span <= 0) return ''
  const from = now - span
  const cells: (number | undefined)[] = Array(width).fill(undefined)
  for (const one of series) {
    if (one.t < from) continue
    const at = Math.min(width - 1, Math.floor(((one.t - from) / span) * width))
    cells[at] = Math.max(cells[at] ?? 0, one.p)
  }
  let carried: number | undefined
  return cells
    .map(value => {
      if (value === undefined) {
        if (carried === undefined) return ' '
        value = carried
      }
      carried = value
      return BLOCKS[Math.min(7, Math.round((Math.min(100, value) / 100) * 7))]
    })
    .join('')
}

/** `2h 13m`, `4d 6h`, `45m`, `now`. */
export function duration(ms: number): string {
  if (ms < 60_000) return 'now'
  const minutes = Math.floor(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`
  return `${rest}m`
}

export function percentText(percent: number): string {
  return `${Math.round(percent)}%`
}
