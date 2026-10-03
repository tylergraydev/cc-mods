import { expect, test } from 'claude-code/testing'

import type { Catalog, LoadoutItem } from '../types'
import {
  buildItems,
  desiredFor,
  emptyCatalog,
  findGist,
  firstLine,
  fnv8,
  frontmatterName,
  hookId,
  mergeCatalogs,
  parseAuthStatus,
  parseCatalog,
  parseCommand,
  parseGist,
  parsePluginList,
  parsePluginResult,
  parseTags,
  planProfile,
  planReconcile,
  pluginToggleArgv,
  resolveId,
  scrub,
  serializeCatalog,
  gistFindArgv,
  gistPatchArgv,
  gistPostArgv,
  gistPostBody,
  slugOf,
  uniqueSlug,
} from '../hooks/loadout'

const T = 1_790_000_000_000
const item = (over: Partial<LoadoutItem> & { id: string }): LoadoutItem => {
  const [type = 'skill', ...rest] = over.id.split(':')
  const name = rest.join(':')
  return {
    type: type as LoadoutItem['type'], name, slug: slugOf(name), label: name, state: 'on', apply: 'live', tier: 'user',
    isLocked: false, tags: [], inCatalog: false, drift: false, ...over,
  }
}
const tagged = (id: string, tags: string[], state: 'on' | 'off' = 'on', over: Partial<LoadoutItem> = {}) => item({ id, tags, inCatalog: true, state, ...over })
const catalogOf = (items: Record<string, { tags: string[]; on: boolean }>): Catalog => ({
  ...emptyCatalog(), updatedAt: T, items: Object.fromEntries(Object.entries(items).map(([id, one]) => [id, { ...one, updatedAt: T }])),
})

test('fnv8 is stable across whitespace; hook ids are type:event:matcher:hash', () => {
  expect(fnv8('a')).toBe('e40c292c')
  expect(fnv8('')).toBe('811c9dc5')
  expect(hookId('PreToolUse', 'Bash', { type: 'command', command: 'echo   a\n' })).toBe(hookId('PreToolUse', 'Bash', { type: 'command', command: ' echo a' }))
  expect(hookId('PreToolUse', 'Bash', { command: 'a' })).toBe(`hook:PreToolUse:Bash:${fnv8('a')}`)
  expect(hookId('Stop', '', { command: 'a' })).toBe(`hook:Stop:*:${fnv8('a')}`)
  expect(hookId('Stop', undefined, { command: 'a' })).toBe(`hook:Stop:*:${fnv8('a')}`)
  // a non-command hook hashes its sorted definition
  expect(hookId('Stop', undefined, { url: 'u', type: 'http' })).toBe(hookId('Stop', undefined, { type: 'http', url: 'u' }))
  expect(hookId('Stop', undefined, { type: 'http', url: 'u' })).toMatch(/^hook:Stop:\*:[0-9a-f]{8}$/)
})

test('desiredFor: the profile table', () => {
  const t = (tags: string[], tag: string, inCatalog = true) => desiredFor({ tags, inCatalog }, tag)
  expect(t([], 'work')).toBeUndefined()
  expect(t(['work'], 'work', false)).toBeUndefined()
  expect(t(['work'], 'work')).toBe('on')
  expect(t(['personal'], 'work')).toBe('off')
  expect(t(['work', 'personal'], 'work')).toBe('on')
  expect(t(['personal'], 'all')).toBe('on')
  expect(t([], 'all')).toBeUndefined()
})

