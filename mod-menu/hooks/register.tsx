import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { Catalog, DisabledDir, GhStatus, HookStash, ItemType, LoadoutItem, ModConfigRow, ModEntry, ModMenuSnapshot, ProfilePlan, SyncState } from '../types'
import { BENCH, fillSlot, inSlot, slotOf } from './bench'
import {
  TITLES,
  TYPES,
  appliedText,
  buildItems,
  denyInfo,
  effective,
  emptyCatalog,
  exesFor,
  findGist,
  firstLine,
  frontmatterDescription,
  fnv8,
  frontmatterName,
  ghAuthArgv,
  ghText,
  gistFindArgv,
  gistGetArgv,
  gistListArgv,
  gistPatchArgv,
  gistPatchBody,
  gistPostArgv,
  gistPostBody,
  itemId,
  itemStateText,
  itemsText,
  mergeCatalogs,
  parseAuthStatus,
  parseCatalog,
  parseCommand,
  parseGist,
  parseGistReply,
  parseTags,
  parseHooks,
  parseMcpFiles,
  parsePluginList,
  parsePluginResult,
  planProfile,
  planReconcile,
  pluginListArgv,
  pluginToggleArgv,
  resolveId,
  serializeCatalog,
} from './loadout'
import type { HookRow, McpRow, PluginRow, SkillRow } from './loadout'
import {
  addDir,
  clip,
  counts,
  derive,
  expand,
  headerText,
  isListed,
  isPlain,
  listDirs,
  listText,
  modConfig,
  norm,
  parseDirs,
  removeDir,
  rewriteDirs,
  sameDirs,
  sepFor,
  showCommand,
  splitDirs,
  statusText,
  stateText,
  toggleToast,
  NOTES,
} from './mods'
import type { Json, ManifestInfo } from './mods'
import { dirsEdit, getPath, hookOffEdit, hookOnEdit, mcpEdit, pluginEdit, rewriteKeys, skillEdit } from './settings-edit'
import type { Edit } from './settings-edit'

const PANE = 'mod-menu'
const TITLE = 'Mods'
const HOTKEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']
// not q r s t y n o: close, refresh, sync, edit tags, plan apply, plan cancel, show pane
const LETTERS = 'abcdefghijklmpuvwxz'.split('')
const HINT = '[list|on <id>|off <id>|tag <id> <tags>|use <tag> [--dry-run]|apply|sync|pull|push [--force]|gh]'

const EMPTY: ModMenuSnapshot = { mods: [], settingsPath: '', readAt: 0 }
const boot = atom({ plugin: 'mod-menu', key: 'boot' } as const, null)
const snapshot = atom({ plugin: 'mod-menu', key: 'snapshot' } as const, EMPTY)
const config = atom({ plugin: 'mod-menu', key: 'config' } as const, [])
const selected = atom({ plugin: 'mod-menu', key: 'selected' } as const, null)
const isWriting = atom({ plugin: 'mod-menu', key: 'isWriting' } as const, false)
const bootSettings = atom({ plugin: 'mod-menu', key: 'bootSettings' } as const, null)
const items = atom({ plugin: 'mod-menu', key: 'items' } as const, [])
const catalog = atom({ plugin: 'mod-menu', key: 'catalog' } as const, null)
const catalogError = atom({ plugin: 'mod-menu', key: 'catalogError' } as const, null)
const gh = atom({ plugin: 'mod-menu', key: 'gh' } as const, { kind: 'unknown', checkedAt: 0 })
const sync = atom({ plugin: 'mod-menu', key: 'sync' } as const, { kind: 'idle' })
const collapsed = atom({ plugin: 'mod-menu', key: 'collapsed' } as const, ['skill', 'hook'])
const editing = atom({ plugin: 'mod-menu', key: 'editing' } as const, null)
const plan = atom({ plugin: 'mod-menu', key: 'plan' } as const, null)

/** Where settings.json is, the config dir it sits in, and the home `~` stands for. */
async function where($: EngineInterface): Promise<{ path: string; dir: string; home: string | undefined; isExplicit: boolean }> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const explicit = await $.env.get('CLAUDE_CONFIG_DIR')
  const dir = (explicit ?? `${home ?? ''}/.claude`).replace(/[\\/]+$/, '')
  return { path: `${dir}/settings.json`, dir, home, isExplicit: explicit !== undefined }
}

/** The dirs this process loaded, captured once: $.state outlives this mod's own reload. */
async function ensureBoot($: EngineInterface): Promise<string[]> {
  const held = await read($, boot)
  if (held !== null) return held
  const { path, home } = await where($)
  let value = await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')
  if (value === undefined) {
    const user = await $.settings.read({ source: 'user' }).catch(() => ({}) as Record<string, unknown>)
    const env = user.env as Record<string, unknown> | undefined
    if (typeof env?.CLAUDE_CODE_PLUGIN_DIRS === 'string') value = env.CLAUDE_CODE_PLUGIN_DIRS
  }
  const list = splitDirs(value ?? '', sepFor(path, value)).map(one => norm(one, home))
  await update($, boot, () => list)
  return list
}

/** This mod's own folder and name, for telling its row apart. */
function whoAmI($: EngineInterface): { name: string; key: string; } {
  const root = $.plugin.root as string | undefined
  return { name: $.plugin.name, key: root ? norm(root) : '' }
}

/** What a mod's folder says about itself. */
async function manifestOf($: EngineInterface, dir: string, home: string | undefined): Promise<ManifestInfo> {
  const path = expand(dir, home)
  if (!(await $.fs.exists(path).catch(() => false))) return { note: 'missing' }
  let text: string
  try {
    text = await $.fs.read(`${path}/.claude-plugin/plugin.json`)
  } catch {
    return { note: 'no-manifest' }
  }
  try {
    const json = JSON.parse(text.replace(/^﻿/, '')) as Record<string, unknown>
    const str = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined)
    return { name: str(json.name), version: str(json.version), description: str(json.description) }
  } catch {
    return { note: 'bad-manifest' }
  }
}

type Ran = { exitCode: number; stdout: string; stderr: string }

/** A host command, or undefined when it cannot start, times out or `$.process` is not there (CLI only). */
async function proc($: EngineInterface, argv: string[], home: string | undefined, timeoutMs: number, stdin?: string): Promise<Ran | undefined> {
  try {
    const out = await $.process.run(argv, { ...(home ? { cwd: home } : {}), timeoutMs, ...(stdin !== undefined ? { stdin } : {}) })
    return { exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr }
  } catch {
    return undefined
  }
}

async function kept<T>($: EngineInterface, key: string, fallback: T): Promise<T> {
  try {
    return ((await $.store.get(key)) ?? fallback) as T
  } catch {
    return fallback
  }
}

/** settings.json as a plain object; empty when it does not parse. */
function settingsObject(raw: string | undefined): Json {
  try {
    const json: unknown = raw === undefined ? undefined : JSON.parse(raw.replace(/^﻿/, ''))
    return isPlain(json) ? json : {}
  } catch {
    return {}
  }
}

/** The project, local and managed settings, read-only; an empty object where one cannot be read. */
async function otherSettings($: EngineInterface): Promise<Record<'project' | 'local' | 'policy', Json>> {
  const out: Record<'project' | 'local' | 'policy', Json> = { project: {}, local: {}, policy: {} }
  for (const source of ['project', 'local', 'policy'] as const) {
    try {
      const got: unknown = await $.settings.read({ source })
      if (isPlain(got)) out[source] = got
    } catch {
      // that tier is not shown
    }
  }
  return out
}

