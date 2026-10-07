import type { Allowance, AutoDenySession, DecidedBy, Denial, DenialSource } from '../types'

export const RING = 20
/** A denial nobody answered goes stale after this long. */
export const PENDING_MS = 30 * 60_000
/** Two signals for one call (PermissionDenied and the tool result) merge inside this window. */
export const MERGE_MS = 10_000
export const SHELL = new Set(['Bash', 'PowerShell', 'Monitor'])

export const USAGE =
  'auto-deny: /auto-allow status | allow [n] | refuse [n] | clear\n' +
  '  allow lets the model retry one exact call that auto mode blocked, once; it has to be typed by you.'

// ---------------------------------------------------------------- config

export type Config = { ttlMinutes: number; maxPending: number; autoSubmit: boolean; askDialog: boolean }

const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Number(v ?? fallback)

  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback
}
const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)

export function parseConfig(o: Readonly<Record<string, unknown>>): Config {
  return {
    ttlMinutes: clamp(o.ttlMinutes, 1, 120, 10),
    maxPending: clamp(o.maxPending, 1, 10, 3),
    autoSubmit: flag(o.autoSubmit, true),
    askDialog: flag(o.askDialog, false),
  }
}

/** Only a person at the composer (or their bridge or SDK) counts; a plugin, peer or scheduled prompt does not. */
export const isHumanOrigin = (origin: { kind?: string } | undefined) => ['composer', 'bridge', 'sdk'].includes(origin?.kind ?? '')

// ---------------------------------------------------------------- recognising a denial

/** The classifier's own wording, with or without "Claude Code" before it. */
export const CLASSIFIER = /auto[- ]mode classifier/i

type CallResult = { deny?: string; isError?: boolean; text?: string }

export const denialText = (r: CallResult | undefined): string | undefined => r?.deny ?? (r?.isError ? r.text : undefined)

/** A tool.call result that says the auto-mode classifier refused the call. */
export function isClassifierDeny(r: CallResult | undefined): boolean {
  const text = denialText(r)

  return typeof text === 'string' && CLASSIFIER.test(text)
}

/** `[Self-Modification]` gives `Self-Modification`; a reason with no tag gives `classifier`. */
export function reasonTag(reason: string): string {
  const m = /\[([A-Za-z][A-Za-z0-9 _-]{1,40})\]/.exec(reason)
  if (m?.[1]) return m[1]
  if (/classifier/i.test(reason)) return 'classifier'

  return reason.trim().slice(0, 40) || 'classifier'
}

const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'consent'])

/** The tool's own arguments out of a tool.call event, which spreads them beside its envelope. */
export function inputOf(e: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(e)) if (!RESERVED.has(k)) out[k] = v

  return out
}

// ---------------------------------------------------------------- matching

export const normalizeCommand = (s: string) => s.replace(/\s+/g, ' ').trim()

const PATH_KEYS = ['file_path', 'notebook_path', 'path']
const NOISE = new Set(['description', 'timeout', 'run_in_background'])

/** `C:\Users\x\f.md` and `c:/Users/x/f.md` are one path. */
const normalizePath = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `${d.toLowerCase()}:`)

/** The input as the match sees it: what the model may vary without changing the act is dropped. */
export function canonicalInput(tool: string, input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input
  const out: Record<string, unknown> = {}
  const isShell = SHELL.has(tool)
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k === 'description') continue
    if (isShell && NOISE.has(k)) continue
    if (isShell && k === 'command' && typeof v === 'string') out[k] = normalizeCommand(v)
    else if (PATH_KEYS.includes(k) && typeof v === 'string') out[k] = normalizePath(v)
    else out[k] = v
  }

  return out
}