test('planProfile: counts, restart, missing, locked, self, unknown tag, exact text', () => {
  const items = [
    tagged('mod:a', ['work'], 'off', { apply: 'restart' }),
    tagged('mod:b', ['personal'], 'on', { apply: 'restart' }),
    tagged('skill:c', ['work', 'personal'], 'off'),
    tagged('plugin:d@m', ['personal'], 'on', { apply: 'reload' }),
    tagged('mod:mod-menu', ['personal'], 'on', { apply: 'restart', isLocked: true }),
    tagged('mcp:e', ['work'], 'on', { apply: 'restart', isLocked: true }),
    item({ id: 'skill:untagged', state: 'off' }),
  ]
  const cat = catalogOf({ 'mod:a': { tags: ['work'], on: true }, 'skill:gone': { tags: ['work'], on: true }, 'mod:gone2': { tags: ['work'], on: true } })
  const plan = planProfile(items, cat, 'work')
  expect(plan.on).toEqual(['mod:a', 'skill:c'])
  expect(plan.off).toEqual(['mod:b', 'plugin:d@m'])
  expect(plan.restart).toEqual(['mod:a', 'mod:b', 'plugin:d@m'])
  expect(plan.locked).toEqual(['mod:mod-menu'])
  expect(plan.missing).toEqual(['mod:gone2', 'skill:gone'])
  expect(plan.isDryRun).toBe(true)
  expect(plan.text).toBe('use work: 2 on, 2 off, 3 need restart · 2 missing here (mod:gone2, skill:gone) · 1 locked')

  expect(planProfile(items, cat, 'nothing')).toMatchObject({ on: [], off: [], text: 'no items tagged "nothing"' })
  const quiet = planProfile([tagged('skill:x', ['work'], 'on')], null, 'work')
  expect(quiet.text).toBe('use work: already in place')
  expect(planProfile(items, cat, 'all').on).toEqual(['mod:a', 'skill:c'])
  // apply: the machine is brought to the catalog
  const apply = planReconcile([tagged('mod:a', ['work'], 'off', { apply: 'restart' }), tagged('skill:q', [], 'on')], catalogOf({ 'mod:a': { tags: ['work'], on: true }, 'skill:q': { tags: [], on: false } }))
  expect(apply).toMatchObject({ on: ['mod:a'], off: ['skill:q'], restart: ['mod:a'], text: 'apply: 1 on, 1 off, 1 need restart' })
})

test('a pending item is judged by what it is configured to be', () => {
  const back = [tagged('mod:a', ['work'], 'on', { pending: 'off', apply: 'restart' })]
  expect(planProfile(back, null, 'work').on).toEqual(['mod:a'])
  const kept = [tagged('mod:a', ['personal'], 'on', { pending: 'off', apply: 'restart' })]
  expect(planProfile(kept, null, 'work').text).toBe('no items tagged "work"')
})

test('mergeCatalogs: newer wins, ties are deterministic, tombstones, machines, active', () => {
  const base = (over: Partial<Catalog>): Catalog => ({ ...emptyCatalog(), ...over })
  const local = base({ updatedAt: T, items: { 'mod:a': { tags: ['work'], on: true, updatedAt: T + 5 }, 'mod:b': { tags: [], on: true, updatedAt: T } }, active: { tag: 'work', at: T + 1 } })
  const remote = base({ updatedAt: T + 9, items: { 'mod:a': { tags: ['personal'], on: false, updatedAt: T + 2 }, 'mod:c': { tags: [], on: false, updatedAt: T } }, active: { tag: 'personal', at: T + 3 } })
  const merged = mergeCatalogs(local, remote)
  expect(merged.items['mod:a']!.tags).toEqual(['work'])
  expect(Object.keys(merged.items).sort()).toEqual(['mod:a', 'mod:b', 'mod:c'])
  expect(merged.active).toEqual({ tag: 'personal', at: T + 3 })
  expect(merged.updatedAt).toBe(T + 9)

  const x = base({ items: { 'mod:a': { tags: ['x'], on: true, updatedAt: T } } })
  const y = base({ items: { 'mod:a': { tags: ['y'], on: true, updatedAt: T } } })
  expect(mergeCatalogs(x, y)).toEqual(mergeCatalogs(y, x))

  const dead = base({ items: { 'mod:a': { tags: [], on: false, updatedAt: T + 10, deleted: true } } })
  expect(mergeCatalogs(local, dead).items['mod:a']!.deleted).toBe(true)
  expect(mergeCatalogs(dead, local).items['mod:a']!.deleted).toBe(true)

  const m1 = base({ machines: { m1: { name: 'A', seenAt: T, missing: [] }, m2: { name: 'B', seenAt: T, missing: ['x'] } } })
  const m2 = base({ machines: { m1: { name: 'A', seenAt: T + 4, missing: ['y'] }, m3: { name: 'C', seenAt: T, missing: [] } } })
  const both = mergeCatalogs(m1, m2)
  expect(Object.keys(both.machines).sort()).toEqual(['m1', 'm2', 'm3'])
  expect(both.machines.m1!.missing).toEqual(['y'])
})