/** The marketplace plugins: from the claude CLI, else from enabledPlugins in settings.json. */
async function listPlugins($: EngineInterface, user: Json, others: Record<'project' | 'local' | 'policy', Json>, home: string | undefined, isWindows: boolean): Promise<{ rows: PluginRow[]; note?: string }> {
  const ran = await proc($, pluginListArgv(exesFor(isWindows).claude), home, 20_000)
  let rows = ran && ran.exitCode === 0 ? parsePluginList(ran.stdout) : undefined
  let note: string | undefined
  if (rows === undefined) {
    note = 'claude CLI not available: plugins read from enabledPlugins in settings.json'
    const enabled = isPlain(user.enabledPlugins) ? user.enabledPlugins : {}
    rows = Object.entries(enabled).filter(([, on]) => typeof on === 'boolean').map(([key, on]) => ({ key, enabled: on === true }))
  }
  const lockedBy = (key: string) => {
    for (const [tier, why] of [['policy', 'managed by policy'], ['project', 'set in project settings'], ['local', 'set in project settings']] as const) {
      const set = others[tier].enabledPlugins
      if (isPlain(set) && key in set) return why
    }
    return undefined
  }
  return { rows: rows.map(one => (lockedBy(one.key) && !one.isLocked ? { ...one, isLocked: true, lockReason: lockedBy(one.key) } : one)), ...(note ? { note } : {}) }
}

/** Skill folders under `base` that hold a SKILL.md; the name is the frontmatter's, else the folder's. */
async function skillsIn($: EngineInterface, base: string, tier: SkillRow['tier'], overrides: Json): Promise<SkillRow[]> {
  const entries = await $.fs.list(base).catch(() => [])
  const rows: SkillRow[] = []
  for (const entry of entries) {
    if (entry.kind === 'file' || (tier === 'user' && entry.name === 'synced')) continue
    let text: string
    try {
      text = await $.fs.read(`${base}/${entry.name}/SKILL.md`)
    } catch {
      continue
    }
    const name = frontmatterName(text) ?? entry.name
    const description = frontmatterDescription(text)
    const held = rows.find(one => one.name === name)
    if (held) held.folders += 1
    else {
      const override = tier === 'user' && typeof overrides[name] === 'string' ? (overrides[name] as string) : undefined
      rows.push({ name, tier, folders: 1, ...(description !== undefined ? { description } : {}), ...(override !== undefined ? { override } : {}) })
    }
  }
  return rows
}

async function listSkills($: EngineInterface, dir: string, root: string | undefined, overrides: Json): Promise<SkillRow[]> {
  const rows = await skillsIn($, `${dir}/skills`, 'user', overrides)
  for (const uuid of await $.fs.list(`${dir}/skills/synced`).catch(() => [])) {
    if (uuid.kind !== 'file') rows.push(...(await skillsIn($, `${dir}/skills/synced/${uuid.name}`, 'synced', overrides)))
  }
  if (root !== undefined) rows.push(...(await skillsIn($, `${root}/.claude/skills`, 'project', overrides)))
  return rows
}

/** The MCP servers: ~/.claude.json and <root>/.mcp.json, read-only, nothing written. */
async function listMcp($: EngineInterface, dir: string, home: string | undefined, isExplicit: boolean, root: string | undefined): Promise<{ rows: McpRow[]; note?: string }> {
  let claudeJson: string | undefined
  let note: string | undefined
  try {
    claudeJson = await $.fs.read(`${isExplicit ? dir : (home ?? '')}/.claude.json`)
    if (claudeJson.length > 4_194_304) {
      claudeJson = undefined
      note = '~/.claude.json is too big to read: servers from the deny list and catalog only'
    }
  } catch {
    note = '~/.claude.json not readable: servers from the deny list and catalog only'
  }
  const mcpJson = root === undefined ? undefined : await $.fs.read(`${root}/.mcp.json`).catch(() => undefined)
  return { rows: parseMcpFiles(claudeJson, mcpJson, root), ...(note ? { note } : {}) }
}

/** loadout.json: absent reads as empty; a file that does not parse is an error and is never overwritten. */
async function readCatalog($: EngineInterface, dir: string): Promise<{ raw?: string; catalog: Catalog } | { error: string }> {
  let raw: string | undefined
  try {
    raw = await $.fs.read(`${dir}/loadout.json`)
  } catch {
    raw = undefined
  }
  if (raw === undefined) return { catalog: emptyCatalog() }
  const parsed = parseCatalog(raw)
  return 'error' in parsed ? { error: parsed.error } : { raw, catalog: parsed.catalog }
}

/** Run one lister; its failure becomes the section's note, not a dead pane. */
async function guarded<T>(notes: Partial<Record<ItemType, string>>, type: ItemType, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    notes[type] = `could not list: ${String(err).slice(0, 60)}`
    return fallback
  }
}

/** Read settings.json, the folders, the other sections and the config rows again and redraw. */
async function refresh($: EngineInterface) {
  const booted = await ensureBoot($)
  const { path, dir, home, isExplicit } = await where($)
  const now = await $.clock.now()
  let disk = booted
  let error: string | undefined
  let raw: string | undefined
  try {
    raw = await $.fs.read(path)
    const parsed = parseDirs(raw, path)
    if (parsed.error) error = parsed.error
    else disk = parsed.dirs
  } catch (err) {
    error = `could not read ${path}: ${String(err).slice(0, 80)}`
  }
  const held = await kept<DisabledDir[]>($, 'disabled', [])
  const disabled = Array.isArray(held) ? held : []
  const manifests: Record<string, ManifestInfo> = {}
  for (const row of listDirs(booted, disk, disabled, home)) {
    manifests[row.key] = await manifestOf($, row.dir, home)
  }
  const me = whoAmI($)
  const mods = derive(booted, disk, disabled, manifests, me.name, me.key, home)

  const rows = await $.config.list().catch(() => [])
  await update($, config, () => modConfig(rows, mods.map(one => one.name)))

  // the other four sections: one failure is a note on its section
  const notes: Partial<Record<ItemType, string>> = {}
  const user = settingsObject(raw)
  const others = await otherSettings($)
  const isWindows = sepFor(path, undefined) === ';'
  let root: string | undefined
  try {
    root = await $.session.root()
  } catch {
    root = undefined
  }
  if ((await read($, bootSettings)) === null) {
    const enabled = isPlain(user.enabledPlugins) ? Object.entries(user.enabledPlugins).filter(([, on]) => typeof on === 'boolean') : []
    await update($, bootSettings, () => ({ enabledPlugins: Object.fromEntries(enabled) as Record<string, boolean>, denied: denyInfo(user.deniedMcpServers, []).user }))
  }
  const plugins = await guarded(notes, 'plugin', async () => {
    const got = await listPlugins($, user, others, home, isWindows)
    if (got.note) notes.plugin = got.note
    return got.rows
  }, [] as PluginRow[])
  const skills = await guarded(notes, 'skill', () => listSkills($, dir, root, isPlain(user.skillOverrides) ? user.skillOverrides : {}), [] as SkillRow[])
  const hooks = await guarded(notes, 'hook', async () => [...parseHooks(user.hooks, 'user'), ...parseHooks(others.project.hooks, 'project'), ...parseHooks(others.local.hooks, 'local')] as HookRow[], [] as HookRow[])
  const mcp = await guarded(notes, 'mcp', async () => {
    const got = await listMcp($, dir, home, isExplicit, root)
    if (got.note) notes.mcp = got.note
    return got.rows
  }, [] as McpRow[])
  const loaded = await readCatalog($, dir)
  const cat = 'error' in loaded ? null : loaded.catalog
  await update($, catalog, () => cat)
  await update($, catalogError, () => ('error' in loaded ? loaded.error : null))
  const stash = await kept<HookStash[]>($, 'hookStash', [])
  const all = buildItems({
    mods, plugins, skills, hooks, mcp, stash: Array.isArray(stash) ? stash : [],
    denied: denyInfo(user.deniedMcpServers, [others.project.deniedMcpServers, others.local.deniedMcpServers, others.policy.deniedMcpServers]),
    boot: await read($, bootSettings), catalog: cat,
  })
  await update($, items, () => all)
  await update($, snapshot, () => ({ mods, settingsPath: path, readAt: now, ...(error ? { error } : {}), ...(Object.keys(notes).length > 0 ? { notes } : {}) }))
  const base = statusText(mods)
  const profile = cat?.active ? `profile ${cat.active.tag}` : undefined
  $.ui.status(base !== undefined ? (profile ? `${base} · ${profile}` : base) : profile ? `mods: ${profile}` : undefined)
}

