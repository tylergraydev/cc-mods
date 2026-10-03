import type { CueId, KnownAgent, SoundId, SoundMapping, UserSound } from '../types'
import type { Builtin } from './builtins'

// Pure logic for the sound board: cues, defaults, the play decision, quiet
// hours, the /sounds argument parser, sound resolution, a RIFF reader and the
// fixed PowerShell scripts. Nothing here touches `$`; register.tsx does.

export const CUES: readonly CueId[] = [
  'agent.spawn',
  'agent.done',
  'agent.failed',
  'permission.ask',
  'permission.autoDenied',
  'turn.done',
  'turn.failed',
  'session.compactAuto',
  'session.end',
  'tool.longBash',
]

export const LABEL: Record<CueId, string> = {
  'agent.spawn': 'Agent starts',
  'agent.done': 'Agent finishes',
  'agent.failed': 'Agent fails',
  'permission.ask': 'Permission asked',
  'permission.autoDenied': 'Auto mode denied',
  'turn.done': 'Answer finished',
  'turn.failed': 'Turn failed',
  'session.compactAuto': 'Auto compact',
  'session.end': 'Session ends',
  'tool.longBash': 'Long command done',
}

export const DEFAULTS: Record<CueId, SoundId> = {
  'agent.spawn': 'builtin:agent-spawn',
  'agent.done': 'builtin:agent-done',
  'agent.failed': 'builtin:agent-failed',
  'permission.ask': 'builtin:permission-ask',
  'permission.autoDenied': 'builtin:permission-denied',
  'turn.done': 'builtin:turn-done',
  'turn.failed': 'builtin:turn-failed',
  'session.compactAuto': 'builtin:compact',
  'session.end': 'builtin:session-end',
  'tool.longBash': 'builtin:long-tool',
}

/** Higher wins the same tick: a denial is heard over a spawn ping. */
export const PRIORITY: Record<CueId, number> = {
  'session.compactAuto': 1,
  'agent.spawn': 2,
  'tool.longBash': 2,
  'session.end': 3,
  'agent.done': 4,
  'turn.done': 5,
  'agent.failed': 6,
  'turn.failed': 7,
  'permission.ask': 8,
  'permission.autoDenied': 9,
}

/** The mute's end for "until I unmute". */
export const MUTED_FOREVER = 8.64e15
/** Two cues closer than this are one tick. */
export const TICK_MS = 120
export const MAX_USER_BYTES = 4 * 1024 * 1024

/** A cue's file slug, as a pane key: `agent.spawn` becomes `agent-spawn`. */
export const slug = (cue: CueId): string => cue.replace(/\./g, '-')

export const isCue = (value: unknown): value is CueId => typeof value === 'string' && (CUES as readonly string[]).includes(value)

/** The stored mapping laid over the defaults; anything malformed falls back. */
export function mergeMapping(stored: unknown): SoundMapping {
  const cues: Partial<Record<CueId, SoundId>> = { ...DEFAULTS }
  const raw = (stored as { cues?: unknown } | null | undefined)?.cues
  if (typeof raw === 'object' && raw !== null) {
    for (const [key, value] of Object.entries(raw)) {
      if (isCue(key) && typeof value === 'string' && value !== '') cues[key] = value
    }
  }
  return { version: 1, cues }
}


export type Resolved =
  | { kind: 'builtin'; file: string; durationMs: number }
  | { kind: 'user'; path: string; mime: UserSound['mime'] }
  | 'off'
  | 'missing'

export function resolveSound(id: SoundId, builtins: readonly Builtin[], users: readonly UserSound[]): Resolved {
  if (id === 'off') return 'off'
  if (id.startsWith('builtin:')) {
    const found = builtins.find(one => one.name === id.slice(8))
    return found ? { kind: 'builtin', file: found.file, durationMs: found.durationMs } : 'missing'
  }
  if (id.startsWith('user:')) {
    const found = users.find(one => one.file === id.slice(5))
    return found ? { kind: 'user', path: found.path, mime: found.mime } : 'missing'
  }
  return 'missing'
}

