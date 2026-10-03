import type { ApplyWhen, Catalog, CatalogItem, CatalogMachine, CatalogProfile, GhStatus, HookStash, ItemType, LoadoutItem, ModEntry, ProfilePlan, SyncState, Tier } from '../types'
import { NOTES, slug as modSlug } from './mods'

// Pure logic of the loadout: item ids, the tag catalog and its merge, profile
// plans, the gh and claude CLI argv and their parsers, the command grammar and
// the texts. Nothing here touches `$`; register.tsx runs the processes and
// the file reads and passes strings and objects in.

type Json = Record<string, unknown>
const isPlain = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined)

export const TYPES: ItemType[] = ['mod', 'plugin', 'skill', 'hook', 'mcp']
export const TITLES: Record<ItemType, string> = { mod: 'Mods', plugin: 'Plugins', skill: 'Skills', hook: 'Hooks', mcp: 'MCP' }
/** Whether a skillOverrides edit applies mid-session is unverified: set this to 'restart' if it does not. */
export const SKILL_APPLY: ApplyWhen = 'live'
export const DESC = 'claude-loadout (mod-menu)'
export const FILE = 'loadout.json'
const DAY = 86_400_000

// ---------- ids ----------

/** FNV-1a, 32 bits, as 8 hex digits. */
export function fnv8(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

const sorted = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(sorted) : isPlain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value

/** `hook:<Event>:<matcher|*>:<fnv8>`: the hash is of the command with its whitespace squeezed, or of the sorted definition. */
export function hookId(event: string, matcher: string | undefined, def: Json): string {
  const body = typeof def.command === 'string' ? def.command.trim().replace(/\s+/g, ' ') : JSON.stringify(sorted(def))
  return `hook:${event}:${matcher === undefined || matcher === '' ? '*' : matcher}:${fnv8(body)}`
}

export const itemId = (type: ItemType, name: string) => `${type}:${name}`

/** The type and name an id spells; a type that is not one of ours leaves the whole as the name of a bare item. */
export function splitId(id: string): { type: ItemType | undefined; name: string } {
  const at = id.indexOf(':')
  const head = at > 0 ? id.slice(0, at) : ''
  const type = TYPES.find(one => one === head)
  return type === undefined ? { type: undefined, name: id } : { type, name: id.slice(at + 1) }
}

/** A key-safe word for a name. */
export const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'item'

/** `base`, or `base-2`, `base-3`... when `used` has it. */
export function uniqueSlug(base: string, used: Set<string>): string {
  let out = base
  for (let n = 2; used.has(out); n += 1) out = `${base}-${n}`
  used.add(out)
  return out
}

/** The `name:` of a SKILL.md's frontmatter. */
export function frontmatterName(text: string): string | undefined {
  const head = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]
  const line = head === undefined ? undefined : /^name:\s*(.+?)\s*$/m.exec(head)?.[1]
  return line === undefined ? undefined : str(line.replace(/^(["'])(.*)\1$/, '$2'))
}

/** The one-line `description:` of a SKILL.md's frontmatter, when it is on one line. */
export function frontmatterDescription(text: string): string | undefined {
  const head = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]
  const line = head === undefined ? undefined : /^description:\s*(.+?)\s*$/m.exec(head)?.[1]
  return line === undefined || /^[>|]/.test(line) ? undefined : str(line.replace(/^(["'])(.*)\1$/, '$2'))
}

// ---------- tags ----------

/** The tags a command or the tag field spells: `-` clears, `all` is reserved. */
export function parseTags(text: string): { tags: string[] } | { error: string } {
  const trimmed = text.trim()
  if (trimmed === '-' || trimmed === '') return { tags: [] }
  const tags = new Set<string>()
  for (const word of trimmed.split(/[\s,]+/).filter(Boolean)) {
    const tag = word.toLowerCase()
    if (tag === 'all') return { error: 'The tag "all" is reserved: /mod-menu use all turns everything tagged on.' }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(tag)) return { error: `"${word}" is not a tag: use letters, digits, . _ -` }
    tags.add(tag)
  }
  return { tags: [...tags].sort() }
}

// ---------- the catalog ----------

export const emptyCatalog = (): Catalog => ({ version: 1, updatedAt: 0, items: {}, profiles: {}, machines: {} })

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** Reads loadout.json tolerantly: unknown keys dropped, a bad item skipped with a note, an unparsable file refused. */
export function parseCatalog(text: string): { catalog: Catalog; notes: string[] } | { error: string } {
  let json: unknown
  try {
    json = JSON.parse(text.replace(/^﻿/, ''))
  } catch (error) {
    return { error: `loadout.json is not valid JSON, parse error: ${String(error).slice(0, 80)}; nothing written` }
  }
  if (!isPlain(json)) return { error: 'loadout.json is not a JSON object, parse refused; nothing written' }
  if (json.version !== 1) return { error: 'loadout.json has an unknown version, parse refused; nothing written' }
  const notes: string[] = []
  const catalog = emptyCatalog()
  catalog.updatedAt = num(json.updatedAt)
  for (const [id, raw] of Object.entries(isPlain(json.items) ? json.items : {})) {
    if (!isPlain(raw) || typeof raw.on !== 'boolean' || !Array.isArray(raw.tags)) {
      notes.push(`skipped item ${id}`)
      continue
    }
    const tags = [...new Set(raw.tags.filter((one): one is string => typeof one === 'string' && one !== ''))].sort()
    catalog.items[id] = { tags, on: raw.on, ...(str(raw.note) ? { note: str(raw.note)! } : {}), updatedAt: num(raw.updatedAt), ...(raw.deleted === true ? { deleted: true as const } : {}) }
  }
  for (const [tag, raw] of Object.entries(isPlain(json.profiles) ? json.profiles : {})) {
    if (!isPlain(raw)) {
      notes.push(`skipped profile ${tag}`)
      continue
    }
    catalog.profiles[tag] = { updatedAt: num(raw.updatedAt), ...(str(raw.note) ? { note: str(raw.note)! } : {}), ...(raw.deleted === true ? { deleted: true as const } : {}) }
  }
  if (isPlain(json.active) && typeof json.active.tag === 'string') catalog.active = { tag: json.active.tag, at: num(json.active.at) }
  for (const [mid, raw] of Object.entries(isPlain(json.machines) ? json.machines : {})) {
    if (!isPlain(raw) || typeof raw.name !== 'string') {
      notes.push(`skipped machine ${mid}`)
      continue
    }
    const missing = Array.isArray(raw.missing) ? raw.missing.filter((one): one is string => typeof one === 'string') : []
    catalog.machines[mid] = { name: raw.name, seenAt: num(raw.seenAt), missing }
  }
  return { catalog, notes }
}

const byKey = <T>(rec: Record<string, T>, fn: (value: T) => unknown) =>
  Object.fromEntries(Object.keys(rec).sort().map(key => [key, fn(rec[key]!)]))

/** loadout.json text: 2 spaces, `\n`, sorted keys; tombstones older than 90 days are dropped. */
export function serializeCatalog(catalog: Catalog, now: number): string {
  const live = <T extends { deleted?: true; updatedAt: number }>(rec: Record<string, T>) =>
    Object.fromEntries(Object.entries(rec).filter(([, one]) => !(one.deleted && now - one.updatedAt > 90 * DAY)))
  const out = {
    ...(catalog.active ? { active: { at: catalog.active.at, tag: catalog.active.tag } } : {}),
    items: byKey(live(catalog.items), (one: CatalogItem) => ({
      ...(one.deleted ? { deleted: true } : {}),
      ...(one.note !== undefined ? { note: one.note } : {}),
      on: one.on,
      tags: [...one.tags].sort(),
      updatedAt: one.updatedAt,
    })),
    machines: byKey(catalog.machines, (one: CatalogMachine) => ({ missing: one.missing, name: one.name, seenAt: one.seenAt })),
    profiles: byKey(live(catalog.profiles), (one: CatalogProfile) => ({
      ...(one.deleted ? { deleted: true } : {}),
      ...(one.note !== undefined ? { note: one.note } : {}),
      updatedAt: one.updatedAt,
    })),
    updatedAt: catalog.updatedAt,
    version: 1,
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

/** The newer of two records; a tie goes to the greater JSON, so both sides pick the same one. */
function newer<T>(a: T, b: T, stamp: (value: T) => number): T {
  if (stamp(a) !== stamp(b)) return stamp(a) > stamp(b) ? a : b
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b
}

function mergeRecords<T>(a: Record<string, T>, b: Record<string, T>, stamp: (value: T) => number): Record<string, T> {
  const out: Record<string, T> = {}
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const left = a[key]
    const right = b[key]
    out[key] = left === undefined ? right! : right === undefined ? left : newer(left, right, stamp)
  }
  return out
}

/** Item-level last-writer-wins; depends on the machines' clocks. */
export function mergeCatalogs(local: Catalog, remote: Catalog): Catalog {
  const active = local.active && remote.active ? (local.active.at >= remote.active.at ? local.active : remote.active) : (local.active ?? remote.active)
  return {
    version: 1,
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    items: mergeRecords(local.items, remote.items, one => one.updatedAt),
    profiles: mergeRecords(local.profiles, remote.profiles, one => one.updatedAt),
    ...(active ? { active } : {}),
    machines: mergeRecords(local.machines, remote.machines, one => one.seenAt),
  }
}

// ---------- items ----------

export type PluginRow = { key: string; version?: string; enabled: boolean; isLocked?: boolean; lockReason?: string }
export type SkillRow = { name: string; tier: Tier; folders: number; description?: string; override?: string }
export type HookRow = { event: string; matcher: string; def: Json; tier: 'user' | 'project' | 'local' }
export type McpRow = { name: string; tier: Tier; url?: string; command?: string }
export type Denied = { user: string[]; elsewhere: string[]; byUrl: string[] }
export type BootSettings = { enabledPlugins: Record<string, boolean>; denied: string[] }

export type BuildInput = {
  mods: ModEntry[]
  plugins: PluginRow[]
  skills: SkillRow[]
  hooks: HookRow[]
  mcp: McpRow[]
  stash: HookStash[]
  denied: Denied
  boot: BootSettings | null
  catalog: Catalog | null
}

/** What an item is now: the pending value when one waits, else its state. */
export const effective = (item: Pick<LoadoutItem, 'state' | 'pending'>) => item.pending ?? item.state

type Base = Omit<LoadoutItem, 'tags' | 'inCatalog' | 'drift' | 'slug'> & { slug?: string }

/** Every item the menu shows, in section order, with its tags and drift from the catalog. */
export function buildItems(input: BuildInput): LoadoutItem[] {
  const out: Base[] = []

  for (const mod of input.mods) {
    const base = modSlug(mod.name)
    const name = mod.id === base ? mod.name : mod.id
    const isOn = mod.state === 'on' || mod.state === 'turning-off'
    const target = mod.state === 'on' || mod.state === 'turning-on'
    out.push({
      id: itemId('mod', name), type: 'mod', name, slug: mod.id, label: `${mod.name}${mod.version ? ` ${mod.version}` : ''}`,
      ...(mod.description !== undefined ? { description: mod.description } : {}),
      state: isOn ? 'on' : 'off', ...(isOn !== target ? { pending: target ? ('on' as const) : ('off' as const) } : {}),
      apply: 'restart', tier: 'user', isLocked: mod.isSelf, ...(mod.isSelf ? { lockReason: "this menu can't switch itself off" } : {}),
      ...(mod.note ? { note: NOTES[mod.note] } : {}),
    })
  }

  for (const plugin of input.plugins) {
    const bootOn = input.boot?.enabledPlugins[plugin.key]
    const isMoved = bootOn !== undefined && bootOn !== plugin.enabled
    out.push({
      id: itemId('plugin', plugin.key), type: 'plugin', name: plugin.key, label: `${plugin.key}${plugin.version ? ` ${plugin.version}` : ''}`,
      state: (isMoved ? bootOn : plugin.enabled) ? 'on' : 'off', ...(isMoved ? { pending: plugin.enabled ? ('on' as const) : ('off' as const) } : {}),
      apply: 'reload', tier: plugin.isLocked ? 'project' : 'user', isLocked: plugin.isLocked === true,
      ...(plugin.lockReason !== undefined ? { lockReason: plugin.lockReason } : {}),
    })
  }

  const userSkills = new Set(input.skills.filter(one => one.tier === 'user').map(one => one.name))
  for (const skill of input.skills) {
    const isUser = skill.tier === 'user'
    const notes = [
      skill.folders > 1 ? `${skill.folders} folders` : undefined,
      isUser && input.skills.some(one => one.tier === 'synced' && one.name === skill.name) ? 'also hides the synced copy' : undefined,
      isUser && skill.override !== undefined && skill.override !== 'off' ? `override: ${skill.override}` : undefined,
    ].filter(Boolean)
    out.push({
      id: itemId('skill', isUser || !userSkills.has(skill.name) ? skill.name : `${skill.name}#${skill.tier}`), type: 'skill', name: skill.name, label: skill.name,
      ...(skill.description !== undefined ? { description: skill.description } : {}),
      state: skill.override === 'off' ? 'off' : 'on', apply: SKILL_APPLY, tier: skill.tier, isLocked: !isUser,
      ...(isUser ? {} : { lockReason: skill.tier === 'synced' ? 'synced from claude.ai, read-only' : `${skill.tier} skill, read-only` }),
      ...(notes.length > 0 ? { note: notes.join(' · ') } : {}),
    })
  }

  const seenHooks = new Set<string>()
  for (const hook of input.hooks) {
    const id = hookId(hook.event, hook.matcher, hook.def)
    seenHooks.add(id)
    const isUser = hook.tier === 'user'
    out.push({
      id, type: 'hook', name: id.slice('hook:'.length), label: `${hook.event}${hook.matcher === '*' ? '' : ` ${hook.matcher}`}`,
      description: typeof hook.def.command === 'string' ? hook.def.command : String(hook.def.type ?? 'hook'),
      state: 'on', apply: 'live', tier: hook.tier, isLocked: !isUser, ...(isUser ? {} : { lockReason: 'set in project settings, read-only' }),
    })
  }
  for (const stash of input.stash) {
    if (seenHooks.has(stash.id)) continue
    out.push({
      id: stash.id, type: 'hook', name: stash.id.slice('hook:'.length), label: `${stash.event}${stash.matcher === undefined ? '' : ` ${stash.matcher}`}`,
      description: typeof stash.def.command === 'string' ? stash.def.command : String(stash.def.type ?? 'hook'),
      state: 'off', apply: 'live', tier: 'user', isLocked: false, note: 'stashed here',
    })
  }

  const names = new Set<string>()
  const addMcp = (name: string, tier: Tier, row?: McpRow) => {
    if (names.has(name)) return
    names.add(name)
    const isDenied = input.denied.user.includes(name)
    const isLocked = input.denied.elsewhere.includes(name)
    const bootOff = input.boot?.denied.includes(name)
    const isMoved = input.boot !== null && bootOff !== isDenied && !isLocked
    out.push({
      id: itemId('mcp', name), type: 'mcp', name, label: name,
      ...(row?.url ?? row?.command ? { description: String(row?.url ?? row?.command) } : {}),
      state: isLocked || (isMoved ? bootOff : isDenied) ? 'off' : 'on', ...(isMoved ? { pending: isDenied ? ('off' as const) : ('on' as const) } : {}),
      apply: 'restart', tier, isLocked, ...(isLocked ? { lockReason: 'denied in project or managed settings' } : {}),
      ...(row?.url !== undefined && input.denied.byUrl.includes(row.url) ? { note: 'blocked elsewhere (by url)' } : {}),
    })
  }
  for (const row of input.mcp) addMcp(row.name, row.tier, row)
  for (const name of input.denied.user) addMcp(name, 'user')
  for (const [id, one] of Object.entries(input.catalog?.items ?? {})) {
    const at = splitId(id)
    if (at.type === 'mcp' && !one.deleted) addMcp(at.name, 'user')
  }

  const used: Record<string, Set<string>> = {}
  return out.map(one => {
    const slug = one.slug ?? uniqueSlug(slugOf(one.name), (used[one.type] ??= new Set()))
    const held = input.catalog?.items[one.id]
    const inCatalog = held !== undefined && !held.deleted
    return {
      ...one, slug, tags: inCatalog ? [...held.tags] : [], inCatalog,
      drift: inCatalog && !one.isLocked && held.on !== (effective(one) === 'on'),
    }
  })
}

// ---------- reading the other files ----------

/** The hooks of a settings `hooks` object: one row per inner hook. */
export function parseHooks(hooks: unknown, tier: HookRow['tier']): HookRow[] {
  const rows: HookRow[] = []
  if (!isPlain(hooks)) return rows
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      if (!isPlain(group) || !Array.isArray(group.hooks)) continue
      const matcher = str(group.matcher) ?? '*'
      for (const def of group.hooks) if (isPlain(def)) rows.push({ event, matcher, def, tier })
    }
  }
  return rows
}

/** The MCP servers ~/.claude.json (user, and this project's local) and <root>/.mcp.json (project) define. */
export function parseMcpFiles(claudeJson: string | undefined, mcpJson: string | undefined, root: string | undefined): McpRow[] {
  const rows: McpRow[] = []
  const take = (servers: unknown, tier: Tier) => {
    if (!isPlain(servers)) return
    for (const [name, def] of Object.entries(servers)) {
      const one = isPlain(def) ? def : {}
      rows.push({ name, tier, ...(str(one.url) ? { url: str(one.url)! } : {}), ...(str(one.command) ? { command: str(one.command)! } : {}) })
    }
  }
  const parse = (text: string | undefined): Json => {
    try {
      const json: unknown = text === undefined ? undefined : JSON.parse(text.replace(/^﻿/, ''))
      return isPlain(json) ? json : {}
    } catch {
      return {}
    }
  }
  const user = parse(claudeJson)
  take(user.mcpServers, 'user')
  const flat = (dir: string) => dir.replace(/[\/]+/g, '/').replace(/\/$/, '').toLowerCase()
  if (root !== undefined && isPlain(user.projects)) {
    for (const [dir, project] of Object.entries(user.projects)) if (flat(dir) === flat(root) && isPlain(project)) take(project.mcpServers, 'local')
  }
  take(parse(mcpJson).mcpServers, 'project')
  return rows
}

/** deniedMcpServers: the user's names, those denied by other settings tiers, and urls denied. */
export function denyInfo(user: unknown, elsewhere: unknown[]): Denied {
  const names = (list: unknown) => (Array.isArray(list) ? list.filter(isPlain).map(one => str(one.serverName)).filter((one): one is string => one !== undefined) : [])
  const urls = (list: unknown) => (Array.isArray(list) ? list.filter(isPlain).map(one => str(one.serverUrl)).filter((one): one is string => one !== undefined) : [])
  return { user: names(user), elsewhere: elsewhere.flatMap(names), byUrl: [...urls(user), ...elsewhere.flatMap(urls)] }
}

// ---------- profiles ----------

/** What `use <tag>` wants of an item: on, off, or undefined to leave it. */
export function desiredFor(item: Pick<LoadoutItem, 'tags' | 'inCatalog'>, tag: string): 'on' | 'off' | undefined {
  if (!item.inCatalog || item.tags.length === 0) return undefined
  if (tag === 'all') return 'on'
  return item.tags.includes(tag) ? 'on' : 'off'
}

const suffix = (missing: string[], locked: string[]) =>
  `${missing.length > 0 ? ` · ${missing.length} missing here (${missing.slice(0, 3).join(', ')})` : ''}${locked.length > 0 ? ` · ${locked.length} locked` : ''}`

function tally(items: LoadoutItem[], wants: Map<string, 'on' | 'off'>, catalog: Catalog | null, isMatch: (id: string, one: CatalogItem) => boolean) {
  const on: string[] = []
  const off: string[] = []
  const locked: string[] = []
  const restart: string[] = []
  for (const item of items) {
    const want = wants.get(item.id)
    if (want === undefined || want === effective(item)) continue
    if (item.isLocked) locked.push(item.id)
    else {
      ;(want === 'on' ? on : off).push(item.id)
      if (item.apply !== 'live') restart.push(item.id)
    }
  }
  const have = new Set(items.map(one => one.id))
  const missing = Object.entries(catalog?.items ?? {}).filter(([id, one]) => !one.deleted && !have.has(id) && isMatch(id, one)).map(([id]) => id).sort()
  return { on, off, locked, restart, missing }
}

/** What `use <tag>` would change: on and off by id, those needing a restart, the catalog ids not here, the locked. */
export function planProfile(items: LoadoutItem[], catalog: Catalog | null, tag: string): ProfilePlan {
  const tagged = items.filter(one => one.inCatalog && (tag === 'all' ? one.tags.length > 0 : one.tags.includes(tag)))
  if (tagged.length === 0) return { tag, on: [], off: [], restart: [], missing: [], locked: [], text: `no items tagged "${tag}"`, isDryRun: true }
  const wants = new Map<string, 'on' | 'off'>()
  for (const item of items) {
    const want = desiredFor(item, tag)
    if (want !== undefined) wants.set(item.id, want)
  }
  const { on, off, locked, restart, missing } = tally(items, wants, catalog, (_id, one) => (tag === 'all' ? one.tags.length > 0 : one.tags.includes(tag)))
  const head = on.length + off.length === 0 ? `use ${tag}: already in place` : `use ${tag}: ${on.length} on, ${off.length} off, ${restart.length} need restart`
  return { tag, on, off, restart, missing, locked, text: head + suffix(missing, locked), isDryRun: true }
}

/** What `apply` would change: this machine brought to the catalog's on/off. */
export function planReconcile(items: LoadoutItem[], catalog: Catalog | null): ProfilePlan {
  const wants = new Map<string, 'on' | 'off'>()
  for (const item of items) {
    const held = catalog?.items[item.id]
    if (held && !held.deleted) wants.set(item.id, held.on ? 'on' : 'off')
  }
  const { on, off, locked, restart, missing } = tally(items, wants, catalog, () => true)
  const head = on.length + off.length === 0 ? 'apply: already in place' : `apply: ${on.length} on, ${off.length} off, ${restart.length} need restart`
  return { tag: '', on, off, restart, missing, locked, text: head + suffix(missing, locked), isDryRun: true }
}

// ---------- commands ----------

export type Command =
  | { kind: 'open' }
  | { kind: 'list' }
  | { kind: 'gh' }
  | { kind: 'apply' }
  | { kind: 'toggle'; want: 'on' | 'off'; ref: string }
  | { kind: 'tag'; ref: string; tags: string[] }
  | { kind: 'forget'; ref: string }
  | { kind: 'use'; tag: string; isDryRun: boolean }
  | { kind: 'sync'; op: 'sync' | 'pull' | 'push'; isForce: boolean; isRelink: boolean }
  | { kind: 'error'; text: string }

export const HELP = 'Usage: /mod-menu [list | on <id> | off <id> | tag <id> <tags|-> | use <tag> [--dry-run] | apply | sync | pull | push [--force] | gh | forget <id>]'

/** Words, with "double" or 'single' quotes holding spaces. */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(match[1] ?? match[2] ?? match[3] ?? '')
  return out
}

/** The arguments of /mod-menu. */
export function parseCommand(args: string | undefined): Command {
  const tokens = tokenize((args ?? '').trim())
  if (tokens.length === 0) return { kind: 'open' }
  const [word = '', ...rest] = tokens
  const flags = rest.filter(one => one.startsWith('--'))
  const words = rest.filter(one => !one.startsWith('--'))
  const usage = (why: string): Command => ({ kind: 'error', text: `${HELP}\n${why}` })
  switch (word) {
    case 'list':
    case 'gh':
    case 'apply':
      return { kind: word }
    case 'on':
    case 'off':
      return words.length > 0 ? { kind: 'toggle', want: word, ref: words.join(' ') } : usage(`/mod-menu ${word} needs an item name or id.`)
    case 'forget':
      return words.length > 0 ? { kind: 'forget', ref: words.join(' ') } : usage('/mod-menu forget needs an item id.')
    case 'tag': {
      if (words.length < 2) return usage('/mod-menu tag needs an item and its tags: tag skill:build-mod work,personal (or - to clear).')
      const parsed = parseTags(words[words.length - 1]!)
      return 'error' in parsed ? { kind: 'error', text: parsed.error } : { kind: 'tag', ref: words.slice(0, -1).join(' '), tags: parsed.tags }
    }
    case 'use':
      return words[0] === undefined ? usage('/mod-menu use needs a tag.') : { kind: 'use', tag: words[0].toLowerCase(), isDryRun: flags.includes('--dry-run') }
    case 'sync':
    case 'pull':
    case 'push':
      return { kind: 'sync', op: word, isForce: flags.includes('--force'), isRelink: flags.includes('--relink') }
    default:
      return { kind: 'error', text: HELP }
  }
}

/** The id a command's name points at: `type:name`, or a bare name when it is unique across types. */
export function resolveId(ids: string[], ref: string): { id: string } | { error: string } {
  const want = ref.trim().toLowerCase()
  const exact = ids.find(id => id.toLowerCase() === want)
  if (exact !== undefined) return { id: exact }
  const at = splitId(ref.trim())
  const hits = ids.filter(id => {
    const one = splitId(id)
    const named = one.name.toLowerCase() === (at.type === undefined ? want : at.name.toLowerCase()) || slugOf(one.name) === slugOf(at.type === undefined ? want : at.name)
    return named && (at.type === undefined || one.type === at.type)
  })
  if (hits.length === 1) return { id: hits[0]! }
  if (hits.length === 0) return { error: `No item "${ref}". Try /mod-menu list.` }
  return { error: `"${ref}" is ambiguous: ${hits.join(', ')}. Use type:name.` }
}

// ---------- processes: argv and parsers ----------

export type Exes = { gh: string; claude: string }
export const exesFor = (isWindows: boolean): Exes => ({ gh: isWindows ? 'gh.exe' : 'gh', claude: isWindows ? 'claude.exe' : 'claude' })

export const pluginListArgv = (claude: string) => [claude, 'plugin', 'list', '--json']
export const pluginToggleArgv = (claude: string, key: string, on: boolean) => [claude, 'plugin', on ? 'enable' : 'disable', '--json', '--scope', 'user', key]
export const ghAuthArgv = (gh: string) => [gh, 'auth', 'status', '--hostname', 'github.com']
export const gistGetArgv = (gh: string, id: string) => [gh, 'api', `/gists/${id}`]
export const gistFindArgv = (gh: string) => [gh, 'api', '--paginate', '/gists', '--jq', `.[] | select(.description=="${DESC}") | .id`]
export const gistListArgv = (gh: string) => [gh, 'api', '/gists?per_page=100']
export const gistPatchArgv = (gh: string, id: string) => [gh, 'api', '--method', 'PATCH', `/gists/${id}`, '--input', '-']
export const gistPostArgv = (gh: string) => [gh, 'api', '--method', 'POST', '/gists', '--input', '-']
export const gistPatchBody = (content: string) => JSON.stringify({ files: { [FILE]: { content } } })
export const gistPostBody = (content: string) => JSON.stringify({ description: DESC, public: false, files: { [FILE]: { content } } })

/** Masks anything shaped like a GitHub token. */
export const scrub = (text: string) => text.replace(/\bgh[opsur]_[A-Za-z0-9]{20,}\b/g, '***')
/** The first non-empty line of stderr, scrubbed: all a toast shows of it. */
export const firstLine = (text: string) => scrub(text).split(/\r?\n/).map(one => one.trim()).find(Boolean) ?? ''

/** What `gh auth status` says; the raw text is never kept. */
export function parseAuthStatus(exitCode: number, text: string): Pick<GhStatus, 'kind' | 'login' | 'message'> {
  const match = /Logged in to (\S+) (?:as|account) ([A-Za-z0-9-]+)/.exec(text)
  if (exitCode !== 0 || /not logged in/i.test(text)) return { kind: 'logged-out' }
  if (match) return { kind: 'ok', login: match[2]! }
  return { kind: 'error', message: 'could not read gh auth status' }
}

/** JSON from output that may carry a banner line first. */
function jsonOf(text: string, open: '[' | '{'): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const at = trimmed.indexOf(open)
    if (at < 0) return undefined
    try {
      return JSON.parse(trimmed.slice(at))
    } catch {
      return undefined
    }
  }
}

/** The marketplace plugins of `claude plugin list --json`; inline mods (scope "session") are dropped. undefined when it is not that JSON. */
export function parsePluginList(stdout: string): PluginRow[] | undefined {
  const json = jsonOf(stdout, '[')
  if (!Array.isArray(json)) return undefined
  const rows: PluginRow[] = []
  for (const one of json) {
    if (!isPlain(one) || typeof one.id !== 'string' || one.scope === 'session') continue
    const isLocked = one.projectEnabled === true || one.scope === 'project' || one.scope === 'local'
    rows.push({
      key: one.id, ...(str(one.version) ? { version: str(one.version)! } : {}), enabled: one.enabled === true,
      ...(isLocked ? { isLocked: true, lockReason: 'set in project settings' } : {}),
    })
  }
  return rows
}

/** The result line of `claude plugin enable|disable --json`; success is decided from it, never from the exit code. */
export function parsePluginResult(stdout: string): { ok: boolean; message: string } | undefined {
  const line = stdout.split(/\r?\n/).map(one => one.trim()).filter(one => one.startsWith('{')).pop()
  if (line === undefined) return undefined
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isPlain(json) || typeof json.outcome !== 'string') return undefined
  const isOk = json.alreadyInGoalState === true || json.outcome !== 'failed'
  return { ok: isOk, message: str(json.message) ?? json.outcome }
}

/** The loadout gist among a page of `/gists`. */
export function findGist(stdout: string): string | undefined {
  const json = jsonOf(stdout, '[')
  if (!Array.isArray(json)) return undefined
  const hit = json.find(one => isPlain(one) && one.description === DESC && typeof one.id === 'string')
  return isPlain(hit) ? (hit.id as string) : undefined
}

/** A gist's loadout file, when and by whom it was last written. */
export function parseGist(stdout: string): { content: string; updatedAt: string; owner?: string; isTruncated: boolean } | { error: string } {
  const json = jsonOf(stdout, '{')
  if (!isPlain(json)) return { error: 'the gist did not come back as JSON' }
  const files = isPlain(json.files) ? json.files : {}
  const file = files[FILE]
  if (!isPlain(file) || typeof file.content !== 'string') return { error: `the gist has no ${FILE}` }
  const owner = isPlain(json.owner) ? str(json.owner.login) : undefined
  return { content: file.content, updatedAt: str(json.updated_at) ?? '', ...(owner ? { owner } : {}), isTruncated: file.truncated === true }
}

/** The gist's `id` and `updated_at` in a create or update response. */
export function parseGistReply(stdout: string): { id?: string; updatedAt?: string; owner?: string } {
  const json = jsonOf(stdout, '{')
  if (!isPlain(json)) return {}
  return { id: str(json.id), updatedAt: str(json.updated_at), owner: isPlain(json.owner) ? str(json.owner.login) : undefined }
}

// ---------- texts ----------

export function ago(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  if (min < 48 * 60) return `${Math.floor(min / 60)}h ago`
  return `${Math.floor(min / 1440)}d ago`
}

/** The pane's GitHub line. */
export function ghText(gh: GhStatus, sync: SyncState, lastSyncAt: number | undefined, now: number): string {
  const head =
    gh.kind === 'ok' ? `GitHub: ${gh.login ?? 'logged in'} ✓`
    : gh.kind === 'logged-out' ? 'GitHub: not logged in · run gh auth login --web'
    : gh.kind === 'missing' ? 'GitHub: gh not installed · https://cli.github.com'
    : gh.kind === 'error' ? `GitHub: ${gh.message ?? 'error'}`
    : gh.kind === 'checking' ? 'GitHub: checking…'
    : 'GitHub: not checked'
  const tail = sync.kind === 'busy' ? ' · syncing…' : sync.kind === 'error' ? ` · sync failed: ${sync.message ?? ''}` : lastSyncAt !== undefined ? ` · synced ${ago(now - lastSyncAt)}` : ''
  return head + tail
}

const WHEN: Record<ApplyWhen, string> = { live: 'now', reload: 'after /reload-plugins', restart: 'next session' }

/** What a non-mod row's state box says: the pending change, else the lock, the note or the description. */
export function itemStateText(item: LoadoutItem): string {
  if (item.pending !== undefined) return `${item.state} → ${item.pending} ${WHEN[item.apply]}`
  if (item.isLocked) return item.lockReason ?? 'locked'
  if (item.state === 'off') return [item.type === 'mcp' ? 'blocked via deniedMcpServers · next session' : item.type === 'skill' ? 'off via skillOverrides' : 'off', item.note].filter(Boolean).join(' · ')
  return [item.note, item.description].filter(Boolean).join(' · ')
}

/** The toast after a batch: what changed and what it needs. */
export function appliedText(head: string, restart: boolean, reload: boolean, failed: string[]): string {
  return `${head}${restart ? ' · restart Claude Code' : ''}${reload ? ' · run /reload-plugins' : ''}${failed.length > 0 ? ` · not changed: ${failed.join('; ')}` : ''}`
}

/** One item per line, for the command's text. */
export function itemsText(items: LoadoutItem[]): string {
  return items
    .map(one => {
      const state = `${one.state}${one.pending ? `→${one.pending}` : ''}`.padEnd(8)
      const rest = [one.tags.length > 0 ? `[${one.tags.join(', ')}]` : undefined, one.isLocked ? 'locked' : undefined, one.drift ? 'differs from catalog' : undefined].filter(Boolean).join(' · ')
      return `${state} ${one.id}${rest ? `  ${rest}` : ''}`
    })
    .join('\n')
}
