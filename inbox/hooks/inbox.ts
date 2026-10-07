import type { InboxFilter, InboxLock, InboxRun, InboxStatus, InboxTask, InboxWorker } from '../types'
import { lockState } from './lock'
import { level, shortDuration, stallCounts, toolLabel } from './watch'
import type { WatchConfig } from './watch'

// The inbox's pure side: the item file format (the `inbox/` queue a repo's
// AGENTS.md describes: todo items at the root, then processing/, review/,
// done/ and blocked/), which items are ready, who works them, the workers'
// briefs, the /inbox arguments and the state summary.

export { toolLabel }

export const DIR = 'inbox'
export const STATUSES: readonly InboxStatus[] = ['todo', 'processing', 'review', 'done', 'blocked']

/** A path with forward slashes and no trailing slash, as the engine's paths are compared. */
export const tidyPath = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '')

/**
 * The directories that may hold `inbox/`, most likely first: the session's project root (a shell `cd`
 * does not move it), the working directory, then the root's parents up to `levels` up. No duplicates.
 */
export function rootCandidates(root: string, cwd: string, levels = 3): string[] {
  const out: string[] = []
  const add = (path: string) => {
    const clean = tidyPath(path)
    if (clean && !out.includes(clean)) out.push(clean)
  }
  add(root)
  add(cwd)
  let up = tidyPath(root)
  for (let i = 0; i < levels && up; i += 1) {
    const cut = up.lastIndexOf('/')
    if (cut <= 0 || /^[A-Za-z]:$/.test(up.slice(0, cut))) break
    up = up.slice(0, cut)
    add(up)
  }
  return out
}
/** The folder inside `inbox/` for each status; todo items sit at the root. */
export const FOLDERS: Record<InboxStatus, string> = { todo: '', processing: 'processing', review: 'review', done: 'done', blocked: 'blocked' }
export const WORKERS: readonly InboxWorker[] = ['codex', 'claude']
/** The agent type each worker is, and the model a Claude worker runs on. */
export const AGENT: Record<InboxWorker, { subagentType: string; model?: string }> = {
  codex: { subagentType: 'codex-runner' },
  claude: { subagentType: 'general-purpose', model: 'sonnet' },
}
/** Codex sandboxes started in the same second have crashed each other: the second and later wait this long apiece. */
export const CODEX_STAGGER_S = 20
export const MAX_WIDTH = 10
/** The front matter a claim adds; a send-back renames these to `prev-<field>`. */
const CLAIM_FIELDS = ['claim-id', 'started', 'finished', 'dispatched', 'worker-kind', 'worker-agent']

export const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'item'

export const fileName = (id: number, title: string) => `${id}-${slug(title)}.md`

/** An item file: `.md`, not a `_TEMPLATE.md` or any other `_`/`.`-prefixed helper. */
export const isItemFile = (name: string) => /\.md$/i.test(name) && !/^[_.]/.test(name)

/** The item's name: the file name without its folder and `.md`. */
export const nameOf = (file: string) => (file.split('/').pop() ?? file).replace(/\.md$/i, '')

export const idOf = (name: string) => Number(/^(\d+)/.exec(name)?.[1] ?? 0)

export const folderOf = (file: string): InboxStatus => {
  const dir = file.includes('/') ? file.slice(0, file.indexOf('/')) : ''
  return STATUSES.find(status => FOLDERS[status] === dir) ?? 'todo'
}

export const pathOf = (status: InboxStatus, name: string) => `${FOLDERS[status] ? `${FOLDERS[status]}/` : ''}${name}.md`

export const nextId = (tasks: readonly InboxTask[]) => tasks.reduce((max, one) => Math.max(max, one.id), 0) + 1

/** A comma-separated field; a `<placeholder>` left from the template counts as empty. */
const listField = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map(one => one.trim())
    .filter(one => one && !one.startsWith('<'))

/** The text of a `## Heading` section, up to the next `## `. */
export function section(body: string, heading: string): string | undefined {
  const match = new RegExp(`(?:^|\\n)## ${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`).exec(body)
  return match ? match[1]?.trim() || '' : undefined
}