/** Every pickable sound as a Select option, the current one kept even when missing. */
export function soundOptions(builtins: readonly Builtin[], users: readonly UserSound[], current?: SoundId) {
  const list = [
    ...builtins.map(one => ({ value: `builtin:${one.name}`, label: `${one.name} (${one.label})` })),
    ...users.map(one => ({ value: `user:${one.file}`, label: `★ ${one.file}` })),
    { value: 'off', label: 'off' },
  ]
  if (current !== undefined && !list.some(one => one.value === current)) list.push({ value: current, label: `${current.replace(/^user:/, '')} (missing)` })
  return list
}

/** The next option after `current`, wrapping; for a surface with no Select. */
export function nextOf(options: readonly { value: string }[], current: string): string {
  const at = options.findIndex(one => one.value === current)
  return options[(at + 1) % Math.max(1, options.length)]?.value ?? current
}

/** A sound named by hand: `builtin:bell`, `bell`, `my ding` or `my ding.wav`; undefined when none matches. */
export function pickSound(raw: string, builtins: readonly Builtin[], users: readonly UserSound[]): SoundId | undefined {
  const low = raw.trim().toLowerCase()
  if (low === 'off' || low === 'none' || low === 'silent') return 'off'
  const bare = (file: string) => file.toLowerCase().replace(/\.(wav|mp3)$/, '')
  const user = users.find(one => one.file.toLowerCase() === low.replace(/^user:/, '') || bare(one.file) === low.replace(/^user:/, ''))
  if (user) return `user:${user.file}`
  const builtin = builtins.find(one => one.name === low.replace(/^builtin:/, ''))
  return builtin ? `builtin:${builtin.name}` : undefined
}

// ---- quiet hours ----

export type QuietRange = { start: number; end: number }

/** `22:00-08:00` as minutes of the day; empty or malformed is null. */
export function parseQuiet(text: string): QuietRange | null {
  const match = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(text)
  if (!match) return null
  const [h1, m1, h2, m2] = match.slice(1).map(Number) as [number, number, number, number]
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null
  const start = h1 * 60 + m1
  const end = h2 * 60 + m2
  return start === end ? null : { start, end }
}

export function inQuiet(range: QuietRange | null, minute: number): boolean {
  if (!range) return false
  return range.start < range.end ? minute >= range.start && minute < range.end : minute >= range.start || minute < range.end
}

export const minuteOfDay = (now: number): number => {
  const d = new Date(now)
  return d.getHours() * 60 + d.getMinutes()
}

const two = (n: number) => String(n).padStart(2, '0')
export const clockText = (minutes: number): string => `${two(Math.floor(minutes / 60) % 24)}:${two(minutes % 60)}`

// ---- the play decision ----

export type Gate = {
  enabled: boolean
  mutedUntil: number | null
  quiet: QuietRange | null
  cooldownMs: number
  lastPlayed: Record<string, number>
  lastPriority: number
  isHeadless: boolean
}

export type Verdict = { play: true } | { play: false; why: 'disabled' | 'headless' | 'muted' | 'quiet' | 'off' | 'cooldown' | 'busy' }

export function decide(cue: CueId, sound: Resolved, g: Gate, now: number, minute: number, isTest = false): Verdict {
  if (sound === 'off') return { play: false, why: 'off' }
  if (isTest) return { play: true }
  if (!g.enabled) return { play: false, why: 'disabled' }
  if (g.isHeadless) return { play: false, why: 'headless' }
  if (g.mutedUntil !== null && now < g.mutedUntil) return { play: false, why: 'muted' }
  if (inQuiet(g.quiet, minute)) return { play: false, why: 'quiet' }
  const last = g.lastPlayed[cue]
  if (last !== undefined && now - last < g.cooldownMs) return { play: false, why: 'cooldown' }
  const any = g.lastPlayed['*']
  if (any !== undefined && now - any < TICK_MS && PRIORITY[cue] <= g.lastPriority) return { play: false, why: 'busy' }
  return { play: true }
}

// ---- classifiers ----

export type TurnLike = { reason: string; durationMs: number; isAborted?: boolean; agentId?: string }

/** The cue a finished turn raises, if any. `known` holds the subagents this mod saw start. */
export function turnCue(e: TurnLike, minTurnSeconds: number, known: Record<string, KnownAgent>, scope: 'all' | 'top'): CueId | undefined {
  if (e.isAborted || e.reason === 'aborted') return undefined
  const failed = e.reason === 'error' || e.reason === 'refusal'
  if (e.agentId !== undefined) {
    const agent = known[e.agentId]
    if (!agent || (scope === 'top' && !agent.isTop)) return undefined
    if (e.reason === 'answer') return 'agent.done'
    return failed ? 'agent.failed' : undefined
  }
  if (failed) return 'turn.failed'
  if (e.reason === 'answer' && e.durationMs >= Math.max(0, minTurnSeconds) * 1000) return 'turn.done'
  return undefined
}