type Written = { kind: 'wrote'; before: string[]; after: string[] } | { kind: 'same' } | { kind: 'failed'; reason: string }

/** Rewrite the dirs in settings.json: a fresh read, a backup, the write, a read back. */
async function writeDirs($: EngineInterface, change: (dirs: string[]) => string[]): Promise<Written> {
  const { path, home } = await where($)
  try {
    const raw = await $.fs.read(path)
    const me = whoAmI($)
    const sep = parseDirs(raw, path).sep
    const result = rewriteDirs(raw, change, { sep, selfKey: me.key, home })
    if (result.kind === 'same') return { kind: 'same' }
    if (result.kind === 'error') return { kind: 'failed', reason: result.reason }
    await $.fs.write(path.replace(/settings\.json$/, 'settings.json.mod-menu-backup'), raw)
    await $.fs.write(path, result.text)
    const back = parseDirs(await $.fs.read(path), path)
    if (back.error || back.dirs.join(sep) !== result.after.join(sep)) {
      return { kind: 'failed', reason: `settings.json changed on write, check it (backup: settings.json.mod-menu-backup)` }
    }
    return { kind: 'wrote', before: result.before, after: result.after }
  } catch (err) {
    return { kind: 'failed', reason: `could not write settings.json: ${String(err).slice(0, 100)}` }
  }
}

type Wrote = { kind: 'wrote'; before: string; after: string } | { kind: 'same' } | { kind: 'failed'; reason: string }

/**
 * Edit settings.json: a fresh read (no awaits before the rewrite), a backup,
 * the write, then a read back that parses and compares every edited path.
 * `build` gets the fresh text and returns the edits; the caller holds `isWriting`.
 */
async function writeSettings($: EngineInterface, build: (raw: string) => Edit[]): Promise<Wrote> {
  const { path } = await where($)
  try {
    const raw = await $.fs.read(path)
    const edits = build(raw)
    const result = rewriteKeys(raw, edits)
    if (result.kind === 'same') return { kind: 'same' }
    if (result.kind === 'error') return { kind: 'failed', reason: result.reason }
    await $.fs.write(path.replace(/settings\.json$/, 'settings.json.mod-menu-backup'), raw)
    await $.fs.write(path, result.text)
    const back = settingsObject(await $.fs.read(path))
    const want = settingsObject(result.text)
    if (!edits.every(edit => JSON.stringify(getPath(back, edit.path)) === JSON.stringify(getPath(want, edit.path)))) {
      return { kind: 'failed', reason: 'settings changed underneath — check settings.json' }
    }
    return { kind: 'wrote', before: raw, after: result.text }
  } catch (err) {
    return { kind: 'failed', reason: `could not write settings.json: ${String(err).slice(0, 100)}` }
  }
}

/** Run `fn` unless another write is under way. */
async function guard($: EngineInterface, fn: () => Promise<string>): Promise<string> {
  if (await read($, isWriting)) return 'mod-menu: busy writing settings, try again'
  await update($, isWriting, () => true)
  try {
    return await fn()
  } finally {
    await update($, isWriting, () => false)
  }
}

/** The machine this catalog entry is: a made-up id kept in the store, and the computer's name. */
async function machineOf($: EngineInterface): Promise<{ id: string; name: string }> {
  const held = await kept<{ id?: string; name?: string }>($, 'machine', {})
  const name = (await $.env.get('COMPUTERNAME')) ?? (await $.env.get('HOSTNAME')) ?? 'this machine'
  if (typeof held.id === 'string') return { id: held.id, name }
  const id = `${fnv8(`${name}:${await $.clock.now()}:${Math.random()}`)}${fnv8(String(Math.random()))}`
  await $.store.set('machine', { id, name })
  return { id, name }
}

/** Change loadout.json: a fresh read, `fn` on a copy, a backup, the write; nothing written when nothing changed or the file does not parse. */
async function updateCatalog($: EngineInterface, fn: (cat: Catalog, now: number) => void): Promise<{ error?: string }> {
  const { dir } = await where($)
  const loaded = await readCatalog($, dir)
  if ('error' in loaded) {
    await update($, catalogError, () => loaded.error)
    return { error: loaded.error }
  }
  const now = await $.clock.now()
  const next: Catalog = JSON.parse(JSON.stringify(loaded.catalog)) as Catalog
  fn(next, now)
  if (serializeCatalog(next, now) === serializeCatalog(loaded.catalog, now)) return {}
  next.updatedAt = now
  return saveCatalog($, dir, loaded.raw, next, now)
}

async function saveCatalog($: EngineInterface, dir: string, prev: string | undefined, next: Catalog, now: number): Promise<{ error?: string }> {
  try {
    if (prev !== undefined) await $.fs.write(`${dir}/loadout.json.bak`, prev)
    await $.fs.write(`${dir}/loadout.json`, serializeCatalog(next, now))
  } catch (err) {
    return { error: `could not write loadout.json: ${String(err).slice(0, 100)}` }
  }
  await update($, catalog, () => next)
  await update($, catalogError, () => null)
  return {}
}

/** Turn a mod on or off for the next session; resolves the text to say. */
async function toggleMod($: EngineInterface, mod: ModEntry, want?: 'on' | 'off'): Promise<string> {
  if (mod.isSelf) return `${mod.name}: this menu can't switch itself off; remove it by hand in settings.json`
  const wantOn = want === undefined ? !isListed(mod) : want === 'on'
  if (want !== undefined && wantOn === isListed(mod)) return `${mod.name}: already ${want}`
  if (await read($, isWriting)) return 'mod-menu: busy writing settings.json, try again'
  await update($, isWriting, () => true)
  try {
    const { home } = await where($)
    const stored = (await $.store.get('disabled')) as DisabledDir[] | undefined
    const disabled = Array.isArray(stored) ? stored : []
    const mine = disabled.find(one => norm(one.dir, home) === mod.key)
    const done = wantOn
      ? await writeDirs($, addDir(mine?.dir ?? mod.dir, mine?.after, home))
      : await writeDirs($, removeDir(mod.key, home))
    if (done.kind === 'failed') return `${mod.name}: not changed (${done.reason})`
    if (done.kind === 'wrote') {
      const others = disabled.filter(one => norm(one.dir, home) !== mod.key)
      if (wantOn) {
        await $.store.set('disabled', others)
      } else {
        const at = done.before.findIndex(one => norm(one, home) === mod.key)
        const entry: DisabledDir = { dir: mod.dir, name: mod.name, after: at > 0 ? done.before[at - 1] : undefined, at: await $.clock.now() }
        await $.store.set('disabled', [...others, entry])
      }
      await followCatalog($, [{ item: itemOfMod(await read($, items), mod), on: wantOn }])
    }
    const booted = (await read($, boot)) ?? []
    const now = done.kind === 'wrote' ? done.after.map(one => norm(one, home)) : []
    const isBack = done.kind === 'wrote' && sameDirs(now, booted)
    return toggleToast(mod.name, wantOn, isBack)
  } finally {
    await update($, isWriting, () => false)
    await refresh($)
  }
}

const itemOfMod = (list: LoadoutItem[], mod: ModEntry) => list.find(one => one.type === 'mod' && one.slug === mod.id)

type Change = { item: LoadoutItem | undefined; on: boolean }

