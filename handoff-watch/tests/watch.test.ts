import { expect, test } from 'claude-code/testing'

import {
  EMPTY,
  ceilingOf,
  compactLine,
  compacted,
  decide,
  fillOf,
  handoffPath,
  isGitCommit,
  isHandoffPath,
  kTokens,
  parseArgs,
  readConfig,
  recorded,
  requestText,
  stampOf,
  statusText,
  turnEnd,
  withCompactInstructions,
  resumeKey,
  resumeText,
} from '../hooks/watch'
import type { Checkpoint, Config, Decision, State } from '../hooks/watch'

const cfg: Config = { showAt: 0.3, warnAt: 0.6, urgentAt: 0.85, remindEvery: 0.15, maxWaitTurns: 3, handoffDir: '.claude/handoffs', compactInstructions: true, autoClear: true, autoResume: true }

type Row = [number, number | null, number | null, Checkpoint, number, number | null, boolean, boolean, Decision, Partial<Config>?]
const q = 'quiet'
const b = 'busy'
const TABLE: Row[] = [
  [1, null, null, q, 1, null, false, false, { kind: 'idle' }],
  [2, 0.55, null, q, 1, null, false, false, { kind: 'idle' }],
  [3, 0.62, null, b, 1, null, false, false, { kind: 'wait', band: 0 }],
  [4, 0.62, null, b, 3, null, false, false, { kind: 'fire', band: 0, reason: 'waited' }],
  [5, 0.62, null, q, 1, null, false, false, { kind: 'fire', band: 0, reason: 'quiet' }],
  [6, 0.62, null, 'commit', 1, null, false, false, { kind: 'fire', band: 0, reason: 'commit' }],
  [7, 0.7, null, q, 1, 0, false, false, { kind: 'held', band: 0 }],
  [8, 0.7, null, q, 1, null, false, true, { kind: 'held', band: 0 }],
  [9, 0.76, null, q, 1, 0, false, false, { kind: 'fire', band: 1, reason: 'quiet' }],
  [10, 0.7, 0.62, q, 1, null, false, false, { kind: 'idle' }],
  [11, 0.78, 0.62, q, 1, null, false, false, { kind: 'fire', band: 0, reason: 'quiet' }],
  [12, 0.86, null, b, 1, 1, false, false, { kind: 'fire', band: 1, reason: 'urgent' }],
  [13, 0.86, null, b, 1, 1, true, false, { kind: 'held', band: 1 }],
  [14, 0.86, 0.8, b, 1, null, false, false, { kind: 'idle' }],
  [15, 0.96, 0.8, b, 1, null, false, false, { kind: 'fire', band: 0, reason: 'urgent' }],
  [16, 0.62, null, b, 1, null, false, false, { kind: 'fire', band: 0, reason: 'waited' }, { maxWaitTurns: 0 }],
]

for (const [n, fill, ref, checkpoint, turnsWaited, firedBand, urgentFired, hasPending, want, over] of TABLE) {
  test(`decide row ${n}`, () => {
    expect(decide({ fill, ref, checkpoint, turnsWaited, firedBand, urgentFired, hasPending, cfg: { ...cfg, ...over } })).toEqual(want)
  })
}

test('the ceiling is the auto-compact point when known, else the window', () => {
  expect(ceilingOf({ window: 200_000, threshold: 160_000, isAutoCompact: true })).toEqual({ ceiling: 160_000, source: 'threshold' })
  expect(ceilingOf({ window: 200_000, threshold: 160_000, isAutoCompact: false })).toEqual({ ceiling: 200_000, source: 'window' })
  expect(ceilingOf({ window: 200_000 })).toEqual({ ceiling: 200_000, source: 'window' })
})

test('fill is null without tokens and is not clamped', () => {
  expect(fillOf(undefined, 160_000)).toBe(null)
  expect(fillOf(null, 160_000)).toBe(null)
  expect(fillOf(100_000, 0)).toBe(null)
  expect(fillOf(176_000, 160_000)).toBe(1.1)
})

test('status line: hidden below showAt and without a reading, with the handoff when this context has one', () => {
  const meter = { ...EMPTY.meter, fill: 0.64 }
  expect(statusText({ meter: { ...meter, fill: null }, lastHandoff: null, compactions: 0, nudge: null, cfg })).toBe(undefined)
  expect(statusText({ meter: { ...meter, fill: 0.2 }, lastHandoff: null, compactions: 0, nudge: null, cfg })).toBe(undefined)
  expect(statusText({ meter, lastHandoff: null, compactions: 0, nudge: null, cfg })).toBe('ctx 64%')
  const h = { fill: 0.41, path: 'a.md', at: 0, epoch: 0, source: 'detected' as const }
  expect(statusText({ meter, lastHandoff: h, compactions: 0, nudge: null, cfg })).toBe('ctx 64% · handoff 41%')
  expect(statusText({ meter, lastHandoff: { ...h, fill: null }, compactions: 0, nudge: null, cfg })).toBe('ctx 64% · handoff ✓')
  expect(statusText({ meter, lastHandoff: h, compactions: 1, nudge: null, cfg })).toBe('ctx 64%')
})

