import type { AgentCall, AgentRow, DeckPolicy } from '../types'

const CALLS_KEPT = 12
const ROWS_KEPT = 200

export const isRunning = (row: AgentRow) => row.status === 'running' || row.status === 'pending'

/** Adds a just-started subagent, or refreshes the row it already has. */
export function spawned(
  rows: readonly AgentRow[],
  agent: Pick<AgentRow, 'id' | 'type' | 'description' | 'startedAt'> & Partial<AgentRow>,
): AgentRow[] {
  const held = rows.find(one => one.id === agent.id)
  if (held) return rows.map(one => (one.id === agent.id ? { ...one, ...agent, startedAt: one.startedAt } : one))
  const row: AgentRow = { status: 'running', toolCount: 0, errorCount: 0, calls: [], ...agent }
  return [...rows, row].slice(-ROWS_KEPT)
}

function patch(rows: readonly AgentRow[], id: string, change: (row: AgentRow) => AgentRow): AgentRow[] {
  return rows.map(one => (one.id === id ? change(one) : one))
}

export function toolStarted(rows: readonly AgentRow[], agentId: string, call: Omit<AgentCall, 'isDone'>): AgentRow[] {
  return patch(rows, agentId, row => ({
    ...row,
    toolCount: row.toolCount + 1,
    calls: [...row.calls, { ...call, isDone: false }].slice(-CALLS_KEPT),
  }))
}

export function toolEnded(rows: readonly AgentRow[], agentId: string, callId: string, isError: boolean): AgentRow[] {
  return patch(rows, agentId, row => ({
    ...row,
    errorCount: row.errorCount + (isError ? 1 : 0),
    calls: row.calls.map(one => (one.id === callId ? { ...one, isDone: true, isError } : one)),
  }))
}

export function completed(
  rows: readonly AgentRow[],
  agentId: string,
  done: { reason: string; answer: string; tokens?: number },
  now: number,
): AgentRow[] {
  const status = done.reason === 'answer' ? 'completed' : done.reason === 'aborted' ? 'killed' : 'failed'
  return patch(rows, agentId, row => ({
    ...row,
    status,
    endedAt: now,
    answer: done.answer || row.answer,
    tokens: (row.tokens ?? 0) + (done.tokens ?? 0) || undefined,
    calls: row.calls.map(one => ({ ...one, isDone: true })),
  }))
}

/** Folds in the engine's own list: agents the deck missed, and statuses it did not see change. */
export function synced(
  rows: readonly AgentRow[],
  list: readonly { id: string; type: string; description: string; status: string; parentId?: string; spawnedBy?: string }[],
  now: number,
): AgentRow[] {
  let next = [...rows]
  for (const one of list) {
    const held = next.find(row => row.id === one.id)
    if (!held) {
      next = spawned(next, { ...one, startedAt: now })
      continue
    }
    if (held.status !== one.status && (isRunning(held) || held.status === 'pending')) {
      next = patch(next, one.id, row => ({
        ...row,
        status: one.status,
        endedAt: isRunning({ ...row, status: one.status }) ? undefined : (row.endedAt ?? now),
      }))
    }
  }
  return next
}

/** The rows as a tree: each parent followed by its children, with their depth. */
export function tree(rows: readonly AgentRow[]): { row: AgentRow; depth: number }[] {
  const ids = new Set(rows.map(one => one.id))
  const out: { row: AgentRow; depth: number }[] = []
  const walk = (parentId: string | undefined, depth: number) => {
    for (const row of rows) {
      const parent = row.parentId && ids.has(row.parentId) ? row.parentId : undefined
      if (parent !== parentId) continue
      out.push({ row, depth })
      if (depth < 8) walk(row.id, depth + 1)
    }
  }
  walk(undefined, 0)
  return out
}

export function counts(rows: readonly AgentRow[]) {
  let running = 0
  let done = 0
  let failed = 0
  for (const row of rows) {
    if (isRunning(row)) running += 1
    else if (row.status === 'completed') done += 1
    else failed += 1
  }
  return { running, done, failed }
}

export function statusText(rows: readonly AgentRow[]): string | undefined {
  if (rows.length === 0) return undefined
  const { running, done, failed } = counts(rows)
  const parts = [`agents ${running} running`]
  if (done) parts.push(`${done} done`)
  if (failed) parts.push(`${failed} failed`)
  return parts.join(' · ')
}

