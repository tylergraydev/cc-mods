import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

const PROPS = { title: 'Mods', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const

const NAMES = ['agent-deck', 'usage-tracker', 'doom-pane', 'guardrail', 'dev-doctor', 'inbox', 'rail-runner', 'quiet-hours', 'mod-menu', 'workbench']
const dirOf = (name: string) => `C:\\mods\\${name}`
const SETTINGS = 'c:/users/me/.claude/settings.json'

const ROWS = [
  { key: 'guardrail.blockNoVerify', label: 'Block hook skipping', description: 'Deny git --no-verify', kind: 'boolean', value: true, provider: { plugin: 'guardrail', tier: 'user' }, isLocked: false },
  { key: 'guardrail.dryRunScope', label: 'Dry-run scope', kind: 'choice', value: 'tool', options: ['tool', 'session'], provider: { plugin: 'guardrail', tier: 'user' }, isLocked: false },
  { key: 'dev-doctor.intervalMinutes', label: 'Interval', kind: 'number', value: 5, provider: { plugin: 'dev-doctor', tier: 'user' }, isLocked: false },
  { key: 'theme', label: 'Theme', kind: 'choice', value: 'dark', options: ['dark', 'light'], provider: { plugin: 'claude-code', tier: 'user' }, isLocked: false },
] as const

type Opts = { settings?: string; denySet?: string; missing?: string[]; noManifest?: string[]; commands?: string[] }

/** The files, the settings and the engine ops beneath the plugin, recorded. */
function world(on: On, opts: Opts = {}) {
  const list = NAMES.map(dirOf).join(';')
  const files = new Map<string, string>()
  const key = (path: string) => path.split('\\').join('/').toLowerCase()
  files.set(SETTINGS, opts.settings ?? `{\n  "permissions": { "allow": ["Bash(ls)"] },\n  "enabledPlugins": { "x@y": true },\n  "env": { "CLAUDE_CODE_PLUGIN_DIRS": ${JSON.stringify(list)} }\n}\n`)
  for (const name of NAMES) {
    if (opts.noManifest?.includes(name)) continue
    files.set(key(`${dirOf(name)}/.claude-plugin/plugin.json`), JSON.stringify({ name, version: '0.1.0', description: `${name} description` }))
  }
  const writes: { path: string; text: string }[] = []
  const sets: { key: string; value: unknown }[] = []
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const opened: string[] = []
  mock.clock(on, { now: Date.parse('2026-10-03T10:00:00Z') })
  const store = new Map<string, unknown>()
  on('store.get', async (_, e) => ({ value: store.get(e.key) }))
  on('store.set', async (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  mock.env(on, { USERPROFILE: 'C:\\Users\\me', CLAUDE_CODE_PLUGIN_DIRS: list })
  on('fs.read', async (_, e) => (files.has(key(e.path)) ? { value: files.get(key(e.path))! } : { deny: 'ENOENT' }))
  on('fs.write', async (_, e) => {
    writes.push({ path: key(e.path), text: e.text })
    files.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('fs.exists', async (_, e) => ({ value: !opts.missing?.some(name => key(e.path) === key(dirOf(name))) }))
  on('settings.read', async () => ({ value: {} }))
  // v0.2 reads more: no claude/gh exe, no project, no skill folders
  on('process.run', async () => ({ deny: 'ENOENT' }))
  on('session.root', async () => ({ value: 'C:/proj' }))
  on('fs.list', async () => ({ value: [] }))
  on('config.list', async () => ({ value: [...ROWS] as never }))
  on('config.set', async (_, e) => {
    sets.push({ key: e.key, value: e.value })
    return opts.denySet ? { deny: opts.denySet } : { value: e.value }
  })
  on('ui.open', async (_, e) => {
    opened.push((e as { id: string }).id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.toast', async (_, e) => {
    toasts.push(String((e as { text?: unknown }).text))
    return { value: undefined }
  })
  on('ui.status', async (_, e) => {
    statuses.push((e as { text?: string }).text)
    return { value: undefined }
  })
  on('command.list', async () => ({ value: (opts.commands ?? []).map(name => ({ name, description: '', source: 'plugin' })) as never }))
  const env = () => (JSON.parse(files.get(SETTINGS)!.replace(/^\uFEFF/, '')) as { env: { CLAUDE_CODE_PLUGIN_DIRS: string } }).env.CLAUDE_CODE_PLUGIN_DIRS
  return { store, files, writes, sets, toasts, statuses, opened, env }
}

const mount = <S extends RenderSurface = 'terminal'>($: Engine, surface: S = 'terminal' as S) =>
  $.ui.mount({ plugin: 'mod-menu', surface, component: 'Pane', requestId: 'mod-menu', props: PROPS })
const run = ($: Engine, args = '') => $.command.run({ command: 'mod-menu', args } as Parameters<typeof $.command.run>[0])

test('/mod-menu opens the pane and lists the mods', async ($, on) => {
  const w = world(on)
  const said = await run($)
  expect(w.opened).toEqual(['mod-menu'])
  expect(String(said.text)).toContain('guardrail')
  expect(String(said.text)).toContain('10 on')
  const listed = await run($, 'list')
  // ten mods, then the one plugin the settings fixture lists (x@y)
  expect(String(listed.text).split('\n')).toHaveLength(11)
})

test('both surfaces: versions shown, the self row has no toggle, workbench does', async ($, on) => {
  world(on)
  await run($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, surface)
    expect((await ui.find({ key: 'mod-guardrail' }))?.text).toContain('0.1.0')
    expect(await ui.find({ key: 'toggle-mod-menu' })).toBeUndefined()
    expect(await ui.find({ key: 'toggle-workbench' })).toBeDefined()
    expect(await ui.find({ key: 'toggle-doom-pane' })).toBeDefined()
    await ui.unmount()
  }
})

test('show runs the loaded mod command, with the workbench dock opened first', async ($, on) => {
  const runs: string[] = []
  const w = world(on, { commands: ['workbench', 'deck'] })
  on('command.run', { command: 'deck' }, async () => {
    runs.push('deck')
    return { text: 'deck opened' }
  })
  await run($)
  const ui = await mount($)
  // no pane: no button; this menu: no button; a loaded mod with a pane: a button
  expect(await ui.find({ key: 'show-guardrail' })).toBeUndefined()
  expect(await ui.find({ key: 'show-mod-menu' })).toBeUndefined()
  expect(await ui.find({ key: 'show-agent-deck' })).toBeDefined()
  expect(await ui.find({ key: 'show-workbench' })).toBeDefined()
  const before = w.opened.length
  await ui.press({ key: 'show-agent-deck' })
  expect(w.opened.slice(before)).toEqual(['workbench'])
  expect(runs).toEqual(['deck'])
  await ui.unmount()
})

test('show is not offered for a mod that is not loaded yet, and says so when its command is missing', async ($, on) => {
  const w = world(on, { commands: ['workbench'] })
  await run($)
  const ui = await mount($)
  await ui.press({ key: 'show-agent-deck' })
  expect(w.toasts.at(-1)).toContain('/deck is not registered')
  await ui.unmount()
})

test('turning a mod off writes once, with a backup, and turning it on restores the order', async ($, on) => {
  const w = world(on)
  await run($)
  const original = w.env()
  const ui = await mount($)
  await ui.press({ key: 'toggle-doom-pane' })

  expect(w.writes).toHaveLength(2)
  expect(w.writes[0]?.path.endsWith('settings.json.mod-menu-backup')).toBe(true)
  const after = JSON.parse(w.files.get(SETTINGS)!)
  expect(after.env.CLAUDE_CODE_PLUGIN_DIRS).not.toContain('doom-pane')
  expect(after.env.CLAUDE_CODE_PLUGIN_DIRS.endsWith('workbench')).toBe(true)
  expect(after.permissions).toEqual({ allow: ['Bash(ls)'] })
  expect(after.enabledPlugins).toEqual({ 'x@y': true })
  expect((w.store.get('disabled') as { dir: string }[]).map(one => one.dir)).toEqual([dirOf('doom-pane')])
  expect(w.toasts.at(-1)).toContain('restart')
  expect((await ui.find({ key: 'state-doom-pane' }))?.text).toContain('next session')
  expect(w.statuses.at(-1)).toBe('mods: 10 on · 1 pending restart')

  await ui.press({ key: 'toggle-doom-pane' })
  expect(w.env()).toBe(original)
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(w.store.get('disabled')).toEqual([])
  expect(w.toasts.at(-1)).toContain('no restart needed')
  await ui.unmount()
})

test('a setting flips now', async ($, on) => {
  const w = world(on)
  await run($)
  const ui = await mount($)
  await ui.press({ key: 'row-guardrail' })
  await ui.press({ key: 'cfg-guardrail-blockNoVerify' })
  expect(w.sets).toEqual([{ key: 'guardrail.blockNoVerify', value: false }])
  expect(w.toasts.at(-1)).toContain('applied now')
  await ui.unmount()
})

test('a refused setting shows the reason', async ($, on) => {
  const denied = world(on, { denySet: 'locked by policy' })
  await run($)
  const again = await mount($)
  await again.press({ key: 'row-guardrail' })
  await again.press({ key: 'cfg-guardrail-blockNoVerify' })
  expect(denied.toasts.at(-1)).toContain('locked by policy')
  await again.unmount()
})

test('a choice and a number are set from their controls; a bad number is not', async ($, on) => {
  const w = world(on)
  await run($)
  const ui = await mount($)
  await ui.press({ key: 'row-guardrail' })
  await ui.select({ key: 'cfg-guardrail-dryRunScope', value: 'session' })
  expect(w.sets.at(-1)).toEqual({ key: 'guardrail.dryRunScope', value: 'session' })
  await ui.press({ key: 'row-guardrail' })
  await ui.press({ key: 'row-dev-doctor' })
  await ui.input({ key: 'cfg-dev-doctor-intervalMinutes', text: '10' })
  expect(w.sets.at(-1)).toEqual({ key: 'dev-doctor.intervalMinutes', value: 10 })
  const before = w.sets.length
  await ui.input({ key: 'cfg-dev-doctor-intervalMinutes', text: 'abc' })
  expect(w.sets).toHaveLength(before)
  expect(w.toasts.at(-1)).toContain('not a number')
  await ui.unmount()
})

test('unparsable settings.json: nothing is written', async ($, on) => {
  const w = world(on, { settings: '{ bad' })
  await run($)
  const ui = await mount($)
  expect(await ui.find({ key: 'error' })).toBeDefined()
  await ui.press({ key: 'toggle-doom-pane' })
  expect(w.writes).toHaveLength(0)
  expect(w.toasts.at(-1)).toContain('parse')
  await ui.unmount()
})

test('a folder with no plugin.json and a missing folder render with notes and still toggle', async ($, on) => {
  world(on, { noManifest: ['inbox'], missing: ['rail-runner'] })
  await run($)
  const ui = await mount($)
  expect((await ui.find({ key: 'state-inbox' }))?.text).toContain('no plugin.json')
  expect((await ui.find({ key: 'state-rail-runner' }))?.text).toContain('folder missing')
  expect(await ui.find({ key: 'toggle-inbox' })).toBeDefined()
  expect(await ui.find({ key: 'toggle-rail-runner' })).toBeDefined()
  await ui.unmount()
})

test('all on and nothing pending: no status', async ($, on) => {
  const w = world(on)
  await run($)
  expect(w.statuses.at(-1)).toBeUndefined()
})

test('/mod-menu off <name> writes and says to restart; the menu refuses itself', async ($, on) => {
  const w = world(on)
  const said = await run($, 'off guardrail')
  expect(w.writes).toHaveLength(2)
  expect(w.env()).not.toContain('guardrail')
  expect(String(said.text)).toContain('restart')
  const again = await run($, 'off guardrail')
  expect(String(again.text)).toContain('already off')
  const self = await run($, 'off mod-menu')
  expect(String(self.text)).toContain("can't switch itself off")
  expect(w.writes).toHaveLength(2)
  const back = await run($, 'on guardrail')
  expect(String(back.text)).toContain('no restart needed')
})

test('session start registers /mod-menu and tries /mods, and survives a refused alias', async ($, on) => {
  const w = world(on)
  const names: string[] = []
  on('command.register', async (_, e) => {
    const name = (e as { name: string }).name
    names.push(name)
    if (name === 'mods') throw new Error('built-in')
    return { value: undefined } as never
  })
  on('session.start', async (_, e) => e as never)
  await $.session.start({ cwd: 'C:/work', surface: null, isInteractive: true })
  await run($, 'list')
  expect(names).toEqual(['mod-menu', 'mods'])
  expect(w.statuses.at(-1)).toBeUndefined()
})