/** JSON with keys sorted and undefined dropped, so one input has one spelling. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(x => (x === undefined ? 'null' : stableJson(x))).join(',')}]`
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>
    const parts = Object.keys(o)
      .sort()
      .filter(k => o[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${stableJson(o[k])}`)

    return `{${parts.join(',')}}`
  }

  return JSON.stringify(v) ?? 'null'
}

/** cyrb53: a 53-bit string hash, enough to tell two long inputs apart. */
function hash53(str: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** The identity of a call: tool plus canonical input; long inputs by length and hash. */
export function matchKey(tool: string, input: unknown): string {
  const j = stableJson(canonicalInput(tool, input))

  return j.length <= 4000 ? `${tool}\n${j}` : `${tool}\n#${j.length}:${hash53(j)}`
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

/** One short line saying what the call is. */
export function summarize(tool: string, input: unknown): string {
  const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  if (SHELL.has(tool) && typeof o.command === 'string') return cut(normalizeCommand(o.command), 120)
  if (['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const p = str(o.file_path) ?? str(o.notebook_path)
    if (p) return cut(p, 120)
  }
  if (tool === 'Glob' || tool === 'Grep') {
    const pattern = str(o.pattern)
    if (pattern) return cut(`${pattern}${str(o.path) ? ` in ${str(o.path)}` : ''}`, 120)
  }
  if (tool === 'WebFetch' && str(o.url)) return cut(str(o.url) ?? '', 120)
  if ((tool === 'Agent' || tool === 'Task') && (str(o.subagent_type) || str(o.description))) {
    return cut(`${str(o.subagent_type) ?? 'agent'}: ${str(o.description) ?? ''}`, 120)
  }

  return cut(stableJson(canonicalInput(tool, input)), 120)
}

// ---------------------------------------------------------------- state transitions

export type RawDenial = { id?: string; tool: string; input: unknown; reason: string; agentId?: string; source: DenialSource }

const replaceAt = (list: Denial[], target: Denial, next: Denial) => list.map(d => (d === target ? next : d))

/** Drops expired allowances and stale pending entries. */
export function sweep(s: AutoDenySession, now: number): { state: AutoDenySession; changed: boolean } {
  let changed = false
  const dead = new Set<string>()
  const allowances = s.allowances.filter(a => {
    if (a.expiresAt > now) return true
    dead.add(a.denialId)
    changed = true

    return false
  })
  const denials = s.denials.map(d => {
    const isDead = d.outcome === 'allowed' && dead.has(d.id)
    const isStale = d.outcome === 'pending' && d.at + PENDING_MS <= now
    if (!isDead && !isStale) return d
    changed = true

    return { ...d, outcome: 'expired' as const }
  })

  return changed ? { state: { ...s, denials, allowances }, changed } : { state: s, changed }
}

/** Records a denial, or folds it into one already there. */
export function addDenial(s0: AutoDenySession, raw: RawDenial, now: number): { state: AutoDenySession; entry: Denial; isNew: boolean } {
  const s = sweep(s0, now).state
  const key = matchKey(raw.tool, raw.input)
  const reason = raw.reason.slice(0, 500)
  const tag = reasonTag(raw.reason)

  const same = raw.id === undefined ? undefined : s.denials.find(d => d.id === raw.id)
  if (same) {
    const merged = raw.source === 'classic' ? { ...same, reason, tag } : same

    return { state: { ...s, denials: replaceAt(s.denials, same, merged) }, entry: merged, isNew: false }
  }

  const alike = s.denials.filter(d => d.outcome === 'pending' && d.tool === raw.tool && d.key === key)
  const twin = alike.find(d => d.source !== raw.source && now - d.at <= MERGE_MS)
  if (twin) {
    const merged = raw.source === 'classic' ? { ...twin, reason, tag } : twin

    return { state: { ...s, denials: replaceAt(s.denials, twin, merged) }, entry: merged, isNew: false }
  }

  // the model tried again while the first was undecided: one row, counted
  const again = alike[alike.length - 1]
  if (again) {
    const bumped = { ...again, times: again.times + 1, at: now }

    return { state: { ...s, denials: [...s.denials.filter(d => d !== again), bumped] }, entry: bumped, isNew: false }
  }

  const n = s.seq + 1
  const entry: Denial = {
    id: raw.id ?? `d${n}`,
    n,
    tool: raw.tool,
    key,
    summary: summarize(raw.tool, raw.input),
    reason,
    tag,
    ...(raw.agentId === undefined ? {} : { agentId: raw.agentId }),
    at: now,
    source: raw.source,
    times: 1,
    outcome: 'pending',
  }

  return { state: { ...s, seq: n, denials: [...s.denials, entry].slice(-RING) }, entry, isNew: true }
}

const pick = (s: AutoDenySession, n: number | undefined): Denial | undefined =>
  n === undefined ? [...s.denials].reverse().find(d => d.outcome === 'pending') : s.denials.find(d => d.n === n)

export const ago = (ms: number) => {
  if (ms < 1000) return 'now'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`

  return `${Math.floor(sec / 3600)}h`
}

/** Allows entry `n` (or the newest pending) once, for `ttlMinutes`. */
export function grant(
  s0: AutoDenySession,
  n: number | undefined,
  by: DecidedBy,
  now: number,
  ttlMinutes: number,
): { state: AutoDenySession; entry?: Denial; error?: string } {
  const s = sweep(s0, now).state
  const target = pick(s, n)
  if (!target) return { state: s, error: n === undefined ? 'Nothing is pending.' : `No blocked call #${n} in the last ${RING}.` }
  const live = s.allowances.find(a => a.denialId === target.id)
  if (target.outcome === 'allowed' && live) return { state: s, error: `#${target.n} is already allowed (expires in ${ago(live.expiresAt - now)}).` }

  const entry: Denial = { ...target, outcome: 'allowed', decidedAt: now, by }
  const allowance: Allowance = {
    denialId: target.id,
    n: target.n,
    tool: target.tool,
    key: target.key,
    summary: target.summary,
    grantedAt: now,
    expiresAt: now + ttlMinutes * 60_000,
    by,
  }
  const kept = s.allowances.filter(a => !(a.tool === target.tool && a.key === target.key))

  return {
    state: { ...s, denials: replaceAt(s.denials, target, entry), allowances: [...kept, allowance].slice(-RING) },
    entry,
  }
}

/** Refuses entry `n` (or the newest pending); it only tightens. */
export function refuse(
  s0: AutoDenySession,
  n: number | undefined,
  by: DecidedBy,
  now: number,
): { state: AutoDenySession; entry?: Denial; error?: string } {
  const s = sweep(s0, now).state
  const target = pick(s, n)
  if (!target) return { state: s, error: n === undefined ? 'Nothing is pending.' : `No blocked call #${n} in the last ${RING}.` }
  const entry: Denial = { ...target, outcome: 'refused', decidedAt: now, by }

  return {
    state: { ...s, denials: replaceAt(s.denials, target, entry), allowances: s.allowances.filter(a => a.denialId !== target.id) },
    entry,
  }
}

export function findAllowance(s: AutoDenySession, tool: string, key: string, now: number): Allowance | undefined {
  return s.allowances.find(a => a.tool === tool && a.key === key && a.expiresAt > now)
}

/** Uses up the allowance for this exact call; a second call finds none. */
export function consume(s: AutoDenySession, tool: string, key: string, now: number): { state: AutoDenySession; used: boolean; allowance?: Allowance } {
  const allowance = findAllowance(s, tool, key, now)
  if (!allowance) return { state: s, used: false }

  return {
    state: {
      ...s,
      allowances: s.allowances.filter(a => a !== allowance),
      denials: s.denials.map(d => (d.id === allowance.denialId && d.outcome === 'allowed' ? { ...d, outcome: 'used' as const } : d)),
    },
    used: true,
    allowance,
  }
}

/** /clear: pending entries and allowances end, the history stays. */
export function clearAll(s: AutoDenySession, now: number): AutoDenySession {
  void now

  return {
    ...s,
    allowances: [],
    denials: s.denials.map(d => (d.outcome === 'pending' || d.outcome === 'allowed' ? { ...d, outcome: 'expired' as const } : d)),
  }
}

/** Pending and not stale, newest first. */
export const pendingList = (s: AutoDenySession, now: number): Denial[] =>
  s.denials.filter(d => d.outcome === 'pending' && d.at + PENDING_MS > now).reverse()

// ---------------------------------------------------------------- text

export const toastText = (d: Denial) => `Auto mode blocked ${d.tool}: ${d.tag}. Allow once above the prompt or /auto-allow.`

/** What the model is told when the person allows the call. */
export function retryText(d: Denial, by: DecidedBy, ttlMinutes: number): string {
  const who =
    by === 'band'
      ? 'The user pressed "Allow once"'
      : by === 'command'
        ? 'The user typed /auto-allow allow'
        : 'The user chose "Allow once" in the dialog'
  const sub = d.agentId ? 'A subagent made this call; run it yourself in this conversation if it is still needed. ' : ''

  return (
    `${sub}${who} for the ${d.tool} call that auto mode blocked (${d.tag}): ${d.summary}. ` +
    `Retry it unchanged; it is allowed once (exactly this input, for the next ${ttlMinutes} minutes). If you already ran it, ignore this.`
  )
}

export function statusLine(s: AutoDenySession, now: number): string | undefined {
  const p = pendingList(s, now).length
  const a = s.allowances.filter(x => x.expiresAt > now).length
  if (p === 0 && a === 0) return undefined

  return `auto-deny: ${p} pending${a > 0 ? ` · ${a} allowed` : ''}`
}

export function statusReport(s: AutoDenySession, now: number, cfg: Pick<Config, 'ttlMinutes'>): string {
  const live = s.allowances.filter(a => a.expiresAt > now)
  const lines = [`auto-deny: ${pendingList(s, now).length} pending, ${live.length} allowed once`]
  for (const a of live) lines.push(`  #${a.n} ${a.tool} ${a.summary.slice(0, 60)} expires in ${ago(a.expiresAt - now)}`)
  if (s.denials.length === 0) return 'No auto-mode denials this session.'
  lines.push(`Last ${RING}:`)
  for (const d of [...s.denials].reverse()) {
    lines.push(
      `#${d.n}  ${ago(now - d.at)} ago  ${d.tool}  [${d.tag}]${d.agentId ? ' (subagent)' : ''}  ${d.summary.slice(0, 60)}  ${d.outcome}${d.times > 1 ? ` ×${d.times}` : ''}`,
    )
  }
  lines.push(`Allow once lasts ${cfg.ttlMinutes} min and covers one exact call.`)

  return lines.join('\n')
}

export type Args = { kind: 'status' } | { kind: 'clear' } | { kind: 'usage' } | { kind: 'allow' | 'refuse'; n?: number }

export function parseArgs(args: string): Args {
  const [word = '', arg, ...rest] = args.trim().split(/\s+/)
  const w = word.toLowerCase()
  if (w === '' || w === 'status') return { kind: 'status' }
  if (w === 'clear') return { kind: 'clear' }
  if (w === 'allow' || w === 'refuse') {
    if (rest.length > 0) return { kind: 'usage' }
    if (arg === undefined) return { kind: w }
    if (!/^\d+$/.test(arg)) return { kind: 'usage' }

    return { kind: w, n: Number(arg) }
  }

  return { kind: 'usage' }
}
