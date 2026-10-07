import { expect, test } from 'claude-code/testing'

import type { AutoDenySession } from '../types'
import {
  PENDING_MS,
  addDenial,
  clearAll,
  consume,
  grant,
  inputOf,
  isClassifierDeny,
  isHumanOrigin,
  matchKey,
  parseArgs,
  parseConfig,
  pendingList,
  reasonTag,
  refuse,
  retryText,
  summarize,
  sweep,
} from '../hooks/deny'

const NOW = Date.parse('2026-10-07T10:00:00Z')
const EMPTY: AutoDenySession = { denials: [], allowances: [], seq: 0 }
const SED = "sed -i 's/old/new/' ~/.claude/agents/codex-runner.md"

const raw = (id: string | undefined, command: string, over: Record<string, unknown> = {}) => ({
  ...(id === undefined ? {} : { id }),
  tool: 'Bash',
  input: { command, description: 'x' },
  reason: '[Self-Modification] edits agent config',
  source: 'classic' as const,
  ...over,
})

const add = (s: AutoDenySession, r: ReturnType<typeof raw>, now = NOW) => addDenial(s, r, now)

test('matchKey: whitespace, description, timeout and path spelling do not change the match', () => {
  expect(matchKey('Bash', { command: '  sed -i  "s/a/b/"  f ' })).toBe(matchKey('Bash', { command: 'sed -i "s/a/b/" f' }))
  expect(matchKey('Bash', { command: 'ls', description: 'one' })).toBe(matchKey('Bash', { command: 'ls', description: 'two' }))
  expect(matchKey('Bash', { command: 'ls', timeout: 5, run_in_background: true })).toBe(matchKey('Bash', { command: 'ls' }))
  expect(matchKey('Edit', { file_path: 'C:\\Users\\x\\f.md', old_string: 'a', new_string: 'b' })).toBe(
    matchKey('Edit', { file_path: 'c:/Users/x/f.md', old_string: 'a', new_string: 'b' }),
  )
})

test('matchKey: a different act is a different key', () => {
  expect(matchKey('Bash', { command: 'ls' })).not.toBe(matchKey('Bash', { command: 'ls -la' }))
  expect(matchKey('Bash', { command: 'ls' })).not.toBe(matchKey('PowerShell', { command: 'ls' }))
  expect(matchKey('Bash', { command: 'ls', dangerouslyDisableSandbox: true })).not.toBe(matchKey('Bash', { command: 'ls' }))
  expect(matchKey('Edit', { file_path: 'f', new_string: 'a' })).not.toBe(matchKey('Edit', { file_path: 'f', new_string: 'b' }))
  const big = 'x'.repeat(5000)
  expect(matchKey('Write', { file_path: 'f', content: big })).not.toBe(matchKey('Write', { file_path: 'f', content: `${big.slice(0, -1)}y` }))
  expect(matchKey('Write', { file_path: 'f', content: big })).toBe(matchKey('Write', { file_path: 'f', content: big }))
  expect(matchKey('Write', { file_path: 'f', content: big }).length).toBeLessThan(100)
})

test('summarize: shell head, file path, JSON for unknown tools', () => {
  const s = summarize('Bash', { command: 'a'.repeat(200) })
  expect(s).toHaveLength(120)
  expect(s.endsWith('…')).toBe(true)
  expect(summarize('Edit', { file_path: 'C:/x/f.md', old_string: 'a' })).toBe('C:/x/f.md')
  expect(summarize('Grep', { pattern: 'foo', path: 'src' })).toBe('foo in src')
  expect(summarize('Mystery', { b: 1, a: 2 })).toBe('{"a":2,"b":1}')
})

test('reasonTag and isClassifierDeny read the classifier wording', () => {
  expect(reasonTag('[Self-Modification] edits agent config')).toBe('Self-Modification')
  expect(reasonTag('denied by the auto mode classifier')).toBe('classifier')
  expect(isClassifierDeny({ deny: 'blocked by the auto-mode classifier: x' })).toBe(true)
  expect(isClassifierDeny({ isError: true, text: 'denied by the Claude Code auto mode classifier. Reason: [x]' })).toBe(true)
  expect(isClassifierDeny({ isError: true, text: 'Exit code 1' })).toBe(false)
  expect(isClassifierDeny({ deny: 'guardrail: no' })).toBe(false)
  expect(isClassifierDeny({})).toBe(false)
  expect(isClassifierDeny(undefined)).toBe(false)
  expect(inputOf({ tool: 'Bash', tool_use_id: 't', agentId: 'a', consent: 1, command: 'ls' })).toEqual({ command: 'ls' })
})

test('the ring keeps the last 20, numbers keep counting', () => {
  let s = EMPTY
  for (let i = 1; i <= 25; i++) s = add(s, raw(`t${i}`, `cmd ${i}`)).state
  expect(s.denials).toHaveLength(20)
  expect(s.denials.map(d => d.n)).toEqual(Array.from({ length: 20 }, (_, i) => i + 6))
})

test('the same id merges, and classic overwrites the tag', () => {
  const a = add(EMPTY, raw('t1', 'ls', { source: 'tool-result', reason: 'denied by the auto mode classifier' }))
  expect(a.entry.tag).toBe('classifier')
  const b = add(a.state, raw('t1', 'ls'))
  expect(b.isNew).toBe(false)
  expect(b.state.denials).toHaveLength(1)
  expect(b.entry.tag).toBe('Self-Modification')
})

