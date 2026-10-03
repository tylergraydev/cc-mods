import type { HandoffRecord, Meter, Nudge } from '../types'

/** The whole `$.state` of this mod as one value. */
export type State = {
  meter: Meter
  lastHandoff: HandoffRecord | null
  nudge: Nudge | null
  firedBand: number | null
  urgentFired: boolean
  turnsWaited: number
  turns: number
  lastCheckpointTurn: number | null
  requestedPath: string | null
  compactions: number
  lastCompactAt: number | null
}

export const EMPTY: State = {
  meter: { fill: null, tokens: null, window: 0, ceiling: 0, ceilingSource: 'window', isAutoCompact: false, lastMeasuredAt: 0 },
  lastHandoff: null,
  nudge: null,
  firedBand: null,
  urgentFired: false,
  turnsWaited: 0,
  turns: 0,
  lastCheckpointTurn: null,
  requestedPath: null,
  compactions: 0,
  lastCompactAt: null,
}

export const REQUEST_PREFIX = 'Write a handoff document for this session to '
export const COMPACT_MARK = '[handoff-watch]'
/** A handoff file anywhere: HANDOFF.md, HANDOFF-PROJ-1.md, handoff_notes.md; not handoffs.ts or handoffer.md. */
export const HANDOFF_FILE = /(^|\/)handoff(?:[-_.][^/]*)?\.md$/i