const CLASSIFIER = /auto[- ]mode classifier/i

/** A tool.call result that says the auto-mode classifier refused the call. */
export function isClassifierDeny(r: { deny?: string; isError?: boolean; text?: string } | undefined): boolean {
  if (!r) return false
  const text = r.deny ?? (r.isError ? r.text : undefined)
  return typeof text === 'string' && CLASSIFIER.test(text)
}

/** askVia "check": a real call (it has a tool_use_id) whose verdict is ask. */
export const askFromCheck = (r: { decision?: string } | undefined, toolUseId: string | undefined): boolean =>
  r?.decision === 'ask' && toolUseId !== undefined

export const isLongTool = (tool: string, elapsedMs: number, seconds: number, input: { run_in_background?: boolean }): boolean =>
  (tool === 'Bash' || tool === 'PowerShell') && seconds > 0 && input.run_in_background !== true && elapsedMs >= seconds * 1000

// ---- /sounds ----

export type Command =
  | { kind: 'open' }
  | { kind: 'list' }
  | { kind: 'rescan' }
  | { kind: 'test'; cue: CueId }
  | { kind: 'set'; cue: CueId; sound: string }
  | { kind: 'mute'; mode: 'toggle' | 'on' | 'off' | { forMs: number } }
  | { kind: 'error'; text: string }

const ALIASES: Record<string, CueId> = {
  spawn: 'agent.spawn',
  done: 'agent.done',
  failed: 'agent.failed',
  ask: 'permission.ask',
  autodenied: 'permission.autoDenied',
  denied: 'permission.autoDenied',
  compactauto: 'session.compactAuto',
  compact: 'session.compactAuto',
  end: 'session.end',
  longbash: 'tool.longBash',
  long: 'tool.longBash',
}

/** `agent.spawn`, `spawn`, `autoDenied`..., case-insensitive. */
export function cueFromName(name: string): CueId | undefined {
  const low = name.trim().toLowerCase()
  const full = CUES.find(one => one.toLowerCase() === low)
  if (full) return full
  return ALIASES[low.includes('.') ? low.slice(low.lastIndexOf('.') + 1) : low]
}

/** `30m`, `90s`, `2h`, `1h30m` as ms; undefined when it is not a duration. */
export function parseDuration(text: string): number | undefined {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(text.trim())
  if (!match || (match[1] === undefined && match[2] === undefined && match[3] === undefined)) return undefined
  const ms = (Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) * 1000
  return ms > 0 ? ms : undefined
}

export const USAGE = 'usage: /sounds [list | test <cue> | set <cue> <sound|default|off> | mute [on|off|30m|2h] | rescan]'

export function parseArgs(args: string): Command {
  const text = args.trim()
  if (text === '') return { kind: 'open' }
  const [verb = '', ...rest] = text.split(/\s+/)
  const word = verb.toLowerCase()
  if (word === 'list') return { kind: 'list' }
  if (word === 'rescan') return { kind: 'rescan' }
  if (word === 'unmute') return { kind: 'mute', mode: 'off' }
  if (word === 'mute') {
    const arg = (rest[0] ?? '').toLowerCase()
    if (arg === '') return { kind: 'mute', mode: 'toggle' }
    if (arg === 'on') return { kind: 'mute', mode: 'on' }
    if (arg === 'off' || arg === 'unmute') return { kind: 'mute', mode: 'off' }
    const forMs = parseDuration(arg)
    return forMs === undefined
      ? { kind: 'error', text: `mute: "${rest[0]}" is not on, off or a duration like 30m. ${USAGE}` }
      : { kind: 'mute', mode: { forMs } }
  }
  if (word === 'test') {
    const cue = cueFromName(rest[0] ?? '')
    return cue ? { kind: 'test', cue } : { kind: 'error', text: `test: unknown cue "${rest[0] ?? ''}". Cues: ${CUES.join(', ')}` }
  }
  if (word === 'set') {
    const cue = cueFromName(rest[0] ?? '')
    if (!cue) return { kind: 'error', text: `set: unknown cue "${rest[0] ?? ''}". Cues: ${CUES.join(', ')}` }
    const sound = rest.slice(1).join(' ').trim()
    return sound === '' ? { kind: 'error', text: `set: name a sound for ${cue}. ${USAGE}` } : { kind: 'set', cue, sound }
  }
  return { kind: 'error', text: `unknown subcommand "${verb}". ${USAGE}` }
}

