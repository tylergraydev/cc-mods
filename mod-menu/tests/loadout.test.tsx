import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

import { hookId } from '../hooks/loadout'

const PROPS = { title: 'Mods', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

const T = 1_790_000_000_000
const NAMES = ['guardrail', 'mod-menu', 'workbench']
const dirOf = (name: string) => `C:\\mods\\${name}`
const DIR = 'c:/users/me/.claude'
const SETTINGS = `${DIR}/settings.json`
const LOADOUT = `${DIR}/loadout.json`
const HOOK = hookId('PreToolUse', 'Bash', { type: 'command', command: 'echo guard' })
const SECRET = `ghp_${'q9W8e7R6t5'.repeat(3)}`

const key = (path: string) => path.split('\\').join('/').toLowerCase()
const entry = (tags: string[], on: boolean) => ({ tags, on, updatedAt: T })
/** A catalog file: names and tags only. */
const catalogText = (items: Record<string, { tags: string[]; on: boolean; updatedAt: number }>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, updatedAt: T, items, profiles: { work: { updatedAt: T }, personal: { updatedAt: T } }, machines: {}, ...extra })
const LOCAL = catalogText({
  'mod:guardrail': entry(['work'], true),
  'mod:workbench': entry(['personal'], true),
  'skill:build-mod': entry(['work', 'personal'], true),
  'skill:notes': entry(['personal'], true),
  'plugin:warp@claude-code-warp': entry(['personal'], true),
  'mcp:notion': entry(['personal'], true),
  [HOOK]: entry(['work'], true),
})

type Opts = {
  gh?: 'ok' | 'out' | 'missing'
  claude?: 'ok' | 'missing'
  loadout?: string | null
  sync?: Record<string, unknown>
  gist?: { content: string; rev: number } | null
}

