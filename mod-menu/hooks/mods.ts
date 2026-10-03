import type { DisabledDir, ModConfigRow, ModEntry, ModNote, ModState } from '../types'

// Pure logic of the mod menu: path handling, the CLAUDE_CODE_PLUGIN_DIRS
// rewrite of settings.json, what state each mod is in, and the texts. Nothing
// here touches `$`; register.tsx reads and writes and passes the pieces in.

export const VAR = 'CLAUDE_CODE_PLUGIN_DIRS'

export type Json = Record<string, unknown>

export const isPlain = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A dir as a comparison key: one slash, no trailing slash, `~` expanded, lowercase on Windows. */
export function norm(dir: string, home?: string): string {
  let s = dir.trim()
  if (home && (s === '~' || /^~[\\/]/.test(s))) s = home + s.slice(1)
  s = s.replace(/[\\/]+/g, '/')
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return /^[a-z]:/i.test(s) ? s.toLowerCase() : s
}

/** A dir with `~` expanded, spelling kept; for reading from disk. */
export function expand(dir: string, home?: string): string {
  const s = dir.trim()
  return home && (s === '~' || /^~[\\/]/.test(s)) ? home + s.slice(1) : s
}

/** The folder's own name, case kept. */
export function baseName(dir: string): string {
  const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? dir
}

/** `;` when the settings path or value looks like Windows, else `:`. */
export function sepFor(settingsPath: string, value: string | undefined): string {
  const isWindows = /^[a-z]:|\\/i.test(settingsPath) || /^[a-z]:[\\/]/i.test(value ?? '') || (value ?? '').includes(';')
  return isWindows ? ';' : ':'
}

export const splitDirs = (value: string, sep: string): string[] =>
  value.split(sep).map(one => one.trim()).filter(Boolean)

const stripBom = (raw: string) => (raw.startsWith('﻿') ? raw.slice(1) : raw)

/** The dirs settings.json lists now, or why it cannot be read. */
export function parseDirs(raw: string, settingsPath: string): { dirs: string[]; value?: string; sep: string; error?: string } {
  const sep = sepFor(settingsPath, undefined)
  let obj: unknown
  try {
    obj = JSON.parse(stripBom(raw))
  } catch (error) {
    return { dirs: [], sep, error: `settings.json is not valid JSON, parse error: ${String(error).slice(0, 80)}` }
  }
  if (!isPlain(obj)) return { dirs: [], sep, error: 'settings.json is not a JSON object' }
  const env = obj.env
  if (env !== undefined && !isPlain(env)) return { dirs: [], sep, error: 'settings.json: "env" is not an object' }
  const value = env?.[VAR]
  if (value !== undefined && typeof value !== 'string') return { dirs: [], sep, error: `settings.json: ${VAR} is not a string` }
  const real = sepFor(settingsPath, value)
  return { dirs: splitDirs(value ?? '', real), value, sep: real }
}

export type RewriteOpts = { sep: string; selfKey: string; home?: string }
export type RewriteResult =
  | { kind: 'write'; text: string; before: string[]; after: string[] }
  | { kind: 'same' }
  | { kind: 'error'; reason: string }

/** A refusal raised inside an edit; the rewrite turns it into `{ kind: 'error' }`. */
export class EditError extends Error {}

/** A settings.json taken apart: its layout, and the parsed root. */
export type Split = { bom: boolean; body: string; eol: string; hasTrailingNewline: boolean; indent: string | number; obj: Json }

/** The layout of settings.json and its parsed root, or why it cannot be edited. */
export function splitRaw(raw: string): { kind: 'ok'; split: Split } | { kind: 'error'; reason: string } {
  const bom = raw.startsWith('﻿')
  const body = stripBom(raw)
  const eol = body.includes('\r\n') ? '\r\n' : '\n'
  const hasTrailingNewline = /\r?\n$/.test(body)
  const lead = /^([ \t]+)\S/m.exec(body)?.[1]
  const indent = lead === undefined ? 2 : lead.startsWith('\t') ? '\t' : Math.min(10, lead.length)
  let obj: unknown
  try {
    obj = JSON.parse(body)
  } catch (error) {
    return { kind: 'error', reason: `settings.json is not valid JSON, parse error: ${String(error).slice(0, 80)}; not written` }
  }
  if (!isPlain(obj)) return { kind: 'error', reason: 'settings.json is not a JSON object; not written' }
  return { kind: 'ok', split: { bom, body, eol, hasTrailingNewline, indent, obj } }
}