/** The item's description for the pane: its body without the worker's and reviewer's sections. */
export function goalText(body: string): string {
  return body.replace(/(?:^|\n)## (Result|Review)[^\n]*\n[\s\S]*?(?=\n## |$)/g, '').replace(/^#[^\n]*\n/, '').trim()
}

/** Reads an item file; `file` is its path inside `inbox/`. Every front matter field is kept. */
export function parseTask(file: string, text: string): InboxTask {
  const name = nameOf(file)
  const folder = folderOf(file)
  const fields: Record<string, string> = {}
  let body = text.replace(/\r\n/g, '\n')
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(body)
  if (front) {
    for (const line of (front[1] ?? '').split('\n')) {
      const at = line.indexOf(':')
      if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim()
    }
    body = body.slice(front[0].length)
  }
  body = body.replace(/^\n+/, '')
  const status = STATUSES.find(one => one === fields.status) ?? folder
  const title = /^# +(.+)$/m.exec(body)?.[1]?.trim() || name
  const ownerPaths = listField(fields['owner-paths']).map(normalizePath)
  const dependsOn = listField(fields['depends-on']).map(one => one.replace(/\.md$/i, ''))
  const chosen = WORKERS.find(one => one === fields.worker)
  const result = section(body, 'Result')
  const review = section(body, 'Review')
  return {
    name,
    id: idOf(name),
    file,
    title,
    status,
    folder,
    fields,
    ownerPaths,
    dependsOn,
    worker: chosen ?? routeWorker(ownerPaths),
    body,
    ...(result !== undefined ? { result } : {}),
    ...(review !== undefined ? { review } : {}),
  }
}

export function serializeTask(task: InboxTask): string {
  const front = Object.entries(task.fields).map(([key, value]) => `${key}: ${value}`)
  return `---\n${front.join('\n')}\n---\n${task.body.trim()}\n`
}

/** The task with fields set (a `undefined` value removes one), re-read so derived values follow. */
export function withFields(task: InboxTask, patch: Record<string, string | undefined>, file = task.file): InboxTask {
  const fields = { ...task.fields }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete fields[key]
    else fields[key] = value
  }
  return parseTask(file, serializeTask({ ...task, fields }))
}

/** The task with a section appended to its body. */
export function withSection(task: InboxTask, heading: string, text: string): InboxTask {
  return parseTask(task.file, serializeTask({ ...task, body: `${task.body.trim()}\n\n## ${heading}\n\n${text.trim()}\n` }))
}

export const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')

/** The front matter a dispatch adds while moving the item to processing/. */
export function claimFields(task: InboxTask, now: number): Record<string, string> {
  const iso = stamp(now)
  return {
    status: 'processing',
    started: iso,
    'claim-id': `${task.name}-${iso.replace(/[:.]/g, '-')}`,
    'worker-kind': 'subagent',
    'worker-agent': task.worker,
    dispatched: iso,
  }
}

/** The patch that sends an item back to todo: claim fields kept as `prev-*`, the way a reviewer's send-back does. */
export function unclaimFields(task: InboxTask): Record<string, string | undefined> {
  const patch: Record<string, string | undefined> = { status: 'todo' }
  for (const key of CLAIM_FIELDS) {
    if (task.fields[key] !== undefined) {
      patch[`prev-${key}`] = task.fields[key]
      patch[key] = undefined
    }
  }
  return patch
}

/** The patch that undoes a claim whose spawn failed: only what the claim added goes. */
export function releaseFields(): Record<string, string | undefined> {
  const patch: Record<string, string | undefined> = { status: 'todo' }
  for (const key of CLAIM_FIELDS) patch[key] = undefined
  return patch
}

export const normalizePath = (path: string) => path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')

/** Front-end code: `apps/client/**`, `apps/landing/**`, or a `.css`/`.tsx` file. */
export const isUiPath = (path: string) => /^apps\/(client|landing)(\/|$)/.test(path) || /\.(css|tsx)$/.test(path)

/** Codex when every owner path is UI code; Claude otherwise, and when in doubt. */
export const routeWorker = (ownerPaths: readonly string[]): InboxWorker =>
  ownerPaths.length > 0 && ownerPaths.every(isUiPath) ? 'codex' : 'claude'

/** Two owner paths overlap when one is the other or lies under it. */
export const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

export const pathsOverlap = (a: readonly string[], b: readonly string[]) => a.some(one => b.some(other => overlaps(one, other)))