/** The files, the host commands and the fake gist beneath the plugin, recorded. */
function world(on: On, opts: Opts = {}) {
  const list = NAMES.map(dirOf).join(';')
  const files = new Map<string, string>()
  files.set(
    SETTINGS,
    `${JSON.stringify(
      {
        permissions: { allow: ['Bash(ls)'] },
        enabledPlugins: { 'warp@claude-code-warp': true, 'impeccable@impeccable': true },
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo guard' }] }] },
        env: { CLAUDE_CODE_PLUGIN_DIRS: list },
      },
      null,
      2,
    )}\n`,
  )
  if (opts.loadout !== null) files.set(LOADOUT, opts.loadout ?? LOCAL)
  files.set(key('C:\\Users\\me/.claude.json'), JSON.stringify({ mcpServers: { notion: { url: 'https://notion.test/mcp' } } }))
  for (const name of NAMES) files.set(key(`${dirOf(name)}/.claude-plugin/plugin.json`), JSON.stringify({ name, version: '0.1.0', description: `${name} description` }))
  files.set(`${DIR}/skills/build-mod/skill.md`, '---\nname: build-mod\ndescription: builds mods\n---\nbody')
  files.set(`${DIR}/skills/notes/skill.md`, '---\nname: notes\n---\nbody')

  const writes: { path: string; text: string }[] = []
  const toasts: string[] = []
  const store = new Map<string, unknown>()
  if (opts.sync) store.set('sync', opts.sync)
  mock.clock(on, { now: T })
  on('store.get', async (_, e) => ({ value: store.get(e.key) }))
  on('store.set', async (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  mock.env(on, { USERPROFILE: 'C:\\Users\\me', CLAUDE_CODE_PLUGIN_DIRS: list, COMPUTERNAME: 'DESKTOP-A' })
  on('fs.read', async (_, e) => (files.has(key(e.path)) ? { value: files.get(key(e.path))! } : { deny: 'ENOENT' }))
  on('fs.write', async (_, e) => {
    writes.push({ path: key(e.path), text: e.text })
    files.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('fs.exists', async (_, e) => ({ value: [...files.keys()].some(one => one === key(e.path) || one.startsWith(`${key(e.path)}/`)) }))
  on('fs.list', async (_, e) => {
    const base = `${key(e.path ?? '')}/`
    const seen = new Map<string, 'file' | 'dir'>()
    for (const one of files.keys()) {
      if (!one.startsWith(base)) continue
      const rest = one.slice(base.length)
      seen.set(rest.split('/')[0]!, rest.includes('/') ? 'dir' : 'file')
    }
    return { value: [...seen].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 1, isLink: false })) }
  })
  on('session.root', async () => ({ value: 'C:/proj' }))
  on('settings.read', async () => ({ value: {} }))
  on('config.list', async () => ({ value: [] }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('ui.toast', async (_, e) => {
    toasts.push(String((e as { text?: unknown }).text))
    return { value: undefined }
  })
  const statuses: (string | undefined)[] = []
  on('ui.status', async (_, e) => {
    statuses.push((e as { text?: string }).text)
    return { value: undefined }
  })
  on('command.list', async () => ({ value: [] }))

  // the fake gist: one secret gist, revisions counted
  const gists = new Map<string, { description: string; content: string; rev: number }>()
  if (opts.gist) gists.set('g1', { description: 'claude-loadout (mod-menu)', content: opts.gist.content, rev: opts.gist.rev })
  const stamp = (rev: number) => `2026-10-03T10:00:0${rev}Z`
  const gistJson = (id: string) => {
    const one = gists.get(id)!
    return JSON.stringify({ id, description: one.description, updated_at: stamp(one.rev), owner: { login: 'tylergraydev' }, files: { 'loadout.json': { content: one.content, truncated: false } } })
  }

  const plugins: Record<string, boolean> = { 'warp@claude-code-warp': true, 'impeccable@impeccable': true }
  const ran: string[][] = []
  const inits: ({ stdin?: string; timeoutMs?: number; cwd?: string } | undefined)[] = []
  const stdins: (string | undefined)[] = []
  const out = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', async (_, e) => {
    const argv = [...(e as unknown as { argv: readonly string[] }).argv]
    const init = (e as unknown as { init?: { stdin?: string; timeoutMs?: number; cwd?: string } }).init
    ran.push(argv)
    stdins.push(init?.stdin)
    inits.push(init)
    const [exe, ...rest] = argv
    if (exe === 'claude.exe') {
      if (opts.claude === 'missing') return { deny: 'ENOENT' }
      if (rest[0] === 'plugin' && rest[1] === 'list') {
        return out(JSON.stringify([
          ...Object.entries(plugins).map(([id, enabled]) => ({ id, version: '1.0.0', scope: 'user', enabled, projectEnabled: false })),
          { id: 'guardrail@inline', version: '0.1.0', scope: 'session', enabled: true },
        ]))
      }
      const plugin = rest[rest.length - 1]!
      plugins[plugin] = rest[1] === 'enable'
      return out(JSON.stringify({ command: rest[1], outcome: 'success', plugin, scope: 'user', message: `${rest[1]}d ${plugin}`, alreadyInGoalState: false }))
    }
    if (exe !== 'gh.exe') return { deny: 'ENOENT' }
    if (rest[0] === 'auth') {
      if (opts.gh === 'missing') return { deny: 'ENOENT' }
      if (opts.gh === 'out') return out('', 1, `You are not logged into any GitHub hosts. To log in, run: gh auth login (${SECRET})`)
      return out('github.com\n  ✓ Logged in to github.com as tylergraydev (keyring)\n  - Active account: true\n')
    }
    // gh api ...
    const method = rest.includes('--method') ? rest[rest.indexOf('--method') + 1]! : 'GET'
    const path = rest.find(one => one.startsWith('/'))!
    if (method === 'GET' && path === '/gists' && rest.includes('--jq')) return out([...gists].filter(([, g]) => g.description === 'claude-loadout (mod-menu)').map(([id]) => id).join('\n'))
    if (method === 'GET' && path.startsWith('/gists?')) return out(JSON.stringify([...gists].map(([id, g]) => ({ id, description: g.description }))))
    const id = path.split('/')[2]
    if (method === 'GET') return gists.has(id!) ? out(gistJson(id!)) : out('', 1, 'gh: Not Found (HTTP 404)')
    const body = JSON.parse(init?.stdin ?? '{}') as { description?: string; files?: Record<string, { content: string }> }
    if (method === 'POST') {
      gists.set('g-new', { description: body.description ?? '', content: body.files!['loadout.json']!.content, rev: 1 })
      return out(gistJson('g-new'))
    }
    const held = gists.get(id!)!
    held.content = body.files!['loadout.json']!.content
    held.rev += 1
    return out(gistJson(id!))
  })

  const settings = () => JSON.parse(files.get(SETTINGS)!) as Record<string, any>
  const loadout = () => JSON.parse(files.get(LOADOUT)!) as { items: Record<string, { tags: string[]; on: boolean }>; active?: { tag: string }; profiles: Record<string, unknown> }
  const settingsWrites = () => writes.filter(one => one.path === SETTINGS)
  /** The stdin of the last gh api call that wrote (POST or PATCH). */
  const sent = () => stdins[ran.findLastIndex(argv => argv.includes('PATCH') || argv.includes('POST'))]
  const ghCalls = () => ran.filter(argv => argv[0] === 'gh.exe').map(argv => argv.slice(1))
  return { sent, files, writes, toasts, statuses, store, ran, inits, stdins, gists, settings, loadout, settingsWrites, ghCalls }
}

const mount = <S extends RenderSurface = 'terminal'>($: Engine, surface: S = 'terminal' as S) =>
  $.ui.mount({ plugin: 'mod-menu', surface, component: 'Pane', requestId: 'mod-menu', props: PROPS })
const run = ($: Engine, args = '') => $.command.run({ command: 'mod-menu', args } as Parameters<typeof $.command.run>[0])

const REMOTE = catalogText({ 'skill:remote-only': { tags: ['work'], on: false, updatedAt: T + 1000 }, 'mod:guardrail': { tags: ['work', 'extra'], on: true, updatedAt: T + 2000 }, 'skill:notes': { tags: ['personal'], on: false, updatedAt: T + 3000 } })

test('use work --dry-run says what would change and touches nothing', async ($, on) => {
  const w = world(on)
  const said = await run($, 'use work --dry-run')
  expect(String(said.text)).toContain('use work: 0 on, 4 off, 3 need restart')
  expect(String(said.text)).toContain('dry run')
  expect(w.writes).toHaveLength(0)
  // only the plugin listing ran: no disable, no gh
  expect(w.ran.every(argv => argv[0] === 'claude.exe' && argv[2] === 'list')).toBe(true)
  expect(String((await run($, 'use nothing --dry-run')).text)).toContain('no items tagged "nothing"')
  // every host command passed a timeout and ran from the home folder
  expect(w.inits.length).toBeGreaterThan(0)
  expect(w.inits.every(init => (init?.timeoutMs ?? 0) > 0 && init?.cwd === 'C:\\Users\\me')).toBe(true)
})

test('use work: one settings write for mods, skills and MCP, the plugin through the CLI, the catalog follows', async ($, on) => {
  const w = world(on)
  const before = w.settings()
  const said = await run($, 'use work')
  expect(w.settingsWrites()).toHaveLength(1)
  expect(w.writes.filter(one => one.path.endsWith('settings.json.mod-menu-backup'))).toHaveLength(1)
  const after = w.settings()
  expect(after.skillOverrides).toEqual({ notes: 'off' })
  expect(after.deniedMcpServers).toEqual([{ serverName: 'notion' }])
  expect(after.env.CLAUDE_CODE_PLUGIN_DIRS).toBe('C:\\mods\\guardrail;C:\\mods\\mod-menu')
  expect(after.permissions).toEqual(before.permissions)
  expect(after.hooks).toEqual(before.hooks)
  // the plugin went through the CLI, never through enabledPlugins
  expect(after.enabledPlugins).toEqual(before.enabledPlugins)
  expect(w.ran).toContainEqual(['claude.exe', 'plugin', 'disable', '--json', '--scope', 'user', 'warp@claude-code-warp'])
  expect(w.loadout().active?.tag).toBe('work')
  expect(w.loadout().items['skill:notes']!.on).toBe(false)
  expect(w.loadout().items['skill:build-mod']!.on).toBe(true)
  expect(String(said.text)).toContain('restart Claude Code')
  expect(String(said.text)).toContain('/reload-plugins')
  expect(w.toasts.at(-1)).toContain('/reload-plugins')
  expect(w.writes.some(one => one.path === `${DIR}/loadout.json.bak`)).toBe(true)

  const ui = await mount($)
  await ui.press({ key: 'sec-skill' })
  expect((await ui.find({ key: 'state-workbench' }))?.text).toContain('next session')
  expect((await ui.find({ key: 'state-skill-notes' }))?.text).toContain('off')
  await ui.unmount()

  // the same profile again: already in place, and nothing more is written
  const count = w.writes.length
  const dry = await run($, 'use work --dry-run')
  expect(String(dry.text)).toContain('use work: already in place')
  expect(String((await run($, 'use work')).text)).toContain('use work: already in place')
  expect(w.writes).toHaveLength(count)
})

test('tag writes the catalog and the pane shows it; the tag field sets tags too', async ($, on) => {
  const w = world(on, { loadout: null })
  const said = await run($, 'tag skill:build-mod work,personal')
  expect(String(said.text)).toContain('tags personal, work')
  expect(w.loadout().items['skill:build-mod']).toMatchObject({ tags: ['personal', 'work'], on: true })
  expect(w.loadout().profiles).toHaveProperty('work')
  expect(JSON.stringify(w.loadout())).not.toContain('C:')

  const ui = await mount($)
  await ui.press({ key: 'sec-skill' })
  expect((await ui.find({ key: 'tags-skill-build-mod' }))?.text).toContain('personal,work')
  await ui.press({ key: 'row-skill-build-mod' })
  await ui.press({ key: 'tagbtn-skill-build-mod' })
  await ui.input({ key: 'tagedit-skill-build-mod', text: 'personal' })
  expect(w.loadout().items['skill:build-mod']!.tags).toEqual(['personal'])
  expect(String((await run($, 'tag skill:build-mod all')).text)).toContain('reserved')
  expect(String((await run($, 'tag skill:nope work')).text)).toContain('No item')
  await ui.unmount()
})

test('a skill and a hook switch live; the hook comes back from its stash', async ($, on) => {
  const w = world(on, { loadout: null })
  await run($, 'off skill:notes')
  expect(w.settings().skillOverrides).toEqual({ notes: 'off' })
  await run($, 'on skill:notes')
  expect(w.settings().skillOverrides).toEqual({})
  expect(w.settingsWrites()).toHaveLength(2)

  const original = w.settings().hooks
  const off = await run($, `off ${HOOK}`)
  expect(String(off.text)).toContain('applied now')
  expect(w.settings().hooks).toEqual({})
  expect((w.store.get('hookStash') as { id: string }[]).map(one => one.id)).toEqual([HOOK])
  const on2 = await run($, `on ${HOOK}`)
  expect(String(on2.text)).toContain('applied now')
  expect(w.settings().hooks).toEqual(original)
  expect(w.store.get('hookStash')).toEqual([])
  // the catalog is untouched: nothing was tagged
  expect(w.files.has(LOADOUT)).toBe(false)
})

test('sync with a gist: auth, GET, a second GET, then PATCH with the merged catalog', async ($, on) => {
  const w = world(on, { gist: { content: REMOTE, rev: 1 }, sync: { gistId: 'g1', owner: 'tylergraydev', remoteUpdatedAt: '2026-10-03T10:00:01Z' } })
  const said = await run($, 'sync')
  expect(w.ghCalls().map(argv => argv.slice(0, argv[0] === 'api' ? 2 : 1).join(' '))).toEqual(['auth', 'api /gists/g1', 'api /gists/g1', 'api --method'])
  expect(w.ghCalls().at(-1)).toEqual(['api', '--method', 'PATCH', '/gists/g1', '--input', '-'])
  const patched = JSON.parse(w.sent()!) as { files: Record<string, { content: string }> }
  const sent = JSON.parse(patched.files['loadout.json']!.content) as { items: Record<string, { tags: string[] }> }
  expect(Object.keys(sent.items).sort()).toContain('skill:remote-only')
  expect(Object.keys(sent.items).sort()).toContain('skill:notes')
  expect(sent.items['mod:guardrail']!.tags).toEqual(['extra', 'work'])
  // the local file took the remote's newer entries
  expect(w.loadout().items['skill:remote-only']).toBeDefined()
  expect(w.loadout().items['mod:guardrail']!.tags).toEqual(['extra', 'work'])
  expect(String(said.text)).toContain('synced')
  expect((w.store.get('sync') as { gistId: string; remoteUpdatedAt: string }).remoteUpdatedAt).toBe('2026-10-03T10:00:02Z')
  // sync never applies anything to settings
  expect(w.settingsWrites()).toHaveLength(0)
  expect(w.ran.some(argv => argv.includes('disable'))).toBe(false)
})

test('sync with no gist finds none, creates a secret one and remembers it', async ($, on) => {
  const w = world(on)
  const said = await run($, 'sync')
  expect(w.ghCalls().map(argv => argv.slice(0, 3).join(' '))).toEqual(['auth status --hostname', 'api --paginate /gists', 'api --method POST'])
  expect(JSON.parse(w.sent()!)).toMatchObject({ description: 'claude-loadout (mod-menu)', public: false })
  expect(String(said.text)).toContain('Created a secret gist')
  expect(w.store.get('sync')).toMatchObject({ gistId: 'g-new', owner: 'tylergraydev' })
  // no token anywhere: the secret in gh's stderr was never asked for, shown or kept
  expect(JSON.stringify([...w.store])).not.toContain(SECRET)
  expect(w.gists.get('g-new')!.content).not.toContain('echo guard')
})

test('gh logged out: sync says how to log in and calls no api', async ($, on) => {
  const w = world(on, { gh: 'out' })
  const said = await run($, 'sync')
  expect(String(said.text)).toContain('gh auth login --web')
  expect(String(said.text)).not.toContain(SECRET)
  expect(w.ghCalls().every(argv => argv[0] === 'auth')).toBe(true)
  const status = await run($, 'gh')
  expect(String(status.text)).toContain('not logged in')
  expect(String(status.text)).not.toContain(SECRET)
  expect(w.toasts.join(' ')).not.toContain(SECRET)
})

test('gh not installed: sync is unavailable', async ($, on) => {
  const w = world(on, { gh: 'missing' })
  expect(String((await run($, 'sync')).text)).toContain('sync unavailable: install gh')
  expect(w.ghCalls().every(argv => argv[0] === 'auth')).toBe(true)
})

test('gh on another account: sync refuses and names the way out', async ($, on) => {
  const w = world(on, { sync: { gistId: 'g1', owner: 'someone-else' } })
  const refused = await run($, 'sync')
  expect(String(refused.text)).toContain('syncs as someone-else')
  expect(String(refused.text)).toContain('--relink')
  expect(w.ghCalls().every(argv => argv[0] === 'auth')).toBe(true)
})

test('push refuses when the remote moved, and --force overwrites it', async ($, on) => {
  const w = world(on, { gist: { content: REMOTE, rev: 3 }, sync: { gistId: 'g1', owner: 'tylergraydev', remoteUpdatedAt: '2026-10-03T10:00:01Z' } })
  const refused = await run($, 'push')
  expect(String(refused.text)).toContain('remote changed since your last sync')
  expect(w.ghCalls().some(argv => argv.includes('PATCH'))).toBe(false)
  const forced = await run($, 'push --force')
  expect(w.ghCalls().at(-1)).toContain('PATCH')
  expect(String(forced.text)).toContain('pushed')
  const sent = JSON.parse((JSON.parse(w.sent()!) as { files: Record<string, { content: string }> }).files['loadout.json']!.content) as { items: Record<string, unknown> }
  // push sends the local catalog as it is
  expect(Object.keys(sent.items)).not.toContain('skill:remote-only')
})

test('pull merges the remote into the local file and writes nothing remote', async ($, on) => {
  const w = world(on, { gist: { content: REMOTE, rev: 2 }, sync: { gistId: 'g1', owner: 'tylergraydev' } })
  const said = await run($, 'pull')
  expect(String(said.text)).toContain('pulled')
  expect(w.loadout().items['skill:remote-only']).toBeDefined()
  expect(w.ghCalls().some(argv => argv.includes('PATCH') || argv.includes('POST'))).toBe(false)
  expect(String(said.text)).toContain('differ here')
})

test('claude.exe cannot start: the plugin switch falls back to enabledPlugins', async ($, on) => {
  const w = world(on, { claude: 'missing', loadout: null })
  const said = await run($, 'off warp@claude-code-warp')
  expect(String(said.text)).toContain('/reload-plugins')
  expect(w.settings().enabledPlugins).toEqual({ 'warp@claude-code-warp': false, 'impeccable@impeccable': true })
  expect(w.settingsWrites()).toHaveLength(1)
  // and the pane still lists the plugins, from settings
  const ui = await mount($)
  expect(await ui.find({ key: 'plugin-warp-claude-code-warp' })).toBeDefined()
  await ui.unmount()
})

test('both surfaces: five sections, the GitHub line, a profile preview and its apply', async ($, on) => {
  const w = world(on)
  await run($, 'list')
  await run($, 'gh')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, surface)
    for (const type of ['mod', 'plugin', 'skill', 'hook', 'mcp']) expect(await ui.find({ key: `sec-${type}` })).toBeDefined()
    expect((await ui.find({ key: 'gh' }))?.text).toContain('tylergraydev')
    expect(await ui.find({ key: 'toggle-plugin-warp-claude-code-warp' })).toBeDefined()
    expect(await ui.find({ key: 'toggle-mcp-notion' })).toBeDefined()
    expect(await ui.find({ key: 'toggle-mod-menu' })).toBeUndefined()
    expect(await ui.find({ key: 'profile-work' })).toBeDefined()
    expect(await ui.find({ key: 'profile-all' })).toBeDefined()
    await ui.unmount()
  }
  const ui = await mount($)
  expect(await ui.find({ key: 'plan' })).toBeUndefined()
  await ui.press({ key: 'profile-work' })
  expect((await ui.find({ key: 'plan' }))?.text).toContain('use work: 0 on, 4 off')
  expect(w.writes).toHaveLength(0)
  await ui.press({ key: 'plan-apply' })
  expect(w.settingsWrites()).toHaveLength(1)
  expect(w.settings().deniedMcpServers).toEqual([{ serverName: 'notion' }])
  expect(await ui.find({ key: 'plan' })).toBeUndefined()
  await ui.unmount()
})

