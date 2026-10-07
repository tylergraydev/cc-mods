import type { PluginOptions } from 'claude-code'

// The pure side of walkie: config, which files in the drop folder are new,
// the prompt built from a transcript, who owns the folder, the command
// grammar and the status texts. Nothing here touches `$`.

export type Config = {
  /** The exchange folder, absolute, forward slashes, no trailing slash. */
  folder: string
  /** How often the drop folder is listed, in ms. */
  pollMs: number
  /** Submit the transcript as the person's own words, without the plugin frame. */
  asUser: boolean
  /** Write each answer to `replies/` for the recorder to read aloud. */
  speak: boolean
  /** Appended to every voice prompt; empty for none. */
  hint: string
  /** Start walkie.py from the owning session when no recorder is alive. */
  autoStart: boolean
  /** The Python executable that runs walkie.py. */
  python: string
  /** Extra arguments for walkie.py. */
  recorderArgs: string[]
  /** How old a heartbeat (the recorder's, or the owner's) may be before it counts as gone. */
  staleMs: number
}

export type Entry = { name: string; kind: 'file' | 'dir' | 'other'; mtimeMs: number }
export type Drop = { name: string; stem: string }
export type Recorder = 'on' | 'off'
/** Who consumes the folder: this session, another live session, or nobody yet. */
export type Owner = 'mine' | 'other' | 'free'

export type Command =
  | { kind: 'status' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'say'; text: string }
  | { kind: 'drop'; text: string }
  | { kind: 'start' }
  | { kind: 'stop' }
  | { kind: 'log' }
  | { kind: 'take' }
  | { kind: 'help' }

export type Snapshot = {
  folder: string
  recorder: Recorder
  owner: Owner
  /** Whether this session's own recorder child is running. */
  child: boolean
  paused: boolean
  handled: number
  pending: number
  last?: { text: string; at: number }
  now: number
}

export const DEFAULT_HINT =
  'Spoken over push-to-talk while I am away from the keyboard. Keep the reply short and plain: it is read aloud.'

export const HELP = [
  '/walkie             status: recorder, owner, folder, drops handled',
  '/walkie pause       ignore drops until resumed (mute)',
  '/walkie resume      listen again; drops made while paused are skipped',
  '/walkie say <text>  have the recorder read <text> aloud',
  '/walkie drop <text> write a drop by hand, as if it had been spoken',
  '/walkie start       start the recorder from this session',
  '/walkie stop        stop the recorder this session started; no auto-start until /walkie start',
  "/walkie log         the recorder's last lines",
  '/walkie take        make this session the one that answers the drops',
].join('\n')

const DROP = /^(\d+)\.txt$/
const DEFAULT_TEST_DROP = 'walkie test: say hello in five words'
const STAMP = /^\d\d:\d\d:\d\d /

/** A path with forward slashes, `~` expanded, no trailing slash. */
export function normalizeFolder(path: string, home: string): string {
  let p = path.replace(/\\/g, '/')
  if (p === '~' || p.startsWith('~/')) p = `${home.replace(/\\/g, '/')}${p.slice(1)}`
  return p.replace(/\/+$/, '')
}

/** A command line split on whitespace, double quotes grouping. */
export function splitArgs(text: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1] ?? m[2] ?? '')
  return out
}

/** The userConfig values with their defaults; `home` stands in for `~`. */
export function readConfig(options: PluginOptions, home: string): Config {
  const raw = typeof options.folder === 'string' ? options.folder.trim() : ''
  const poll = Number(options.pollMs)
  const python = typeof options.python === 'string' ? options.python.trim() : ''
  return {
    folder: normalizeFolder(raw || '~/.claude/walkie', home),
    pollMs: Number.isFinite(poll) && poll >= 100 ? poll : 500,
    asUser: options.asUser !== false,
    speak: options.speakReplies !== false,
    hint: typeof options.hint === 'string' ? options.hint.trim() : DEFAULT_HINT,
    autoStart: options.autoStart !== false,
    python: python || 'python.exe',
    recorderArgs: splitArgs(typeof options.recorderArgs === 'string' ? options.recorderArgs : ''),
    staleMs: 15_000,
  }
}