test('two signals for one call merge, a repeat while pending counts', () => {
  const a = add(EMPTY, raw(undefined, 'ls', { source: 'tool-result' }))
  const b = add(a.state, raw('t9', 'ls'), NOW + 2000)
  expect(b.isNew).toBe(false)
  expect(b.state.denials).toHaveLength(1)
  const c = add(b.state, raw('t10', 'ls'), NOW + 60_000)
  expect(c.isNew).toBe(false)
  expect(c.entry.times).toBe(2)
  expect(add(c.state, raw('t11', 'other'), NOW + 61_000).isNew).toBe(true)
})

test('grant, consume, refuse, sweep', () => {
  const s0 = add(EMPTY, raw('t1', SED)).state
  const g = grant(s0, undefined, 'band', NOW, 10)
  expect(g.entry?.outcome).toBe('allowed')
  expect(g.state.allowances[0]?.expiresAt).toBe(NOW + 600_000)
  expect(grant(g.state, 1, 'band', NOW + 1000, 10).error).toContain('already allowed')

  const key = matchKey('Bash', { command: SED })
  const c = consume(g.state, 'Bash', key, NOW + 1000)
  expect(c.used).toBe(true)
  expect(c.state.allowances).toHaveLength(0)
  expect(c.state.denials[0]?.outcome).toBe('used')
  expect(consume(c.state, 'Bash', key, NOW + 1000).used).toBe(false)
  expect(grant(c.state, 1, 'command', NOW + 2000, 10).entry?.outcome).toBe('allowed')

  const r = refuse(g.state, 1, 'band', NOW + 1000)
  expect(r.state.allowances).toHaveLength(0)
  expect(r.state.denials[0]?.outcome).toBe('refused')

  const swept = sweep(g.state, NOW + 600_001)
  expect(swept.changed).toBe(true)
  expect(swept.state.denials[0]?.outcome).toBe('expired')
  expect(consume(g.state, 'Bash', key, NOW + 600_001).used).toBe(false)

  const stale = sweep(s0, NOW + PENDING_MS)
  expect(stale.state.denials[0]?.outcome).toBe('expired')
  expect(pendingList(s0, NOW + PENDING_MS)).toEqual([])
})

test('grant and refuse errors, and clear', () => {
  expect(grant(EMPTY, undefined, 'band', NOW, 10).error).toBe('Nothing is pending.')
  expect(grant(EMPTY, 4, 'band', NOW, 10).error).toBe('No blocked call #4 in the last 20.')
  expect(refuse(EMPTY, undefined, 'band', NOW).error).toBe('Nothing is pending.')
  const g = grant(add(EMPTY, raw('t1', 'ls')).state, undefined, 'band', NOW, 10).state
  const cleared = clearAll(add(g, raw('t2', 'rm x')).state, NOW)
  expect(cleared.allowances).toEqual([])
  expect(pendingList(cleared, NOW)).toEqual([])
  expect(cleared.denials).toHaveLength(2)
})

test('parseArgs reads every form', () => {
  expect(parseArgs('')).toEqual({ kind: 'status' })
  expect(parseArgs('status')).toEqual({ kind: 'status' })
  expect(parseArgs('allow')).toEqual({ kind: 'allow' })
  expect(parseArgs('allow 3')).toEqual({ kind: 'allow', n: 3 })
  expect(parseArgs('refuse 2')).toEqual({ kind: 'refuse', n: 2 })
  expect(parseArgs('refuse')).toEqual({ kind: 'refuse' })
  expect(parseArgs('clear')).toEqual({ kind: 'clear' })
  expect(parseArgs('allow x')).toEqual({ kind: 'usage' })
  expect(parseArgs('bogus')).toEqual({ kind: 'usage' })
})

test('retryText says what, how, and who', () => {
  const d = add(EMPTY, raw('t1', SED)).entry
  const t = retryText(d, 'band', 10)
  expect(t).toContain('Bash')
  expect(t).toContain("sed -i 's/old/new/'")
  expect(t).toContain('Retry it unchanged; it is allowed once')
  expect(t).not.toContain('A subagent made this call')
  expect(retryText({ ...d, agentId: 'a1' }, 'band', 10)).toContain('A subagent made this call')
  expect(retryText(d, 'command', 10)).toContain('/auto-allow allow')
})

test('isHumanOrigin and parseConfig', () => {
  expect(isHumanOrigin(undefined)).toBe(false)
  expect(isHumanOrigin({ kind: 'plugin' })).toBe(false)
  expect(isHumanOrigin({ kind: 'composer' })).toBe(true)
  expect(parseConfig({})).toEqual({ ttlMinutes: 10, maxPending: 3, autoSubmit: true, askDialog: false })
  expect(parseConfig({ ttlMinutes: 999, maxPending: 0, autoSubmit: false, askDialog: true })).toEqual({
    ttlMinutes: 120,
    maxPending: 1,
    autoSubmit: false,
    askDialog: true,
  })
  expect(parseConfig({ ttlMinutes: 'abc' }).ttlMinutes).toBe(10)
})