test('the catalog: tolerant parse, a refusal for junk, a stable serialization, old tombstones dropped', () => {
  const text = JSON.stringify({
    version: 1, updatedAt: T, extra: 1,
    items: { 'mod:a': { tags: ['b', 'a', 3], on: true, updatedAt: T, junk: 1 }, 'mod:bad': { tags: 'x' }, 'mod:old': { tags: [], on: false, updatedAt: T - 91 * 86_400_000, deleted: true } },
    profiles: { work: { updatedAt: T } }, active: { tag: 'work', at: T }, machines: { m: { name: 'A', seenAt: T, missing: ['mod:z'] } },
  })
  const parsed = parseCatalog(text)
  if ('error' in parsed) throw new Error(parsed.error)
  expect(parsed.notes).toEqual(['skipped item mod:bad'])
  expect(parsed.catalog.items['mod:a']).toEqual({ tags: ['a', 'b'], on: true, updatedAt: T })
  const out = serializeCatalog(parsed.catalog, T)
  expect(out.endsWith('}\n')).toBe(true)
  expect(out).not.toContain('mod:old')
  expect(out).not.toContain('junk')
  expect(out.indexOf('"active"')).toBeLessThan(out.indexOf('"items"'))
  const again = parseCatalog(out)
  if ('error' in again) throw new Error(again.error)
  expect(serializeCatalog(again.catalog, T)).toBe(out)
  for (const bad of ['{ bad', '[]', '{"version":2}', '{}']) {
    const got = parseCatalog(bad)
    expect('error' in got).toBe(true)
  }
  expect(JSON.stringify(parseCatalog('{ bad'))).toContain('parse')
})

test('gh auth status: 2.38 text, the account wording, logged out, and no match', () => {
  expect(parseAuthStatus(0, 'github.com\n  ✓ Logged in to github.com as tylergraydev (keyring)\n')).toEqual({ kind: 'ok', login: 'tylergraydev' })
  expect(parseAuthStatus(0, 'github.com\n  ✓ Logged in to github.com account tylergraydev (keyring)\n')).toEqual({ kind: 'ok', login: 'tylergraydev' })
  expect(parseAuthStatus(1, 'You are not logged into any GitHub hosts. Run gh auth login')).toEqual({ kind: 'logged-out' })
  expect(parseAuthStatus(0, 'You are not logged in')).toEqual({ kind: 'logged-out' })
  expect(parseAuthStatus(0, 'something else').kind).toBe('error')
})

test('scrub masks tokens; stderr shows its first line only', () => {
  const token = `ghp_${'a1B2c3D4e5'.repeat(3)}`
  expect(scrub(`bad ${token} here`)).toBe('bad *** here')
  expect(scrub('gho_short')).toBe('gho_short')
  expect(firstLine(`\n  failed with ${token}\nsecond line`)).toBe('failed with ***')
})

test('argv builders are exact', () => {
  expect(pluginToggleArgv('claude.exe', 'warp@claude-code-warp', false)).toEqual(['claude.exe', 'plugin', 'disable', '--json', '--scope', 'user', 'warp@claude-code-warp'])
  expect(pluginToggleArgv('claude', 'x@y', true).slice(1, 3)).toEqual(['plugin', 'enable'])
  expect(gistFindArgv('gh.exe')).toEqual(['gh.exe', 'api', '--paginate', '/gists', '--jq', '.[] | select(.description=="claude-loadout (mod-menu)") | .id'])
  expect(gistPatchArgv('gh', 'abc')).toEqual(['gh', 'api', '--method', 'PATCH', '/gists/abc', '--input', '-'])
  expect(gistPostArgv('gh')).toEqual(['gh', 'api', '--method', 'POST', '/gists', '--input', '-'])
  expect(JSON.parse(gistPostBody('{}'))).toEqual({ description: 'claude-loadout (mod-menu)', public: false, files: { 'loadout.json': { content: '{}' } } })
})