/** The drop files newer than the watermark, oldest first. A drop is `<epoch ms>.txt`. */
export function newDrops(entries: readonly Entry[], watermark: string): Drop[] {
  const mark = Number(watermark) || 0
  return entries
    .filter(entry => entry.kind === 'file')
    .map(entry => ({ name: entry.name, stem: DROP.exec(entry.name)?.[1] ?? '' }))
    .filter(drop => drop.stem !== '' && Number(drop.stem) > mark)
    .sort((a, b) => Number(a.stem) - Number(b.stem))
}

/** The prompt a transcript becomes: the words, then the hint in parentheses. */
export function promptText(transcript: string, hint: string): string {
  const body = transcript.trim()
  return hint ? `${body}\n\n(${hint})` : body
}

export function parseCommand(args: string): Command {
  const [head = '', ...rest] = args.trim().split(/\s+/)
  const tail = rest.join(' ').trim()
  switch (head.toLowerCase()) {
    case '':
    case 'status':
      return { kind: 'status' }
    case 'pause':
    case 'off':
    case 'mute':
      return { kind: 'pause' }
    case 'resume':
    case 'on':
    case 'unmute':
      return { kind: 'resume' }
    case 'say':
      return tail ? { kind: 'say', text: tail } : { kind: 'help' }
    case 'drop':
    case 'test':
      return { kind: 'drop', text: tail || DEFAULT_TEST_DROP }
    case 'start':
      return { kind: 'start' }
    case 'stop':
      return { kind: 'stop' }
    case 'log':
      return { kind: 'log' }
    case 'take':
      return { kind: 'take' }
    default:
      return { kind: 'help' }
  }
}

/** Whether the recorder's heartbeat file is fresh. */
export const recorderState = (mtimeMs: number | undefined, now: number, staleMs: number): Recorder =>
  mtimeMs !== undefined && now - mtimeMs < staleMs ? 'on' : 'off'

/** Who the owner file says consumes the folder: me by its text, another session while it is fresh, else free. */
export function ownership(mtimeMs: number | undefined, text: string, now: number, staleMs: number, me: string): Owner {
  if (mtimeMs === undefined) return 'free'
  if (text.trim() === me) return 'mine'
  return now - mtimeMs < staleMs ? 'other' : 'free'
}

/** A recorder log line worth a toast, without its time stamp; undefined for the rest. */
export function recorderNote(line: string): string | undefined {
  const text = line.replace(STAMP, '').trim()
  if (!text) return undefined
  const notable = /^ready:|traceback|error|failed|exiting|no input device|falling back/i.test(text)
  return notable ? `walkie: ${short(text, 100)}` : undefined
}

export const storeKey = (folder: string) => `watermark:${folder}`

export function short(text: string, max = 60): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`
}

/** The status-line text: shown only while something is worth knowing. */
export function statusLine(s: Pick<Snapshot, 'paused' | 'recorder' | 'owner'>): string | undefined {
  if (s.owner === 'other') return undefined
  if (s.paused) return 'walkie: paused'
  return s.recorder === 'on' ? '🎙 walkie' : undefined
}

export function statusReport(s: Snapshot): string {
  const recorder = s.recorder === 'off' ? 'off' : s.child ? 'on (started by this session)' : 'on (started elsewhere)'
  const owner = s.owner === 'mine' ? 'this session' : s.owner === 'other' ? 'another session (/walkie take to claim it)' : 'nobody yet'
  const lines = [
    `walkie: recorder ${recorder}${s.paused ? ', paused' : ''}`,
    `answers drops: ${owner}`,
    `folder: ${s.folder}`,
    `drops handled this session: ${s.handled}${s.pending ? ` (${s.pending} awaiting a turn)` : ''}`,
  ]
  if (s.last) lines.push(`last: "${short(s.last.text, 80)}" ${ago(s.now - s.last.at)}`)
  return lines.join('\n')
}
