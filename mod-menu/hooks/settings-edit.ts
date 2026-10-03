import type { HookStash } from '../types'
import { hookId } from './loadout'
import { EditError, applyDirs, finishRaw, fullText, isPlain, splitRaw } from './mods'
import type { Json, RewriteOpts, Split } from './mods'

// Pure edits of settings.json: any keys at any depth are changed in a clone,
// and the file's text is patched one top-level key at a time, so every other
// key keeps its bytes. Nothing here touches `$`; register.tsx reads and writes.

/** What a `change` returns to remove its leaf. */
export const DELETE = Symbol('delete')

/** One edit: `change` gets the leaf's current value and returns the new one (`undefined` leaves it alone). */
export type Edit = { path: string[]; change: (cur: unknown) => unknown }
export type EditResult = { kind: 'write'; text: string } | { kind: 'same' } | { kind: 'error'; reason: string }

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Where the value of the root's own key `key` sits in `body`; undefined when the key is not there. */
export function topLevelSpan(body: string, key: string): { start: number; end: number } | undefined {
  let depth = 0
  let expectKey = false
  const stringEnd = (from: number) => {
    let i = from + 1
    while (i < body.length && body[i] !== '"') i += body[i] === '\\' ? 2 : 1
    return i + 1
  }
  const skipWs = (from: number) => {
    let i = from
    while (i < body.length && /\s/.test(body[i]!)) i += 1
    return i
  }
  let i = 0
  while (i < body.length) {
    const ch = body[i]!
    if (ch === '"') {
      const end = stringEnd(i)
      if (depth === 1 && expectKey) {
        expectKey = false
        const colon = skipWs(end)
        if (body[colon] === ':' && JSON.parse(body.slice(i, end)) === key) {
          const start = skipWs(colon + 1)
          return { start, end: valueEnd(body, start) }
        }
      }
      i = end
      continue
    }
    if (ch === '{' || ch === '[') {
      depth += 1
      if (depth === 1) expectKey = true
    } else if (ch === '}' || ch === ']') depth -= 1
    else if (ch === ',' && depth === 1) expectKey = true
    i += 1
  }
  return undefined
}

/** The end of the JSON value that starts at `start`. */
function valueEnd(body: string, start: number): number {
  const first = body[start]
  if (first === '"') {
    let i = start + 1
    while (i < body.length && body[i] !== '"') i += body[i] === '\\' ? 2 : 1
    return i + 1
  }
  if (first === '{' || first === '[') {
    let depth = 0
    let i = start
    while (i < body.length) {
      const ch = body[i]!
      if (ch === '"') {
        i += 1
        while (i < body.length && body[i] !== '"') i += body[i] === '\\' ? 2 : 1
      } else if (ch === '{' || ch === '[') depth += 1
      else if (ch === '}' || ch === ']') {
        depth -= 1
        if (depth === 0) return i + 1
      }
      i += 1
    }
    return body.length
  }
  let i = start
  while (i < body.length && !/[,}\]\s]/.test(body[i]!)) i += 1
  return i
}

/** `expected` with every edit applied in order; throws EditError on a refusal. */
function applyEdits(obj: Json, edits: Edit[]): Json {
  const expected = clone(obj)
  for (const edit of edits) {
    const { path } = edit
    const leaf = path[path.length - 1]!
    let node: Json = expected
    let isGone = false
    for (const step of path.slice(0, -1)) {
      const next = node[step]
      if (next === undefined) {
        // an absent parent is created only when the edit puts something in it
        const probe = edit.change(undefined)
        if (probe === undefined || probe === DELETE) {
          isGone = true
          break
        }
        node[step] = {}
      } else if (!isPlain(next)) {
        throw new EditError(`settings.json: "${step}" is not an object; not written`)
      }
      node = node[step] as Json
    }
    if (isGone) continue
    const value = edit.change(node[leaf])
    if (value === undefined) continue
    if (value === DELETE) {
      if (path.length === 1) throw new EditError('refusing to delete a top-level key')
      delete node[leaf]
    } else node[leaf] = value
  }
  return expected
}

/** `raw` with the top-level key `key` set to `value`: replaced in place, or added before the closing brace. */
function patchKey(s: Split, text: string, key: string, value: unknown): string {
  const unit = typeof s.indent === 'number' ? ' '.repeat(s.indent) : s.indent
  const literal = JSON.stringify(value, null, s.indent).replace(/\n/g, s.eol + unit)
  const span = topLevelSpan(text, key)
  if (span) return text.slice(0, span.start) + literal + text.slice(span.end)
  const close = text.lastIndexOf('}')
  let at = close
  while (at > 0 && /\s/.test(text[at - 1]!)) at -= 1
  const open = text.indexOf('{')
  const isEmpty = text.slice(open + 1, close).trim() === ''
  const entry = `${unit}${JSON.stringify(key)}: ${literal}`
  if (isEmpty) return `${text.slice(0, open + 1)}${s.eol}${entry}${s.eol}${text.slice(close)}`
  return `${text.slice(0, at)},${s.eol}${entry}${text.slice(at)}`
}

/**
 * settings.json with `edits` applied. Each changed top-level key is patched in
 * the text; the result is checked by parsing it again, and the fallback
 * re-serializes the file. Nothing changed gives `same`.
 */