test('an unparsable loadout.json: tags and profiles are refused and nothing is written', async ($, on) => {
  const w = world(on, { loadout: '{ "version": 1, ' })
  const said = await run($, 'tag skill:notes work')
  expect(String(said.text)).toContain('parse')
  const used = await run($, 'use work')
  expect(String(used.text)).toContain('parse')
  expect(w.writes).toHaveLength(0)
  const ui = await mount($)
  expect(await ui.find({ key: 'catalog-error' })).toBeDefined()
  await ui.unmount()
})

test('a toggle that is already in the catalog keeps it in step; a toggle that is not leaves the file alone', async ($, on) => {
  const w = world(on)
  await run($, 'off skill:notes')
  expect(w.loadout().items['skill:notes']!.on).toBe(false)
  await run($, 'off skill:build-mod')
  const loaded = w.loadout()
  expect(loaded.items['skill:build-mod']!.on).toBe(false)
  const text = w.files.get(LOADOUT)!
  await run($, 'on skill:build-mod')
  expect(w.files.get(LOADOUT)).not.toBe(text)
  // forget writes a tombstone
  await run($, 'forget skill:notes')
  expect((w.loadout().items['skill:notes'] as { deleted?: boolean }).deleted).toBe(true)
})

test('the status line carries the active profile', async ($, on) => {
  const w = world(on)
  await run($, 'use work')
  expect(w.statuses.at(-1)).toContain('profile work')
})