/** The re-serialized form of `expected`, in the file's own layout. */
export const fullText = (s: Split, expected: unknown) =>
  JSON.stringify(expected, null, s.indent).replace(/\n/g, s.eol) + (s.hasTrailingNewline ? s.eol : '')

/** `text` checked against `expected` by parsing it again, with the BOM put back. */
export function finishRaw(s: Split, text: string, expected: unknown): { kind: 'ok'; text: string } | { kind: 'error'; reason: string } {
  try {
    if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(expected)) throw new Error('mismatch')
  } catch {
    return { kind: 'error', reason: 'the rewritten settings.json did not check out; not written' }
  }
  return { kind: 'ok', text: (s.bom ? '﻿' : '') + text }
}

/** The plugin dirs list after `change`: v0.1's self guard and workbench-last rules. Throws EditError on a refusal. */
export function applyDirs(
  cur: string | undefined,
  change: (dirs: string[]) => string[],
  opts: RewriteOpts,
): { same: true } | { same: false; value: string; before: string[]; after: string[] } {
  const { sep, selfKey, home } = opts
  const dirs = splitDirs(cur ?? '', sep)
  const changed = change(dirs)
  const isNoop = cur !== undefined ? changed.join(sep) === dirs.join(sep) : changed.length === 0
  if (isNoop) return { same: true }

  const isSelf = (dir: string) => selfKey !== '' && norm(dir, home) === selfKey
  if (dirs.some(isSelf) && !changed.some(isSelf)) throw new EditError("mod-menu won't remove itself; edit settings.json by hand")

  // workbench hosts the other panes, so it loads last
  const isBench = (dir: string) => baseName(norm(dir, home)).toLowerCase() === 'workbench'
  const next = [...changed.filter(one => !isBench(one)), ...changed.filter(isBench)]
  if (next.join(sep) === dirs.join(sep)) return { same: true }
  return { same: false, value: next.join(sep), before: dirs, after: next }
}

/**
 * settings.json with the plugin dirs changed by `change`. Everything else in
 * the file stays: the literal is replaced in place where it can be, and the
 * result is checked by parsing it again; the fallback re-serializes the file.
 */
