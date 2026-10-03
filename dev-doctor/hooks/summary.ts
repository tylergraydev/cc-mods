import type { DoctorCheckId, DoctorHolder, DoctorResult, DoctorRun } from '../types'
import { hasProjectMarker } from './gates'

/** A PowerShell single-quoted literal. */
export const psq = (text: string) => `'${text.replaceAll("'", "''")}'`

const ids = (results: DoctorResult[], status: DoctorResult['status']) =>
  results
    .filter(r => r.status === status)
    .map(r => r.id)
    .sort()

/** The ids of failing checks, sorted. */
export const failIds = (results: DoctorResult[]): DoctorCheckId[] => ids(results, 'fail')

/** `doctor: 7/9 ✓`; nothing when no project marker matched and nothing failed. */
export function statusLine(run: DoctorRun): string | undefined {
  const ran = run.results.filter(r => r.status !== 'skip')
  const fails = ran.filter(r => r.status === 'fail').length
  if (fails === 0 && !hasProjectMarker(run.markers)) return undefined
  const ok = ran.filter(r => r.status === 'pass' || r.status === 'warn').length
  return `doctor: ${ok}/${ran.length} ${fails > 0 ? '✗' : '✓'}`
}

/** The toast, only when `now` holds a failing id that `before` did not. */
export function toastText(now: DoctorCheckId[], before: DoctorCheckId[]): string | undefined {
  if (!now.some(id => !before.includes(id))) return undefined
  return `dev-doctor FAIL: ${[...now].sort().join(', ')} — /dev-doctor`
}

const holderText = (h: DoctorHolder) => `${h.port} ${h.image} PID ${h.pid}`
const byPort = (a: DoctorHolder, b: DoctorHolder) => a.port - b.port || a.pid - b.pid

/**
 * The prompt section: at most 4 lines, stable. Only sorted ids, ports, image
 * names and PIDs; no ages, times or durations. Empty when there is nothing to say.
 */
export function composeText(results: DoctorResult[]): string {
  const fails = failIds(results)
  const holders = (results.find(r => r.id === 'ports')?.holders ?? []).slice().sort(byPort)
  const own = holders.filter(h => h.isOwn)
  const other = holders.filter(h => !h.isOwn)
  if (fails.length === 0 && own.length === 0) return ''
  const out = [
    fails.length > 0
      ? `Environment check (dev-doctor): FAIL ${fails.join(', ')}.`
      : 'Environment check (dev-doctor): watched ports are in use.',
  ]
  if (own.length > 0) {
    out.push(`Held by this repo's running app: ${own.map(holderText).join(', ')}.`)
    out.push('Those apps are running: do not kill or restart them; ask the user first.')
  }
  if (other.length > 0) out.push(`Held by other processes: ${other.map(holderText).join(', ')}.`)
  return out.slice(0, 4).join('\n')
}

/** What `/dev-doctor` tells the model: names, statuses, one-line evidence. */
export function summaryForModel(run: DoctorRun | null): string {
  if (!run) return 'dev-doctor has not run yet.'
  const rows = [...run.results].sort(byStatus).map(r => `${r.status.toUpperCase()} ${r.name}: ${r.evidence}`)
  return [`dev-doctor in ${run.root}:`, ...rows].join('\n')
}

const RANK = { fail: 0, warn: 1, pass: 2, skip: 3 } as const
/** Fail first, then warn, pass, skip. */
export const byStatus = (a: DoctorResult, b: DoctorResult) => RANK[a.status] - RANK[b.status]
