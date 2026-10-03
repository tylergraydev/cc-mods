import { expect, test } from 'claude-code/testing'

import { hookId } from '../hooks/loadout'
import { removeDir } from '../hooks/mods'
import { DELETE, dirsEdit, hookOffEdit, hookOnEdit, mcpEdit, pluginEdit, rewriteKey, rewriteKeys, skillEdit, topLevelSpan } from '../hooks/settings-edit'

const LIST = 'C:\\mods\\agent-deck;C:\\mods\\mod-menu;C:\\mods\\workbench'
// the shape of a real user settings.json, sanitized
const HOOKS = {
  PreToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo a' }, { type: 'command', command: 'echo   b' }] },
    { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo c' }] },
  ],
  Stop: [{ hooks: [{ type: 'command', command: 'echo d' }] }],
}
const file = (extra: Record<string, unknown> = {}) =>
  `${JSON.stringify(
    {
      env: { CLAUDE_CODE_PLUGIN_DIRS: LIST },
      permissions: { allow: ['Bash(ls)'], defaultMode: 'acceptEdits' },
      enabledPlugins: { 'warp@claude-code-warp': true, 'impeccable@impeccable': true },
      extraKnownMarketplaces: { 'claude-code-warp': { source: { source: 'github', repo: 'warpdotdev/claude-code-warp' } } },
      statusLine: { type: 'command', command: 'x' },
      sandbox: { enabled: false },
      ...extra,
    },
    null,
    2,
  )}\n`

const written = (out: ReturnType<typeof rewriteKeys>) => {
  if (out.kind !== 'write') throw new Error(`expected a write, got ${JSON.stringify(out)}`)
  return out.text
}
const blank = (text: string, key: string) => {
  const span = topLevelSpan(text, key)
  if (!span) throw new Error(`no ${key}`)
  return `${text.slice(0, span.start)}X${text.slice(span.end)}`
}
const idOf = (event: string, matcher: string | undefined, command: string) => hookId(event, matcher, { type: 'command', command })

test('one plugin switch changes only its literal; every other key keeps its bytes', () => {
  const raw = file()
  const text = written(rewriteKey(raw, ['enabledPlugins', 'warp@claude-code-warp'], () => false))
  expect(JSON.parse(text).enabledPlugins).toEqual({ 'warp@claude-code-warp': false, 'impeccable@impeccable': true })
  expect(blank(text, 'enabledPlugins')).toBe(blank(raw, 'enabledPlugins'))
  for (const key of ['env', 'permissions', 'sandbox', 'statusLine', 'extraKnownMarketplaces']) {
    expect(JSON.parse(text)[key]).toEqual(JSON.parse(raw)[key])
  }
  expect(rewriteKey(raw, ['enabledPlugins', 'warp@claude-code-warp'], () => true).kind).toBe('same')
  expect(rewriteKeys(raw, [pluginEdit('warp@claude-code-warp', true)]).kind).toBe('same')
})

test('hooks: an unknown id is a no-op; off removes one hook and its emptied group; on puts it back', () => {
  const raw = file({ hooks: HOOKS })
  expect(rewriteKeys(raw, [hookOffEdit('hook:Stop:*:00000000', 1).edit]).kind).toBe('same')
  expect(rewriteKeys(file(), [hookOffEdit('hook:Stop:*:00000000', 1).edit]).kind).toBe('same')

  const a = hookOffEdit(idOf('PreToolUse', 'Bash', 'echo a'), 5)
  const afterA = JSON.parse(written(rewriteKeys(raw, [a.edit])))
  expect(afterA.hooks.PreToolUse[0].hooks).toEqual([{ type: 'command', command: 'echo   b' }])
  expect(afterA.hooks.PreToolUse[1]).toEqual(HOOKS.PreToolUse[1])
  expect(afterA.hooks.Stop).toEqual(HOOKS.Stop)
  expect(a.out.stash).toMatchObject({ event: 'PreToolUse', matcher: 'Bash', groupIndex: 0, hookIndex: 0, at: 5 })

  // the hash ignores whitespace: the same hook under a squeezed spelling is the same id
  expect(idOf('PreToolUse', 'Bash', 'echo b')).toBe(idOf('PreToolUse', 'Bash', 'echo   b'))

  // the emptied group and the emptied event go, the rest is untouched
  const c = hookOffEdit(idOf('PreToolUse', 'Edit', 'echo c'), 1)
  const afterC = JSON.parse(written(rewriteKeys(raw, [c.edit])))
  expect(afterC.hooks.PreToolUse).toEqual([HOOKS.PreToolUse[0]])
  const d = hookOffEdit(idOf('Stop', undefined, 'echo d'), 1)
  const afterD = JSON.parse(written(rewriteKeys(raw, [d.edit])))
  expect(afterD.hooks.Stop).toBeUndefined()
  expect(afterD.hooks.PreToolUse).toEqual(HOOKS.PreToolUse)

  // round trip: on restores the position, from the stash
  for (const one of [a, c, d]) {
    const off = written(rewriteKeys(raw, [one.edit]))
    const back = JSON.parse(written(rewriteKeys(off, [hookOnEdit(one.out.stash!)])))
    expect(back.hooks).toEqual(HOOKS)
  }
})

