import { expect, test } from 'claude-code/testing'

import type { UserSound } from '../types'
import { BUILTINS } from '../hooks/builtins'
import {
  DEFAULTS,
  MUTED_FOREVER,
  askFromCheck,
  decide,
  inQuiet,
  isClassifierDeny,
  isLongTool,
  mergeMapping,
  parseArgs,
  parseQuiet,
  pickSound,
  psPlayArgs,
  readWavHeader,
  resolveSound,
  statusText,
  turnCue,
  type Gate,
  type Resolved,
} from '../hooks/board'

const SOUND: Resolved = { kind: 'builtin', file: 'pop.wav', durationMs: 100 }
const gate = (over: Partial<Gate> = {}): Gate => ({
  enabled: true, mutedUntil: null, quiet: null, cooldownMs: 300, lastPlayed: {}, lastPriority: 0, isHeadless: false, ...over,
})
const NOON = new Date(2026, 9, 3, 12, 0).getTime()
const why = (v: ReturnType<typeof decide>) => (v.play ? 'play' : v.why)

test('decide: each gate in order, and the test bypass', () => {
  expect(why(decide('turn.done', 'off', gate(), NOON, 720, true))).toBe('off')
  expect(why(decide('turn.done', SOUND, gate({ enabled: false }), NOON, 720))).toBe('disabled')
  expect(why(decide('turn.done', SOUND, gate({ isHeadless: true }), NOON, 720))).toBe('headless')
  expect(why(decide('turn.done', SOUND, gate({ mutedUntil: NOON + 1 }), NOON, 720))).toBe('muted')
  expect(why(decide('turn.done', SOUND, gate({ mutedUntil: NOON }), NOON, 720))).toBe('play')
  expect(why(decide('turn.done', SOUND, gate({ quiet: { start: 600, end: 800 } }), NOON, 720))).toBe('quiet')
  expect(why(decide('turn.done', SOUND, gate({ lastPlayed: { 'turn.done': NOON - 100 } }), NOON, 720))).toBe('cooldown')
  expect(why(decide('turn.done', SOUND, gate({ lastPlayed: { 'turn.done': NOON - 400 } }), NOON, 720))).toBe('play')
  // a test plays through mute, quiet hours and a disabled switch
  expect(why(decide('turn.done', SOUND, gate({ enabled: false, mutedUntil: MUTED_FOREVER, isHeadless: true }), NOON, 720, true))).toBe('play')
})

test('decide: the same tick lets only a higher priority overlap', () => {
  const g = gate({ lastPlayed: { '*': NOON - 50, 'agent.spawn': NOON - 50 }, lastPriority: 5 })
  expect(why(decide('agent.spawn', SOUND, gate({ ...g, lastPlayed: { '*': NOON - 50 } }), NOON, 720))).toBe('busy')
  expect(why(decide('permission.autoDenied', SOUND, g, NOON, 720))).toBe('play')
  expect(why(decide('turn.done', SOUND, g, NOON, 720))).toBe('busy')
  expect(why(decide('agent.spawn', SOUND, gate({ lastPlayed: { '*': NOON - 500 }, lastPriority: 9 }), NOON, 720))).toBe('play')
})

test('quiet hours parse and wrap midnight', () => {
  const night = parseQuiet('22:00-08:00')
  expect(night).toEqual({ start: 1320, end: 480 })
  for (const m of [23 * 60 + 30, 3 * 60, 7 * 60 + 59]) expect(inQuiet(night, m)).toBe(true)
  for (const m of [8 * 60, 12 * 60]) expect(inQuiet(night, m)).toBe(false)
  const day = parseQuiet('09:00-17:00')
  expect(inQuiet(day, 9 * 60)).toBe(true)
  expect(inQuiet(day, 17 * 60)).toBe(false)
  expect(parseQuiet('')).toBeNull()
  expect(parseQuiet('25:00-1')).toBeNull()
  expect(parseQuiet('9-5')).toBeNull()
  expect(parseQuiet('10:00-10:00')).toBeNull()
  expect(parseQuiet(' 9:05 - 9:30 ')).toEqual({ start: 545, end: 570 })
  expect(inQuiet(null, 0)).toBe(false)
})

