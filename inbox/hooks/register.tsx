import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { InboxFilter, InboxLock, InboxPhase, InboxRun, InboxStatus, InboxTask } from '../types'
import { BENCH, fillSlot, inSlot, slotOf } from './bench'
import {
  AGENT,
  DIR,
  FOLDERS,
  HELP,
  STATUSES,
  claimFields,
  commitGrepArgv,
  counts,
  elapsedText,
  fileName,
  filtered,
  findTask,
  goalText,
  isItemFile,
  isLive,
  liveRun,
  nextId,
  parseCodexReport,
  parseCommand,
  parseCommitReport,
  parseTask,
  pathOf,
  pending,
  readiness,
  releaseFields,
  reviewBrief,
  rootCandidates,
  serializeTask,
  spawnSpec,
  stamp,
  summary,
  tidyPath,
  toStart,
  toolLabel,
  unclaimFields,
  withFields,
  withSection,
} from './inbox'
import { LOCK_DIR, claimLock, describeLock, lockState, parseLock, refreshedLock, releasedLock, serializeLock } from './lock'
import { beatText, errorCount, fingerprint, inFlight, lastTool, level, observe, shortDuration, stallCounts, step, toolCount, watchConfig } from './watch'
import type { WatchConfig } from './watch'

const PANE = 'inbox'
const TITLE = 'Inbox'
const TICK_MS = 3_000
const LOCK_REFRESH_MS = 60_000
/** How long after the agent list says an agent ended the tick waits for its turn.complete before settling without a report. */
const SETTLE_GRACE_MS = 20_000

const tasks = atom({ plugin: 'inbox', key: 'tasks' } as const, [])
const runs = atom({ plugin: 'inbox', key: 'runs' } as const, [])
const selected = atom({ plugin: 'inbox', key: 'selected' } as const, null)
const filter = atom({ plugin: 'inbox', key: 'filter' } as const, 'active' as InboxFilter)
const drain = atom({ plugin: 'inbox', key: 'drain' } as const, 0)
const clockNow = atom({ plugin: 'inbox', key: 'now' } as const, 0)
const locks = atom({ plugin: 'inbox', key: 'locks' } as const, [])
const sessionId = atom({ plugin: 'inbox', key: 'sessionId' } as const, '')
const inboxRoot = atom({ plugin: 'inbox', key: 'root' } as const, '')
const autoReviewOn = atom({ plugin: 'inbox', key: 'autoReview' } as const, false)

const STATUS: Record<InboxStatus, { glyph: string; color?: string; dimColor?: boolean }> = {
  todo: { glyph: '○' },
  processing: { glyph: '●', color: 'yellow' },
  review: { glyph: '◆', color: 'cyan' },
  blocked: { glyph: '✗', color: 'red' },
  done: { glyph: '✓', color: 'green', dimColor: true },
}
const WAITING: { glyph: string; color?: string; dimColor?: boolean } = { glyph: '◌', dimColor: true }

const TONE = {
  dim: { dimColor: true },
  yellow: { color: 'yellow', bold: true },
  red: { color: 'red', bold: true },
} as const

/** Parsed item files by path, kept while their mtime stands. */
const cache = new Map<string, { mtimeMs: number; task: InboxTask }>()
let isTicking = false
let isPumping = false
/** The userConfig values, set by register. */
let cfg: WatchConfig = watchConfig({})
let codexModel = ''
/** The `autoReview` option: start a reviewer when a worker lands an item in review/. */
let autoReview = false
/** Items this session already started an auto-reviewer on, so a reviewer that ends without moving its item is not respawned forever. */
const autoReviewed = new Set<string>()
/** The repository holding `inbox/`, absolute; '' until one is found. Checked again whenever it stops holding the folder. */
let repoRoot = ''
/** Where the last search looked when it found nothing: the project root, else the working directory. */
let fallbackRoot = ''

/**
 * Finds the repository whose `inbox/` the pane shows. The session's project root comes first (a shell `cd`
 * does not move it), then the working directory, then the root's parents, so the queue is found from a
 * subfolder and after `/cd`. Every `$.fs` path is built absolute from this, never relative to the cwd.
 */
async function repo($: EngineInterface) {
  if (repoRoot && (await $.fs.exists(`${repoRoot}/${DIR}`).catch(() => false))) return repoRoot
  const root = tidyPath(await $.session.root().catch(() => ''))
  const cwd = tidyPath(await $.session.cwd().catch(() => ''))
  fallbackRoot = root || cwd
  let found = ''
  for (const dir of rootCandidates(root, cwd)) {
    if (await $.fs.exists(`${dir}/${DIR}`).catch(() => false)) {
      found = dir
      break
    }
  }
  repoRoot = found
  if ((await read($, inboxRoot)) !== found) await update($, inboxRoot, () => found)
  return found || fallbackRoot
}

/** The absolute path of a file inside `inbox/`. */
async function inboxPath($: EngineInterface, file: string) {
  return `${await repo($)}/${DIR}/${file}`
}

/** The absolute path of an item's lock file. */
async function lockAt($: EngineInterface, name: string) {
  return `${await repo($)}/${LOCK_DIR}/${name}.lock`
}

/** Reads inbox/ and its status folders into state: new and changed files, removed ones dropped. */
async function loadTasks($: EngineInterface) {
  const list: InboxTask[] = []
  const seen = new Set<string>()
  const base = `${await repo($)}/${DIR}`
  if (await $.fs.exists(base).catch(() => false)) {
    for (const status of STATUSES) {
      const dir = FOLDERS[status] ? `${base}/${FOLDERS[status]}` : base
      if (status !== 'todo' && !(await $.fs.exists(dir).catch(() => false))) continue
      const entries = await $.fs.list(dir).catch(() => [])
      for (const entry of entries) {
        if (entry.kind !== 'file' || !isItemFile(entry.name)) continue
        const file = FOLDERS[status] ? `${FOLDERS[status]}/${entry.name}` : entry.name
        seen.add(file)
        const held = cache.get(file)
        if (held && held.mtimeMs === entry.mtimeMs) {
          list.push(held.task)
          continue
        }
        const text = await $.fs.read(`${base}/${file}`).catch(() => undefined)
        if (typeof text !== 'string') continue
        const task = parseTask(file, text)
        cache.set(file, { mtimeMs: entry.mtimeMs, task })
        list.push(task)
      }
    }
  }
  for (const file of [...cache.keys()]) if (!seen.has(file)) cache.delete(file)
  const held = await read($, tasks)
  if (JSON.stringify(held) !== JSON.stringify(list)) await update($, tasks, () => list)
  return list
}