export type Config = {
  showAt: number
  warnAt: number
  urgentAt: number
  remindEvery: number
  maxWaitTurns: number
  handoffDir: string
  compactInstructions: boolean
  autoClear: boolean
  autoResume: boolean
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** The options as the module uses them: clamped, ordered, trimmed. */
export function readConfig(o: Record<string, unknown>): Config {
  const warnAt = clamp(num(o.warnAt, 0.6), 0.05, 0.99)
  const remindEvery = clamp(num(o.remindEvery, 0.15), 0.02, 0.5)
  let urgentAt = clamp(num(o.urgentAt, 0.85), 0.05, 0.99)
  if (urgentAt <= warnAt) urgentAt = Math.min(0.99, warnAt + remindEvery)
  return {
    showAt: clamp(num(o.showAt, 0.3), 0.05, 0.99),
    warnAt,
    urgentAt,
    remindEvery,
    maxWaitTurns: Math.round(clamp(num(o.maxWaitTurns, 3), 0, 20)),
    handoffDir: (typeof o.handoffDir === 'string' ? o.handoffDir : '.claude/handoffs').trim().replace(/\\/g, '/').replace(/\/+$/, ''),
    compactInstructions: o.compactInstructions !== false,
    autoClear: o.autoClear !== false,
    autoResume: o.autoResume !== false,
  }
}

/** What fill is measured against: the auto-compact point when known, else the window. */
export function ceilingOf(a: { window: number; threshold?: number; isAutoCompact?: boolean }): { ceiling: number; source: 'threshold' | 'window' } {
  if (a.isAutoCompact !== false && a.threshold !== undefined && a.threshold > 0) return { ceiling: a.threshold, source: 'threshold' }
  return { ceiling: a.window, source: 'window' }
}

/** Tokens over the ceiling; not clamped above 1. */
export function fillOf(tokens: number | undefined | null, ceiling: number): number | null {
  if (tokens === undefined || tokens === null || !(ceiling > 0)) return null
  return tokens / ceiling
}

export type Checkpoint = 'quiet' | 'commit' | 'busy'
export type DecideInput = {
  fill: number | null
  /** The fill of the handoff made in this context, or null. */
  ref: number | null
  checkpoint: Checkpoint
  /** Turn ends while due, this one included. */
  turnsWaited: number
  firedBand: number | null
  urgentFired: boolean
  hasPending: boolean
  cfg: Config
}
export type Decision =
  | { kind: 'idle' }
  | { kind: 'held'; band: number }
  | { kind: 'wait'; band: number }
  | { kind: 'fire'; band: number; reason: 'quiet' | 'commit' | 'waited' | 'urgent' }

/** The nudge line: warnAt, or one step past the last handoff. */
export function baseOf(ref: number | null, cfg: Config): number {
  return ref === null ? cfg.warnAt : Math.max(cfg.warnAt, ref + cfg.remindEvery)
}

/** Whether a nudge is due at a turn end, and why or why not. */
export function decide(i: DecideInput): Decision {
  const { fill, cfg } = i
  if (fill === null) return { kind: 'idle' }
  const base = baseOf(i.ref, cfg)
  if (fill < base) return { kind: 'idle' }
  const band = Math.floor((fill - base) / cfg.remindEvery + 1e-9)
  if (fill >= cfg.urgentAt && !i.urgentFired) return { kind: 'fire', band, reason: 'urgent' }
  if (i.hasPending || (i.firedBand !== null && band <= i.firedBand)) return { kind: 'held', band }
  if (i.checkpoint === 'quiet') return { kind: 'fire', band, reason: 'quiet' }
  if (i.checkpoint === 'commit') return { kind: 'fire', band, reason: 'commit' }
  if (i.turnsWaited >= cfg.maxWaitTurns) return { kind: 'fire', band, reason: 'waited' }
  return { kind: 'wait', band }
}

/** The handoff that still belongs to this context, or null once a compaction has passed. */
export function currentHandoff(s: State): HandoffRecord | null {
  return s.lastHandoff && s.lastHandoff.epoch === s.compactions ? s.lastHandoff : null
}

/** The toast a nudge shows. */
export function nudgeToast(fill: number, reason: Nudge['reason']): { text: string; timeoutMs: number } {
  if (reason === 'urgent') return { text: `handoff-watch: context ${pct(fill)} — auto-compact is close · /handoff now`, timeoutMs: 10000 }
  if (reason === 'commit') return { text: `handoff-watch: context ${pct(fill)} — committed; good moment for a handoff · /handoff`, timeoutMs: 8000 }
  return { text: `handoff-watch: context ${pct(fill)} — good moment for a handoff · /handoff`, timeoutMs: 8000 }
}

/** A main-loop turn ended with an answer: decide, and fold the decision into the state. */
export function turnEnd(
  s: State,
  a: { checkpoint: Checkpoint; now: number; cfg: Config },
): { state: State; decision: Decision; toast?: { text: string; timeoutMs: number } } {
  const ref = currentHandoff(s)?.fill ?? null
  const fill = s.meter.fill
  const decision = decide({
    fill,
    ref,
    checkpoint: a.checkpoint,
    turnsWaited: s.turnsWaited + 1,
    firedBand: s.firedBand,
    urgentFired: s.urgentFired,
    hasPending: s.nudge !== null,
    cfg: a.cfg,
  })
  const turns = s.turns + 1
  if (decision.kind === 'wait') return { state: { ...s, turns, turnsWaited: s.turnsWaited + 1 }, decision }
  if (decision.kind !== 'fire' || fill === null) return { state: { ...s, turns, turnsWaited: 0 }, decision }
  const nudge: Nudge = { band: decision.band, fill, reason: decision.reason, at: a.now, turn: turns }
  return {
    state: {
      ...s,
      turns,
      turnsWaited: 0,
      firedBand: Math.max(s.firedBand ?? -1, decision.band),
      urgentFired: s.urgentFired || decision.reason === 'urgent',
      nudge,
    },
    decision,
    toast: nudgeToast(fill, decision.reason),
  }
}

/** A handoff was written (path) or marked done (null). */
export function recorded(s: State, path: string | null, source: HandoffRecord['source'], now: number): State {
  return {
    ...s,
    lastHandoff: { fill: s.meter.fill, path, at: now, epoch: s.compactions, source },
    nudge: null,
    firedBand: null,
    urgentFired: false,
    turnsWaited: 0,
    requestedPath: null,
    lastCheckpointTurn: s.turns,
  }
}

/** A compaction finished: a fresh context, so nothing is due. */
export function compacted(s: State, tokensAfter: number | undefined, now: number): State {
  return {
    ...s,
    compactions: s.compactions + 1,
    lastCompactAt: now,
    nudge: null,
    firedBand: null,
    urgentFired: false,
    turnsWaited: 0,
    meter: { ...s.meter, fill: tokensAfter === undefined ? null : fillOf(tokensAfter, s.meter.ceiling), tokens: tokensAfter ?? null },
  }
}

/** /clear or a resume: everything starts over except what the model's window says. */
export function cleared(s: State): State {
  const { window, ceiling, isAutoCompact, ceilingSource } = s.meter
  return { ...EMPTY, meter: { ...EMPTY.meter, window, ceiling, isAutoCompact, ceilingSource } }
}

// ---- text -----------------------------------------------------------------

export function pct(f: number): string {
  return `${Math.round(f * 100)}%`
}

/** `160000` is `160k`; 1M and up `1M`; one decimal below 10k. */
export function kTokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${Number((n / 1000).toFixed(1))}k`
  return String(Math.round(n))
}

export function fit(text: string, cols: number): string {
  return text.length <= cols ? text : `${text.slice(0, Math.max(0, cols - 1))}…`
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

type View = Pick<State, 'meter' | 'lastHandoff' | 'compactions' | 'nudge'> & { cfg: Config }

/** The status line: nothing below `showAt`, unless a nudge is showing. */
export function statusText(v: View): string | undefined {
  const { fill } = v.meter
  if (fill === null) return undefined
  if (fill < v.cfg.showAt && v.nudge === null) return undefined
  let text = `ctx ${pct(fill)}`
  const h = v.lastHandoff
  if (h && h.epoch === v.compactions) text += h.fill !== null ? ` · handoff ${pct(h.fill)}` : ' · handoff ✓'
  return text
}

/** The band's first line. */
export function bandLine(s: State): string {
  const { meter, nudge } = s
  const fill = meter.fill ?? nudge?.fill ?? 0
  let text = `◆ context ${pct(fill)} of ${kTokens(meter.ceiling)}`
  if (s.lastCheckpointTurn !== null) text += ` · ${plural(Math.max(0, s.turns - s.lastCheckpointTurn), 'turn')} since last checkpoint`
  if (nudge?.reason === 'commit') text += ' · after commit'
  return text
}

export function stampOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

export const normalizePath = (p: string) => p.replace(/\\/g, '/')

export function handoffPath(dir: string, stamp: string, id?: string): string {
  return `${dir ? `${dir}/` : ''}HANDOFF-${id ?? stamp}.md`
}

/** Whether a written file is a handoff doc: the one asked for, any HANDOFF*.md, or a .md in the handoff folder. */
export function isHandoffPath(filePath: string, requested: string | null, dir: string): boolean {
  const p = normalizePath(filePath).toLowerCase()
  if (requested) {
    const r = normalizePath(requested).toLowerCase()
    if (p === r || p.endsWith(`/${r}`)) return true
  }
  if (HANDOFF_FILE.test(p)) return true
  const d = normalizePath(dir).toLowerCase()
  return d !== '' && p.includes(`/${d}/`) && p.endsWith('.md')
}

/** A path shown relative to the project when it is under it. */
export function relativeTo(path: string, cwd: string): string {
  const p = normalizePath(path)
  const c = normalizePath(cwd).replace(/\/+$/, '')
  return c && p.toLowerCase().startsWith(`${c.toLowerCase()}/`) ? p.slice(c.length + 1) : p
}

export function isGitCommit(command: string): boolean {
  return /\bgit(?:\s+-(?:C|c)\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+commit\b/.test(command) && !/--dry-run\b/.test(command)
}

export function requestText(a: { path: string; focus?: string; previous?: string | null }): string {
  const lines = [
    `${REQUEST_PREFIX}\`${a.path}\`. Sections:`,
    '1. Goal and current status.',
    '2. What was done: files created or changed, commits (hash and subject), commands that mattered.',
    '3. What was verified (by a command, test or file read) versus assumed. Mark anything unverified as UNVERIFIED.',
    '4. Open questions, and the next steps in order.',
    '5. Gotchas and environment notes (services, ports, credentials needed, things that broke).',
    '6. How to resume: the exact commands to run first.',
    'Keep it factual and short; no narrative. Then tell me the path.',
  ]
  if (a.previous && a.previous !== a.path) lines.push(`The previous handoff for this project is \`${a.previous}\`; read it first and carry forward anything still open.`)
  if (a.focus) lines.push(`Focus especially on: ${a.focus}`)
  return lines.join('\n')
}

