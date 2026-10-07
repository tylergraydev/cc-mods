/** Pure logic for cache-clock: no `$` here, so `register.tsx` can pass values in and tests can call it directly. */

export type Config = {
  /** How long the prompt cache keeps a prefix after a request, in minutes. 60 on this plan; 5 while in overage. */
  ttlMinutes: number
  /** Switch to m:ss and a warning glyph under this many minutes. */
  warnMinutes: number
  /** Draw the Compact / Handoff / Clear band once the cache has lapsed. */
  showBand: boolean
  /** Above this many tokens, Compact is the recommended press; below it, Keep going. */
  compactAbove: number
}

import type { Phase, Reading } from '../types'

export type { Phase, Reading }

export const INITIAL: Reading = {
  anchorAt: null,
  working: false,
  phase: 'idle',
  remainingMs: 0,
  coldMinutes: 0,
  dismissed: false,
  tokens: null,
  percent: null,
  hasHandoff: false,
}

const num = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function readConfig(o: Record<string, unknown>): Config {
  return {
    ttlMinutes: num(o.ttlMinutes, 60, 1, 24 * 60),
    warnMinutes: num(o.warnMinutes, 5, 0, 24 * 60),
    showBand: o.showBand === undefined ? true : o.showBand !== false && o.showBand !== 'false',
    compactAbove: num(o.compactAbove, 30_000, 0, 10_000_000),
  }
}

/** The phase and the time left at `now`, from the anchor and whether a turn is running. */
export function phaseAt(
  anchorAt: number | null,
  working: boolean,
  now: number,
  ttlMinutes: number,
  warnMinutes: number,
): { phase: Phase; remainingMs: number; coldMinutes: number } {
  if (working) return { phase: 'working', remainingMs: ttlMinutes * 60_000, coldMinutes: 0 }
  if (anchorAt === null) return { phase: 'idle', remainingMs: 0, coldMinutes: 0 }
  const remainingMs = anchorAt + ttlMinutes * 60_000 - now
  if (remainingMs <= 0) return { phase: 'cold', remainingMs, coldMinutes: Math.floor(Math.abs(remainingMs) / 60_000) }
  if (remainingMs <= warnMinutes * 60_000) return { phase: 'warn', remainingMs, coldMinutes: 0 }
  return { phase: 'warm', remainingMs, coldMinutes: 0 }
}

/** `58m` above the warn line; `4:59` under it. Whole minutes round up so the line never shows `0m` while warm. */
export function formatSpan(ms: number, fine: boolean): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  if (!fine) return `${Math.max(1, Math.ceil(s / 60))}m`
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${sec.toString().padStart(2, '0')}`
}

/** The status line's text: `undefined` clears it. Status-bar labels it `cache:`; alone it reads `cache-clock: …`. */
export function statusText(r: Pick<Reading, 'phase' | 'remainingMs' | 'coldMinutes'>): string | undefined {
  switch (r.phase) {
    case 'idle':
      return undefined
    case 'working':
      return 'warming'
    case 'warm':
      return `${formatSpan(r.remainingMs, false)} left`
    case 'warn':
      return `${formatSpan(r.remainingMs, true)} left ⚠`
    case 'cold':
      return `cold ${r.coldMinutes}m · /cache`
  }
}

export type Advice = {
  primary: 'compact' | 'continue'
  /** One sentence for the band: what the next prompt costs and which press pays least. */
  line: string
}

const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)

/**
 * Which press costs least after a lapse. Every path that sends a request (continuing, compact, handoff) pays the
 * whole context uncached once; only /clear pays nothing. Compact and handoff pay it once and then shrink what every
 * later request re-sends, so they win whenever the context is big enough to be worth shrinking.
 */
export function advise(tokens: number | null, compactAbove: number, coldMinutes: number): Advice {
  const ago = coldMinutes <= 0 ? 'just now' : `${coldMinutes} min ago`
  if (tokens === null) {
    return { primary: 'compact', line: `prompt cache lapsed ${ago} · the next prompt re-sends the whole context uncached` }
  }
  if (tokens < compactAbove) {
    return {
      primary: 'continue',
      line: `prompt cache lapsed ${ago} · the next prompt re-sends ~${k(tokens)} tokens uncached, a small miss: keep going`,
    }
  }
  return {
    primary: 'compact',
    line: `prompt cache lapsed ${ago} · the next prompt re-sends ~${k(tokens)} tokens uncached · compact pays that once and shrinks every prompt after`,
  }
}

export type Command =
  | { kind: 'status' }
  | { kind: 'ttl'; minutes: number }
  | { kind: 'band'; on: boolean }
  | { kind: 'reset' }
  | { kind: 'help' }
  | { kind: 'error'; text: string }

export function parseCommand(args: string | undefined): Command {
  const words = (args ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { kind: 'status' }
  const [head, arg] = words
  switch (head.toLowerCase()) {
    case 'status':
      return { kind: 'status' }
    case 'help':
      return { kind: 'help' }
    case 'reset':
      return { kind: 'reset' }
    case 'band':
      if (arg === 'on') return { kind: 'band', on: true }
      if (arg === 'off') return { kind: 'band', on: false }
      return { kind: 'error', text: 'cache-clock: /cache band on|off' }
    case 'ttl': {
      const n = Number(arg)
      if (!Number.isFinite(n) || n < 1 || n > 24 * 60) return { kind: 'error', text: 'cache-clock: /cache ttl <minutes>, 1 to 1440 (60 normally, 5 in overage)' }
      return { kind: 'ttl', minutes: n }
    }
    default:
      return { kind: 'error', text: `cache-clock: unknown "${head}". ${HELP}` }
  }
}

export const HELP = 'Usage: /cache [status | ttl <minutes> | band on|off | reset | help]'

export function report(r: Reading, ttlMinutes: number, showBand: boolean): string {
  const lines: string[] = []
  switch (r.phase) {
    case 'idle':
      lines.push('cache-clock: no request yet in this context; the countdown starts when the next answer lands.')
      break
    case 'working':
      lines.push('cache-clock: a turn is running; each of its requests refreshes the cache.')
      break
    case 'warm':
    case 'warn':
      lines.push(`cache-clock: the prompt cache holds for another ${formatSpan(r.remainingMs, true)} (TTL ${ttlMinutes} min).`)
      break
    case 'cold':
      lines.push(`cache-clock: the prompt cache lapsed ${r.coldMinutes} min ago (TTL ${ttlMinutes} min). ${advise(r.tokens, 0, r.coldMinutes).line}.`)
      break
  }
  if (r.tokens !== null) lines.push(`Context: ~${k(r.tokens)} tokens${r.percent !== null ? ` (${r.percent}%)` : ''} would be re-sent uncached after a lapse.`)
  lines.push(`Band after a lapse: ${showBand ? 'on' : 'off'}. ${HELP}`)
  return lines.join('\n')
}