/** A toggled item that is already in the catalog keeps the catalog's on/off in step. */
async function followCatalog($: EngineInterface, changes: Change[]) {
  const held = changes.filter((one): one is { item: LoadoutItem; on: boolean } => one.item?.inCatalog === true)
  if (held.length === 0) return
  await updateCatalog($, (cat, now) => {
    for (const { item, on } of held) {
      const was = cat.items[item.id]
      if (was) cat.items[item.id] = { ...was, on, updatedAt: now }
    }
  })
}

type Applied = { done: string[]; failed: string[]; restart: boolean; reload: boolean }

/**
 * Switch items on or off. Plugins go one at a time through the claude CLI
 * (the JSON edit only when it cannot start); everything else is ONE settings
 * write. The caller holds `isWriting`.
 */
async function applyChanges($: EngineInterface, changes: { item: LoadoutItem; on: boolean }[]): Promise<Applied> {
  const { path, home } = await where($)
  const exes = exesFor(sepFor(path, undefined) === ';')
  const out: Applied = { done: [], failed: [], restart: false, reload: false }
  const viaFile = changes.filter(one => one.item.type !== 'plugin')
  for (const one of changes.filter(one => one.item.type === 'plugin')) {
    const ran = await proc($, pluginToggleArgv(exes.claude, one.item.name, one.on), home, 30_000)
    if (ran === undefined) {
      viaFile.push(one)
      continue
    }
    const result = parsePluginResult(ran.stdout)
    if (result?.ok) {
      out.done.push(one.item.id)
      out.reload = true
    } else {
      out.failed.push(`${one.item.name}: ${firstLine(result?.message ?? ran.stderr) || 'claude plugin failed'}`)
    }
  }
  if (viaFile.length === 0) return out

  const disabled = await kept<DisabledDir[]>($, 'disabled', [])
  const prevs = await kept<Record<string, string>>($, 'skillPrev', {})
  const stash = await kept<HookStash[]>($, 'hookStash', [])
  const { mods } = await read($, snapshot)
  const now = await $.clock.now()
  const me = whoAmI($)
  const taken: { stash?: HookStash }[] = []
  const skipped = new Set<string>()
  const skillWas: Record<string, string | undefined> = {}

  const wrote = await writeSettings($, raw => {
    const edits: Edit[] = []
    const sep = parseDirs(raw, path).sep
    const current = settingsObject(raw)
    for (const { item, on } of viaFile) {
      if (item.type === 'mod') {
        const mod = mods.find(one => one.id === item.slug)
        if (!mod) {
          skipped.add(item.id)
          out.failed.push(`${item.name}: not in the list`)
          continue
        }
        const mine = disabled.find(one => norm(one.dir, home) === mod.key)
        edits.push(dirsEdit(on ? addDir(mine?.dir ?? mod.dir, mine?.after, home) : removeDir(mod.key, home), { sep, selfKey: me.key, home }))
      } else if (item.type === 'plugin') {
        edits.push(pluginEdit(item.name, on))
      } else if (item.type === 'skill') {
        const cur = isPlain(current.skillOverrides) ? current.skillOverrides[item.name] : undefined
        skillWas[item.name] = typeof cur === 'string' && cur !== 'off' ? cur : undefined
        edits.push(skillEdit(item.name, on, prevs[item.name]))
      } else if (item.type === 'hook') {
        if (on) {
          const held = stash.find(one => one.id === item.id)
          if (!held) {
            skipped.add(item.id)
            out.failed.push(`${item.label}: no local copy of this hook (hooks don't sync their commands)`)
            continue
          }
          edits.push(hookOnEdit(held))
        } else {
          const off = hookOffEdit(item.id, now)
          edits.push(off.edit)
          taken.push(off.out)
        }
      } else {
        edits.push(mcpEdit(item.name, on))
      }
    }
    return edits
  })
  const reached = viaFile.filter(one => !skipped.has(one.item.id))
  if (wrote.kind === 'failed') {
    out.failed.push(...reached.map(one => `${one.item.name}: ${wrote.reason}`).slice(0, 1))
    return out
  }
  for (const one of reached) {
    out.done.push(one.item.id)
    if (one.item.type === 'plugin') out.reload = true
    else if (one.item.apply === 'restart') out.restart = true
  }
  if (wrote.kind === 'wrote') {
    const before = parseDirs(wrote.before, path).dirs
    let nextDisabled = disabled
    const nextPrevs = { ...prevs }
    let nextStash = stash
    for (const { item, on } of reached) {
      if (item.type === 'mod') {
        const mod = mods.find(one => one.id === item.slug)!
        nextDisabled = nextDisabled.filter(one => norm(one.dir, home) !== mod.key)
        if (!on) {
          const at = before.findIndex(one => norm(one, home) === mod.key)
          nextDisabled = [...nextDisabled, { dir: mod.dir, name: mod.name, after: at > 0 ? before[at - 1] : undefined, at: now }]
        }
      } else if (item.type === 'skill') {
        if (on) delete nextPrevs[item.name]
        else if (skillWas[item.name] !== undefined) nextPrevs[item.name] = skillWas[item.name]!
      } else if (item.type === 'hook') {
        nextStash = nextStash.filter(one => one.id !== item.id)
      }
    }
    for (const one of taken) if (one.stash) nextStash = [...nextStash.filter(held => held.id !== one.stash!.id), one.stash]
    await $.store.set('disabled', nextDisabled)
    await $.store.set('skillPrev', nextPrevs)
    await $.store.set('hookStash', nextStash)
  }
  return out
}

/** What a toggle of a non-mod item says. */
const toggleText = (item: LoadoutItem, wantOn: boolean) =>
  `${item.name}: ${wantOn ? 'on' : 'off'} — ${item.apply === 'live' ? 'applied now' : item.apply === 'reload' ? 'run /reload-plugins to apply' : 'restart Claude Code to apply'}`

/** Switch one non-mod item; resolves the text to say. */
async function toggleItem($: EngineInterface, item: LoadoutItem, want?: 'on' | 'off'): Promise<string> {
  if (item.isLocked) return `${item.name}: locked (${item.lockReason ?? 'cannot be changed here'})`
  const wantOn = want === undefined ? effective(item) === 'off' : want === 'on'
  if (want !== undefined && wantOn === (effective(item) === 'on')) return `${item.name}: already ${want}`
  const said = await guard($, async () => {
    const done = await applyChanges($, [{ item, on: wantOn }])
    if (done.failed.length > 0) return `${item.name}: not changed (${done.failed[0]})`
    await followCatalog($, [{ item, on: wantOn }])
    return toggleText(item, wantOn)
  })
  await refresh($)
  return said
}

/** Replace an item's tags in the catalog. */
async function setTags($: EngineInterface, item: LoadoutItem, tags: string[]): Promise<string> {
  const done = await updateCatalog($, (cat, now) => {
    const was = cat.items[item.id]
    cat.items[item.id] = { tags, on: was && !was.deleted ? was.on : effective(item) === 'on', ...(was?.note !== undefined ? { note: was.note } : {}), updatedAt: now }
    for (const tag of tags) if (cat.profiles[tag] === undefined || cat.profiles[tag]!.deleted) cat.profiles[tag] = { updatedAt: now }
  })
  await refresh($)
  if (done.error) return done.error
  return tags.length > 0 ? `${item.id}: tags ${tags.join(', ')}` : `${item.id}: tags cleared`
}