/** Forgets the folder and every parsed file, finds `inbox/` again and re-reads it all; says what it found. */
async function refresh($: EngineInterface) {
  repoRoot = ''
  cache.clear()
  const list = await loadTasks($)
  await refreshLocks($)
  await tick($)
  const root = await read($, inboxRoot)
  if (!root) return `No ${DIR}/ folder under ${fallbackRoot || 'the project root'} (the working directory and parent folders were checked too).`
  return `Refreshed: ${list.length} item${list.length === 1 ? '' : 's'} in ${root}/${DIR}/.`
}

/** The item as its file stands now, wherever a worker has moved it. */
async function fresh($: EngineInterface, name: string) {
  return findTask(await loadTasks($), name)
}

async function writeTask($: EngineInterface, task: InboxTask) {
  await $.fs.write(await inboxPath($, task.file), serializeTask(task))
  cache.delete(task.file)
  await update($, tasks, list => [...list.filter(one => one.name !== task.name), task])
}

/** Changes an item's fields from its file as it stands now, so edits made meanwhile are kept. */
async function patchTask($: EngineInterface, name: string, change: (task: InboxTask) => InboxTask) {
  const known = await fresh($, name)
  if (!known) return undefined
  const next = change(known)
  await writeTask($, next)
  return next
}