/** Added to a prompt that talks about a handoff, so the doc lands where this mod looks. */
export function contextLine(fill: number | null, path: string): string {
  const at = fill === null ? 'unknown' : pct(fill)
  return `${COMPACT_MARK} Context is at ${at} of the auto-compact point. If you write a handoff, save it to \`${path}\` with: goal and status; what was done (files, commits, commands); verified vs assumed; open questions and next steps in order; gotchas and environment notes; how to resume (exact commands).`
}

export function compactLine(last: HandoffRecord | null): string {
  let text = `${COMPACT_MARK} In the summary, keep as explicit lists: the current goal and its status; every file created or edited (paths); commits made (hash and subject); which facts were verified by a command or a file read versus assumed; open questions; the next steps in order; the exact commands needed to resume.`
  if (last?.path) text += ` The latest handoff document is ${last.path}${last.fill !== null ? ` (written at ${pct(last.fill)} context)` : ''}; name it in the summary so work can resume from it.`
  return text
}

/** The user's own instructions stay first; ours is added once. */
export function withCompactInstructions(existing: string | undefined, line: string): string {
  if (existing?.includes(COMPACT_MARK)) return existing
  return existing && existing.trim() ? `${existing.trimEnd()}\n\n${line}` : line
}

export type Args = { kind: 'request'; id?: string; focus?: string } | { kind: 'done' } | { kind: 'status' } | { kind: 'resume' }

