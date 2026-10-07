import type { InboxLock, InboxPhase } from '../types'
import { shortDuration } from './watch'

// Per-item lock files in inbox/.locks/, so two Claude sessions in one repo do
// not work or review the same item. $.fs has no exclusive create, so taking a
// lock is best effort: write, read back, and trust it only if the nonce is ours.
// The pure side lives here; the reads and writes sit in register.tsx, since a
// hooks module may not hand `$` to a function across an import.

export const LOCK_DIR = 'inbox/.locks'

export const lockPath = (name: string) => `${LOCK_DIR}/${name}.lock`

export type LockState = 'free' | 'mine' | 'stale' | 'held'

const stampIso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')

/** Reads a lock file; undefined for anything that is not one. */
export function parseLock(text: string): InboxLock | undefined {
  try {
    const raw: unknown = JSON.parse(text.trim())
    if (typeof raw !== 'object' || raw === null) return undefined
    const lock = raw as Partial<InboxLock>
    if (typeof lock.task !== 'string' || typeof lock.session !== 'string' || typeof lock.refreshedAt !== 'string') return undefined
    return {
      task: lock.task,
      phase: lock.phase === 'review' ? 'review' : 'work',
      session: lock.session,
      ...(typeof lock.host === 'string' ? { host: lock.host } : {}),
      acquiredAt: typeof lock.acquiredAt === 'string' ? lock.acquiredAt : lock.refreshedAt,
      refreshedAt: lock.refreshedAt,
      nonce: typeof lock.nonce === 'string' ? lock.nonce : '',
      released: lock.released === true,
      ...(typeof lock.releasedAt === 'string' ? { releasedAt: lock.releasedAt } : {}),
    }
  } catch {
    return undefined
  }
}

export const serializeLock = (lock: InboxLock) => `${JSON.stringify(lock)}\n`

export function lockState(lock: InboxLock | undefined, now: number, me: string, staleMs: number): LockState {
  if (!lock || lock.released) return 'free'
  if (lock.session === me) return 'mine'
  const refreshed = Date.parse(lock.refreshedAt)
  return Number.isNaN(refreshed) || now - refreshed > staleMs ? 'stale' : 'held'
}

/** `other session abcd1234 (review, refreshed 2m ago)`. */
export function describeLock(lock: InboxLock, now: number): string {
  const ago = shortDuration(now - Date.parse(lock.refreshedAt))
  return `other session ${lock.session.slice(0, 8)} (${lock.phase}, refreshed ${ago} ago)`
}

/** What taking a lock writes, or why it is refused. `tookOver` is the stale lock it replaces. */
export function claimLock(
  held: InboxLock | undefined,
  id: string,
  phase: InboxPhase,
  me: string,
  now: number,
  staleMs: number,
  host: string | undefined,
): { lock: InboxLock; tookOver?: InboxLock } | { reason: string } {
  const state = lockState(held, now, me, staleMs)
  if (state === 'held' && held) return { reason: `${id} locked by ${describeLock(held, now)}` }
  const nonce = `${me}:${now}:${Math.random().toString(36).slice(2, 8)}`
  const lock: InboxLock = {
    task: id,
    phase,
    session: me,
    ...(host ? { host } : {}),
    acquiredAt: state === 'mine' && held ? held.acquiredAt : stampIso(now),
    refreshedAt: stampIso(now),
    nonce,
    released: false,
  }
  return { lock, ...(state === 'stale' && held ? { tookOver: held } : {}) }
}

export const releasedLock = (lock: InboxLock, now: number): InboxLock => ({ ...lock, released: true, releasedAt: stampIso(now) })

export const refreshedLock = (lock: InboxLock, now: number): InboxLock => ({ ...lock, refreshedAt: stampIso(now) })
