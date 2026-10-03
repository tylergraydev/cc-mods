import { expect, test } from 'claude-code/testing'

import type { DisabledDir } from '../types'
import { addDir, derive, headerText, norm, parseCommand, removeDir, rewriteDirs, statusText } from '../hooks/mods'

const W = { sep: ';', selfKey: 'c:/mods/mod-menu' }
const LIST = 'C:\\mods\\agent-deck;C:\\mods\\doom-pane;C:\\mods\\mod-menu;C:\\mods\\workbench'
const file = () =>
  `{\n  "permissions": { "allow": ["Bash(ls)"] },\n  "enabledPlugins": { "x@y": true },\n  "pluginConfigs": { "a": { "b": 1 } },\n  "sandbox": { "enabled": false },\n  "statusLine": { "type": "command", "command": "x" },\n  "env": { "CLAUDE_CODE_PLUGIN_DIRS": ${JSON.stringify(LIST)} }\n}\n`
const off = (dir: string) => removeDir(norm(dir))

const written = (raw: string, change: (d: string[]) => string[], opts = W) => {
  const out = rewriteDirs(raw, change, opts)
  if (out.kind !== 'write') throw new Error(`expected a write, got ${JSON.stringify(out)}`)
  return out
}

test('other keys are kept, and only the literal changes', () => {
  const raw = file()
  const out = written(raw, off('C:\\mods\\doom-pane'))
  expect(JSON.parse(out.text)).toEqual({
    ...JSON.parse(raw),
    env: { CLAUDE_CODE_PLUGIN_DIRS: 'C:\\mods\\agent-deck;C:\\mods\\mod-menu;C:\\mods\\workbench' },
  })
  const blank = (text: string) => text.replace(/"CLAUDE_CODE_PLUGIN_DIRS": "[^\n]*"/, 'X')
  expect(blank(out.text)).toBe(blank(raw))
  expect(out.before).toHaveLength(4)
  expect(out.after).toHaveLength(3)
})

test('nothing changed, nothing written; other entries keep their spelling', () => {
  expect(rewriteDirs(file(), d => d, W).kind).toBe('same')
  expect(rewriteDirs(file(), addDir('C:/MODS/doom-pane/', undefined), W).kind).toBe('same')
  expect(rewriteDirs(file(), off('C:\\mods\\nothing'), W).kind).toBe('same')
  const out = written(file(), off('C:\\mods\\agent-deck'))
  expect(out.after).toEqual(['C:\\mods\\doom-pane', 'C:\\mods\\mod-menu', 'C:\\mods\\workbench'])
})

test('workbench stays last when something is added', () => {
  const out = written(file(), addDir('C:\\mods\\new-one', undefined))
  expect(out.after).toEqual(['C:\\mods\\agent-deck', 'C:\\mods\\doom-pane', 'C:\\mods\\mod-menu', 'C:\\mods\\new-one', 'C:\\mods\\workbench'])
  const after = written(file(), addDir('C:\\mods\\new-one', 'C:\\mods\\workbench'))
  expect(after.after.at(-1)).toBe('C:\\mods\\workbench')
})

test('a re-enabled mod goes back after its predecessor', () => {
  const out = written(file(), addDir('C:\\mods\\x', 'C:\\mods\\agent-deck'))
  expect(out.after.indexOf('C:\\mods\\x')).toBe(1)
})

test('this mod is never dropped', () => {
  const out = rewriteDirs(file(), off('C:\\mods\\mod-menu'), W)
  expect(out).toEqual({ kind: 'error', reason: "mod-menu won't remove itself; edit settings.json by hand" })
})

test('backslashes survive the round trip', () => {
  const out = written(file(), off('C:\\mods\\doom-pane'))
  expect(out.text).toContain('C:\\\\mods\\\\agent-deck')
  expect(JSON.parse(out.text).env.CLAUDE_CODE_PLUGIN_DIRS.split(';')[0]).toBe('C:\\mods\\agent-deck')
})

test('unparsable settings are refused', () => {
  for (const bad of ['{ "env": {}, }', '{ // c\n "env": {} }', '[]', '{ "env": "x" }', '{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": 3 } }', '{ bad']) {
    const out = rewriteDirs(bad, d => [...d, 'C:\\x'], W)
    expect(out.kind).toBe('error')
    expect('text' in out).toBe(false)
  }
})

test('BOM, CRLF and the trailing newline are kept', () => {
  const raw = `\uFEFF${file().replace(/\n/g, '\r\n')}`
  const out = written(raw, off('C:\\mods\\doom-pane'))
  expect(out.text.startsWith('\uFEFF{')).toBe(true)
  expect(out.text.endsWith('}\r\n')).toBe(true)
  expect(out.text.replace(/\r\n/g, '')).not.toContain('\n')
  const fallback = written('\uFEFF{\r\n\t"a": 1\r\n}', d => [...d, 'C:\\x'])
  expect(fallback.text).toBe('\uFEFF{\r\n\t"a": 1,\r\n\t"env": {\r\n\t\t"CLAUDE_CODE_PLUGIN_DIRS": "C:\\\\x"\r\n\t}\r\n}')
})