export function parseArgs(args: string): Args {
  const text = args.trim()
  if (text === '') return { kind: 'request' }
  if (text === 'done') return { kind: 'done' }
  if (text === 'status') return { kind: 'status' }
  if (text === 'resume') return { kind: 'resume' }
  const [first, ...rest] = text.split(/\s+/)
  if (/^[A-Z][A-Z0-9]+-\d+$/.test(first!)) return { kind: 'request', id: first, ...(rest.length > 0 ? { focus: rest.join(' ') } : {}) }
  return { kind: 'request', focus: text }
}

/** `/handoff status`. */
export function statusReport(s: State, cfg: Config, now: number): string {
  const m = s.meter
  const h = currentHandoff(s)
  const read = `${kTokens(m.tokens ?? 0)} tokens, read ${ago(now - m.lastMeasuredAt)} ago`
  let context: string
  if (m.fill === null) context = 'no reading yet (the first response of this context has not arrived)'
  else if (m.ceilingSource === 'threshold') context = `${pct(m.fill)} of the ${kTokens(m.ceiling)} auto-compact point (${read})`
  else context = `${pct(m.fill)} of the ${m.ceiling > 0 ? `${kTokens(m.ceiling)} ` : ''}window (auto-compact off or unknown; ${read})`
  const last = h ? `${h.path ?? 'marked done'}${h.fill !== null ? ` at ${pct(h.fill)}` : ''}, ${ago(now - h.at)} ago` : 'none in this context'
  const compaction = s.compactions > 0 && s.lastCompactAt !== null ? `${s.compactions} (last ${ago(now - s.lastCompactAt)} ago)` : 'none'
  const base = baseOf(h?.fill ?? null, cfg)
  let next: string
  if (s.nudge) next = 'showing now'
  else if (m.fill !== null && m.fill >= base && s.firedBand !== null) next = `next band at ${pct(base + (s.firedBand + 1) * cfg.remindEvery)}`
  else if (m.fill !== null && m.fill >= base) next = `due now; waiting for a quiet turn or a commit (${s.turnsWaited} of ${cfg.maxWaitTurns} busy turns)`
  else next = `at ${pct(base)}`
  if (!s.urgentFired) next += `; urgent at ${pct(cfg.urgentAt)}`
  return ['handoff-watch', `  context       ${context}`, `  last handoff  ${last}`, `  compactions   ${compaction}`, `  next nudge    ${next}`].join('\n')
}

/** The key the store keeps a project's last handoff under. */
export function storeKey(cwd: string): string {
  return `last:${normalizePath(cwd).toLowerCase().replace(/\/+$/, '')}`
}

/** The key under which a /clear issued after a handoff leaves the doc to resume from. */
export function resumeKey(cwd: string): string {
  return `resume:${normalizePath(cwd).toLowerCase().replace(/\/+$/, '')}`
}

/** The prompt submitted into the fresh conversation after a /clear that followed a handoff. */
export function resumeText(path: string): string {
  return [
    `Resume this project from the handoff doc at \`${path}\`.`,
    'Read it in full first. Treat what it lists as verified as fact and what it marks UNVERIFIED as still open.',
    'Then continue with its next steps in order, and say in one line where things stand before you start.',
  ].join('\n')
}

/** The meter after a reading: the ceiling from what is known of the auto-compact point, fill from the tokens. */
export function meterOf(
  prev: Meter,
  ctx: { tokens?: number; window: number },
  a: { threshold?: number; isAutoCompact?: boolean; now: number; keepTokens?: boolean },
): Meter {
  const { ceiling, source } = ceilingOf({ window: ctx.window, threshold: a.threshold, isAutoCompact: a.isAutoCompact })
  const tokens = ctx.tokens ?? (a.keepTokens ? prev.tokens : null)
  return {
    fill: fillOf(tokens, ceiling),
    tokens,
    window: ctx.window,
    ceiling,
    ceilingSource: source,
    isAutoCompact: a.isAutoCompact ?? prev.isAutoCompact,
    lastMeasuredAt: a.now,
  }
}