const clip = (text: string, size: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > size ? `${flat.slice(0, size - 1)}…` : flat
}

const base = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** A short line for a tool call: the tool and its main argument. */
export function toolLabel(tool: string, input: Record<string, unknown>): string {
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')
  const arg =
    tool === 'Bash' || tool === 'PowerShell' ? text('command')
    : tool === 'Read' || tool === 'Edit' || tool === 'Write' ? base(text('file_path'))
    : tool === 'Grep' || tool === 'Glob' ? text('pattern')
    : tool === 'WebFetch' ? text('url')
    : tool === 'WebSearch' ? text('query')
    : tool === 'Agent' ? text('description')
    : ''
  const name = tool.startsWith('mcp__') ? tool.split('__').slice(1).join(':') : tool
  return clip(arg ? `${name} ${arg}` : name, 60)
}

/** `/deck spawn <type> [--model <m>] [--bg] <prompt>` after `spawn`. */
export function parseSpawn(args: string): { type: string; model?: string; prompt: string } | { error: string } {
  const words = args.trim().split(/\s+/)
  const type = words.shift()
  let model: string | undefined
  while (words[0]?.startsWith('--')) {
    const flag = words.shift()
    if (flag === '--model') model = words.shift()
    else return { error: `unknown flag ${flag}` }
  }
  const prompt = words.join(' ').trim()
  if (!type || !prompt) return { error: 'usage: /deck spawn <type> [--model <model>] <prompt>' }
  return { type, model, prompt }
}

/** What the policy does to one spawn: refuse it, force a model, or nothing. */
export function judge(
  policy: DeckPolicy,
  spawn: { subagentType: string; model?: string; fork: boolean },
  running: number,
): { deny: string } | { model?: string } {
  if (policy.maxRunning > 0 && running >= policy.maxRunning) {
    return {
      deny: `agent-deck: ${running} subagents are already running (cap ${policy.maxRunning}). Wait for one to finish, or do this yourself.`,
    }
  }
  const forced = policy.models[spawn.subagentType]
  if (forced && !spawn.model && !spawn.fork) return { model: forced }
  return {}
}

/** `1m 12s`, `45s`, `2h 3m`. */
export function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** `812`, `14k`, `1.2M`. */
export function tokenText(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`
  return `${(tokens / 1_000_000).toFixed(1)}M`
}

export type PresetAgent = { type: string; description: string; prompt: string }

const REVIEW_BASE = [
  'You are one of three parallel code reviewers. Review the current changes in the working directory:',
  'run `git status` and `git diff HEAD` (and read untracked files). If this is not a git repository,',
  'review the files modified most recently instead and say which ones you chose.',
  'Do NOT edit, create or delete any files. Read surrounding code as needed to confirm each finding.',
  'Report only findings you verified, most severe first, each as:',
  '`file:line` — severity (high/medium/low) — what is wrong — the concrete fix.',
  'End with a one-line verdict. If you find nothing, say so plainly.',
].join(' ')

const REVIEWERS: { lens: string; description: string; focus: string }[] = [
  {
    lens: 'bugs',
    description: 'review: correctness',
    focus: 'Your lens: correctness. Logic errors, wrong edge cases, broken error handling, race conditions, type misuse, regressions in callers of changed code.',
  },
  {
    lens: 'security',
    description: 'review: security',
    focus: 'Your lens: security and safety. Injection, path traversal, secrets in code or logs, unsafe shell or eval, missing validation of untrusted input, destructive operations without guards.',
  },
  {
    lens: 'quality',
    description: 'review: quality & tests',
    focus: 'Your lens: maintainability and tests. Needless complexity, duplication of existing helpers, misleading names, dead code, and behaviour the changes add without a test covering it.',
  },
]

/** The agents a preset fans out into; `scope` narrows what they look at. */
export function preset(name: string, scope: string): PresetAgent[] | undefined {
  if (name !== 'review') return undefined
  const narrowed = scope ? ` Scope: limit the review to ${scope}.` : ''
  return REVIEWERS.map(one => ({
    type: 'general-purpose',
    description: one.description,
    prompt: `${REVIEW_BASE}${narrowed}\n\n${one.focus}`,
  }))
}

export const PRESETS = ['review'] as const

/** True once every agent of a group has ended. */
export function groupDone(rows: readonly AgentRow[], group: string): boolean {
  const members = rows.filter(one => one.group === group)
  return members.length > 0 && !members.some(isRunning)
}