test('turnCue classifies a finished turn', () => {
  const known = { a1: { description: 'scan', isTop: true }, a2: { description: 'deep', isTop: false } }
  const main = { reason: 'answer', durationMs: 25_000 }
  expect(turnCue(main, 20, known, 'all')).toBe('turn.done')
  expect(turnCue({ ...main, durationMs: 5000 }, 20, known, 'all')).toBeUndefined()
  expect(turnCue({ ...main, durationMs: 5000 }, 0, known, 'all')).toBe('turn.done')
  expect(turnCue({ reason: 'error', durationMs: 1 }, 20, known, 'all')).toBe('turn.failed')
  expect(turnCue({ reason: 'refusal', durationMs: 1 }, 20, known, 'all')).toBe('turn.failed')
  expect(turnCue({ ...main, isAborted: true }, 20, known, 'all')).toBeUndefined()
  expect(turnCue({ reason: 'aborted', durationMs: 90_000 }, 20, known, 'all')).toBeUndefined()
  expect(turnCue({ ...main, agentId: 'a1', durationMs: 10 }, 20, known, 'all')).toBe('agent.done')
  expect(turnCue({ reason: 'refusal', durationMs: 10, agentId: 'a1' }, 20, known, 'all')).toBe('agent.failed')
  expect(turnCue({ reason: 'error', durationMs: 10, agentId: 'a1' }, 20, known, 'all')).toBe('agent.failed')
  expect(turnCue({ ...main, agentId: 'zzz' }, 20, known, 'all')).toBeUndefined()
  expect(turnCue({ ...main, agentId: 'a2' }, 20, known, 'top')).toBeUndefined()
  expect(turnCue({ ...main, agentId: 'a2' }, 20, known, 'all')).toBe('agent.done')
})

test('mergeMapping keeps known cues and drops the rest', () => {
  expect(mergeMapping(undefined).cues).toEqual(DEFAULTS)
  expect(mergeMapping('junk').cues).toEqual(DEFAULTS)
  const merged = mergeMapping({ version: 1, cues: { 'agent.spawn': 'off', 'nope.cue': 'builtin:bell', 'turn.done': 5 } })
  expect(merged.cues['agent.spawn']).toBe('off')
  expect(merged.cues['turn.done']).toBe(DEFAULTS['turn.done'])
  expect('nope.cue' in merged.cues).toBe(false)
})

test('resolveSound and pickSound', () => {
  const users: UserSound[] = [{ file: 'my ding.wav', path: 'C:/h/.claude/sounds/my ding.wav', size: 10, mime: 'audio/wav' }]
  expect(resolveSound('off', BUILTINS, users)).toBe('off')
  expect(resolveSound('builtin:bell', BUILTINS, users)).toEqual({ kind: 'builtin', file: 'bell.wav', durationMs: 600 })
  expect(resolveSound('user:my ding.wav', BUILTINS, users)).toEqual({ kind: 'user', path: 'C:/h/.claude/sounds/my ding.wav', mime: 'audio/wav' })
  expect(resolveSound('user:gone.wav', BUILTINS, users)).toBe('missing')
  expect(resolveSound('builtin:nope', BUILTINS, users)).toBe('missing')
  expect(pickSound('my ding', BUILTINS, users)).toBe('user:my ding.wav')
  expect(pickSound('My Ding.WAV', BUILTINS, users)).toBe('user:my ding.wav')
  expect(pickSound('bell', BUILTINS, users)).toBe('builtin:bell')
  expect(pickSound('off', BUILTINS, users)).toBe('off')
  expect(pickSound('what', BUILTINS, users)).toBeUndefined()
})

test('/sounds arguments', () => {
  expect(parseArgs('')).toEqual({ kind: 'open' })
  expect(parseArgs('list')).toEqual({ kind: 'list' })
  expect(parseArgs('rescan')).toEqual({ kind: 'rescan' })
  expect(parseArgs('test spawn')).toEqual({ kind: 'test', cue: 'agent.spawn' })
  expect(parseArgs('test AutoDenied')).toEqual({ kind: 'test', cue: 'permission.autoDenied' })
  expect(parseArgs('set agent.done my ding')).toEqual({ kind: 'set', cue: 'agent.done', sound: 'my ding' })
  expect(parseArgs('set compact default')).toEqual({ kind: 'set', cue: 'session.compactAuto', sound: 'default' })
  expect(parseArgs('mute')).toEqual({ kind: 'mute', mode: 'toggle' })
  expect(parseArgs('mute on')).toEqual({ kind: 'mute', mode: 'on' })
  expect(parseArgs('mute off')).toEqual({ kind: 'mute', mode: 'off' })
  expect(parseArgs('unmute')).toEqual({ kind: 'mute', mode: 'off' })
  expect(parseArgs('mute 30m')).toEqual({ kind: 'mute', mode: { forMs: 1_800_000 } })
  expect(parseArgs('mute 90s')).toEqual({ kind: 'mute', mode: { forMs: 90_000 } })
  expect(parseArgs('mute 2h')).toEqual({ kind: 'mute', mode: { forMs: 7_200_000 } })
  expect(parseArgs('mute 1h30m')).toEqual({ kind: 'mute', mode: { forMs: 5_400_000 } })
  expect(parseArgs('mute soon').kind).toBe('error')
  expect(parseArgs('set nope x').kind).toBe('error')
  expect(parseArgs('set spawn').kind).toBe('error')
  expect(parseArgs('test').kind).toBe('error')
  expect(parseArgs('dance').kind).toBe('error')
})

