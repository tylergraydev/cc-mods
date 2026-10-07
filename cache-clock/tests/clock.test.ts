import { expect, test } from 'claude-code/testing'

import { advise, formatSpan, parseCommand, phaseAt, readConfig, statusText } from '../hooks/clock'

const MIN = 60_000

test('phaseAt: working, idle, warm, warn, cold', () => {
  expect(phaseAt(null, true, 0, 60, 5).phase).toBe('working')
  expect(phaseAt(null, false, 0, 60, 5).phase).toBe('idle')
  expect(phaseAt(0, false, 10 * MIN, 60, 5)).toEqual({ phase: 'warm', remainingMs: 50 * MIN, coldMinutes: 0 })
  expect(phaseAt(0, false, 56 * MIN, 60, 5)).toEqual({ phase: 'warn', remainingMs: 4 * MIN, coldMinutes: 0 })
  expect(phaseAt(0, false, 60 * MIN, 60, 5)).toEqual({ phase: 'cold', remainingMs: 0, coldMinutes: 0 })
  expect(phaseAt(0, false, 73 * MIN + 30_000, 60, 5)).toEqual({ phase: 'cold', remainingMs: -(13 * MIN + 30_000), coldMinutes: 13 })
})

test('phaseAt honours a 5 minute TTL', () => {
  expect(phaseAt(0, false, 3 * MIN, 5, 5).phase).toBe('warn')
  expect(phaseAt(0, false, 5 * MIN + 1, 5, 5).phase).toBe('cold')
})

test('formatSpan rounds minutes up and pads seconds', () => {
  expect(formatSpan(50 * MIN, false)).toBe('50m')
  expect(formatSpan(49 * MIN + 1, false)).toBe('50m')
  expect(formatSpan(1, false)).toBe('1m')
  expect(formatSpan(4 * MIN + 59_000, true)).toBe('4:59')
  expect(formatSpan(5_000, true)).toBe('0:05')
  expect(formatSpan(-1, true)).toBe('0:00')
})

test('statusText per phase', () => {
  expect(statusText({ phase: 'idle', remainingMs: 0, coldMinutes: 0 })).toBeUndefined()
  expect(statusText({ phase: 'working', remainingMs: 0, coldMinutes: 0 })).toBe('warming')
  expect(statusText({ phase: 'warm', remainingMs: 58 * MIN, coldMinutes: 0 })).toBe('58m left')
  expect(statusText({ phase: 'warn', remainingMs: 4 * MIN + 59_000, coldMinutes: 0 })).toBe('4:59 left ⚠')
  expect(statusText({ phase: 'cold', remainingMs: -12 * MIN, coldMinutes: 12 })).toBe('cold 12m · /cache')
})

test('advise: compact for a big context, keep going for a small one, compact when the size is unknown', () => {
  const big = advise(142_000, 30_000, 3)
  expect(big.primary).toBe('compact')
  expect(big.line).toContain('~142k tokens')
  expect(big.line).toContain('3 min ago')
  const small = advise(12_400, 30_000, 0)
  expect(small.primary).toBe('continue')
  expect(small.line).toContain('~12k tokens')
  expect(small.line).toContain('just now')
  expect(advise(null, 30_000, 1).primary).toBe('compact')
})

test('parseCommand', () => {
  expect(parseCommand(undefined)).toEqual({ kind: 'status' })
  expect(parseCommand('  ')).toEqual({ kind: 'status' })
  expect(parseCommand('ttl 5')).toEqual({ kind: 'ttl', minutes: 5 })
  expect(parseCommand('ttl 0').kind).toBe('error')
  expect(parseCommand('ttl x').kind).toBe('error')
  expect(parseCommand('band off')).toEqual({ kind: 'band', on: false })
  expect(parseCommand('band')).toEqual(expect.objectContaining({ kind: 'error' }))
  expect(parseCommand('reset')).toEqual({ kind: 'reset' })
  expect(parseCommand('nope').kind).toBe('error')
})

test('readConfig clamps and defaults', () => {
  expect(readConfig({})).toEqual({ ttlMinutes: 60, warnMinutes: 5, showBand: true, compactAbove: 30_000 })
  expect(readConfig({ ttlMinutes: '5', showBand: false, compactAbove: -4 })).toEqual({ ttlMinutes: 5, warnMinutes: 5, showBand: false, compactAbove: 0 })
  expect(readConfig({ ttlMinutes: 0 }).ttlMinutes).toBe(1)
})