test('plugin list drops session mods; a result is judged by its JSON, not the exit code', () => {
  const list = JSON.stringify([
    { id: 'warp@claude-code-warp', version: '2.0.0', scope: 'user', enabled: true, projectEnabled: false },
    { id: 'usage-tracker@inline', version: '0.1.0', scope: 'session', enabled: true },
    { id: 'p@m', scope: 'user', enabled: false, projectEnabled: true },
  ])
  expect(parsePluginList(list)).toEqual([
    { key: 'warp@claude-code-warp', version: '2.0.0', enabled: true },
    { key: 'p@m', enabled: false, isLocked: true, lockReason: 'set in project settings' },
  ])
  expect(parsePluginList('not json')).toBeUndefined()
  expect(parsePluginList(`warning\n${list}`)).toHaveLength(2)
  const already = '{"command":"disable","outcome":"failed","message":"already disabled","failureCode":"already_in_goal_state","alreadyInGoalState":true}'
  expect(parsePluginResult(already)).toEqual({ ok: true, message: 'already disabled' })
  expect(parsePluginResult('{"outcome":"failed","message":"nope"}')).toEqual({ ok: false, message: 'nope' })
  expect(parsePluginResult('{"outcome":"success","message":"done"}')?.ok).toBe(true)
  expect(parsePluginResult('garbage')).toBeUndefined()
})

test('gist parsing', () => {
  const gist = JSON.stringify({ id: 'g1', updated_at: '2026-10-03T10:00:00Z', owner: { login: 'me' }, files: { 'loadout.json': { content: '{"a":1}', truncated: false } } })
  expect(parseGist(gist)).toEqual({ content: '{"a":1}', updatedAt: '2026-10-03T10:00:00Z', owner: 'me', isTruncated: false })
  expect(parseGist(JSON.stringify({ files: {} }))).toEqual({ error: 'the gist has no loadout.json' })
  expect(findGist(JSON.stringify([{ id: 'x', description: 'other' }, { id: 'g2', description: 'claude-loadout (mod-menu)' }]))).toBe('g2')
  expect(findGist('[]')).toBeUndefined()
})

test('parseCommand v2', () => {
  expect(parseCommand('')).toEqual({ kind: 'open' })
  expect(parseCommand('list')).toEqual({ kind: 'list' })
  expect(parseCommand('on skill:build-mod')).toEqual({ kind: 'toggle', want: 'on', ref: 'skill:build-mod' })
  expect(parseCommand('off "claude.ai Gmail"')).toEqual({ kind: 'toggle', want: 'off', ref: 'claude.ai Gmail' })
  expect(parseCommand('off claude.ai Gmail')).toEqual({ kind: 'toggle', want: 'off', ref: 'claude.ai Gmail' })
  expect(parseCommand('tag skill:build-mod work,personal')).toEqual({ kind: 'tag', ref: 'skill:build-mod', tags: ['personal', 'work'] })
  expect(parseCommand('tag "mcp:claude.ai Gmail" -')).toEqual({ kind: 'tag', ref: 'mcp:claude.ai Gmail', tags: [] })
  expect(parseCommand('tag x all').kind).toBe('error')
  expect(parseCommand('tag x').kind).toBe('error')
  expect(parseCommand('use Work --dry-run')).toEqual({ kind: 'use', tag: 'work', isDryRun: true })
  expect(parseCommand('use work')).toEqual({ kind: 'use', tag: 'work', isDryRun: false })
  expect(parseCommand('use').kind).toBe('error')
  expect(parseCommand('apply')).toEqual({ kind: 'apply' })
  expect(parseCommand('sync --relink')).toEqual({ kind: 'sync', op: 'sync', isForce: false, isRelink: true })
  expect(parseCommand('push --force')).toEqual({ kind: 'sync', op: 'push', isForce: true, isRelink: false })
  expect(parseCommand('pull')).toEqual({ kind: 'sync', op: 'pull', isForce: false, isRelink: false })
  expect(parseCommand('gh')).toEqual({ kind: 'gh' })
  expect(parseCommand('forget mod:x')).toEqual({ kind: 'forget', ref: 'mod:x' })
  expect(parseCommand('on').kind).toBe('error')
  expect(parseCommand('bogus').kind).toBe('error')
  expect(parseTags('Work, personal work')).toEqual({ tags: ['personal', 'work'] })
  expect(parseTags('bad tag!')).toHaveProperty('error')
})