test('classifier denials and ask checks', () => {
  expect(isClassifierDeny({ isError: true, text: 'Permission denied by the Claude Code auto mode classifier' })).toBe(true)
  expect(isClassifierDeny({ deny: 'blocked by auto-mode classifier: risky' })).toBe(true)
  expect(isClassifierDeny({ isError: true, text: 'ENOENT: no such file' })).toBe(false)
  expect(isClassifierDeny({ text: 'the auto mode classifier said ok' })).toBe(false)
  expect(isClassifierDeny(undefined)).toBe(false)
  expect(askFromCheck({ decision: 'ask' }, 'toolu_1')).toBe(true)
  expect(askFromCheck({ decision: 'ask' }, undefined)).toBe(false)
  expect(askFromCheck({ decision: 'allow' }, 'toolu_1')).toBe(false)
  expect(isLongTool('Bash', 61_000, 60, {})).toBe(true)
  expect(isLongTool('Bash', 59_000, 60, {})).toBe(false)
  expect(isLongTool('Bash', 61_000, 0, {})).toBe(false)
  expect(isLongTool('Bash', 61_000, 60, { run_in_background: true })).toBe(false)
  expect(isLongTool('Read', 61_000, 60, {})).toBe(false)
})

test('status text', () => {
  const base = { enabled: true, mutedUntil: null, now: NOON, quiet: null }
  expect(statusText(base)).toBeUndefined()
  expect(statusText({ ...base, enabled: false })).toBe('🔇 off')
  expect(statusText({ ...base, mutedUntil: MUTED_FOREVER })).toBe('🔇 muted')
  expect(statusText({ ...base, mutedUntil: NOON + 30 * 60_000 })).toBe('🔇 until 12:30')
  expect(statusText({ ...base, mutedUntil: NOON - 1 })).toBeUndefined()
  expect(statusText({ ...base, quiet: { start: 11 * 60, end: 13 * 60 } })).toBe('🔇 quiet until 13:00')
})

test('every built-in is a 44.1 kHz mono 16-bit wav of 100 to 600 ms, and the defaults name real ones', () => {
  expect(BUILTINS.length).toBeGreaterThanOrEqual(13)
  for (const one of BUILTINS) {
    const info = readWavHeader(one.header)
    if ('error' in info) throw new Error(`${one.name}: ${info.error}`)
    expect([info.sampleRate, info.channels, info.bitsPerSample]).toEqual([44100, 1, 16])
    expect(info.durationMs).toBeGreaterThanOrEqual(100)
    expect(info.durationMs).toBeLessThanOrEqual(600)
    expect(Math.abs(info.durationMs - one.durationMs)).toBeLessThanOrEqual(1)
  }
  for (const id of Object.values(DEFAULTS)) expect(resolveSound(id, BUILTINS, [])).not.toBe('missing')
  const bad = [...(BUILTINS[0]?.header ?? [])]
  bad[0] = 0
  expect('error' in readWavHeader(bad)).toBe(true)
  expect('error' in readWavHeader(bad.slice(0, 20))).toBe(true)
})

test('the PowerShell scripts are fixed text with no path in them', () => {
  for (const kind of ['wav', 'mp3'] as const) {
    const argv = psPlayArgs(kind)
    expect(argv[0]).toBe('powershell.exe')
    expect(argv[argv.length - 1]).toContain('$env:SB_FILE')
    expect(argv.join(' ')).not.toMatch(/[A-Za-z]:\\|\.wav|\.mp3|assets/)
  }
})