/** Apply a plan: plugins through the CLI, one settings write for the rest, then the catalog. */
async function applyPlan($: EngineInterface, planned: ProfilePlan): Promise<string> {
  if (planned.on.length + planned.off.length === 0 && planned.tag === '') return planned.text
  const said = await guard($, async () => {
    const list = await read($, items)
    const changes = [
      ...planned.on.map(id => ({ item: list.find(one => one.id === id)!, on: true })),
      ...planned.off.map(id => ({ item: list.find(one => one.id === id)!, on: false })),
    ].filter(one => one.item !== undefined)
    const done = await applyChanges($, changes)
    const me = await machineOf($)
    const wrote = await updateCatalog($, (cat, now) => {
      for (const one of changes) {
        const was = cat.items[one.item.id]
        if (was && done.done.includes(one.item.id)) cat.items[one.item.id] = { ...was, on: one.on, updatedAt: now }
      }
      if (planned.tag !== '') {
        cat.active = { tag: planned.tag, at: now }
        cat.profiles[planned.tag] = { ...(cat.profiles[planned.tag] ?? {}), updatedAt: now }
      }
      cat.machines[me.id] = { name: me.name, seenAt: now, missing: planned.missing }
    })
    return appliedText(planned.text, done.restart, done.reload, [...done.failed, ...(wrote.error ? [wrote.error] : [])])
  })
  await refresh($)
  return said
}

/** gh's login state; never stores gh's text or any token. */
async function checkGh($: EngineInterface): Promise<GhStatus> {
  const { path, home } = await where($)
  await update($, gh, () => ({ kind: 'checking', checkedAt: 0 }))
  const ran = await proc($, ghAuthArgv(exesFor(sepFor(path, undefined) === ';').gh), home, 10_000)
  const checkedAt = await $.clock.now()
  const status: GhStatus = ran === undefined ? { kind: 'missing', checkedAt } : { ...parseAuthStatus(ran.exitCode, `${ran.stdout}\n${ran.stderr}`), checkedAt }
  await update($, gh, () => status)
  return status
}

type SyncHold = { gistId?: string; owner?: string; remoteUpdatedAt?: string; lastSyncAt?: number }

/** /mod-menu sync, pull and push, all through `gh api` with the JSON on stdin. */
async function runSync($: EngineInterface, op: 'sync' | 'pull' | 'push', isForce: boolean, isRelink: boolean): Promise<string> {
  if ((await read($, sync)).kind === 'busy') return 'sync: already running'
  await update($, sync, (): SyncState => ({ kind: 'busy', op }))
  let text: string
  let isOk = false
  try {
    const got = await syncOnce($, op, isForce, isRelink)
    text = got.text
    isOk = got.isOk
  } catch (err) {
    text = `sync failed: ${firstLine(String(err)).slice(0, 100)}`
  }
  const at = await $.clock.now()
  await update($, sync, () => ({ kind: isOk ? 'ok' : 'error', op, message: text, at }) as SyncState)
  await refresh($)
  if (isOk && op !== 'push') {
    const differ = (await read($, items)).filter(one => one.drift).length
    text += differ > 0 ? ` · ${differ} item${differ === 1 ? '' : 's'} differ here — /mod-menu apply` : ' · everything matches here'
  }
  return text
}

async function syncOnce($: EngineInterface, op: 'sync' | 'pull' | 'push', isForce: boolean, isRelink: boolean): Promise<{ text: string; isOk: boolean }> {
  const fail = (text: string) => ({ text, isOk: false })
  const { path, dir, home } = await where($)
  const exes = exesFor(sepFor(path, undefined) === ';')
  const status = await checkGh($)
  if (status.kind === 'missing') return fail('sync unavailable: install gh (https://cli.github.com)')
  if (status.kind === 'logged-out') return fail('gh is not logged in: run gh auth login --web, then /mod-menu sync')
  if (status.kind !== 'ok' || status.login === undefined) return fail(status.message ?? 'could not read gh auth status')

  let held = await kept<SyncHold>($, 'sync', {})
  if (isRelink) {
    held = { ...(held.lastSyncAt !== undefined ? { lastSyncAt: held.lastSyncAt } : {}) }
    await $.store.set('sync', held)
  }
  if (held.owner !== undefined && held.owner !== status.login) {
    return fail(`gh is logged in as ${status.login}; this loadout syncs as ${held.owner}. Run "gh auth switch" or /mod-menu sync --relink`)
  }
  const call = (argv: string[], stdin?: string) => proc($, argv, home, 30_000, stdin)
  const refuse = (what: string, ran: Ran | undefined) => fail(ran === undefined ? 'sync unavailable: gh could not run' : `${what}: ${firstLine(ran.stderr) || `exit ${ran.exitCode}`}`)

  // where the gist is: remembered, else found by its description
  let id = held.gistId
  let first: Ran | undefined
  if (id !== undefined) {
    first = await call(gistGetArgv(exes.gh, id))
    if (first === undefined) return refuse('sync', first)
    if (first.exitCode !== 0) {
      if (!/not found|404/i.test(`${first.stderr}${first.stdout}`)) return refuse('could not read the gist', first)
      held = { ...held }
      delete held.gistId
      await $.store.set('sync', held)
      id = undefined
      first = undefined
    }
  }
  if (id === undefined) {
    const found = await call(gistFindArgv(exes.gh))
    if (found === undefined) return refuse('sync', found)
    if (found.exitCode === 0) id = found.stdout.split(/\r?\n/).map(one => one.trim()).find(Boolean)
    else {
      // the jq filter may not survive this platform's argv quoting: filter the list here instead
      const listed = await call(gistListArgv(exes.gh))
      if (listed === undefined || listed.exitCode !== 0) return refuse('could not list gists', listed)
      id = findGist(listed.stdout)
    }
  }

  const loaded = await readCatalog($, dir)
  if ('error' in loaded) return fail(loaded.error)
  const now = await $.clock.now()
  const content = (cat: Catalog) => serializeCatalog(cat, now)

  if (id === undefined) {
    if (op === 'pull') return fail('no synced loadout found: run /mod-menu sync to create one')
    const made = await call(gistPostArgv(exes.gh), gistPostBody(content(loaded.catalog)))
    if (made === undefined || made.exitCode !== 0) return refuse('could not create the gist', made)
    const reply = parseGistReply(made.stdout)
    if (reply.id === undefined) return fail('could not create the gist: no id came back')
    await $.store.set('sync', { gistId: reply.id, owner: status.login, ...(reply.updatedAt ? { remoteUpdatedAt: reply.updatedAt } : {}), lastSyncAt: now })
    return { text: 'Created a secret gist for your loadout', isOk: true }
  }

  const fetchRemote = async (reuse?: Ran) => {
    const ran = reuse ?? (await call(gistGetArgv(exes.gh, id!)))
    if (ran === undefined || ran.exitCode !== 0) return refuse('could not read the gist', ran)
    const gist = parseGist(ran.stdout)
    if ('error' in gist) return fail(gist.error)
    if (gist.isTruncated) return fail('the gist is too big to read whole')
    const parsed = parseCatalog(gist.content)
    if ('error' in parsed) return fail(`the synced loadout does not parse: ${parsed.error}`)
    return { catalog: parsed.catalog, updatedAt: gist.updatedAt }
  }
  let remote = await fetchRemote(first)
  if ('text' in remote) return remote
  const keep = async (updatedAt: string | undefined, text: string) => {
    await $.store.set('sync', { gistId: id, owner: status.login, ...(updatedAt ? { remoteUpdatedAt: updatedAt } : {}), lastSyncAt: now })
    return { text, isOk: true }
  }
  const patch = async (cat: Catalog) => {
    const ran = await call(gistPatchArgv(exes.gh, id!), gistPatchBody(content(cat)))
    if (ran === undefined || ran.exitCode !== 0) return refuse('could not update the gist', ran)
    return { updatedAt: parseGistReply(ran.stdout).updatedAt ?? (remote as { updatedAt: string }).updatedAt }
  }

  if (op === 'push') {
    if (remote.updatedAt !== held.remoteUpdatedAt && !isForce) return fail('remote changed since your last sync: run /mod-menu sync, or push --force')
    const sent = await patch(loaded.catalog)
    return 'text' in sent ? sent : keep(sent.updatedAt, 'pushed')
  }

  let merged = mergeCatalogs(loaded.catalog, remote.catalog)
  const writeLocal = async () => {
    if (content(merged) === content(loaded.catalog)) return undefined
    return (await saveCatalog($, dir, loaded.raw, merged, now)).error
  }
  const wroteErr = await writeLocal()
  if (wroteErr) return fail(wroteErr)
  if (op === 'pull') return keep(remote.updatedAt, 'pulled')
  if (content(merged) === content(remote.catalog)) return keep(remote.updatedAt, 'synced')

  // the remote may have moved while we merged: one more look
  const again = await fetchRemote()
  if ('text' in again) return again
  if (again.updatedAt !== remote.updatedAt) {
    remote = again
    merged = mergeCatalogs(loaded.catalog, remote.catalog)
    const second = (content(merged) === content(loaded.catalog)) ? undefined : (await saveCatalog($, dir, loaded.raw, merged, now)).error
    if (second) return fail(second)
  }
  const sent = await patch(merged)
  return 'text' in sent ? sent : keep(sent.updatedAt, 'synced')
}