test('which paths count as a handoff doc', () => {
  const yes = ['C:\\repo\\HANDOFF-PROJ-123.md', '/r/.claude/handoffs/HANDOFF-2026-10-03-1405.md', 'docs/handoff.md', 'handoff_notes.md']
  const no = ['src/handoffs.ts', 'handoffer.md', 'README.md']
  for (const p of yes) expect(isHandoffPath(p, null, '')).toBe(true)
  for (const p of no) expect(isHandoffPath(p, null, '.claude/handoffs')).toBe(false)
  expect(isHandoffPath('/r/.claude/handoffs/notes.md', null, '.claude/handoffs')).toBe(true)
  expect(isHandoffPath('C:\\r\\out\\resume.md', '.claude/handoffs/x.md', '.claude/handoffs')).toBe(false)
  expect(isHandoffPath('C:\\r\\.claude\\handoffs\\x.md', '.claude/handoffs/x.md', '')).toBe(true)
})

test('git commit detection', () => {
  for (const c of ['git commit -m x', 'git -C repo commit', 'cd x && git commit -am "y"']) expect(isGitCommit(c)).toBe(true)
  for (const c of ['git log --grep commit', 'git commit --dry-run', 'git status']) expect(isGitCommit(c)).toBe(false)
})

test('dates and paths', () => {
  expect(stampOf(new Date(2026, 9, 3, 14, 5))).toBe('2026-10-03-1405')
  expect(handoffPath('.claude/handoffs', '2026-10-03-1405')).toBe('.claude/handoffs/HANDOFF-2026-10-03-1405.md')
  expect(handoffPath('', '2026-10-03-1405', 'PROJ-123')).toBe('HANDOFF-PROJ-123.md')
  expect(kTokens(160_000)).toBe('160k')
  expect(kTokens(1_000_000)).toBe('1M')
  expect(kTokens(4500)).toBe('4.5k')
})

test('the request names its sections, the previous doc and the focus', () => {
  const plain = requestText({ path: 'H.md' })
  expect(plain.startsWith('Write a handoff document for this session to `H.md`. Sections:')).toBe(true)
  expect(plain).toContain('6. How to resume')
  expect(plain).not.toContain('previous handoff')
  const full = requestText({ path: 'H.md', previous: 'P.md', focus: 'the auth bug' })
  expect(full).toContain('The previous handoff for this project is `P.md`')
  expect(full).toContain('Focus especially on: the auth bug')
  expect(requestText({ path: 'H.md', previous: 'H.md' })).not.toContain('previous handoff')
})

test('compaction instructions keep the user text first and are added once', () => {
  const line = compactLine({ fill: 0.5, path: 'H.md', at: 0, epoch: 0, source: 'detected' })
  expect(line).toContain('The latest handoff document is H.md (written at 50% context)')
  expect(compactLine(null)).not.toContain('latest handoff')
  const once = withCompactInstructions('keep the plan', line)
  expect(once.startsWith('keep the plan')).toBe(true)
  expect(withCompactInstructions(once, line)).toBe(once)
  expect(withCompactInstructions(undefined, line)).toBe(line)
})

test('/handoff arguments', () => {
  expect(parseArgs('')).toEqual({ kind: 'request' })
  expect(parseArgs('done')).toEqual({ kind: 'done' })
  expect(parseArgs('status')).toEqual({ kind: 'status' })
  expect(parseArgs('PROJ-123 the auth bug')).toEqual({ kind: 'request', id: 'PROJ-123', focus: 'the auth bug' })
  expect(parseArgs('the auth bug')).toEqual({ kind: 'request', focus: 'the auth bug' })
})

test('options are clamped and ordered', () => {
  expect(readConfig({})).toEqual({ ...cfg })
  const c = readConfig({ warnAt: 5, urgentAt: 0.2, remindEvery: 0, maxWaitTurns: 99, handoffDir: ' docs\\h// ' })
  expect(c.warnAt).toBe(0.99)
  expect(c.remindEvery).toBe(0.02)
  expect(c.urgentAt).toBe(0.99)
  expect(c.maxWaitTurns).toBe(20)
  expect(c.handoffDir).toBe('docs\\h'.replace('\\', '/'))
  expect(Math.round(readConfig({ warnAt: 0.5, urgentAt: 0.4, remindEvery: 0.1 }).urgentAt * 100)).toBe(60)
})

test('state transitions: a nudge fires once per band, a handoff or compaction clears it', () => {
  const at = (fill: number): State => ({ ...EMPTY, meter: { ...EMPTY.meter, fill, ceiling: 160_000 } })
  const first = turnEnd(at(0.62), { checkpoint: 'quiet', now: 5, cfg })
  expect(first.toast?.text).toBe('handoff-watch: context 62% — good moment for a handoff · /handoff')
  expect(first.state.nudge?.turn).toBe(1)
  expect(first.state.firedBand).toBe(0)
  const again = turnEnd({ ...first.state, meter: { ...first.state.meter, fill: 0.7 } }, { checkpoint: 'quiet', now: 6, cfg })
  expect(again.decision.kind).toBe('held')
  const done = recorded(first.state, 'H.md', 'detected', 7)
  expect(done.nudge).toBe(null)
  expect(done.lastHandoff?.fill).toBe(0.62)
  const after = compacted(done, 40_000, 8)
  expect(after.compactions).toBe(1)
  expect(after.meter.fill).toBe(0.25)
  expect(after.lastHandoff).toBe(done.lastHandoff)
})

test('resume: the arg, the store key, the prompt and the defaults', () => {
  expect(parseArgs(' resume ')).toEqual({ kind: 'resume' })
  expect(resumeKey('C:/Repo/')).toBe('resume:c:/repo')
  expect(resumeText('docs/H.md')).toContain('`docs/H.md`')
  expect(resumeText('docs/H.md').split('\n')).toHaveLength(3)
  expect(readConfig({})).toMatchObject({ autoClear: true, autoResume: true })
  expect(readConfig({ autoClear: false, autoResume: false })).toMatchObject({ autoClear: false, autoResume: false })
})
