import type { BarMode, BarPrefs, BarSegment } from '../types'

/** Short names for the mods whose plugin name is long; anything else keeps its name. */
export const LABELS: Record<string, string> = {
  'usage-tracker': 'usage',
  'claim-check': 'claims',
  'goal-anchor': 'goal',
  'agent-deck': 'agents',
  'handoff-watch': 'handoff',
  'solution-explorer': 'explorer',
  'sound-board': 'sounds',
  guardrail: 'guard',
  'dev-doctor': 'doctor',
  'mod-menu': 'mods',
  'cache-clock': 'cache',
}

export const SEP = ' │ '
/** `⚠ status-bar: ` is 14 cells, plus 2 of margin. A guess: the engine draws it, the types do not say. */
export const ENGINE_PREFIX = 16
export const PALETTE = ['cyan', 'magenta', 'yellow', 'green', 'blue', '#D97757', '#10A37F', '#A78BFA']
export const MODES: readonly BarMode[] = ['status', 'band']

export type Config = {
  mode: BarMode
  maxSegment: number
  width: number
  /** Lower-case plugin names, shown first. */
  order: string[]
  hide: string[]
}

/** One plugin's text ready to draw: `label: body`, or the body alone when it already says who it is. */
export type Seg = { plugin: string; label: string; body: string }

export type Command =
  | { kind: 'report' }
  | { kind: 'mode'; mode: BarMode }
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'hide'; plugin: string }
  | { kind: 'show'; plugin: string }
  | { kind: 'error'; text: string }

export const USAGE = 'usage: /statusbar [mode status|band | on | off | hide <plugin> | show <plugin>]'

export const labelOf = (plugin: string): string => LABELS[plugin] ?? plugin

/** One line: line breaks, tabs and other control characters gone, trimmed. Empty counts as cleared. */
export function clean(text: string | undefined): string {
  if (text === undefined) return ''
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
}

const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
]

const ZERO = /^\p{M}$/u
const PICTO = /^\p{Extended_Pictographic}$/u

/** Terminal cells one character takes: 0 for joiners and marks, 2 for emoji and wide scripts, else 1. */
function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  if (code === 0x200d || code === 0xfe0e || code === 0xfe0f || ZERO.test(ch)) return 0
  if (PICTO.test(ch)) return 2
  for (const [lo, hi] of WIDE) if (code >= lo && code <= hi) return 2
  return 1
}

export function cellWidth(s: string): number {
  let n = 0
  for (const ch of s) n += charWidth(ch)
  return n
}