export function rewriteDirs(raw: string, change: (dirs: string[]) => string[], opts: RewriteOpts): RewriteResult {
  const parsed = splitRaw(raw)
  if (parsed.kind === 'error') return parsed
  const { split } = parsed
  const { body, obj } = split
  const env = obj.env
  if (env !== undefined && !isPlain(env)) return { kind: 'error', reason: 'settings.json: "env" is not an object; not written' }
  const cur = env?.[VAR]
  if (cur !== undefined && typeof cur !== 'string') return { kind: 'error', reason: `settings.json: ${VAR} is not a string; not written` }

  let applied
  try {
    applied = applyDirs(cur, change, opts)
  } catch (error) {
    if (error instanceof EditError) return { kind: 'error', reason: error.message }
    throw error
  }
  if (applied.same) return { kind: 'same' }

  const { value } = applied
  const expected = { ...obj, env: { ...(env ?? {}), [VAR]: value } }
  const expectedText = JSON.stringify(expected)

  let text: string | undefined
  const literal = new RegExp(`("${VAR}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'g')
  if ((body.match(literal) ?? []).length === 1) {
    const candidate = body.replace(literal, (_all, head: string) => head + JSON.stringify(value))
    try {
      if (JSON.stringify(JSON.parse(candidate)) === expectedText) text = candidate
    } catch {
      // fall through to the re-serialized form
    }
  }
  if (text === undefined) text = fullText(split, expected)

  const done = finishRaw(split, text, expected)
  if (done.kind === 'error') return done
  return { kind: 'write', text: done.text, before: applied.before, after: applied.after }
}

/** The change that takes `key` out of the list, every duplicate included. */
export const removeDir = (key: string, home?: string) => (dirs: string[]) =>
  dirs.filter(one => norm(one, home) !== key)

/** The change that lists `dir`: after `after` if that is still listed, else before workbench, else last. */
export const addDir = (dir: string, after: string | undefined, home?: string) => (dirs: string[]) => {
  const key = norm(dir, home)
  if (dirs.some(one => norm(one, home) === key)) return dirs
  const at = after === undefined ? -1 : dirs.findIndex(one => norm(one, home) === norm(after, home))
  const bench = dirs.findIndex(one => baseName(norm(one, home)).toLowerCase() === 'workbench')
  const to = at >= 0 ? at + 1 : bench >= 0 ? bench : dirs.length
  return [...dirs.slice(0, to), dir, ...dirs.slice(to)]
}

/** What the folder says about itself; `note` when it could not be read. */
export type ManifestInfo = { name?: string; version?: string; description?: string; note?: ModNote }

/** Every dir to show, in order: disk first, then loaded-only, then remembered-only. */
export function listDirs(boot: string[], disk: string[], disabled: DisabledDir[], home?: string) {
  const rows = new Map<string, { dir: string; key: string; listed: number; name?: string }>()
  for (const dir of disk) {
    const key = norm(dir, home)
    const held = rows.get(key)
    if (held) held.listed += 1
    else rows.set(key, { dir, key, listed: 1 })
  }
  const remembered = (key: string) => disabled.find(one => norm(one.dir, home) === key)
  for (const key of boot) {
    if (!rows.has(key)) rows.set(key, { dir: remembered(key)?.dir ?? key, key, listed: 0, name: remembered(key)?.name })
  }
  for (const one of disabled) {
    const key = norm(one.dir, home)
    if (!rows.has(key)) rows.set(key, { dir: one.dir, key, listed: 0, name: one.name })
  }
  return [...rows.values()]
}

export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'mod'

/** The mods, each with its state against what this process loaded. */
export function derive(
  boot: string[],
  disk: string[],
  disabled: DisabledDir[],
  manifests: Record<string, ManifestInfo | undefined>,
  selfName: string,
  selfKey: string,
  home?: string,
): ModEntry[] {
  const inBoot = new Set(boot)
  const seen = new Map<string, number>()
  return listDirs(boot, disk, disabled, home).map(row => {
    const info = manifests[row.key]
    const name = info?.name ?? row.name ?? baseName(row.dir)
    const base = slug(name)
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    const isLoaded = inBoot.has(row.key)
    const isListed = row.listed > 0
    const state: ModState = isLoaded ? (isListed ? 'on' : 'turning-off') : isListed ? 'turning-on' : 'off'
    return {
      id: count === 1 ? base : `${base}-${count}`,
      dir: row.dir,
      key: row.key,
      name,
      ...(info?.version !== undefined ? { version: info.version } : {}),
      ...(info?.description !== undefined ? { description: info.description } : {}),
      state,
      isSelf: name === selfName || (selfKey !== '' && row.key === selfKey),
      isWorkbench: baseName(row.dir).toLowerCase() === 'workbench',
      listed: row.listed,
      ...(info?.note !== undefined ? { note: info.note } : {}),
    }
  })
}

/** Mods counted as loaded now, as off now, and as waiting for a restart. */
export function counts(mods: ModEntry[]) {
  const on = mods.filter(one => one.state === 'on' || one.state === 'turning-off').length
  const off = mods.filter(one => one.state === 'off' || one.state === 'turning-on').length
  const pending = mods.filter(one => one.state === 'turning-off' || one.state === 'turning-on').length
  return { on, off, pending }
}

/** `mods: 9 on · 1 off · 2 pending restart`, zero parts dropped; undefined when nothing is off or pending. */
export function statusText(mods: ModEntry[]): string | undefined {
  const { on, off, pending } = counts(mods)
  if (off === 0 && pending === 0) return undefined
  return `mods: ${on} on${off > 0 ? ` · ${off} off` : ''}${pending > 0 ? ` · ${pending} pending restart` : ''}`
}

/** The pane's header counts. */
export function headerText(mods: ModEntry[]): string {
  const { on, off, pending } = counts(mods)
  return `${on} on${off > 0 ? ` · ${off} off` : ''}${pending > 0 ? ` · ${pending} pending restart` : ''}`
}

/** Whether settings.json lists the mod now (what a press flips). */
export const isListed = (mod: ModEntry) => mod.state === 'on' || mod.state === 'turning-on'

export const NOTES: Record<ModNote, string> = {
  missing: 'folder missing',
  'no-manifest': 'no plugin.json',
  'bad-manifest': 'plugin.json unreadable',
}

/** What the state box says: the pending change, else the note, else the description. */
export function stateText(mod: ModEntry): string {
  if (mod.state === 'turning-off') return 'on → off next session'
  if (mod.state === 'turning-on') return 'off → on next session'
  if (mod.isSelf) return 'this menu · remove by hand in settings.json'
  if (mod.note) return NOTES[mod.note]
  if (mod.state === 'off') return 'off'
  if (mod.isWorkbench) return 'always last · hosted panes open as its tabs'
  return mod.description ?? ''
}

/** The text of a toast after a toggle. */
export function toggleToast(name: string, wantOn: boolean, isBack: boolean): string {
  if (isBack) return `${name}: back as it was — no restart needed`
  return `${name}: ${wantOn ? 'on' : 'off'} next session — restart Claude Code to apply`
}

/** Whether two lists name the same dirs, in any order. */
export function sameDirs(a: string[], b: string[]): boolean {
  const left = new Set(a)
  const right = new Set(b)
  return left.size === right.size && [...left].every(one => right.has(one))
}

/** One mod per line, for the command's text. */
export function listText(mods: ModEntry[]): string {
  if (mods.length === 0) return 'No mods are listed in CLAUDE_CODE_PLUGIN_DIRS.'
  return mods
    .map(one => {
      const tag = one.state.padEnd(11)
      const rest = [one.version, one.isSelf ? 'this menu' : undefined, one.note ? NOTES[one.note] : undefined, one.listed > 1 ? `listed ${one.listed}×` : undefined]
        .filter(Boolean)
        .join(' · ')
      return `${tag} ${one.name}${rest ? `  ${rest}` : ''}`
    })
    .join('\n')
}

/** `text` cut to `max` characters with an ellipsis. */
export const clip = (text: string, max: number) =>
  max > 1 && text.length > max ? `${text.slice(0, max - 1)}…` : text

export type Command =
  | { kind: 'open' }
  | { kind: 'list' }
  | { kind: 'toggle'; want: 'on' | 'off'; name: string }
  | { kind: 'error'; text: string }

export const HELP = 'Usage: /mod-menu [list | on <name> | off <name>]'

/** The arguments of /mod-menu. */
export function parseCommand(args: string | undefined): Command {
  const text = (args ?? '').trim()
  if (text === '') return { kind: 'open' }
  const [word = '', ...rest] = text.split(/\s+/)
  const name = rest.join(' ')
  if (word === 'list') return { kind: 'list' }
  if (word === 'on' || word === 'off') {
    return name ? { kind: 'toggle', want: word, name } : { kind: 'error', text: `${HELP}\n/mod-menu ${word} needs a mod name.` }
  }
  return { kind: 'error', text: HELP }
}

/** Config rows of the listed mods: those the mod provides, or keyed under its name. */
export function modConfig(
  rows: readonly {
    key: string
    label: string
    description?: string
    kind: ModConfigRow['kind']
    value: boolean | string | number | readonly string[]
    options?: readonly string[]
    provider: { plugin: string }
    isLocked: boolean
  }[],
  names: string[],
): ModConfigRow[] {
  const out: ModConfigRow[] = []
  for (const row of rows) {
    const plugin = names.find(name => row.provider.plugin === name || row.key.startsWith(`${name}.`))
    if (plugin === undefined) continue
    out.push({
      key: row.key,
      plugin,
      field: row.key.startsWith(`${plugin}.`) ? row.key.slice(plugin.length + 1) : row.key,
      label: row.label,
      ...(row.description !== undefined ? { description: row.description } : {}),
      kind: row.kind,
      value: typeof row.value === 'object' ? [...row.value] : row.value,
      ...(row.options !== undefined ? { options: [...row.options] } : {}),
      isLocked: row.isLocked,
    })
  }
  return out
}

/** The slash command that shows a mod's pane, by mod name. Mods with no pane are absent. */
export const PANE_COMMANDS: Record<string, string> = {
  'agent-deck': 'deck',
  arcade: 'arcade',
  'dev-doctor': 'dev-doctor',
  'diff-viewer': 'diff-viewer',
  'doom-pane': 'doom',
  'gb-pane': 'gb',
  'gba-pane': 'gba',
  inbox: 'inbox',
  'nes-pane': 'nes',
  'rail-runner': 'rail-runner',
  'solution-explorer': 'explorer',
  'sound-board': 'sounds',
  'usage-tracker': 'usage-tracker',
  workbench: 'workbench',
}

/** The command that shows this mod's pane now: a loaded mod with a pane, never this menu itself. */
export function showCommand(mod: ModEntry): string | undefined {
  if (mod.isSelf || (mod.state !== 'on' && mod.state !== 'turning-off')) return undefined
  return PANE_COMMANDS[mod.name]
}