/** The mod a command's name or id points at. */
async function modNamed($: EngineInterface, name: string): Promise<ModEntry | undefined> {
  const { mods } = await read($, snapshot)
  const want = name.trim().toLowerCase()
  return mods.find(one => one.id === want || one.name.toLowerCase() === want)
}

/** Change one of a mod's settings now. */
async function setConfig($: EngineInterface, row: ModConfigRow, value: boolean | string | number) {
  try {
    const result = await $.config.set({ key: row.key, value })
    if ('deny' in result && result.deny !== undefined) $.ui.toast(`${row.key}: ${result.deny}`)
    else $.ui.toast(`${row.plugin} ${row.label} → ${String(value)} (applied now)`)
  } catch (err) {
    $.ui.toast(`${row.key}: not changed (${String(err).slice(0, 100)})`)
  }
  await refresh($)
}

/** The ids on a plan, for the dry-run text. */
const planLines = (planned: ProfilePlan) =>
  [planned.on.length > 0 ? `  on: ${planned.on.join(', ')}` : '', planned.off.length > 0 ? `  off: ${planned.off.join(', ')}` : '', planned.locked.length > 0 ? `  locked: ${planned.locked.join(', ')}` : '']
    .filter(Boolean)
    .join('\n')

/** Opens the workbench dock from this dispatch when the workbench mod is loaded; harmless if it already is. */
async function ensureDock($: EngineInterface) {
  try {
    const hasBench = (await $.command.list()).some(one => one.name === BENCH)
    if (hasBench) await $.ui.open({ id: BENCH, title: 'Workbench', focus: true })
  } catch {
    // no command list on this surface, or the dock refused: the hosted open below still runs
  }
}

