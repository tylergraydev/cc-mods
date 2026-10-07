import { expect, test } from 'claude-code/testing'

import {
  DEFAULT_HINT,
  ago,
  newDrops,
  normalizeFolder,
  ownership,
  parseCommand,
  promptText,
  readConfig,
  recorderNote,
  recorderState,
  short,
  splitArgs,
  statusLine,
  statusReport,
} from '../hooks/walkie'
import type { Entry } from '../hooks/walkie'

const file = (name: string, mtimeMs = 0): Entry => ({ name, kind: 'file', mtimeMs })

test('the config defaults to ~/.claude/walkie under the home folder, with forward slashes', () => {
  const c = readConfig({}, 'C:\\Users\\t')
  expect(c.folder).toBe('C:/Users/t/.claude/walkie')
  expect([c.pollMs, c.asUser, c.speak, c.hint, c.autoStart, c.python, c.recorderArgs]).toEqual([500, true, true, DEFAULT_HINT, true, 'python.exe', []])
  const custom = readConfig(
    { folder: 'D:\\drop\\', pollMs: 250, asUser: false, speakReplies: false, hint: ' ', autoStart: false, python: 'C:\\py\\python.exe', recorderArgs: '--model small --vocab "a b"' },
    'C:/Users/t',
  )
  expect([custom.folder, custom.pollMs, custom.asUser, custom.speak, custom.hint, custom.autoStart]).toEqual(['D:/drop', 250, false, false, '', false])
  expect([custom.python, custom.recorderArgs]).toEqual(['C:\\py\\python.exe', ['--model', 'small', '--vocab', 'a b']])
  expect(readConfig({ pollMs: 5 }, '').pollMs).toBe(500)
  expect(normalizeFolder('~/voice', 'C:\\Users\\t')).toBe('C:/Users/t/voice')
  expect(splitArgs('')).toEqual([])
})

test('only <epoch ms>.txt files newer than the watermark count, oldest first', () => {
  const entries = [
    file('1700000003000.txt'),
    file('1700000001000.txt'),
    file('1700000002000.tmp'),
    file('notes.txt'),
    file('1700000004000.txt'),
    { name: '1700000005000.txt', kind: 'dir' as const, mtimeMs: 0 },
  ]
  expect(newDrops(entries, '1700000001000').map(d => d.stem)).toEqual(['1700000003000', '1700000004000'])
  expect(newDrops(entries, '').map(d => d.stem)).toEqual(['1700000001000', '1700000003000', '1700000004000'])
  expect(newDrops(entries, '1700000004000')).toEqual([])
})

test('the prompt is the words, then the hint in parentheses; no hint, just the words', () => {
  expect(promptText('  what time is it ', 'keep it short')).toBe('what time is it\n\n(keep it short)')
  expect(promptText('what time is it', '')).toBe('what time is it')
})

test('the command grammar', () => {
  expect(parseCommand('')).toEqual({ kind: 'status' })
  expect(parseCommand(' Status ')).toEqual({ kind: 'status' })
  expect(parseCommand('pause')).toEqual({ kind: 'pause' })
  expect(parseCommand('mute')).toEqual({ kind: 'pause' })
  expect(parseCommand('resume')).toEqual({ kind: 'resume' })
  expect(parseCommand('on')).toEqual({ kind: 'resume' })
  expect(parseCommand('say  hello   there ')).toEqual({ kind: 'say', text: 'hello there' })
  expect(parseCommand('say')).toEqual({ kind: 'help' })
  expect(parseCommand('drop run the tests')).toEqual({ kind: 'drop', text: 'run the tests' })
  expect(parseCommand('test').kind).toBe('drop')
  expect([parseCommand('start'), parseCommand('stop'), parseCommand('log'), parseCommand('take')].map(c => c.kind)).toEqual(['start', 'stop', 'log', 'take'])
  expect(parseCommand('wat')).toEqual({ kind: 'help' })
})

test('the recorder is on while its heartbeat is fresh', () => {
  expect(recorderState(1000, 10_000, 15_000)).toBe('on')
  expect(recorderState(1000, 16_001, 15_000)).toBe('off')
  expect(recorderState(undefined, 0, 15_000)).toBe('off')
})

test("the folder is mine by the owner file text, another session's while fresh, else free", () => {
  expect(ownership(undefined, '', 10_000, 15_000, 'me')).toBe('free')
  expect(ownership(1000, 'me\n', 100_000, 15_000, 'me')).toBe('mine')
  expect(ownership(1000, 'you', 10_000, 15_000, 'me')).toBe('other')
  expect(ownership(1000, 'you', 16_001, 15_000, 'me')).toBe('free')
})

test('recorder lines worth a toast lose their time stamp; the rest are quiet', () => {
  expect(recorderNote('08:35:41 ready: hold F13 to talk · drops → C:\\x')).toBe('walkie: ready: hold F13 to talk · drops → C:\\x')
  expect(recorderNote('cuda/float16 failed (x); falling back to cpu/int8')).toBe('walkie: cuda/float16 failed (x); falling back to cpu/int8')
  expect(recorderNote('Traceback (most recent call last):')).toBe('walkie: Traceback (most recent call last):')
  expect(recorderNote('08:35:44 → what time is it  (2.1s audio, 0.7s)')).toBeUndefined()
  expect(recorderNote('   ')).toBeUndefined()
})

test('status texts', () => {
  expect(statusLine({ paused: false, recorder: 'off', owner: 'mine' })).toBeUndefined()
  expect(statusLine({ paused: false, recorder: 'on', owner: 'mine' })).toBe('🎙 walkie')
  expect(statusLine({ paused: true, recorder: 'on', owner: 'mine' })).toBe('walkie: paused')
  expect(statusLine({ paused: true, recorder: 'on', owner: 'other' })).toBeUndefined()
  const report = statusReport({ folder: 'C:/x', recorder: 'on', owner: 'mine', child: true, paused: false, handled: 3, pending: 1, last: { text: 'hello there', at: 1000 }, now: 61_000 })
  expect(report).toBe(
    'walkie: recorder on (started by this session)\nanswers drops: this session\nfolder: C:/x\ndrops handled this session: 3 (1 awaiting a turn)\nlast: "hello there" 1m ago',
  )
  const other = statusReport({ folder: 'C:/x', recorder: 'off', owner: 'other', child: false, paused: true, handled: 0, pending: 0, now: 0 })
  expect(other).toContain('recorder off, paused')
  expect(other).toContain('another session (/walkie take to claim it)')
  expect(short('a  b\nc')).toBe('a b c')
  expect(short('x'.repeat(70)).length).toBe(60)
  expect([ago(5000), ago(90_000), ago(7_200_000)]).toEqual(['5s ago', '2m ago', '2h ago'])
})