test('ids resolve by type:name, or by bare name when unique', () => {
  const ids = ['mod:guardrail', 'skill:guardrail', 'skill:build-mod', 'mcp:claude.ai Gmail', 'plugin:warp@claude-code-warp']
  expect(resolveId(ids, 'skill:build-mod')).toEqual({ id: 'skill:build-mod' })
  expect(resolveId(ids, 'build-mod')).toEqual({ id: 'skill:build-mod' })
  expect(resolveId(ids, 'claude.ai gmail')).toEqual({ id: 'mcp:claude.ai Gmail' })
  expect(resolveId(ids, 'warp@claude-code-warp')).toEqual({ id: 'plugin:warp@claude-code-warp' })
  expect(resolveId(ids, 'guardrail')).toEqual({ error: '"guardrail" is ambiguous: mod:guardrail, skill:guardrail. Use type:name.' })
  expect(resolveId(ids, 'mod:guardrail')).toEqual({ id: 'mod:guardrail' })
  expect(resolveId(ids, 'nothing')).toEqual({ error: 'No item "nothing". Try /mod-menu list.' })
})

test('frontmatter names, slugs and unique slugs', () => {
  expect(frontmatterName('---\nname: build-mod\ndescription: x\n---\nbody')).toBe('build-mod')
  expect(frontmatterName('---\r\nname: "quoted one"\r\n---\r\n')).toBe('quoted one')
  expect(frontmatterName('no frontmatter\nname: x')).toBeUndefined()
  expect(slugOf('claude.ai Gmail')).toBe('claude.ai-gmail')
  expect(slugOf('warp@claude-code-warp')).toBe('warp-claude-code-warp')
  const used = new Set<string>()
  expect([uniqueSlug('a', used), uniqueSlug('a', used), uniqueSlug('a', used)]).toEqual(['a', 'a-2', 'a-3'])
})

test('buildItems: every type, pending, locks, drift and catalog-only MCP rows', () => {
  const cat = catalogOf({ 'plugin:warp@m': { tags: ['personal'], on: false }, 'mcp:claude.ai Gmail': { tags: ['personal'], on: true }, 'skill:s': { tags: [], on: true } })
  const built = buildItems({
    mods: [
      { id: 'guardrail', dir: 'C:/m/g', key: 'c:/m/g', name: 'guardrail', version: '0.1.0', state: 'turning-off', isSelf: false, isWorkbench: false, listed: 0 },
      { id: 'mod-menu', dir: 'C:/m/mm', key: 'c:/m/mm', name: 'mod-menu', state: 'on', isSelf: true, isWorkbench: false, listed: 1 },
    ],
    plugins: [{ key: 'warp@m', enabled: true }, { key: 'proj@m', enabled: true, isLocked: true, lockReason: 'set in project settings' }],
    skills: [{ name: 's', tier: 'user', folders: 2, override: 'off' }, { name: 's', tier: 'synced', folders: 1 }],
    hooks: [{ event: 'Stop', matcher: '*', def: { type: 'command', command: 'echo d' }, tier: 'user' }],
    mcp: [{ name: 'notion', tier: 'user' }],
    stash: [{ id: 'hook:Stop:*:deadbeef', event: 'Stop', groupIndex: 0, hookIndex: 0, def: { type: 'command', command: 'x' }, at: T }],
    denied: { user: ['notion'], elsewhere: [], byUrl: [] },
    boot: { enabledPlugins: { 'warp@m': false }, denied: [] },
    catalog: cat,
  })
  const by = (id: string) => built.find(one => one.id === id)!
  expect(by('mod:guardrail')).toMatchObject({ state: 'on', pending: 'off', apply: 'restart', slug: 'guardrail' })
  expect(by('mod:mod-menu')).toMatchObject({ isLocked: true })
  expect(by('plugin:warp@m')).toMatchObject({ state: 'off', pending: 'on', apply: 'reload', inCatalog: true, tags: ['personal'], drift: true })
  expect(by('plugin:proj@m')).toMatchObject({ isLocked: true, drift: false })
  expect(by('skill:s')).toMatchObject({ state: 'off', apply: 'live', note: '2 folders · also hides the synced copy', inCatalog: true, drift: true })
  expect(by('skill:s#synced')).toMatchObject({ isLocked: true, tier: 'synced' })
  expect(by('hook:Stop:*:deadbeef')).toMatchObject({ state: 'off', note: 'stashed here' })
  expect(built.filter(one => one.type === 'hook')).toHaveLength(2)
  expect(by('mcp:notion')).toMatchObject({ state: 'on', pending: 'off', apply: 'restart' })
  expect(by('mcp:claude.ai Gmail')).toMatchObject({ state: 'on', tags: ['personal'], drift: false })
  expect(new Set(built.filter(one => one.type === 'skill').map(one => one.slug)).size).toBe(2)
})
