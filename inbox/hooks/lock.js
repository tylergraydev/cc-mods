import { shortDuration } from './watch';
// Per-task lock files in .inbox/.locks/, so two Claude sessions in one repo do
// not work or review the same task. $.fs has no exclusive create, so taking a
// lock is best effort: write, read back, and trust it only if the nonce is ours.
export const LOCK_DIR = '.inbox/.locks';
export const lockPath = (id) => `${LOCK_DIR}/${String(id).padStart(3, '0')}.lock`;
const stampIso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
/** Reads a lock file; undefined for anything that is not one. */
export function parseLock(text) {
    try {
        const raw = JSON.parse(text.trim());
        if (typeof raw !== 'object' || raw === null)
            return undefined;
        const lock = raw;
        if (typeof lock.task !== 'number' || typeof lock.session !== 'string' || typeof lock.refreshedAt !== 'string')
            return undefined;
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
        };
    }
    catch {
        return undefined;
    }
}
export const serializeLock = (lock) => `${JSON.stringify(lock)}\n`;
export function lockState(lock, now, me, staleMs) {
    if (!lock || lock.released)
        return 'free';
    if (lock.session === me)
        return 'mine';
    const refreshed = Date.parse(lock.refreshedAt);
    return Number.isNaN(refreshed) || now - refreshed > staleMs ? 'stale' : 'held';
}
/** `other session abcd1234 (review, refreshed 2m ago)`. */
export function describeLock(lock, now) {
    const ago = shortDuration(now - Date.parse(lock.refreshedAt));
    return `other session ${lock.session.slice(0, 8)} (${lock.phase}, refreshed ${ago} ago)`;
}
export async function readLock($, id) {
    const text = await $.fs.read(lockPath(id)).catch(() => undefined);
    return typeof text === 'string' ? parseLock(text) : undefined;
}
/** Every lock file as it stands now, by task. */
export async function loadLocks($) {
    if (!(await $.fs.exists(LOCK_DIR).catch(() => false)))
        return [];
    const entries = await $.fs.list(LOCK_DIR).catch(() => []);
    const locks = [];
    for (const entry of entries) {
        if (entry.kind !== 'file' || !entry.name.endsWith('.lock'))
            continue;
        const text = await $.fs.read(`${LOCK_DIR}/${entry.name}`).catch(() => undefined);
        const lock = typeof text === 'string' ? parseLock(text) : undefined;
        if (lock)
            locks.push(lock);
    }
    return locks.sort((a, b) => a.task - b.task);
}
/** Takes the task's lock for this session; refuses while another live session holds it. */
export async function acquireLock($, id, phase, me, now, staleMs) {
    const held = await readLock($, id);
    const state = lockState(held, now, me, staleMs);
    if (state === 'held' && held)
        return { ok: false, reason: `#${id} locked by ${describeLock(held, now)}` };
    const host = await $.env.get('COMPUTERNAME').catch(() => undefined);
    const nonce = `${me}:${now}:${Math.random().toString(36).slice(2, 8)}`;
    const lock = {
        task: id,
        phase,
        session: me,
        ...(host ? { host } : {}),
        acquiredAt: state === 'mine' && held ? held.acquiredAt : stampIso(now),
        refreshedAt: stampIso(now),
        nonce,
        released: false,
    };
    await $.fs.write(lockPath(id), serializeLock(lock));
    const back = await readLock($, id);
    if (back?.nonce !== nonce) {
        return { ok: false, reason: `#${id} locked by ${back ? describeLock(back, now) : 'another session'}` };
    }
    return { ok: true, ...(state === 'stale' && held ? { tookOver: held } : {}) };
}
/** Marks a lock released by rewriting it; there is no delete. */
export async function releaseLock($, id, now) {
    const held = await readLock($, id);
    if (!held || held.released)
        return;
    await $.fs.write(lockPath(id), serializeLock({ ...held, released: true, releasedAt: stampIso(now) }));
}
/** Rewrites refreshedAt on a lock this session owns. */
export async function refreshLock($, id, me, now) {
    const held = await readLock($, id);
    if (!held || held.released || held.session !== me)
        return;
    await $.fs.write(lockPath(id), serializeLock({ ...held, refreshedAt: stampIso(now) }));
}