/** The item a `depends-on` entry, a `/inbox` argument or an agent description names: by name, or by number. */
export function findTask(tasks: readonly InboxTask[], token: string): InboxTask | undefined {
  const want = token.replace(/^#/, '').replace(/\.md$/i, '')
  const byName = tasks.find(one => one.name === want)
  if (byName) return byName
  const id = Number(want)
  return Number.isInteger(id) && id > 0 ? tasks.find(one => one.id === id) : undefined
}

export const isLive = (run: InboxRun) => run.status === 'running'

export const liveRun = (runs: readonly InboxRun[], name: string) => runs.find(run => run.task === name && isLive(run))

export type Readiness = { ready: true } | { ready: false; why: string }

/**
 * Whether a dispatcher may start this item now: a todo item at the root, its
 * dependencies in review/ or done/, no owner path shared with an item being
 * processed (`busy` adds the ones a batch has just picked), not locked elsewhere.
 */
export function readiness(
  task: InboxTask,
  tasks: readonly InboxTask[],
  runs: readonly InboxRun[],
  blocked: ReadonlySet<string> = new Set(),
  busy: readonly InboxTask[] = [],
): Readiness {
  if (task.status !== 'todo') return { ready: false, why: `is ${task.status}` }
  if (task.folder !== 'todo') return { ready: false, why: `misfiled in ${FOLDERS[task.folder]}/` }
  if (liveRun(runs, task.name)) return { ready: false, why: 'already has an agent' }
  if (blocked.has(task.name)) return { ready: false, why: 'locked by another session' }
  for (const dep of task.dependsOn) {
    const found = findTask(tasks, dep)
    if (!found) return { ready: false, why: `waits on ${dep} (missing)` }
    if (found.status !== 'review' && found.status !== 'done') return { ready: false, why: `waits on ${found.name} (${found.status})` }
  }
  const working = [...tasks.filter(one => one.name !== task.name && (one.status === 'processing' || liveRun(runs, one.name))), ...busy]
  const clash = working.find(one => one.name !== task.name && pathsOverlap(task.ownerPaths, one.ownerPaths))
  if (clash) return { ready: false, why: `paths overlap with ${clash.name}` }
  return { ready: true }
}

/** Items that may start now, in filename order. */
export function pending(tasks: readonly InboxTask[], runs: readonly InboxRun[], blocked: ReadonlySet<string> = new Set()) {
  return sorted(tasks).filter(task => readiness(task, tasks, runs, blocked).ready)
}

/** The items a drain starts now so that `width` agents are busy, none sharing paths with another. */
export function toStart(tasks: readonly InboxTask[], runs: readonly InboxRun[], width: number, blocked: ReadonlySet<string> = new Set()) {
  const room = Math.max(0, width - runs.filter(isLive).length)
  const picked: InboxTask[] = []
  for (const task of sorted(tasks)) {
    if (picked.length >= room) break
    if (readiness(task, tasks, runs, blocked, picked).ready) picked.push(task)
  }
  return picked
}

export function counts(tasks: readonly InboxTask[], runs: readonly InboxRun[] = [], blocked: ReadonlySet<string> = new Set()) {
  const by = (status: InboxStatus) => tasks.filter(one => one.status === status).length
  return { todo: by('todo'), ready: pending(tasks, runs, blocked).length, processing: by('processing'), review: by('review'), done: by('done'), blocked: by('blocked') }
}

/** Numbered items by number, then the rest by name. */
export const sorted = (tasks: readonly InboxTask[]) =>
  [...tasks].sort((a, b) => (a.id && b.id ? a.id - b.id : a.id ? -1 : b.id ? 1 : a.name.localeCompare(b.name)))

/** The pane's order: what is happening, what waits for a reviewer, what can start, what cannot, then done. */
const RANK: Record<InboxStatus, number> = { processing: 0, review: 1, todo: 2, blocked: 3, done: 4 }

export function filtered(tasks: readonly InboxTask[], filter: InboxFilter) {
  const list = sorted(tasks).sort((a, b) => RANK[a.status] - RANK[b.status])
  if (filter === 'all') return list
  if (filter === 'done') return list.filter(one => one.status === 'done')
  return list.filter(one => one.status !== 'done')
}

export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

const REQUIREMENTS = [
  '- This item is already claimed. Implement it directly. Do not dispatch or spawn other workers.',
  '- Read the item, the repository instructions (AGENTS.md, CLAUDE.md) and applicable shared memory. Work only on the item\'s owner-paths and the item file. Ask for a material scope extension in your result rather than editing another worker\'s files.',
  '- Plan, implement and verify every acceptance criterion and the checks the repository requires. Make routine decisions yourself and document material gaps. Do not commit.',
  '- The working tree is shared with other workers whose changes are uncommitted. Never run `git stash`, `git reset`, `git checkout -- <path>`, `git clean`, `git restore` or any other command that discards or hides changes, including on files you own. If the tree looks wrong, say so in your result and stop.',
  '- Preserve the item\'s claim and worker metadata. Append a `## Result` section of at most 15 lines: the change, how you verified it, known gaps, and every file you changed.',
  '- When done, set `status: review` and `finished: <ISO timestamp>` in the item, then move it to `inbox/review/` without overwriting. If you are blocked, record why under `## Result`, set `status: blocked` and `finished`, and move it to `inbox/blocked/`. Never move an item to `done/`.',
  '- Finish with a short outcome and the item\'s new path.',
]

/** The worker's brief: the assignment rules and where the item is. */
export function brief(task: InboxTask, repo: string): string {
  return [
    `You are the worker for inbox item ${task.name} in the repository at ${repo}.`,
    `The item file is ${repo}/${DIR}/${task.file} (title: ${task.title}).`,
    '',
    ...REQUIREMENTS,
  ].join('\n')
}

/** What the codex-runner agent is handed: its header lines, then the worker's brief. */
export function codexBrief(task: InboxTask, repo: string, delayS: number, model?: string): string {
  const thread = task.fields['codex-thread']
  return [
    `Repo: ${repo}`,
    'sandbox: workspace-write',
    `slug: ${task.name}`,
    ...(delayS > 0 ? [`delay: ${delayS}`] : []),
    ...(thread ? [`resume: ${thread}`] : []),
    ...(model ? [`model: ${model}`] : []),
    'Brief:',
    brief(task, repo),
  ].join('\n')
}

export type SpawnSpec = { subagentType: string; model?: string; description: string; prompt: string }

/** The subagent to start on an item; `codexPosition` counts Codex items already started in this batch. */
export function spawnSpec(task: InboxTask, repo: string, codexPosition = 0, codexModel?: string): SpawnSpec {
  const agent = AGENT[task.worker]
  return {
    subagentType: agent.subagentType,
    ...(agent.model ? { model: agent.model } : {}),
    description: `inbox ${task.name}`.slice(0, 60),
    prompt: task.worker === 'codex' ? codexBrief(task, repo, codexPosition * CODEX_STAGGER_S, codexModel) : brief(task, repo),
  }
}

/** What the reviewer deployed on a finished item is told: the inbox-review skill's steps for one item. */
export function reviewBrief(task: InboxTask, repo: string, trailer: string): string {
  const grep = commitGrepArgv(task.name, trailer).slice(1).join(' ')
  return [
    `You are reviewing inbox item ${task.name} in the repository at ${repo}: ${repo}/${DIR}/${task.file} (title: ${task.title}).`,
    'The worker left its changes uncommitted in the working tree. You are the reviewer: the only one who commits them and the only one who moves the item to done/.',
    '',
    'Read AGENTS.md first. Then read the item: its goal, acceptance criteria and the worker\'s `## Result`.',
    'Build the item\'s change set from `git status --short`: every changed or untracked path under its owner-paths plus every file the Result lists. Flag files outside owner-paths, Result entries with no change, paths an item in inbox/processing/ also owns (never commit those), and changed paths no item claims (never commit those).',
    'Verify read-only: read the diff and any new files, run the checks AGENTS.md names, and judge each acceptance criterion met, not met or unverifiable. Do not fix the worker\'s code yourself.',
    '',
    `Accept: stage the change set by explicit path (never \`git add -A\` or \`.\`), check \`git diff --cached --stat\`, and commit in the repository's style with a body of 1-3 lines from the Result and the trailer \`${trailer}: ${task.name}\` on its own line. Immediately before committing run \`git ${grep}\`; if it prints a commit, do not commit again. Then in the item add a short \`## Review\` (verdict, checks, commit hash), set \`status: done\`, \`reviewed: <ISO time>\` and \`commit: <hash>\`, and move it to inbox/done/ without overwriting.`,
    'Send back: append `## Review` with numbered fixes and what already passed, set `status: todo`, add `review-round: <n>`, rename claim-id, started, finished, dispatched, worker-kind and worker-agent to `prev-<field>` (keep codex-thread and codex-run), and move the item back to inbox/. Leave the changes in the working tree.',
    'Blocked (needs the user): append `## Review` with the question, set `status: blocked`, move the item to inbox/blocked/, commit nothing.',
    '',
    'Never commit gitignored files or anything under apps/client/public/cards/. Never push. If .git/index.lock exists, wait and retry.',
    'End your report with one line per verdict and a final line `COMMIT: <sha>` or `NO-COMMIT: <reason>`.',
  ].join('\n')
}

/** The git command that finds a commit already made for an item. */
export const commitGrepArgv = (name: string, trailer: string) => [
  'git', 'log', '--all', '-n', '1', '--format=%h %s', '-E', `--grep=^${trailer}: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
]

/** The sha a reviewer's report ends with, if it committed. */
export const parseCommitReport = (answer: string | undefined) => /^COMMIT:\s*([0-9a-f]{7,40})/m.exec(answer ?? '')?.[1]

/** The thread and run directory a codex-runner report names: `Codex ok · model m · thread <id> · run <dir>`. */
export function parseCodexReport(answer: string | undefined): { thread?: string; run?: string } {
  const thread = /\bthread\s+([A-Za-z0-9_-]{8,})/.exec(answer ?? '')?.[1]
  const run = /\brun\s+(\S+[\\/]\.codex[\\/]runs[\\/]\S+)/.exec(answer ?? '')?.[1]
  return { ...(thread ? { thread } : {}), ...(run ? { run } : {}) }
}

export type InboxCommand =
  | { kind: 'open' }
  | { kind: 'status' }
  | { kind: 'refresh' }
  | { kind: 'help' }
  | { kind: 'list' }
  | { kind: 'new'; title: string; body: string; worker?: InboxWorker; paths: string[]; after: string[] }
  | { kind: 'run'; items: string[] }
  | { kind: 'review'; items: string[] }
  | { kind: 'drain'; width: number }
  | { kind: 'reopen'; items: string[] }
  | { kind: 'accept'; item: string; commit?: string }
  | { kind: 'unlock'; item: string; force: boolean }
  | { kind: 'show'; item: string }
  | { kind: 'error'; text: string }

export const HELP = [
  '/inbox                                          open the inbox pane',
  '/inbox new [--worker codex|claude] [--paths a,b] [--after item,item] <title> [-- <details>]   add an item',
  '/inbox run <item> [<item>…]                     claim each ready item and start its worker (name or number)',
  '/inbox drain [n|off]                            keep n workers (default 2, max 10) on ready items until none are left',
  '/inbox status                                   one line: ready, processing, review, blocked, done, and what to run next',
  '/inbox refresh                                  find the inbox/ folder again and re-read every item (the pane also does this every few seconds)',
  '/inbox review <item> [<item>…]                  start a reviewer on an item in review/: it verifies, commits and moves it to done/',
  '/inbox accept <item> [<sha>]                    you reviewed it yourself: mark it done and move it to done/',
  '/inbox reopen <item> [<item>…]                  send an item back to todo (from processing/, review/ or blocked/)',
  '/inbox unlock <item> [--force]                  release a lock this session holds; --force releases any lock',
  '/inbox show <item> · /inbox list                print an item, or all of them',
  `Items are markdown files in ${DIR}/ (todo), ${DIR}/processing/, review/, done/ and blocked/; the repo's AGENTS.md describes them.`,
].join('\n')

const tokens = (words: string[]) => words.filter(word => word && !word.startsWith('--'))

export function parseCommand(args: string): InboxCommand {
  const text = args.trim()
  const [verb = '', ...words] = text.split(/\s+/)
  const rest = text.slice(verb.length).trim()
  switch (verb) {
    case '':
      return { kind: 'open' }
    case 'help':
      return { kind: 'help' }
    case 'list':
      return { kind: 'list' }
    case 'status':
      return { kind: 'status' }
    case 'refresh':
    case 'reload':
      return { kind: 'refresh' }
    case 'review':
    case 'commit': {
      const list = tokens(words)
      return list.length > 0 ? { kind: 'review', items: list } : { kind: 'error', text: 'Usage: /inbox review <item> [<item>…]' }
    }
    case 'accept':
    case 'done': {
      const [item, commit] = tokens(words)
      return item ? { kind: 'accept', item, ...(commit ? { commit } : {}) } : { kind: 'error', text: 'Usage: /inbox accept <item> [<sha>]' }
    }
    case 'unlock': {
      const [item] = tokens(words)
      return item ? { kind: 'unlock', item, force: words.includes('--force') } : { kind: 'error', text: 'Usage: /inbox unlock <item> [--force]' }
    }
    case 'new':
    case 'add': {
      let head = rest
      let body = ''
      const split = rest.indexOf(' -- ')
      if (split >= 0) {
        head = rest.slice(0, split)
        body = rest.slice(split + 4).trim()
      }
      const flags: Record<string, string> = {}
      const flag = /^--(worker|paths|owner|after|depends)\s+(\S+)\s*/
      for (let m = flag.exec(head); m; m = flag.exec(head)) {
        flags[m[1] ?? ''] = m[2] ?? ''
        head = head.slice(m[0].length)
      }
      const title = head.trim()
      if (!title) return { kind: 'error', text: 'Usage: /inbox new [--worker codex|claude] [--paths a,b] [--after item,item] <title> [-- <details>]' }
      const worker = WORKERS.find(one => one === flags.worker)
      if (flags.worker && !worker) return { kind: 'error', text: `--worker takes codex or claude, not ${flags.worker}` }
      return {
        kind: 'new',
        title,
        body,
        ...(worker ? { worker } : {}),
        paths: listField(flags.paths ?? flags.owner).map(normalizePath),
        after: listField(flags.after ?? flags.depends),
      }
    }
    case 'run':
    case 'deploy':
    case 'dispatch': {
      const list = tokens(words)
      return list.length > 0 ? { kind: 'run', items: list } : { kind: 'error', text: 'Usage: /inbox run <item> [<item>…]' }
    }
    case 'drain': {
      const word = words[0]
      if (word === undefined) return { kind: 'drain', width: 2 }
      if (word === 'off' || word === 'stop') return { kind: 'drain', width: 0 }
      const width = Number(word)
      return Number.isInteger(width) && width >= 1 && width <= MAX_WIDTH
        ? { kind: 'drain', width }
        : { kind: 'error', text: `Usage: /inbox drain [1-${MAX_WIDTH}|off]` }
    }
    case 'reopen':
    case 'sendback':
    case 'send-back': {
      const list = tokens(words)
      return list.length > 0 ? { kind: 'reopen', items: list } : { kind: 'error', text: 'Usage: /inbox reopen <item> [<item>…]' }
    }
    case 'show': {
      const [item] = tokens(words)
      return item ? { kind: 'show', item } : { kind: 'error', text: 'Usage: /inbox show <item>' }
    }
    default:
      return { kind: 'error', text: HELP }
  }
}

/** One line on where the inbox stands; every answer that would otherwise say nothing ends with it. */
export function summary(input: {
  tasks: readonly InboxTask[]
  runs: readonly InboxRun[]
  locks: readonly InboxLock[]
  me: string
  now: number
  cfg: WatchConfig
  drain: number
}): string {
  const { tasks, runs, locks, me, now, cfg, drain } = input
  if (tasks.length === 0) return `The inbox is empty: no items in ${DIR}/. Add one: /inbox new <title>`
  const elsewhere = locks.filter(lock => lockState(lock, now, me, cfg.lockStaleMs) === 'held')
  const blocked = new Set(elsewhere.map(lock => lock.task))
  const c = counts(tasks, runs, blocked)
  const live = runs.filter(isLive)
  const stalled = stallCounts(runs, now, cfg)
  const idle = live.filter(run => level(run, now, cfg) === 'idle')
  const out = live.filter(run => level(run, now, cfg) === 'timedOut')
  const parts = [`${c.ready} ready`]
  if (c.todo - c.ready > 0) parts.push(`${c.todo - c.ready} waiting`)
  if (c.processing > 0 || live.length > 0) {
    const names = idle.map(run => `${run.task} idle ${shortDuration(now - run.lastActivityAt)}`).join(', ')
    parts.push(`${c.processing} processing${live.length > 0 ? ` (${live.length - stalled.timedOut} live here${names ? `; ${names}` : ''})` : ''}`)
  }
  if (out.length > 0) parts.push(`${out.length} timed out (${out.map(run => run.task).join(', ')})`)
  if (c.review > 0) parts.push(`${c.review} in review`)
  if (c.blocked > 0) parts.push(`${c.blocked} blocked`)
  parts.push(`${c.done} done`)
  if (elsewhere.length > 0) parts.push(`locked elsewhere: ${elsewhere.map(lock => `${lock.task} (${lock.phase})`).join(', ')}`)
  const next = pending(tasks, runs, blocked)
  const review = tasks.filter(one => one.status === 'review' && !liveRun(runs, one.name))
  const hints = [
    ...(next.length > 0 ? [`/inbox run ${next[0]?.name}`, ...(drain > 0 ? [] : ['/inbox drain'])] : []),
    ...(review.length > 0 ? [`/inbox review ${review[0]?.name}`] : []),
  ]
  return `Inbox: ${parts.join(' · ')}.${hints.length > 0 ? ` Next: ${hints.join(' · ')}` : ''}${drain > 0 ? ` Draining ×${drain}.` : ''}`
}