/** Renames a file (both paths absolute): `$.fs` has no move, so node does it (or `mv`), creating the folder on the way. */
async function moveFile($: EngineInterface, from: string, to: string): Promise<string | undefined> {
  const script = "const fs=require('fs');const [a,b]=process.argv.slice(1);fs.mkdirSync(require('path').dirname(b),{recursive:true});fs.renameSync(a,b)"
  const attempts: string[][] = [
    ['node', '-e', script, from, to],
    ['sh', '-c', 'mkdir -p "$(dirname "$2")" && mv -n "$1" "$2"', 'mv', from, to],
  ]
  let why = ''
  for (const argv of attempts) {
    const ran = await $.process.run(argv, { timeoutMs: 15_000 }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    if (typeof ran === 'string') {
      why = ran
      continue
    }
    if (ran.exitCode === 0) return undefined
    why = ran.stderr.trim().split('\n').pop() || `exit ${ran.exitCode}`
  }
  return `could not move ${from} to ${to}: ${why}`
}

/** Moves an item to another status folder with its fields changed; the reason when it cannot. */
async function moveItem($: EngineInterface, name: string, to: InboxStatus, patch: Record<string, string | undefined>): Promise<InboxTask | string> {
  const task = await fresh($, name)
  if (!task) return `No item ${name}.`
  const dest = pathOf(to, task.name)
  if (dest !== task.file && (await $.fs.exists(await inboxPath($, dest)).catch(() => false))) return `${DIR}/${dest} already exists.`
  if (dest !== task.file) {
    const failed = await moveFile($, await inboxPath($, task.file), await inboxPath($, dest))
    if (failed) return failed
    cache.delete(task.file)
  }
  const next = withFields(task, patch, dest)
  await writeTask($, next)
  return next
}

async function createTask($: EngineInterface, fields: { title: string; body: string; worker?: string; paths: string[]; after: string[] }) {
  const list = await loadTasks($)
  const id = nextId(list)
  const file = fileName(id, fields.title)
  const now = await $.clock.now()
  const front: Record<string, string> = {
    status: 'todo',
    created: stamp(now).slice(0, 10),
    'owner-paths': fields.paths.join(', '),
    ...(fields.after.length > 0 ? { 'depends-on': fields.after.join(', ') } : {}),
    ...(fields.worker ? { worker: fields.worker } : {}),
  }
  const body = `# ${fields.title}\n\n## Goal\n${fields.body || '<what to build / fix>'}\n\n## Acceptance criteria\n- <checks that prove it's done>\n`
  const task = parseTask(file, serializeTask({ ...parseTask(file, body), fields: front, body }))
  await writeTask($, task)
  return task
}

/** This session's id, asked once and kept so a reload still owns its locks. */
async function getMe($: EngineInterface) {
  const held = await read($, sessionId)
  if (held) return held
  const id = await $.session.id().catch(() => '')
  if (id) await update($, sessionId, () => id)
  return id
}

/** One item's lock file as it stands now. */
async function readLock($: EngineInterface, name: string) {
  const text = await $.fs.read(await lockAt($, name)).catch(() => undefined)
  return typeof text === 'string' ? parseLock(text) : undefined
}

/** Every lock file, by item. */
async function loadLocks($: EngineInterface) {
  const dir = `${await repo($)}/${LOCK_DIR}`
  if (!(await $.fs.exists(dir).catch(() => false))) return []
  const entries = await $.fs.list(dir).catch(() => [])
  const list: InboxLock[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.lock')) continue
    const text = await $.fs.read(`${dir}/${entry.name}`).catch(() => undefined)
    const lock = typeof text === 'string' ? parseLock(text) : undefined
    if (lock) list.push(lock)
  }
  return list.sort((a, b) => a.task.localeCompare(b.task))
}

/** Takes the item's lock: write, read back at once, and keep it only if the nonce is ours (no exclusive create here). */
async function acquireLock($: EngineInterface, name: string, phase: InboxPhase, me: string, now: number) {
  const host = await $.env.get('COMPUTERNAME').catch(() => undefined)
  const claim = claimLock(await readLock($, name), name, phase, me, now, cfg.lockStaleMs, host)
  if ('reason' in claim) return { ok: false as const, reason: claim.reason }
  await $.fs.write(await lockAt($, name), serializeLock(claim.lock))
  const back = await readLock($, name)
  if (back?.nonce !== claim.lock.nonce) {
    return { ok: false as const, reason: `${name} locked by ${back ? describeLock(back, now) : 'another session'}` }
  }
  return { ok: true as const, tookOver: claim.tookOver }
}

/** Marks a lock released by rewriting it; there is no delete. */
async function releaseLock($: EngineInterface, name: string, now: number) {
  const held = await readLock($, name)
  if (held && !held.released) await $.fs.write(await lockAt($, name), serializeLock(releasedLock(held, now)))
}

/** Rewrites refreshedAt on a lock this session owns. */
async function refreshLock($: EngineInterface, name: string, me: string, now: number) {
  const held = await readLock($, name)
  if (held && !held.released && held.session === me) await $.fs.write(await lockAt($, name), serializeLock(refreshedLock(held, now)))
}

/** Reads the lock files into state, written only when they changed. */
async function refreshLocks($: EngineInterface) {
  const list = await loadLocks($)
  if (JSON.stringify(await read($, locks)) !== JSON.stringify(list)) await update($, locks, () => list)
  return list
}

/** Items another live session holds a lock on. */
async function blockedNames($: EngineInterface) {
  const me = await getMe($)
  const now = await $.clock.now()
  return new Set((await read($, locks)).filter(lock => lockState(lock, now, me, cfg.lockStaleMs) === 'held').map(lock => lock.task))
}

/** Takes an item's lock for this session, toasting a takeover; says why not when it can't. */
async function takeLock($: EngineInterface, name: string, phase: InboxPhase) {
  const now = await $.clock.now()
  const got = await acquireLock($, name, phase, await getMe($), now)
  if (got.ok && got.tookOver) {
    const ago = shortDuration(now - Date.parse(got.tookOver.refreshedAt))
    $.ui.toast(`inbox: took over stale lock on ${name} (session ${got.tookOver.session.slice(0, 8)}, ${ago})`)
  }
  await refreshLocks($)
  return got
}

async function dropLock($: EngineInterface, name: string) {
  await releaseLock($, name, await $.clock.now()).catch(() => undefined)
  await refreshLocks($)
}

/** Looks for a commit that already carries the item's trailer. */
async function commitCheck($: EngineInterface, name: string) {
  const ran = await $.process.run(commitGrepArgv(name, cfg.trailer), { timeoutMs: 10_000 }).catch(() => undefined)
  if (!ran) return { kind: 'skipped' as const, why: 'git did not run' }
  if (ran.exitCode !== 0) return { kind: 'skipped' as const, why: ran.stderr.split('\n')[0]?.trim() || `git exited ${ran.exitCode}` }
  const line = ran.stdout.trim().split('\n')[0] ?? ''
  if (!line) return { kind: 'clear' as const }
  const [sha = '', ...subject] = line.split(' ')
  return { kind: 'committed' as const, sha, subject: subject.join(' ') }
}

/** Claims a todo item: lock, then move it to processing/ with the claim's fields. */
async function claimItem($: EngineInterface, task: InboxTask): Promise<InboxTask | string> {
  const got = await takeLock($, task.name, 'work')
  if (!got.ok) return `${got.reason}.`
  const moved = await moveItem($, task.name, 'processing', claimFields(task, await $.clock.now()))
  if (typeof moved === 'string') await dropLock($, task.name)
  return moved
}

/** Undoes a claim whose worker never started: back to the root as it was. */
async function unclaim($: EngineInterface, name: string) {
  await moveItem($, name, 'todo', releaseFields())
  await dropLock($, name)
}

/** Starts a background subagent on an item, to work it or to review it; says what happened. */
async function deploy($: EngineInterface, token: string, phase: InboxPhase = 'work', codexPosition = 0): Promise<string> {
  const list = await loadTasks($)
  let task = findTask(list, token)
  if (!task) return `No item ${token}.`
  if (liveRun(await read($, runs), task.name)) return `${task.name} already has an agent working it.`
  const root = await repo($)
  let note = ''
  if (phase === 'review') {
    if (task.status !== 'review') return `${task.name} is ${task.status}; only an item in review/ can be reviewed.`
    if (task.fields.commit) return `${task.name} already committed in ${task.fields.commit}.`
    const got = await takeLock($, task.name, 'review')
    if (!got.ok) return `${got.reason}.`
    const found = await commitCheck($, task.name)
    if (found.kind === 'committed') {
      await patchTask($, task.name, held => withFields(held, { commit: found.sha }))
      await dropLock($, task.name)
      return `${task.name} already committed in ${found.sha} "${found.subject}".`
    }
    if (found.kind === 'skipped') note = ` (commit check skipped: ${found.why})`
  } else {
    const can = readiness(task, list, await read($, runs), await blockedNames($))
    if (!can.ready) return `${task.name} is not ready: ${can.why}.`
    const claimed = await claimItem($, task)
    if (typeof claimed === 'string') return `${task.name} not claimed: ${claimed}`
    // the brief names the file where the worker will find it: in processing/
    task = claimed
  }
  const spec = phase === 'review'
    ? { subagentType: AGENT.claude.subagentType, description: `inbox ${task.name} review`.slice(0, 60), prompt: reviewBrief(task, root, cfg.trailer) }
    : spawnSpec(task, root, codexPosition, codexModel || undefined)
  const result = await $.agent.spawn(spec)
  if (result.deny) {
    if (phase === 'work') await unclaim($, task.name)
    else await dropLock($, task.name)
    return `${task.name} not started: ${result.deny}`
  }
  // the agent.spawn hook records the run as the agent starts; the result carries its id too
  if (result.agentId) await startRun($, task.name, result.agentId, phase)
  const run = liveRun(await read($, runs), task.name)
  if (!run) {
    if (phase === 'work') await unclaim($, task.name)
    else await dropLock($, task.name)
    return `${task.name} not started: no agent id came back`
  }
  const who = phase === 'review' ? 'reviewer' : `${task.worker} worker (${spec.subagentType})`
  return `${task.name}${phase === 'review' ? ' review' : ''} → ${who} ${run.agentId} on ${result.model}.${note}`
}

/** An agent took an item: its run starts and the file says which agent. */
async function startRun($: EngineInterface, name: string, agentId: string, phase: InboxPhase = 'work') {
  if ((await read($, runs)).some(one => one.agentId === agentId)) return
  const task = await fresh($, name)
  const now = await $.clock.now()
  await update($, clockNow, () => now)
  await update($, runs, list => [
    ...list.filter(one => one.task !== name),
    { task: name, agentId, startedAt: now, tools: 0, errors: 0, status: 'running' as const, phase, worker: task?.worker ?? 'claude', lastActivityAt: now, watch: 'active' as const },
  ])
  await patchTask($, name, held => withFields(held, { [phase === 'review' ? 'reviewer-agent-id' : 'agent-id']: agentId }))
}

/** An agent ended: where the worker left the item decides what the run was. */
async function settle($: EngineInterface, agentId: string, ended: 'answer' | 'other', answer: string | undefined) {
  const run = (await read($, runs)).find(one => one.agentId === agentId && isLive(one))
  if (!run) return
  const now = await $.clock.now()
  const text = answer?.trim()
  let task = await fresh($, run.task)
  if (run.phase === 'review') {
    const sha = parseCommitReport(text)
    if (task && sha && !task.fields.commit) task = await patchTask($, run.task, held => withFields(held, { commit: sha }))
    const status = task?.status === 'done' ? ('done' as const) : ('failed' as const)
    await update($, runs, list => list.map(one => (one.agentId === agentId ? { ...one, status, endedAt: now, waitingOn: undefined } : one)))
    await dropLock($, run.task)
    $.ui.toast(
      task?.status === 'done'
        ? `✓ inbox ${run.task} accepted${sha ? `, committed ${sha}` : ''}`
        : `inbox ${run.task} review ended: ${task ? `item is ${task.status}` : 'item not found'}${text ? '' : ' (no report)'}`,
    )
    void pump($)
    return
  }
  if (task && run.worker === 'codex') {
    const codex = parseCodexReport(text)
    if (codex.thread || codex.run) {
      task = await patchTask($, run.task, held => withFields(held, { ...(codex.thread ? { 'codex-thread': codex.thread } : {}), ...(codex.run ? { 'codex-run': codex.run } : {}) }))
    }
  }
  const landed = task?.status
  const finished = landed === 'review' || landed === 'blocked'
  if (task && !finished && text && task.result === undefined) {
    // the worker stopped without filing its result: keep what it said beside the item
    task = await patchTask($, run.task, held => withSection(held, 'Result', `(The worker ended without moving the item; its last message follows.)\n\n${text}`))
  }
  await update($, runs, list => list.map(one => (one.agentId === agentId ? { ...one, status: finished ? ('done' as const) : ('failed' as const), endedAt: now, waitingOn: undefined } : one)))
  await dropLock($, run.task)
  if (!task) $.ui.toast(`inbox ${run.task}: worker ended but the item is gone`)
  else if (landed === 'review') $.ui.toast(`✓ inbox ${run.task} ready for review: ${task.title}`)
  else if (landed === 'blocked') $.ui.toast(`⊘ inbox ${run.task} blocked: ${task.title}`)
  else $.ui.toast(`✗ inbox ${run.task}: worker ended ${ended === 'answer' ? 'without finishing' : 'abnormally'}; still in ${FOLDERS[landed ?? 'todo'] || DIR}/`)
  // autoReviewOne marks the item before its first await, so the pump below does not start a second reviewer
  if (autoReview && landed === 'review') await autoReviewOne($, run.task)
  void pump($)
}

/** Items in review/ a reviewer could take now: not committed, not being worked, not held elsewhere, not auto-reviewed yet this session. */
function reviewable(list: readonly InboxTask[], held: readonly InboxRun[], blocked: ReadonlySet<string>) {
  return list
    .filter(task => task.status === 'review' && task.folder === 'review' && !task.fields.commit && !liveRun(held, task.name) && !blocked.has(task.name) && !autoReviewed.has(task.name))
    .sort((a, b) => a.id - b.id || a.name.localeCompare(b.name))
}

/** Starts a reviewer on an item, once per session; toasts what happened. */
async function autoReviewOne($: EngineInterface, name: string) {
  if (autoReviewed.has(name)) return
  autoReviewed.add(name)
  const said = await deploy($, name, 'review')
  $.ui.toast(said.includes('→') ? `auto-review: ${said}` : `auto-review skipped: ${said}`)
}

/** Turns the option on or off from the pane: the setting is written first, then the mirror. */
async function setAutoReview($: EngineInterface, on: boolean) {
  const set = await $.config.set({ key: 'inbox.autoReview', value: on }).catch((error: unknown) => ({ deny: error instanceof Error ? error.message : String(error) }))
  if ('deny' in set) {
    $.ui.toast(`Auto-review not changed: ${set.deny}`)
    return
  }
  autoReview = on
  await update($, autoReviewOn, () => on)
  $.ui.toast(on ? 'Auto-review on: items landing in review/ get a reviewer.' : 'Auto-review off.')
  if (on) await pump($)
}

/** While draining, starts ready items until the drain's width of agents is busy. */
async function pump($: EngineInterface) {
  if (isPumping) return
  isPumping = true
  try {
    const width = await read($, drain)
    if (width <= 0) return
    const list = await loadTasks($)
    const held = await read($, runs)
    const blocked = await blockedNames($)
    let codexStarted = 0
    for (const task of toStart(list, held, width, blocked)) {
      const said = await deploy($, task.name, 'work', task.worker === 'codex' ? codexStarted : 0)
      if (said.includes('locked by')) continue
      if (!said.includes('→')) {
        $.ui.toast(`inbox drain stopped: ${said}`)
        await update($, drain, () => 0)
        return
      }
      if (task.worker === 'codex') codexStarted += 1
    }
    if (autoReview) {
      // what the drain has left over after the work items goes to items waiting in review/
      const live = (await read($, runs)).filter(isLive).length
      for (const task of reviewable(await read($, tasks), await read($, runs), blocked).slice(0, Math.max(0, width - live))) {
        await autoReviewOne($, task.name)
      }
    }
    const after = await read($, runs)
    const list2 = await read($, tasks)
    const left = pending(list2, after, blocked).length + (autoReview ? reviewable(list2, after, blocked).length : 0)
    if (left === 0 && !after.some(isLive)) {
      await update($, drain, () => 0)
      $.ui.toast(autoReview ? 'Inbox drained: nothing ready or reviewable is left.' : 'Inbox drained: nothing ready is left.')
    }
  } finally {
    isPumping = false
  }
}

/** What the watchdog does once a run times out, besides marking it; the toast's tail says which. */
async function onTimedOut($: EngineInterface, run: InboxRun, now: number): Promise<string> {
  if (cfg.onTimeout === 'nudge') {
    const text = `[inbox watchdog] No progress on inbox item ${run.task} for ${shortDuration(now - run.lastActivityAt)}. Finish and report now, or say what is blocking you.`
    const sent = await $.session
      .append({ message: { type: 'user', content: [{ type: 'text', text }] }, agentId: run.agentId })
      .catch(() => undefined)
    return sent && !sent.deny ? ' · nudged' : ''
  }
  if (cfg.onTimeout === 'redeploy' && (run.redeploys ?? 0) < 1) {
    await update($, runs, list => list.map(one => (one.agentId === run.agentId ? { ...one, status: 'abandoned' as const, endedAt: now } : one)))
    await dropLock($, run.task)
    if (run.phase === 'work') {
      const task = await fresh($, run.task)
      if (task) await moveItem($, run.task, 'todo', unclaimFields(task))
    }
    const said = await deploy($, run.task, run.phase)
    await update($, runs, list => list.map(one => (one.task === run.task && isLive(one) ? { ...one, redeploys: (run.redeploys ?? 0) + 1 } : one)))
    return said.includes('→') ? ' · redeployed' : ` · redeploy failed: ${said}`
  }
  return ''
}

/** Polls a live run's conversation for the heartbeat and announces a level the first time it is reached. */
async function watch($: EngineInterface, run: InboxRun, now: number) {
  const rows = await $.session.messages({ agentId: run.agentId }).catch(() => undefined)
  if (!Array.isArray(rows)) return
  const polled = observe(run, now, fingerprint(rows), inFlight(rows))
  const latest = lastTool(rows)
  const grown: InboxRun = {
    ...polled,
    tools: Math.max(polled.tools, toolCount(rows)),
    errors: Math.max(polled.errors, errorCount(rows)),
    ...(latest ? { lastTool: latest } : {}),
  }
  const { run: stepped, fire } = step(grown, now, cfg)
  if (JSON.stringify(stepped) !== JSON.stringify(run)) {
    await update($, runs, list => list.map(one => (one.agentId === run.agentId && isLive(one) ? stepped : one)))
  }
  if (!fire) return
  const idle = shortDuration(now - stepped.lastActivityAt)
  if (fire === 'idle') $.ui.toast(`inbox: ${run.task} idle ${idle}`)
  else $.ui.toast(`inbox: ${run.task} timed out (idle ${idle})${await onTimedOut($, stepped, now)}`)
}

/** Picks up moved files, settles agents the hooks missed, watches the workers, keeps locks fresh, feeds a drain. */
async function tick($: EngineInterface) {
  if (isTicking) return
  isTicking = true
  try {
    await loadTasks($)
    const held = await refreshLocks($)
    const me = await getMe($)
    const now = await $.clock.now()
    const live = (await read($, runs)).filter(isLive)
    if (live.length > 0 || held.some(lock => !lock.released)) await update($, clockNow, () => now)
    if (live.length > 0) {
      const agents = await $.agent.list().catch(() => [])
      for (const run of live) {
        const seen = agents.find(one => one.id === run.agentId)
        if (!seen || seen.status === 'running' || seen.status === 'pending') continue
        // the agent's turn.complete, which carries its report, can arrive a little after the list says it ended:
        // give it a grace period before settling without the report
        if (run.endedSeenAt === undefined) {
          await update($, runs, list => list.map(one => (one.agentId === run.agentId ? { ...one, endedSeenAt: now } : one)))
        } else if (now - run.endedSeenAt >= SETTLE_GRACE_MS) {
          await settle($, run.agentId, seen.status === 'completed' ? 'answer' : 'other', undefined)
        }
      }
      for (const run of (await read($, runs)).filter(isLive)) await watch($, run, now)
      for (const run of (await read($, runs)).filter(isLive)) {
        const lock = held.find(one => one.task === run.task)
        if (lock && lock.session === me && !lock.released && now - Date.parse(lock.refreshedAt) > LOCK_REFRESH_MS) {
          await refreshLock($, run.task, me, now)
        }
      }
    }
    await pump($)
  } finally {
    isTicking = false
  }
}

/** Sends an item back to the root as todo, its claim kept as `prev-*`; refused while an agent works it. */
async function reopen($: EngineInterface, token: string): Promise<string> {
  const task = findTask(await loadTasks($), token)
  if (!task) return `No item ${token}.`
  if (liveRun(await read($, runs), task.name)) return `${task.name} has an agent working it; stop that first.`
  if (task.status === 'todo' && task.folder === 'todo') return `${task.name} is already todo.`
  if (task.status === 'done') return `${task.name} is done${task.fields.commit ? ` (commit ${task.fields.commit})` : ''}; make a new item instead.`
  const moved = await moveItem($, task.name, 'todo', unclaimFields(task))
  if (typeof moved === 'string') return moved
  await dropLock($, task.name)
  return `${task.name} is todo again.`
}

/** A human reviewer accepted the item: done/, with the time and the commit they name. */
async function accept($: EngineInterface, token: string, sha?: string): Promise<string> {
  const task = findTask(await loadTasks($), token)
  if (!task) return `No item ${token}.`
  if (liveRun(await read($, runs), task.name)) return `${task.name} has an agent working it; wait for it.`
  if (task.status !== 'review') return `${task.name} is ${task.status}; only an item in review/ can be accepted.`
  const now = stamp(await $.clock.now())
  const noted = withSection(task, 'Review', `Accepted from the inbox pane (${now})${sha ? `, commit ${sha}` : ''}.`)
  await writeTask($, noted)
  const moved = await moveItem($, task.name, 'done', { status: 'done', reviewed: now, ...(sha ? { commit: sha } : {}) })
  if (typeof moved === 'string') return moved
  await dropLock($, task.name)
  return `${task.name} is done${sha ? ` (commit ${sha})` : ''}.`
}

/** The one-line state, from what the atoms hold now. */
async function summaryText($: EngineInterface) {
  const list = await read($, tasks)
  if (list.length === 0) {
    const root = await read($, inboxRoot)
    return root
      ? `The inbox is empty: no items in ${root}/${DIR}/. Add one: /inbox new <title>`
      : `No ${DIR}/ folder under ${fallbackRoot || 'the project root'} (the working directory and parent folders were checked too). /inbox new <title> creates it there.`
  }
  return summary({
    tasks: await read($, tasks),
    runs: await read($, runs),
    locks: await read($, locks),
    me: await getMe($),
    now: await $.clock.now(),
    cfg,
    drain: await read($, drain),
  })
}

export const register: Register = (on, options) => {
  cfg = watchConfig(options)
  codexModel = typeof options.codexModel === 'string' ? options.codexModel.trim() : ''
  autoReview = options.autoReview === true

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await update($, autoReviewOn, () => autoReview)
    await $.command.register({
      name: 'inbox',
      description: `Work queue in ${DIR}/: see items, start Codex or Claude workers on them, review and accept`,
      argumentHint: '[new|run|drain|review|accept|reopen|status|unlock|show|list|help] …',
    })
    await getMe($)
    await repo($)
    await loadTasks($).catch(() => undefined)
    await refreshLocks($).catch(() => undefined)
    $.clock.every(TICK_MS, () => void tick($))
    return started
  })

  // The person flips Auto review in /config: follow it without a reload.
  on('config.set', { key: 'inbox.autoReview' }, async ($, e, next) => {
    const result = await next(e)
    if (!('deny' in result)) {
      autoReview = e.value === true
      await update($, autoReviewOn, () => autoReview)
      if (autoReview) void pump($)
    }
    return result
  })

  // Every spawn on an inbox item, ours or one Claude made with the inbox skill (`inbox <item>`): the run starts here.
  on('agent.spawn', async ($, e, next) => {
    const match = /^inbox\s+#?(\S+?)(\s+review)?(?::|\s|$)/i.exec(e.description ?? '')
    const token = match?.[1] ?? ''
    const phase: InboxPhase = match?.[2] ? 'review' : 'work'
    const task = token ? findTask(await loadTasks($), token) : undefined
    let claimedHere = false
    if (task) {
      const got = await takeLock($, task.name, phase)
      if (!got.ok) {
        $.ui.toast(`inbox: ${got.reason}`)
        return { deny: `${got.reason}. Another session is working it; pick another item.` }
      }
      // the skill moves the item to processing/ before it spawns; a bare spawn on a todo item is claimed here
      if (phase === 'work' && task.status === 'todo' && task.folder === 'todo') {
        const moved = await moveItem($, task.name, 'processing', claimFields(task, await $.clock.now()))
        if (typeof moved === 'string') {
          await dropLock($, task.name)
          return { deny: `inbox could not claim ${task.name}: ${moved}` }
        }
        claimedHere = true
      }
    }
    const result = await next(e)
    if (task) {
      if (result.agentId) await startRun($, task.name, result.agentId, phase)
      else if (claimedHere) await unclaim($, task.name)
      else await dropLock($, task.name)
    }
    return result
  })

  // Only the agents Claude spawned itself pass through here: a hook's own spawns step past it.
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (!agentId || !(await read($, runs)).some(run => run.agentId === agentId && isLive(run))) return next(e)
    const label = toolLabel(e.tool, e as Record<string, unknown>)
    const before = await $.clock.now()
    await update($, runs, list =>
      list.map(run => (run.agentId === agentId ? { ...run, tools: run.tools + 1, lastTool: label, waitingOn: label, lastActivityAt: before } : run)),
    )
    const ran = await next(e)
    const after = await $.clock.now()
    await update($, runs, list =>
      list.map(run => (run.agentId === agentId ? { ...run, waitingOn: undefined, lastActivityAt: after } : run)),
    )
    if (ran.deny || ran.isError) {
      await update($, runs, list => list.map(run => (run.agentId === agentId ? { ...run, errors: run.errors + 1 } : run)))
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) await settle($, e.agentId, e.reason === 'answer' ? 'answer' : 'other', e.answer)
    return result
  })

  on('command.run', { command: 'inbox' }, async ($, e) => {
    const handle = async (): Promise<{ text?: string }> => {
      const cmd = parseCommand(e.args)
      if (cmd.kind !== 'error' && cmd.kind !== 'help') {
        await loadTasks($)
        await refreshLocks($)
        // the pane reads its time from state: a render hook keeps no clock of its own
        const now = await $.clock.now()
        await update($, clockNow, () => now)
      }
      switch (cmd.kind) {
        case 'error':
          return { text: cmd.text }
        case 'help':
          return { text: HELP }
        case 'open': {
          const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
          const shown = opened.isPlaced ? '' : `\nPane not shown: ${opened.reason}.`
          return { text: `${await summaryText($)}${shown}` }
        }
        case 'status': {
          await tick($)
          return { text: await summaryText($) }
        }
        case 'refresh': {
          const said = await refresh($)
          void $.ui.open({ id: PANE, title: TITLE })
          return { text: `${said}\n${await summaryText($)}` }
        }
        case 'list': {
          const list = filtered(await read($, tasks), 'all')
          if (list.length === 0) return { text: await summaryText($) }
          const held = await read($, runs)
          const blocked = await blockedNames($)
          return {
            text: list
              .map(one => {
                const can = readiness(one, list, held, blocked)
                const note = one.status === 'todo' ? (can.ready ? 'ready' : can.why) : one.status
                return `${STATUS[one.status].glyph} ${one.name}  ${one.title}  [${one.worker}] (${note})`
              })
              .join('\n'),
          }
        }
        case 'new': {
          const task = await createTask($, cmd)
          void $.ui.open({ id: PANE, title: TITLE })
          return { text: `Added ${task.name}: ${task.title} (${DIR}/${task.file}, ${task.worker} worker). Fill in its goal and owner-paths, then: /inbox run ${task.name}` }
        }
        case 'run':
        case 'review': {
          const said: string[] = []
          let codexStarted = 0
          for (const token of cmd.items) {
            const task = findTask(await read($, tasks), token)
            const line = await deploy($, token, cmd.kind === 'review' ? 'review' : 'work', task?.worker === 'codex' ? codexStarted : 0)
            if (line.includes('→') && task?.worker === 'codex' && cmd.kind === 'run') codexStarted += 1
            said.push(line)
          }
          void $.ui.open({ id: PANE, title: TITLE })
          // every line a refusal: say where the inbox stands too
          const started = said.some(line => line.includes('→'))
          return { text: started ? said.join('\n') : `${said.join('\n')}\n${await summaryText($)}` }
        }
        case 'drain': {
          if (cmd.width === 0) {
            await update($, drain, () => 0)
            return { text: 'Drain off. Running workers finish their items.' }
          }
          const ready = pending(await read($, tasks), await read($, runs), await blockedNames($)).length
          if (ready === 0) return { text: `Nothing to drain: 0 ready items. ${await summaryText($)}` }
          await update($, drain, () => cmd.width)
          void $.ui.open({ id: PANE, title: TITLE })
          await pump($)
          return { text: `Draining ${ready} ready item${ready === 1 ? '' : 's'}, ${cmd.width} at a time. /inbox drain off stops it.` }
        }
        case 'reopen': {
          const said: string[] = []
          for (const token of cmd.items) said.push(await reopen($, token))
          return { text: said.join('\n') }
        }
        case 'accept':
          return { text: await accept($, cmd.item, cmd.commit) }
        case 'unlock': {
          const task = findTask(await read($, tasks), cmd.item)
          const name = task?.name ?? cmd.item
          const lock = await readLock($, name)
          const now = await $.clock.now()
          const me = await getMe($)
          if (!lock || lock.released) return { text: `No lock on ${name}.` }
          if (lock.session !== me && !cmd.force) {
            return { text: `${name} is locked by ${describeLock(lock, now)}. Release it anyway: /inbox unlock ${name} --force` }
          }
          await dropLock($, name)
          return { text: `Released the lock on ${name}.` }
        }
        case 'show': {
          const task = findTask(await read($, tasks), cmd.item)
          if (!task) return { text: `No item ${cmd.item}.` }
          return { text: `${DIR}/${task.file}\n\n${serializeTask(task)}` }
        }
      }
    }
    const out = await handle()
    return out.text?.trim() ? out : { ...out, text: await summaryText($) }
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
  const elements = $.ui.resolve(e)
  const { Box, Text, Button } = elements
  // mobile draws no Input; adding an item there goes through /inbox new
  const Input = 'Input' in elements ? elements.Input : undefined
  const list = await read($, tasks)
  const held = await read($, runs)
  const locked = await read($, locks)
  const pick = await read($, selected)
  const view = await read($, filter)
  const width = await read($, drain)
  const me = await read($, sessionId)
  const root = await read($, inboxRoot)
  const auto = await read($, autoReviewOn)
  const now = Math.max(await read($, clockNow), ...held.map(run => run.endedAt ?? run.startedAt))
  const columns = Math.max(30, e.props.bodyColumns || 60)
  const blocked = new Set(locked.filter(lock => lockState(lock, now, me, cfg.lockStaleMs) === 'held').map(lock => lock.task))
  const c = counts(list, held, blocked)
  const shown = filtered(list, view)
  const stalled = stallCounts(held, now, cfg)

  /** Another session's lock on an item, and whether it has gone stale. */
  const lockOn = (name: string) => {
    const lock = locked.find(one => one.task === name)
    const state = lockState(lock, now, me, cfg.lockStaleMs)
    return { lock, isHeld: state === 'held', isStale: state === 'stale' }
  }

  const header = (
    <Box key="head" flexDirection="row">
      <Text bold color="#D97757">INBOX </Text>
      <Text>{`${c.ready} ready`}</Text>
      {c.todo - c.ready > 0 && <Text dimColor>{` · ${c.todo - c.ready} waiting`}</Text>}
      <Text color="yellow">{` · ${c.processing} processing`}</Text>
      {stalled.idle > 0 && <Text color="yellow">{` · ${stalled.idle} idle`}</Text>}
      {stalled.timedOut > 0 && <Text color="red">{` · ${stalled.timedOut} timed out`}</Text>}
      {c.review > 0 && <Text color="cyan">{` · ${c.review} review`}</Text>}
      {c.blocked > 0 && <Text color="red">{` · ${c.blocked} blocked`}</Text>}
      <Text dimColor>{` · ${c.done} done`}</Text>
      {width > 0 && <Text color="cyan">{`   draining ×${width}`}</Text>}
      {auto && <Text color="green">{'   auto-review'}</Text>}
    </Box>
  )

  const controls = (
    <Box key="controls" flexDirection="row">
      {(['active', 'all', 'done'] as const).map(one => (
        <Button key={`filter-${one}`} plain dimColor={view !== one} onPress={() => void update($, filter, () => one)}>
          {view === one ? `[${one}]` : ` ${one} `}
        </Button>
      ))}
      <Text> </Text>
      {width > 0 ? (
        <Button key="drain" hotkey="s" onPress={() => void update($, drain, () => 0)}>
          Stop drain
        </Button>
      ) : (
        <Button
          key="drain"
          hotkey="a"
          onPress={() =>
            void (async () => {
              await update($, drain, () => 2)
              await pump($)
            })()
          }
        >
          Drain ×2
        </Button>
      )}
      <Text> </Text>
      <Button key="refresh" hotkey="f" onPress={() => void refresh($).then(said => $.ui.toast(said))}>
        Refresh
      </Button>
      <Text> </Text>
      <Button key="auto-review" hotkey="o" onPress={() => void setAutoReview($, !auto)}>
        {auto ? 'Auto-review: on' : 'Auto-review: off'}
      </Button>
    </Box>
  )

  const adder = Input && (
    <Input
      key="new-task"
      placeholder="New item title… (Enter adds it; goal after ' -- ')"
      submitLabel="Add"
      onSubmit={(value: string) => {
        const [title = '', ...more] = value.split(' -- ')
        if (!title.trim()) return
        void createTask($, { title: title.trim(), body: more.join(' -- ').trim(), paths: [], after: [] }).then(task =>
          update($, selected, () => task.name),
        )
      }}
    />
  )

  const line = (task: InboxTask) => {
    const run = held.find(one => one.task === task.name)
    const isRunning = run !== undefined && isLive(run)
    const lock = lockOn(task.name)
    const isBlocked = lock.isHeld && !isRunning
    const isTimedOut = isRunning && level(run, now, cfg) === 'timedOut'
    const can = task.status === 'todo' ? readiness(task, list, held, blocked) : undefined
    const mark = isBlocked
      ? { glyph: '⊘', dimColor: true }
      : isTimedOut
        ? { glyph: '!', color: 'red' }
        : can && !can.ready
          ? WAITING
          : STATUS[task.status]
    const isOpen = pick === task.name
    const progress = run
      ? `${run.phase === 'review' ? 'review · ' : ''}${elapsedText((run.endedAt ?? now) - run.startedAt)} · ${run.tools} tools${run.errors ? ` · ${run.errors} err` : ''}`
      : can && !can.ready
        ? can.why
        : task.status === 'processing'
          ? `${task.fields['worker-agent'] ?? task.worker}${task.fields.started ? ` · since ${task.fields.started.slice(11, 16)}` : ''} · no agent here`
          : ''
    const beat = isRunning ? beatText(run, now, cfg) : undefined
    const tag = `[${task.worker}]`
    const name = `${isOpen ? '▾' : '▸'} ${task.name} `
    const room = Math.max(8, columns - name.length - tag.length - progress.length - (beat?.text.length ?? 0) - 10)
    const title = task.title.length > room ? `${task.title.slice(0, room - 1)}…` : task.title

    return (
      <Box key={`task-${task.name}`} flexDirection="column">
        <Box key="line" flexDirection="row">
          <Text color={mark.color} dimColor={mark.dimColor}>{`${mark.glyph} `}</Text>
          <Button
            key={`row-${task.name}`}
            plain
            dimColor={task.status === 'done' && !isOpen}
            onPress={() => void update($, selected, held => (held === task.name ? null : task.name))}
          >
            {`${name}${title}`}
          </Button>
          <Text dimColor>{` ${tag}`}</Text>
          {progress && <Text dimColor wrap="truncate">{`  ${progress}`}</Text>}
          {beat && (
            <Box key={`beat-${task.name}`} flexDirection="row">
              <Text wrap="truncate" {...TONE[beat.tone]}>{`  · ${beat.text}`}</Text>
            </Box>
          )}
          {isBlocked && lock.lock && (
            <Box key={`lock-${task.name}`} flexDirection="row">
              <Text color="magenta" wrap="truncate">
                {`  locked by other session · ${lock.lock.phase} · ${shortDuration(now - Date.parse(lock.lock.refreshedAt))} ago`}
              </Text>
            </Box>
          )}
        </Box>
        {isRunning && run?.lastTool && !isOpen && (
          <Text key="now" dimColor wrap="truncate">{`    ↳ ${run.lastTool}`}</Text>
        )}
        {isOpen && detail(task, run)}
      </Box>
    )
  }

  const detail = (task: InboxTask, run: InboxRun | undefined) => {
    const isRunning = run !== undefined && isLive(run)
    const lock = lockOn(task.name)
    const isBlocked = lock.isHeld && !isRunning
    const isTimedOut = isRunning && level(run, now, cfg) === 'timedOut'
    const can = task.status === 'todo' ? readiness(task, list, held, blocked) : undefined
    const goal = goalText(task.body)
    const body = goal.length > 1500 ? `${goal.slice(0, 1500)}…` : goal
    const clip = (text: string | undefined) => text && (text.length > 2500 ? `${text.slice(0, 2500)}…` : text)
    const result = clip(task.result)
    const review = clip(task.review)
    const f = task.fields
    const deps = task.dependsOn.map(dep => {
      const found = findTask(list, dep)
      return `${dep} (${found ? found.status : 'missing'})`
    })
    const when = [
      f.created && `created ${f.created}`,
      f.started && `started ${f.started}`,
      f.finished && `finished ${f.finished}`,
      f.reviewed && `reviewed ${f.reviewed}`,
      f.commit && `commit ${f.commit}`,
      f['review-round'] && `review round ${f['review-round']}`,
      f['codex-thread'] && `codex thread ${f['codex-thread']}`,
    ].filter(Boolean)
    const agent = AGENT[task.worker]
    return (
      <Box key="detail" flexDirection="column" marginLeft={4} marginBottom={1}>
        <Text key="meta" dimColor wrap="truncate">
          {[`${DIR}/${task.file}`, `${task.worker}${f.worker ? '' : ' (routed)'} → ${agent.subagentType}${agent.model ? ` on ${agent.model}` : ''}`].join(' · ')}
        </Text>
        <Text key="paths" dimColor wrap="wrap">
          {task.ownerPaths.length > 0 ? `owner-paths: ${task.ownerPaths.join(', ')}` : 'owner-paths: (none: the worker may edit nothing but the item)'}
        </Text>
        {deps.length > 0 && <Text key="deps" dimColor wrap="wrap">{`depends-on: ${deps.join(', ')}`}</Text>}
        {when.length > 0 && <Text key="when" dimColor wrap="wrap">{when.join(' · ')}</Text>}
        {can && !can.ready && <Text key="why" color="yellow" wrap="wrap">{`Not ready: ${can.why}.`}</Text>}
        {task.status !== task.folder && <Text key="misfiled" color="red" wrap="wrap">{`status: ${task.status} but the file sits in ${FOLDERS[task.folder] || DIR}/.`}</Text>}
        {body ? <Text key="body" wrap="wrap">{body}</Text> : <Text key="body" dimColor>(no details)</Text>}
        {isRunning && run?.lastTool && <Text key="now" color="yellow" wrap="truncate">{`↳ ${run.lastTool}`}</Text>}
        {isRunning && run?.waitingOn && (
          <Text key="waiting" color="yellow" wrap="truncate">{`↳ waiting on ${run.waitingOn} (${shortDuration(now - run.lastActivityAt)})`}</Text>
        )}
        {isTimedOut && cfg.onTimeout === 'mark' && (
          <Text key="timedout" color="red" wrap="wrap">
            Timed out. inbox can't stop subagents; stop it from the engine's task view, then Reopen or Dispatch.
          </Text>
        )}
        {isBlocked && lock.lock && (
          <Box key="locked" flexDirection="column">
            <Text key="lock-line" color="magenta" wrap="wrap">{`Locked by ${describeLock(lock.lock, now)}.`}</Text>
            <Text key="lock-hint" dimColor>{`/inbox unlock ${task.name} --force releases it.`}</Text>
          </Box>
        )}
        {lock.isStale && lock.lock && (
          <Text key="stale-lock" dimColor>{`stale lock (${shortDuration(now - Date.parse(lock.lock.refreshedAt))}) · Dispatch takes over`}</Text>
        )}
        {task.status === 'processing' && !isRunning && (
          <Text key="stale" dimColor>
            {f['worker-kind'] === 'subagent'
              ? 'No agent works it in this session: its worker ended with the session. Reopen it to dispatch again.'
              : 'No agent works it in this session.'}
          </Text>
        )}
        {result !== undefined && (
          <Box key="result" flexDirection="column" marginTop={1}>
            <Text key="label" bold color={task.status === 'blocked' ? 'red' : undefined}>
              Result
            </Text>
            <Text key="text" wrap="wrap">{result || '(empty)'}</Text>
          </Box>
        )}
        {review !== undefined && (
          <Box key="review" flexDirection="column" marginTop={1}>
            <Text key="label" bold>
              Review
            </Text>
            <Text key="text" wrap="wrap">{review || '(empty)'}</Text>
          </Box>
        )}
        <Box key="actions" flexDirection="row" marginTop={1}>
          {can?.ready && !isBlocked && (
            <Button key={`deploy-${task.name}`} hotkey="d" variant="primary" onPress={() => void deploy($, task.name).then(said => $.ui.toast(said))}>
              Dispatch
            </Button>
          )}
          {task.status === 'review' && !isRunning && !isBlocked && !f.commit && (
            <Button key={`review-${task.name}`} hotkey="v" variant="primary" onPress={() => void deploy($, task.name, 'review').then(said => $.ui.toast(said))}>
              Review
            </Button>
          )}
          {task.status === 'review' && !isRunning && !isBlocked && (
            <Button key={`accept-${task.name}`} hotkey="x" onPress={() => void accept($, task.name).then(said => $.ui.toast(said))}>
              Accept
            </Button>
          )}
          {(task.status === 'review' || task.status === 'blocked' || (task.status === 'processing' && !isRunning)) && !isBlocked && (
            <Button key={`reopen-${task.name}`} hotkey="r" onPress={() => void reopen($, task.name).then(said => $.ui.toast(said))}>
              Reopen
            </Button>
          )}
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {header}
      {controls}
      {adder}
      {shown.length === 0 ? (
        <Text key="empty" dimColor>
          {list.length === 0
            ? root
              ? `No items in ${root}/${DIR}/. Add one above, or /inbox new <title>; the repo's AGENTS.md describes the format.`
              : `No ${DIR}/ folder under ${fallbackRoot || 'the project root'} (the working directory and parent folders were checked too). Adding an item creates it there.`
            : `Nothing ${view === 'done' ? 'done' : 'open'} here.`}
        </Text>
      ) : (
        <Box key="list" flexDirection="column" marginTop={1}>
          {shown.map(line)}
        </Box>
      )}
    </Box>
  )
}