test('skillOverrides: off creates the key, on restores the previous value or removes the entry', () => {
  const raw = file()
  const off = written(rewriteKeys(raw, [skillEdit('notes', false, undefined)]))
  expect(JSON.parse(off).skillOverrides).toEqual({ notes: 'off' })
  expect(blank(off, 'skillOverrides')).toContain('"sandbox"')
  expect(JSON.parse(off).permissions).toEqual(JSON.parse(raw).permissions)
  expect(JSON.stringify(JSON.parse(off), (k, v) => (k === 'skillOverrides' ? undefined : v))).toBe(JSON.stringify(JSON.parse(raw)))

  const prev = written(rewriteKeys(file({ skillOverrides: { notes: 'off', keep: 'name-only' } }), [skillEdit('notes', true, 'user-invocable-only')]))
  expect(JSON.parse(prev).skillOverrides).toEqual({ notes: 'user-invocable-only', keep: 'name-only' })

  const gone = written(rewriteKeys(file({ skillOverrides: { notes: 'off' } }), [skillEdit('notes', true, undefined)]))
  expect(JSON.parse(gone).skillOverrides).toEqual({})
  // nothing to remove and no parent: no key is created
  expect(rewriteKeys(raw, [skillEdit('notes', true, undefined)]).kind).toBe('same')
})

test('deniedMcpServers: off appends once, on removes only the single-key entry', () => {
  const raw = file()
  const off = written(rewriteKeys(raw, [mcpEdit('notion', false)]))
  expect(JSON.parse(off).deniedMcpServers).toEqual([{ serverName: 'notion' }])
  expect(rewriteKeys(off, [mcpEdit('notion', false)]).kind).toBe('same')

  const mixed = file({ deniedMcpServers: [{ serverName: 'notion' }, { serverUrl: 'https://x.test/*' }, { serverName: 'other' }] })
  const on = written(rewriteKeys(mixed, [mcpEdit('notion', true)]))
  expect(JSON.parse(on).deniedMcpServers).toEqual([{ serverUrl: 'https://x.test/*' }, { serverName: 'other' }])
  expect(rewriteKeys(raw, [mcpEdit('notion', true)]).kind).toBe('same')
  expect(rewriteKeys(file({ deniedMcpServers: 'x' }), [mcpEdit('notion', false)]).kind).toBe('error')
})

test('bad JSON and the wrong shapes are refused, never written', () => {
  for (const bad of ['{ bad', '{ "a": 1, }', '// c\n{}', '[]', '']) {
    const out = rewriteKey(bad, ['enabledPlugins', 'x@y'], () => true)
    expect(out.kind).toBe('error')
    expect(JSON.stringify(out)).toContain('not written')
  }
  const wrong = rewriteKey(file({ enabledPlugins: 'x' }), ['enabledPlugins', 'x@y'], () => true)
  expect(wrong).toMatchObject({ kind: 'error' })
  expect(rewriteKey(file(), ['permissions'], () => DELETE).kind).toBe('error')
})

test('BOM, CRLF and the trailing newline are kept; a batch parses to its expected result', () => {
  const crlf = `\uFEFF${file().replace(/\n/g, '\r\n')}`
  const text = written(rewriteKeys(crlf, [pluginEdit('warp@claude-code-warp', false), mcpEdit('notion', false), skillEdit('notes', false, undefined)]))
  expect(text.startsWith('\uFEFF')).toBe(true)
  expect(text.endsWith('\r\n')).toBe(true)
  expect(text.replace(/\r\n/g, '')).not.toContain('\n')
  const parsed = JSON.parse(text.slice(1))
  expect(parsed.enabledPlugins['warp@claude-code-warp']).toBe(false)
  expect(parsed.deniedMcpServers).toEqual([{ serverName: 'notion' }])
  expect(parsed.skillOverrides).toEqual({ notes: 'off' })
  expect(parsed.env).toEqual(JSON.parse(file()).env)
  // the tab-indented, no-newline file keeps its layout
  const tabs = `{\n\t"a": 1,\n\t"enabledPlugins": {}\n}`
  const out = written(rewriteKey(tabs, ['enabledPlugins', 'x@y'], () => true))
  expect(out.endsWith('}')).toBe(true)
  expect(JSON.parse(out)).toEqual({ a: 1, enabledPlugins: { 'x@y': true } })
  expect(rewriteKey('{}', ['enabledPlugins', 'x@y'], () => true).kind).toBe('write')
})

test('a mod change inside a batch obeys the self guard and keeps workbench last', () => {
  const opts = { sep: ';', selfKey: 'c:/mods/mod-menu' }
  const refused = rewriteKeys(file(), [dirsEdit(removeDir('c:/mods/mod-menu'), opts), mcpEdit('notion', false)])
  expect(refused).toEqual({ kind: 'error', reason: "mod-menu won't remove itself; edit settings.json by hand" })
  const ok = written(rewriteKeys(file(), [dirsEdit(removeDir('c:/mods/agent-deck'), opts), mcpEdit('notion', false)]))
  expect(JSON.parse(ok).env.CLAUDE_CODE_PLUGIN_DIRS).toBe('C:\\mods\\mod-menu;C:\\mods\\workbench')
  expect(JSON.parse(ok).deniedMcpServers).toEqual([{ serverName: 'notion' }])
  expect(rewriteKeys(file(), [dirsEdit(d => d, opts)]).kind).toBe('same')
})

test('topLevelSpan sees only the root keys, strings and nesting included', () => {
  const body = '{ "a": { "b": 1 }, "s": "x\\"}", "b": [1, {"c": 2}], "z": true }'
  const span = (key: string) => {
    const at = topLevelSpan(body, key)
    return at ? body.slice(at.start, at.end) : undefined
  }
  expect(span('a')).toBe('{ "b": 1 }')
  expect(span('s')).toBe('"x\\"}"')
  expect(span('b')).toBe('[1, {"c": 2}]')
  expect(span('z')).toBe('true')
  expect(span('c')).toBeUndefined()
})