test('no env: enabling creates the key, nothing to add writes nothing', () => {
  const out = written('{\n  "a": 1\n}\n', addDir('C:\\mods\\one', undefined))
  expect(JSON.parse(out.text)).toEqual({ a: 1, env: { CLAUDE_CODE_PLUGIN_DIRS: 'C:\\mods\\one' } })
  expect(out.text.endsWith('\n')).toBe(true)
  expect(rewriteDirs('{}', d => d, W).kind).toBe('same')
  expect(rewriteDirs('{}', off('C:\\mods\\one'), W).kind).toBe('same')
})

test('duplicates: off removes every one', () => {
  const raw = '{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "C:\\\\a;C:\\\\b\\\\;c:/B;C:\\\\mods\\\\mod-menu" } }'
  expect(written(raw, off('C:\\b')).after).toEqual(['C:\\a', 'C:\\mods\\mod-menu'])
})

test('two literals in the file: re-serialized, and still verified', () => {
  const raw = '{\n  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "C:\\\\a;C:\\\\mods\\\\mod-menu" },\n  "note": { "CLAUDE_CODE_PLUGIN_DIRS": "keep" }\n}'
  const out = written(raw, off('C:\\a'))
  expect(JSON.parse(out.text)).toEqual({ env: { CLAUDE_CODE_PLUGIN_DIRS: 'C:\\mods\\mod-menu' }, note: { CLAUDE_CODE_PLUGIN_DIRS: 'keep' } })
})

test('derive: the four states, the union order, notes', () => {
  const disabled: DisabledDir[] = [{ dir: 'C:\\mods\\old', name: 'old', at: 1 }]
  const boot = ['c:/mods/a', 'c:/mods/b', 'c:/mods/gone']
  const disk = ['C:\\mods\\a', 'C:\\mods\\c', 'C:\\mods\\a']
  const info = { 'c:/mods/c': { name: 'cee', note: 'bad-manifest' as const }, 'c:/mods/a': { name: 'mod-menu', version: '1' } }
  const mods = derive(boot, disk, disabled, info, 'mod-menu', '')
  expect(mods.map(m => [m.name, m.state])).toEqual([
    ['mod-menu', 'on'],
    ['cee', 'turning-on'],
    ['b', 'turning-off'],
    ['gone', 'turning-off'],
    ['old', 'off'],
  ])
  expect(mods[0]).toMatchObject({ isSelf: true, listed: 2 })
  expect(mods[1]?.note).toBe('bad-manifest')
  expect(mods.map(m => m.id)).toEqual(['mod-menu', 'cee', 'b', 'gone', 'old'])
  const twins = derive([], ['/x/a', '/y/a'], [], {}, 'me', '')
  expect(twins.map(m => m.id)).toEqual(['a', 'a-2'])
})

test('statusText and the header', () => {
  // boot holds the loaded ones, disk the listed ones
  const mk = (boot: string[], disk: string[]) => derive(boot, disk, [], {}, 'me', '')
  expect(statusText(mk(['/a', '/b'], ['/a', '/b']))).toBeUndefined()
  expect(statusText(mk(['/a', '/b'], ['/a']))).toBe('mods: 2 on · 1 pending restart')
  expect(statusText(mk(['/a', '/b'], ['/a', '/c']))).toBe('mods: 2 on · 1 off · 2 pending restart')
  expect(headerText(mk(['/a'], ['/a', '/c']))).toBe('1 on · 1 off · 1 pending restart')
})

test('norm', () => {
  expect(norm('C:\\Mods\\Foo\\')).toBe('c:/mods/foo')
  expect(norm('/a//b/')).toBe('/a/b')
  expect(norm(' ~/x ', 'C:\\Users\\me')).toBe('c:/users/me/x')
  expect(norm('/Keep/Case')).toBe('/Keep/Case')
})

test('/mod-menu arguments', () => {
  expect(parseCommand('')).toEqual({ kind: 'open' })
  expect(parseCommand(undefined)).toEqual({ kind: 'open' })
  expect(parseCommand(' list ')).toEqual({ kind: 'list' })
  expect(parseCommand('off doom pane')).toEqual({ kind: 'toggle', want: 'off', name: 'doom pane' })
  expect(parseCommand('on x')).toEqual({ kind: 'toggle', want: 'on', name: 'x' })
  expect(parseCommand('on').kind).toBe('error')
  expect(parseCommand('nope').kind).toBe('error')
})