export function rewriteKeys(raw: string, edits: Edit[]): EditResult {
  const parsed = splitRaw(raw)
  if (parsed.kind === 'error') return parsed
  const { split } = parsed
  let expected: Json
  try {
    expected = applyEdits(split.obj, edits)
  } catch (error) {
    if (error instanceof EditError) return { kind: 'error', reason: error.message }
    throw error
  }
  if (same(expected, split.obj)) return { kind: 'same' }

  let text: string | undefined
  let candidate = split.body
  for (const key of Object.keys(expected)) {
    if (key in split.obj && same(expected[key], split.obj[key])) continue
    candidate = patchKey(split, candidate, key, expected[key])
  }
  try {
    if (same(JSON.parse(candidate), expected)) text = candidate
  } catch {
    // fall through to the re-serialized form
  }
  if (text === undefined) text = fullText(split, expected)

  const done = finishRaw(split, text, expected)
  return done.kind === 'error' ? done : { kind: 'write', text: done.text }
}

export const rewriteKey = (raw: string, path: string[], change: (cur: unknown) => unknown): EditResult =>
  rewriteKeys(raw, [{ path, change }])

/** The plugin dirs list as one edit of a batch. */
export function dirsEdit(change: (dirs: string[]) => string[], opts: RewriteOpts): Edit {
  return {
    path: ['env', 'CLAUDE_CODE_PLUGIN_DIRS'],
    change: cur => {
      if (cur !== undefined && typeof cur !== 'string') throw new EditError('settings.json: CLAUDE_CODE_PLUGIN_DIRS is not a string; not written')
      const done = applyDirs(cur, change, opts)
      return done.same ? cur : done.value
    },
  }
}

/** The marketplace-plugin switch, for when the claude CLI cannot start. */
export const pluginEdit = (key: string, on: boolean): Edit => ({ path: ['enabledPlugins', key], change: () => on })

/** A skill's override: off writes "off"; on puts back what was there, else removes the entry. */
export const skillEdit = (name: string, on: boolean, prev: string | undefined): Edit => ({
  path: ['skillOverrides', name],
  change: () => (on ? (prev ?? DELETE) : 'off'),
})

const isNamed = (entry: unknown, name: string) => isPlain(entry) && entry.serverName === name

/** An MCP server in deniedMcpServers: off appends `{ serverName }` once, on removes only that single-key entry. */
export const mcpEdit = (name: string, on: boolean): Edit => ({
  path: ['deniedMcpServers'],
  change: cur => {
    if (cur !== undefined && !Array.isArray(cur)) throw new EditError('settings.json: "deniedMcpServers" is not an array; not written')
    const list = (cur ?? []) as unknown[]
    if (on) return list.some(one => isNamed(one, name) && Object.keys(one as Json).length === 1) ? list.filter(one => !(isNamed(one, name) && Object.keys(one as Json).length === 1)) : cur
    return list.some(one => isNamed(one, name)) ? cur : [...list, { serverName: name }]
  },
})

const matcherOf = (group: Json) => (typeof group.matcher === 'string' && group.matcher !== '' ? group.matcher : '*')

const hooksOf = (cur: unknown): Json => {
  if (!isPlain(cur)) throw new EditError('settings.json: "hooks" is not an object; not written')
  return cur
}

/** Takes the hook `id` out of `hooks`, dropping an emptied group and event; `out.stash` says where it was. */
export function hookOffEdit(id: string, now: number): { edit: Edit; out: { stash?: HookStash } } {
  const out: { stash?: HookStash } = {}
  const edit: Edit = {
    path: ['hooks'],
    change: cur => {
      if (cur === undefined) return undefined
      const hooks = clone(hooksOf(cur))
      for (const [event, groups] of Object.entries(hooks)) {
        if (!Array.isArray(groups)) continue
        for (let g = 0; g < groups.length; g += 1) {
          const group = groups[g]
          if (!isPlain(group) || !Array.isArray(group.hooks)) continue
          const at = group.hooks.findIndex(def => isPlain(def) && hookId(event, matcherOf(group), def) === id)
          if (at < 0) continue
          const def = group.hooks[at] as Json
          out.stash = { id, event, ...(matcherOf(group) === '*' ? {} : { matcher: matcherOf(group) }), groupIndex: g, hookIndex: at, def, at: now }
          group.hooks.splice(at, 1)
          if (group.hooks.length === 0) groups.splice(g, 1)
          if (groups.length === 0) delete hooks[event]
          return hooks
        }
      }
      return cur
    },
  }
  return { edit, out }
}

/** Puts a stashed hook back: into its matcher's group at its old position, clamped, else a new group. */
export function hookOnEdit(stash: HookStash): Edit {
  return {
    path: ['hooks'],
    change: cur => {
      const hooks = cur === undefined ? {} : clone(hooksOf(cur))
      const matcher = stash.matcher ?? '*'
      const groups = Array.isArray(hooks[stash.event]) ? (hooks[stash.event] as unknown[]) : []
      const find = (g: number) => {
        const group = groups[g]
        return isPlain(group) && Array.isArray(group.hooks) && matcherOf(group) === matcher ? group : undefined
      }
      let group = find(Math.min(stash.groupIndex, groups.length - 1))
      if (!group) {
        const at = groups.findIndex((_, g) => find(g) !== undefined)
        group = at >= 0 ? find(at) : undefined
      }
      if (group) {
        const list = group.hooks as unknown[]
        if (list.some(def => same(def, stash.def))) return cur
        list.splice(Math.min(stash.hookIndex, list.length), 0, stash.def)
      } else {
        const made: Json = { ...(stash.matcher === undefined ? {} : { matcher: stash.matcher }), hooks: [stash.def] }
        groups.splice(Math.min(stash.groupIndex, groups.length), 0, made)
      }
      hooks[stash.event] = groups
      return hooks
    },
  }
}

/** The value at `path` of a parsed settings object. */
export function getPath(obj: unknown, path: string[]): unknown {
  let node = obj
  for (const step of path) {
    if (!isPlain(node)) return undefined
    node = node[step]
  }
  return node
}