/** Shows a mod's pane by running the mod's own command: the dock opens first so the pane seats at any width. */
async function showPane($: EngineInterface, mod: ModEntry) {
  const command = showCommand(mod)
  if (command === undefined) return
  await ensureDock($)
  try {
    if (!(await $.command.list()).some(one => one.name === command)) {
      $.ui.toast(`mod-menu: /${command} is not registered; is ${mod.name} loaded?`)
      return
    }
    await $.command.run({ command, args: '' })
  } catch (err) {
    $.ui.toast(`mod-menu: could not show ${mod.name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function runCommand($: EngineInterface, args: string | undefined) {
  const cmd = parseCommand(args)
  if (cmd.kind === 'error') return { text: cmd.text }
  if (cmd.kind === 'gh') {
    const status = await checkGh($)
    return { text: ghText(status, { kind: 'idle' }, undefined, 0) }
  }
  if (cmd.kind === 'sync') return { text: await runSync($, cmd.op, cmd.isForce, cmd.isRelink) }
  await refresh($)
  const { mods, error } = await read($, snapshot)
  const all = await read($, items)
  const bad = await read($, catalogError)
  if (cmd.kind === 'list') {
    const rest = all.filter(one => one.type !== 'mod')
    return { text: `${listText(mods)}${rest.length > 0 ? `\n${itemsText(rest)}` : ''}${error ? `\n${error}` : ''}` }
  }
  if (cmd.kind === 'toggle') {
    const found = resolveId(all.map(one => one.id), cmd.ref)
    if ('error' in found) return { text: found.error }
    const item = all.find(one => one.id === found.id)!
    const mod = item.type === 'mod' ? mods.find(one => one.id === item.slug) : undefined
    const said = mod ? await toggleMod($, mod, cmd.want) : await toggleItem($, item, cmd.want)
    $.ui.toast(said)
    return { text: said }
  }
  if (cmd.kind === 'tag') {
    const found = resolveId(all.map(one => one.id), cmd.ref)
    if ('error' in found) return { text: found.error }
    if (bad) return { text: bad }
    return { text: await setTags($, all.find(one => one.id === found.id)!, cmd.tags) }
  }
  if (cmd.kind === 'forget') {
    const cat = await read($, catalog)
    const found = resolveId(Object.keys(cat?.items ?? {}), cmd.ref)
    if ('error' in found) return { text: found.error }
    const done = await updateCatalog($, (next, now) => {
      next.items[found.id] = { tags: [], on: false, updatedAt: now, deleted: true }
    })
    await refresh($)
    return { text: done.error ?? `${found.id}: forgotten (a tombstone syncs the removal)` }
  }
  if (cmd.kind === 'use' || cmd.kind === 'apply') {
    if (bad) return { text: bad }
    const cat = await read($, catalog)
    const planned = cmd.kind === 'use' ? planProfile(all, cat, cmd.tag) : planReconcile(all, cat)
    if (cmd.kind === 'use' && cmd.isDryRun) return { text: `${planned.text}${planLines(planned) ? `\n${planLines(planned)}` : ''}\n(dry run: nothing changed)` }
    if (cmd.kind === 'use' && planned.text.startsWith('no items tagged')) return { text: planned.text }
    const said = await applyPlan($, { ...planned, isDryRun: false })
    $.ui.toast(said)
    return { text: said }
  }
  // The workbench hosts this pane by opening its own dock from inside a ui.open
  // hook, and the engine counts that nested open as unasked (144-column floor).
  // Opening the dock here, from the person's command, counts as asked and seats
  // at any width; the hosted open then lands in an already-open dock.
  await ensureDock($)
  const placed = await $.ui.open({ id: PANE, title: TITLE, focus: true })
  const why = placed.isPlaced ? '' : `\nThe pane is waiting: ${placed.reason ?? 'no room for it yet'}. Try /workbench first.`
  return { text: `Mods pane opened. ${headerText(mods)}\n${listText(mods)}${why}` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'mod-menu',
      description: 'Manage mods, plugins, skills, hooks and MCP servers: tags, profiles, sync',
      argumentHint: HINT,
    })
    // /mods is an alias; it may be a built-in name, which the engine refuses
    try {
      await $.command.register({
        name: 'mods',
        description: 'Manage mods, plugins, skills, hooks and MCP servers: tags, profiles, sync',
        argumentHint: HINT,
      })
    } catch {
      // keep /mod-menu alone
    }
    await ensureBoot($)
    void refresh($)
    void checkGh($)

    return started
  })

  on('command.run', { command: 'mod-menu' }, async ($, e) => runCommand($, e.args))
  on('command.run', { command: 'mods' }, async ($, e) => runCommand($, e.args))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e))

  // Inside the workbench: fill this pane's slot in its frame.
  on('ui.render', { component: 'Pane', requestId: BENCH }, async ($, e, next) => {
    const frame = await next(e)
    const slot = slotOf(frame, PANE)
    return slot ? fillSlot(frame, PANE, await drawPane($, inSlot(e, slot.columns))) : frame
  })
}

/** The pane's drawing, in its own pane or in a workbench slot. */
async function drawPane($: EngineInterface, e: RenderInput<'Pane'>) {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button } = elements
  // mobile draws no Input or Select: a value there is shown, and changed in /config
  const Input = 'Input' in elements ? elements.Input : undefined
  const Select = 'Select' in elements ? elements.Select : undefined
  const snap = await read($, snapshot)
  const rows = await read($, config)
  const pick = await read($, selected)
  const all = await read($, items)
  const cat = await read($, catalog)
  const catErr = await read($, catalogError)
  const github = await read($, gh)
  const syncing = await read($, sync)
  const shut = await read($, collapsed)
  const editId = await read($, editing)
  const planned = await read($, plan)
  const hold = await kept<{ lastSyncAt?: number }>($, 'sync', {})
  const now = await $.clock.now()
  const columns = Math.max(30, e.props.bodyColumns || 60)
  const { mods } = snap
  const pending = counts(mods).pending

  const toggleable = mods.filter(one => !one.isSelf)

  const configRow = (mod: ModEntry, row: ModConfigRow, letter: string | undefined) => {
    const id = `${row.plugin}-${row.field}`
    const note = row.description ? <Text dimColor wrap="truncate">{clip(`  ${row.description}`, columns - 24)}</Text> : null
    let control
    if (row.isLocked) {
      control = <Text dimColor>{`${row.label}  ${String(row.value)}  locked`}</Text>
    } else if (Array.isArray(row.value)) {
      control = <Text dimColor>{`${row.label}  ${row.value.join(', ')}  (edit in /config)`}</Text>
    } else if (row.kind === 'boolean' && typeof row.value === 'boolean') {
      control = (
        <Button key={`cfg-${id}`} hotkey={letter} onPress={() => void setConfig($, row, !row.value)}>
          {`${row.value ? 'on ' : 'off'} ${row.label}`}
        </Button>
      )
    } else if (row.kind === 'choice' && Select) {
      control = (
        <Select
          key={`cfg-${id}`}
          label={row.label}
          options={(row.options ?? []).map(value => ({ value, label: value }))}
          value={String(row.value)}
          onSelect={(value: string) => void setConfig($, row, value)}
        />
      )
    } else if (row.kind === 'choice') {
      const options = row.options ?? []
      const nextOne = options[(options.indexOf(String(row.value)) + 1) % Math.max(1, options.length)]
      control = (
        <Button key={`cfg-${id}`} onPress={() => nextOne !== undefined && void setConfig($, row, nextOne)}>
          {`${row.label}: ${String(row.value)}`}
        </Button>
      )
    } else if ((row.kind === 'number' || row.kind === 'text') && Input) {
      control = (
        <Input
          key={`cfg-${id}`}
          label={row.label}
          value={String(row.value)}
          submitLabel="Apply"
          onSubmit={(text: string) => {
            if (row.kind === 'text') return void setConfig($, row, text)
            const n = Number(text)
            if (text.trim() === '' || !Number.isFinite(n)) return void $.ui.toast(`${row.key}: "${text}" is not a number`)
            void setConfig($, row, n)
          }}
        />
      )
    } else {
      control = <Text dimColor>{`${row.label}  ${String(row.value)}  (change with /config)`}</Text>
    }
    return (
      <Box key={`cfgrow-${id}`} flexDirection="row">
        {control}
        {note}
      </Box>
    )
  }

  /** The tags line of an open detail, with the button and field that change them. */
  const tagEditor = (item: LoadoutItem) => {
    const key = `${item.type}-${item.slug}`
    const isEditing = editId === item.id
    return (
      <Box key={`tagrow-${key}`} flexDirection="column">
        <Box key={`taglist-${key}`} flexDirection="row">
          <Text dimColor>{`tags: ${item.tags.length > 0 ? item.tags.join(', ') : 'none'}${item.drift ? '  · differs from the catalog' : ''}  `}</Text>
          {Input ? (
            <Button key={`tagbtn-${key}`} hotkey="t" onPress={() => void update($, editing, id => (id === item.id ? null : item.id))}>
              Edit tags
            </Button>
          ) : (
            <Text dimColor>{`edit tags with /mod-menu tag ${item.id} …`}</Text>
          )}
        </Box>
        {Input && isEditing && (
          <Input
            key={`tagedit-${key}`}
            label="tags"
            placeholder="work, personal (- clears)"
            value={item.tags.join(', ')}
            autoFocus
            submitLabel="save"
            onSubmit={(text: string) => {
              const parsed = parseTags(text)
              if ('error' in parsed) return void $.ui.toast(parsed.error)
              void update($, editing, () => null)
              void setTags($, item, parsed.tags).then(said => $.ui.toast(said))
            }}
          />
        )}
      </Box>
    )
  }

  const detail = (mod: ModEntry, item: LoadoutItem | undefined) => {
    const own = rows.filter(row => row.plugin === mod.name)
    const isLoaded = mod.state === 'on' || mod.state === 'turning-off'
    let letters = 0
    return (
      <Box key={`detail-${mod.id}`} flexDirection="column" marginLeft={6}>
        {mod.description && <Text dimColor wrap="truncate">{clip(mod.description, columns - 8)}</Text>}
        <Text dimColor wrap="truncate">{clip(`${mod.dir}${mod.listed > 1 ? `  (listed ${mod.listed}×, off removes all)` : ''}`, columns - 8)}</Text>
        {mod.note && <Text color="yellow" wrap="truncate">{NOTES[mod.note]}</Text>}
        {mod.isWorkbench && <Text dimColor>hosted panes open as their own tabs</Text>}
        {!isLoaded && <Text dimColor>settings appear when it is loaded</Text>}
        {isLoaded && own.length === 0 && <Text dimColor>no settings</Text>}
        {isLoaded &&
          own.map(row => {
            const letter = row.kind === 'boolean' && !row.isLocked ? LETTERS[letters++] : undefined
            return configRow(mod, row, letter)
          })}
        {isLoaded && own.length > 0 && <Text dimColor>settings apply now · locked rows show "locked"</Text>}
        {item && tagEditor(item)}
      </Box>
    )
  }

  const tagsCell = (item: LoadoutItem | undefined, key: string) => (
    <Box key={key} flexDirection="row">
      <Text dimColor wrap="truncate">{item && item.tags.length > 0 ? item.tags.join(',') : ' '}</Text>
    </Box>
  )

  const line = (mod: ModEntry) => {
    const item = itemOfMod(all, mod)
    const itemKey = item?.id ?? itemId('mod', mod.id)
    const isOpen = pick === itemKey
    const at = toggleable.indexOf(mod)
    const hotkey = at >= 0 ? HOTKEYS[at] : undefined
    const isPending = mod.state === 'turning-off' || mod.state === 'turning-on'
    const label = `${isOpen ? '▾' : '▸'} ${mod.name}${mod.version ? ` ${mod.version}` : ''}`
    const tone = isPending ? { color: 'yellow' } : { dimColor: mod.state === 'off' || mod.note !== undefined }
    const show = showCommand(mod)
    const room = Math.max(8, columns - label.length - 16 - (show !== undefined ? 6 : 0))

    return (
      <Box key={`mod-${mod.id}`} flexDirection="column">
        <Box key={`line-${mod.id}`} flexDirection="row">
          {mod.isSelf ? (
            <Text dimColor>{'  ●  '}</Text>
          ) : (
            <Button
              key={`toggle-${mod.id}`}
              hotkey={hotkey}
              {...(isPending ? { variant: 'primary' as const } : {})}
              onPress={() => void toggleMod($, mod).then(said => $.ui.toast(said))}
            >
              {isListed(mod) ? 'on ' : 'off'}
            </Button>
          )}
          <Text> </Text>
          <Button
            key={`row-${mod.id}`}
            plain
            dimColor={mod.state === 'off'}
            onPress={() => void update($, selected, id => (id === itemKey ? null : itemKey))}
          >
            {label}
          </Button>
          <Text>  </Text>
          {show !== undefined && (
            <Button key={`show-${mod.id}`} {...(isOpen ? { hotkey: 'o' } : {})} onPress={() => void showPane($, mod)}>
              show
            </Button>
          )}
          {show !== undefined && <Text>  </Text>}
          {tagsCell(item, `tags-mod-${mod.id}`)}
          <Text>  </Text>
          <Box key={`state-${mod.id}`} flexDirection="row">
            <Text {...tone} wrap="truncate">{clip(stateText(mod), room)}</Text>
          </Box>
        </Box>
        {isOpen && detail(mod, item)}
      </Box>
    )
  }

  /** A plugin, skill, hook or MCP row. */
  const itemLine = (item: LoadoutItem) => {
    const key = `${item.type}-${item.slug}`
    const isOpen = pick === item.id
    const isPending = item.pending !== undefined
    const label = `${isOpen ? '▾' : '▸'} ${item.label}`
    const tags = item.tags.join(',')
    const room = Math.max(8, columns - label.length - tags.length - 16)
    const tone = isPending ? { color: 'yellow' } : { dimColor: effective(item) === 'off' || item.isLocked }

    return (
      <Box key={key} flexDirection="column">
        <Box key={`line-${key}`} flexDirection="row">
          {item.isLocked ? (
            <Box key={`lock-${key}`} flexDirection="row">
              <Text dimColor>{effective(item) === 'on' ? '[ on ]' : '[off ]'}</Text>
            </Box>
          ) : (
            <Button
              key={`toggle-${key}`}
              {...(isPending ? { variant: 'primary' as const } : {})}
              onPress={() => void toggleItem($, item).then(said => $.ui.toast(said))}
            >
              {effective(item) === 'on' ? 'on ' : 'off'}
            </Button>
          )}
          <Text> </Text>
          <Button key={`row-${key}`} plain dimColor={effective(item) === 'off'} onPress={() => void update($, selected, id => (id === item.id ? null : item.id))}>
            {label}
          </Button>
          <Text>  </Text>
          {tagsCell(item, `tags-${key}`)}
          <Text>  </Text>
          <Box key={`state-${key}`} flexDirection="row">
            <Text {...tone} wrap="truncate">{clip(itemStateText(item), room)}</Text>
          </Box>
        </Box>
        {isOpen && (
          <Box key={`detail-${key}`} flexDirection="column" marginLeft={6}>
            <Text dimColor wrap="truncate">{clip(item.id, columns - 8)}</Text>
            {item.description && <Text dimColor wrap="truncate">{clip(item.description, columns - 8)}</Text>}
            {item.isLocked && <Text color="yellow" wrap="truncate">{item.lockReason ?? 'locked'}</Text>}
            {item.note && <Text dimColor wrap="truncate">{item.note}</Text>}
            {tagEditor(item)}
          </Box>
        )}
      </Box>
    )
  }

  const section = (type: ItemType) => {
    const list = all.filter(one => one.type === type)
    const isShut = shut.includes(type)
    const on = list.filter(one => effective(one) === 'on').length
    const off = list.length - on
    const waiting = list.filter(one => one.pending !== undefined).length
    const summary =
      type === 'mod'
        ? headerText(mods)
        : `${list.length}${list.length > 0 ? ` · ${on} on${off > 0 ? ` · ${off} off` : ''}${waiting > 0 ? ` · ${waiting} pending` : ''}` : ''}`
    const note = snap.notes?.[type]
    const empty = type === 'hook' ? 'no hooks in ~/.claude/settings.json' : 'none found'
    return (
      <Box key={`section-${type}`} flexDirection="column">
        <Button key={`sec-${type}`} plain onPress={() => void update($, collapsed, held => (held.includes(type) ? held.filter(one => one !== type) : [...held, type]))}>
          {`${isShut ? '▸' : '▾'} ${TITLES[type]} ${summary}`}
        </Button>
        {note && <Text dimColor wrap="truncate">{clip(`  ${note}`, columns)}</Text>}
        {!isShut && type === 'mod' && mods.length === 0 && (
          <Box key="empty" flexDirection="column">
            <Text dimColor>No mods are listed in CLAUDE_CODE_PLUGIN_DIRS.</Text>
          </Box>
        )}
        {!isShut && type === 'mod' && mods.map(line)}
        {!isShut && type !== 'mod' && list.length === 0 && <Text dimColor>{`  ${empty}`}</Text>}
        {!isShut && type !== 'mod' && list.map(itemLine)}
      </Box>
    )
  }

  const profiles = [...new Set([...Object.keys(cat?.profiles ?? {}).filter(tag => !cat?.profiles[tag]?.deleted), ...all.flatMap(one => one.tags)])].sort()
  const preview = (tag: string) => {
    void update($, plan, () => planProfile(all, cat, tag))
  }

  return (
    <Box flexDirection="column">
      <Box key="head" flexDirection="row">
        <Text bold color="#D97757">MOD MENU </Text>
        <Text>{headerText(mods)}</Text>
        <Text>   </Text>
        <Button key="sync" hotkey="s" onPress={() => void runSync($, 'sync', false, false).then(said => $.ui.toast(said))}>
          Sync
        </Button>
        <Button key="refresh" hotkey="r" onPress={() => void refresh($)}>
          Refresh
        </Button>
        <Button key="close" role="dismiss" hotkey="q" onPress={() => void $.ui.close({ id: PANE })}>
          Close
        </Button>
      </Box>
      <Box key="gh" flexDirection="row">
        <Text dimColor wrap="truncate">{clip(ghText(github, syncing, hold.lastSyncAt, now), columns)}</Text>
      </Box>
      {snap.error && (
        <Box key="error" flexDirection="column">
          <Text color="red" wrap="truncate">{clip(snap.error, columns)}</Text>
          <Text dimColor>Toggling is refused until settings.json parses.</Text>
        </Box>
      )}
      {catErr && (
        <Box key="catalog-error" flexDirection="column">
          <Text color="red" wrap="truncate">{clip(catErr, columns)}</Text>
          <Text dimColor>Tags, profiles and sync are refused until loadout.json parses.</Text>
        </Box>
      )}
      <Box key="profiles" flexDirection="row">
        <Text>Profile: </Text>
        {profiles.map(tag => (
          <Button key={`profile-${tag}`} {...(cat?.active?.tag === tag ? { variant: 'primary' as const } : {})} onPress={() => preview(tag)}>
            {tag}
          </Button>
        ))}
        <Button key="profile-all" onPress={() => preview('all')}>
          all
        </Button>
        <Text dimColor>{cat?.active ? `  active: ${cat.active.tag}` : ''}</Text>
      </Box>
      {planned && (
        <Box key="plan" flexDirection="row">
          <Text wrap="truncate">{clip(`→ ${planned.text}`, columns - 18)}</Text>
          {planned.on.length + planned.off.length > 0 && (
            <Button
              key="plan-apply"
              hotkey="y"
              variant="primary"
              onPress={() => {
                void update($, plan, () => null)
                void applyPlan($, { ...planned, isDryRun: false }).then(said => $.ui.toast(said))
              }}
            >
              Apply
            </Button>
          )}
          <Button key="plan-cancel" hotkey="n" onPress={() => void update($, plan, () => null)}>
            Cancel
          </Button>
        </Box>
      )}
      {TYPES.map(section)}
      <Box key="restart-note" flexDirection="column">
        {pending > 0 ? (
          <Text color="yellow" wrap="truncate">{`⟳ Restart Claude Code to apply ${pending} mod change${pending === 1 ? '' : 's'}. Settings changes apply now.`}</Text>
        ) : (
          <Text dimColor>Mod on/off applies next session. Settings changes apply now.</Text>
        )}
      </Box>
    </Box>
  )
}