/** The longest prefix that fits `n` cells with a trailing ellipsis; `s` itself when it already fits. */
export function clipCells(s: string, n: number): string {
  if (cellWidth(s) <= n) return s
  let out = ''
  let used = 0
  for (const ch of s) {
    const w = charWidth(ch)
    if (used + w > n - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}

/** What a plugin's text looks like in the line, the label dropped when the text already starts with it. */
export function segmentOf(plugin: string, text: string, maxSegment: number): Seg {
  const label = labelOf(plugin)
  const lower = text.toLowerCase()
  const says =
    lower.startsWith(`${label.toLowerCase()}:`) ||
    lower.startsWith(`${label.toLowerCase()} `) ||
    lower.startsWith(`${plugin.toLowerCase()}:`)
  return { plugin, label: says ? '' : label, body: clipCells(text, maxSegment) }
}

export const fullOf = (s: Seg): string => (s.label ? `${s.label}: ${s.body}` : s.body)

/** Comma-separated names: trimmed, lower-cased, empties and repeats dropped. */
export function parseList(csv: string): string[] {
  const out: string[] = []
  for (const part of csv.split(',')) {
    const name = part.trim().toLowerCase()
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

/** Listed names first, in that order, then the rest alphabetically. */
export function orderOf(names: string[], order: string[]): string[] {
  const rank = (name: string) => {
    const at = order.indexOf(name.toLowerCase())
    return at < 0 ? order.length : at
  }
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

/** The segments to show: hidden and empty ones dropped, the rest in order. */
export function visible(segs: Record<string, BarSegment>, prefs: BarPrefs, cfg: Config): Seg[] {
  const names = Object.keys(segs).filter(name => {
    const seg = segs[name]
    return seg !== undefined && seg.text !== '' && !prefs.hidden.includes(name.toLowerCase())
  })
  return orderOf(names, cfg.order).map(name => segmentOf(name, segs[name]?.text ?? '', cfg.maxSegment))
}

/** The one status line: whole segments while they fit, then `│ +N`; undefined when there is nothing. */
export function composeLine(list: Seg[], width: number): string | undefined {
  if (list.length === 0) return undefined
  const avail = width - ENGINE_PREFIX
  const fulls = list.map(fullOf)
  const shown: string[] = []
  let used = 0
  for (let i = 0; i < fulls.length; i += 1) {
    const full = fulls[i] ?? ''
    const left = fulls.length - i - 1
    const more = left > 0 ? cellWidth(SEP) + cellWidth(`+${left}`) : 0
    const sep = shown.length > 0 ? cellWidth(SEP) : 0
    if (used + sep + cellWidth(full) + more > avail) break
    shown.push(full)
    used += sep + cellWidth(full)
  }
  if (shown.length === 0) return clipCells(fulls[0] ?? '', Math.max(1, avail))
  const hidden = fulls.length - shown.length
  return shown.join(SEP) + (hidden > 0 ? `${SEP}+${hidden}` : '')
}

export const colorAt = (i: number): string => PALETTE[i % PALETTE.length] ?? 'white'

/** A new record with this plugin's text set, or its key deleted when the text is empty. */
export function record(
  segs: Record<string, BarSegment>,
  plugin: string,
  text: string | undefined,
  at: number,
): Record<string, BarSegment> {
  const out = { ...segs }
  const body = clean(text)
  if (body === '') delete out[plugin]
  else out[plugin] = { plugin, text: body, at }
  return out
}

/** Stored choices over the options; a stored field of the wrong type counts as unset. */
export function resolvePrefs(stored: Partial<BarPrefs> | undefined, cfg: Config): BarPrefs {
  const s = stored ?? {}
  return {
    mode: s.mode === 'status' || s.mode === 'band' ? s.mode : cfg.mode,
    isOn: typeof s.isOn === 'boolean' ? s.isOn : true,
    hidden: Array.isArray(s.hidden) ? s.hidden.filter(x => typeof x === 'string') : [...cfg.hide],
  }
}

const clamp = (n: unknown, lo: number, hi: number, fallback: number) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback

export function readConfig(options: Readonly<Record<string, unknown>>): Config {
  const mode = options.mode === 'band' ? 'band' : 'status'
  return {
    mode,
    maxSegment: clamp(options.maxSegment, 8, 200, 40),
    width: clamp(options.width, 40, 1000, 160),
    order: parseList(typeof options.order === 'string' ? options.order : ''),
    hide: parseList(typeof options.hide === 'string' ? options.hide : ''),
  }
}

export function parseCommand(args: string | undefined): Command {
  const words = (args ?? '').trim().split(/\s+/).filter(Boolean)
  const [head, arg] = [words[0]?.toLowerCase(), words[1]]
  if (head === undefined) return { kind: 'report' }
  if (words.length === 1 && head === 'on') return { kind: 'on' }
  if (words.length === 1 && head === 'off') return { kind: 'off' }
  if (words.length === 2 && head === 'mode' && (arg === 'status' || arg === 'band')) return { kind: 'mode', mode: arg }
  if (words.length === 2 && head === 'hide' && arg) return { kind: 'hide', plugin: arg.toLowerCase() }
  if (words.length === 2 && head === 'show' && arg) return { kind: 'show', plugin: arg.toLowerCase() }
  return { kind: 'error', text: USAGE }
}

/** What `/statusbar` prints: the state, one line per plugin, the hidden ones. */
export function report(list: Seg[], prefs: BarPrefs): string {
  const lines = [
    `status-bar: ${prefs.isOn ? 'on' : 'off'} · mode ${prefs.mode} · ${list.length} ${list.length === 1 ? 'status' : 'statuses'}`,
    ...list.map(s => `  ${s.plugin} → ${fullOf(s)}`),
  ]
  if (prefs.hidden.length > 0) lines.push(`hidden: ${prefs.hidden.join(', ')}`)
  return lines.join('\n')
}