// ---- status ----

export type StatusInput = { enabled: boolean; mutedUntil: number | null; now: number; quiet: QuietRange | null }

/** The status line entry, or undefined while sounds simply play. */
export function statusText(s: StatusInput): string | undefined {
  if (!s.enabled) return '🔇 off'
  if (s.mutedUntil !== null && s.now < s.mutedUntil) {
    return s.mutedUntil >= MUTED_FOREVER ? '🔇 muted' : `🔇 until ${clockText(minuteOfDay(s.mutedUntil))}`
  }
  if (s.quiet && inQuiet(s.quiet, minuteOfDay(s.now))) return `🔇 quiet until ${clockText(s.quiet.end)}`
  return undefined
}

// ---- WAV header ----

export type WavInfo = { sampleRate: number; channels: number; bitsPerSample: number; dataBytes: number; durationMs: number }

/** Reads a RIFF/WAVE header (PCM, little-endian) out of its first bytes. */
export function readWavHeader(bytes: readonly number[]): WavInfo | { error: string } {
  const text = (at: number) => String.fromCharCode(...bytes.slice(at, at + 4))
  const u16 = (at: number) => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8)
  const u32 = (at: number) => u16(at) + u16(at + 2) * 65536
  if (bytes.length < 12 || text(0) !== 'RIFF' || text(8) !== 'WAVE') return { error: 'not a RIFF/WAVE file' }
  let at = 12
  let fmt: { sampleRate: number; channels: number; bitsPerSample: number } | undefined
  while (at + 8 <= bytes.length) {
    const id = text(at)
    const size = u32(at + 4)
    if (id === 'fmt ') {
      if (u16(at + 8) !== 1) return { error: 'not PCM' }
      fmt = { channels: u16(at + 10), sampleRate: u32(at + 12), bitsPerSample: u16(at + 22) }
    } else if (id === 'data') {
      if (!fmt) return { error: 'data before fmt' }
      const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8)
      return { ...fmt, dataBytes: size, durationMs: bytesPerSecond > 0 ? Math.round((size / bytesPerSecond) * 1000) : 0 }
    }
    at += 8 + size + (size % 2)
  }
  return { error: 'no data chunk' }
}

// ---- PowerShell ----

const POWERSHELL = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']

const WAV_SCRIPT = '(New-Object System.Media.SoundPlayer $env:SB_FILE).PlaySync()'
const MP3_SCRIPT =
  'Add-Type -AssemblyName PresentationCore; $p=New-Object System.Windows.Media.MediaPlayer; $p.Volume=[Math]::Min(1,[double]$env:SB_VOL); $p.Open([Uri]$env:SB_FILE); $i=0; while(-not $p.NaturalDuration.HasTimeSpan -and $i -lt 40){Start-Sleep -m 50;$i++}; $p.Play(); $ms= if($p.NaturalDuration.HasTimeSpan){[int]$p.NaturalDuration.TimeSpan.TotalMilliseconds+150}else{3000}; Start-Sleep -m ([Math]::Min($ms,10000)); $p.Close()'
const SPEAK_SCRIPT = 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak($env:SB_TEXT)'

/** The argv for a fixed script: the file, the volume and the text cross by env only. */
export const psPlayArgs = (kind: 'wav' | 'mp3'): string[] => [...POWERSHELL, kind === 'wav' ? WAV_SCRIPT : MP3_SCRIPT]
export const psSpeakArgs = (): string[] => [...POWERSHELL, SPEAK_SCRIPT]

/** A builtin's absolute path under the plugin root, Windows spelling. */
export const builtinPath = (root: string, file: string): string => `${root.replace(/[\\/]+$/, '')}\\assets\\sounds\\${file}`

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo))

export const isWindowsRoot = (root: string): boolean => /^[A-Za-z]:/.test(root)

export const speakText = (cue: CueId, description: string | undefined): string =>
  `${cue === 'agent.failed' ? 'agent failed' : 'agent done'}: ${description || 'subagent'}`.slice(0, 200)
