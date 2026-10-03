import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { AudioHealth, CueId, KnownAgent, SoundMapping, UserSound } from '../types'
import { BUILTINS } from './builtins'
import {
  CUES,
  DEFAULTS,
  LABEL,
  MAX_USER_BYTES,
  MUTED_FOREVER,
  PRIORITY,
  askFromCheck,
  builtinPath,
  clamp,
  decide,
  inQuiet,
  isClassifierDeny,
  isLongTool,
  isWindowsRoot,
  mergeMapping,
  minuteOfDay,
  nextOf,
  parseArgs,
  parseQuiet,
  pickSound,
  psPlayArgs,
  psSpeakArgs,
  resolveSound,
  slug,
  soundOptions,
  speakText,
  statusText,
  turnCue,
  type Gate,
  type Resolved,
} from './board'
import { BENCH, fillSlot, inSlot, slotOf } from './bench'

const PANE = 'sound-board'
const TITLE = 'Sounds'
const TICK_REFRESH_MS = 60_000
const MAX_PLAYERS = 2
const CACHE_LIMIT = 1024 * 1024
const SESSION_END_MS = 600

const mapping = atom({ plugin: 'sound-board', key: 'mapping' } as const, mergeMapping(undefined))
const mutedUntil = atom({ plugin: 'sound-board', key: 'mutedUntil' } as const, null as number | null)
const lastPlayed = atom({ plugin: 'sound-board', key: 'lastPlayed' } as const, {} as Record<string, number>)
const lastPriority = atom({ plugin: 'sound-board', key: 'lastPriority' } as const, 0)
const audio = atom({ plugin: 'sound-board', key: 'audio' } as const, { isUnavailable: false, hasToasted: false } as AudioHealth)
const userSounds = atom({ plugin: 'sound-board', key: 'userSounds' } as const, [] as UserSound[])
const known = atom({ plugin: 'sound-board', key: 'known' } as const, {} as Record<string, KnownAgent>)
const isHeadless = atom({ plugin: 'sound-board', key: 'isHeadless' } as const, false)

/** The manifest's options, coerced; set by register, so a /config change reloads them. */
type Settings = {
  enabled: boolean
  volume: number
  quietHours: string
  minTurnSeconds: number
  speak: boolean
  cooldownMs: number
  player: 'auto' | 'engine' | 'powershell'
  subagentScope: 'all' | 'top'
  askVia: 'dialog' | 'check'
  longToolSeconds: number
}

let settings: Settings = {
  enabled: true, volume: 100, quietHours: '', minTurnSeconds: 20, speak: false, cooldownMs: 300,
  player: 'auto', subagentScope: 'all', askVia: 'dialog', longToolSeconds: 60,
}

let running = 0
const cache = new Map<string, string>()
const seenDenied: string[] = []

type Extra = { isTest?: boolean; description?: string }

/** Plays through whichever player fits; rejects on any failure, the caller swallows it. */
async function playSound($: EngineInterface, sound: Exclude<Resolved, 'off' | 'missing'>): Promise<void> {
  const gain = clamp(settings.volume / 100, 0, 4)
  const player = settings.player === 'auto' ? (isWindowsRoot($.plugin.root) ? 'powershell' : 'engine') : settings.player
  if (player === 'engine') {
    if (sound.kind === 'builtin') {
      await $.audio.play({ asset: `assets/sounds/${sound.file}` }, { gain })
      return
    }
    let base64 = cache.get(sound.path)
    if (base64 === undefined) {
      base64 = (await $.fs.read(sound.path, { as: 'bytes' })).base64
      if (base64.length < CACHE_LIMIT) cache.set(sound.path, base64)
    }
    await $.audio.play({ base64, mime: sound.mime }, { gain })
    return
  }
  if (running >= MAX_PLAYERS) return
  running += 1
  try {
    const path = sound.kind === 'builtin' ? builtinPath($.plugin.root, sound.file) : sound.path
    const kind = /\.mp3$/i.test(path) ? 'mp3' : 'wav'
    // the path and the volume cross by env only, never into the script
    const ran = await $.process.run(psPlayArgs(kind), { env: { SB_FILE: path, SB_VOL: String(gain) }, timeoutMs: 15_000 })
    if (ran.exitCode !== 0) throw new Error(ran.stderr.trim().split('\n')[0] || `powershell exited ${ran.exitCode}`)
  } finally {
    running -= 1
  }
}

/** Says a line with the platform's synthesizer; errors are the caller's to swallow. */
async function say($: EngineInterface, text: string): Promise<void> {
  const player = settings.player === 'auto' ? (isWindowsRoot($.plugin.root) ? 'powershell' : 'engine') : settings.player
  if (player === 'engine') {
    await $.audio.speak(text.slice(0, 200))
    return
  }
  await $.process.run(psSpeakArgs(), { env: { SB_TEXT: text }, timeoutMs: 15_000 })
}

/** One toast per session at most, then the audio stays marked unavailable. */
async function noteFailure($: EngineInterface, error: unknown) {
  const held = await read($, audio)
  const reason = String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 60)
  await update($, audio, () => ({ isUnavailable: true, reason, hasToasted: true }))
  if (!held.hasToasted) $.ui.toast(`sound-board: audio unavailable on this surface (${reason})`)
}

/** The gate the decision reads, from the held state and the options. */
async function gateOf($: EngineInterface): Promise<Gate> {
  return {
    enabled: settings.enabled,
    mutedUntil: await read($, mutedUntil),
    quiet: parseQuiet(settings.quietHours),
    cooldownMs: Math.max(0, settings.cooldownMs),
    lastPlayed: await read($, lastPlayed),
    lastPriority: await read($, lastPriority),
    isHeadless: await read($, isHeadless),
  }
}

/** A cue's sound: the mapped one, else the cue's default when the mapped file is gone. */
async function soundFor($: EngineInterface, cue: CueId): Promise<Resolved> {
  const map = await read($, mapping)
  const users = await read($, userSounds)
  const chosen = resolveSound(map.cues[cue] ?? DEFAULTS[cue], BUILTINS, users)
  return chosen === 'missing' ? resolveSound(DEFAULTS[cue], BUILTINS, users) : chosen
}

/** Plays a cue if the gate lets it. Never throws; a play that fails is noted once. */
async function fire($: EngineInterface, cue: CueId, extra: Extra = {}): Promise<string> {
  try {
    const now = await $.clock.now()
    const sound = await soundFor($, cue)
    const verdict = decide(cue, sound, await gateOf($), now, minuteOfDay(now), extra.isTest)
    if (!verdict.play) return verdict.why
    if (sound === 'off' || sound === 'missing') return 'off'
    if (!extra.isTest) {
      await update($, lastPlayed, held => ({ ...held, [cue]: now, '*': now }))
      await update($, lastPriority, () => PRIORITY[cue])
    }
    try {
      await playSound($, sound)
    } catch (error) {
      await noteFailure($, error)
      return 'failed'
    }
    if (settings.speak && !extra.isTest && (cue === 'agent.done' || cue === 'agent.failed')) {
      await say($, speakText(cue, extra.description)).catch(() => undefined)
    }
    return 'played'
  } catch {
    return 'failed'
  }
}

/** Schedules a cue after the hooked event has been answered. */
function later($: EngineInterface, cue: CueId, extra?: Extra) {
  $.clock.after(0, () => void fire($, cue, extra))
}

/** The auto-mode denial cue, once per tool call however many signals reported it. */
function denied($: EngineInterface, id: string | undefined) {
  if (id !== undefined) {
    if (seenDenied.includes(id)) return
    seenDenied.push(id)
    if (seenDenied.length > 100) seenDenied.shift()
  }
  later($, 'permission.autoDenied')
}

async function refreshStatus($: EngineInterface) {
  try {
    const now = await $.clock.now()
    $.ui.status(statusText({ enabled: settings.enabled, mutedUntil: await read($, mutedUntil), now, quiet: parseQuiet(settings.quietHours) }))
  } catch {
    // a status line is never worth an error
  }
}

async function setMute($: EngineInterface, mode: 'toggle' | 'on' | 'off' | { forMs: number }): Promise<string> {
  const now = await $.clock.now()
  const held = await read($, mutedUntil)
  const isMuted = held !== null && now < held
  const until =
    mode === 'toggle' ? (isMuted ? null : MUTED_FOREVER)
    : mode === 'on' ? MUTED_FOREVER
    : mode === 'off' ? null
    : now + mode.forMs
  await update($, mutedUntil, () => until)
  await $.store.set('mute', { until })
  await refreshStatus($)
  if (until !== null && until < MUTED_FOREVER) $.clock.after(until - now + 50, () => void refreshStatus($))
  return until === null ? 'sounds unmuted' : until >= MUTED_FOREVER ? 'sounds muted until you unmute' : `sounds muted for ${Math.round((until - now) / 60_000)} min`
}

async function setCue($: EngineInterface, cue: CueId, sound: string) {
  const held = await read($, mapping)
  const next: SoundMapping = { version: 1, cues: { ...held.cues, [cue]: sound } }
  await update($, mapping, () => next)
  await $.store.set('mapping', next)
}

/** Reads ~/.claude/sounds for .wav and .mp3 files the engine player could take. */
async function rescan($: EngineInterface): Promise<number> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  const dir = `${home}/.claude/sounds`
  let found: UserSound[] = []
  try {
    if (home !== '' && (await $.fs.exists(dir))) {
      found = (await $.fs.list(dir))
        .filter(one => one.kind === 'file' && /\.(wav|mp3)$/i.test(one.name) && one.size <= MAX_USER_BYTES)
        .map(one => ({ file: one.name, path: `${dir}/${one.name}`, size: one.size, mime: (/\.mp3$/i.test(one.name) ? 'audio/mpeg' : 'audio/wav') as UserSound['mime'] }))
        .sort((a, b) => a.file.localeCompare(b.file))
    }
  } catch {
    found = []
  }
  cache.clear()
  await update($, userSounds, () => found)
  return found.length
}

/** Opens the pane. Opened from a command the workbench would nest it into an unasked slot, so open it first. */
async function openPane($: EngineInterface) {
  try {
    if ((await $.command.list()).some(c => c.name === 'workbench')) {
      await $.ui.open({ id: 'workbench', title: 'Workbench', focus: true })
    }
  } catch {
    // the dock-first step is best effort
  }
  await $.ui.open({ id: PANE, title: TITLE })
}

const soundText = async ($: EngineInterface, cue: CueId): Promise<string> => {
  const map = await read($, mapping)
  const users = await read($, userSounds)
  const id = map.cues[cue] ?? DEFAULTS[cue]
  return resolveSound(id, BUILTINS, users) === 'missing' ? `${id} (missing, using the default)` : id
}

const num = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback)

export const register: Register = (on, options) => {
  settings = {
    enabled: options.enabled !== false,
    volume: clamp(num(options.volume, 100), 0, 200),
    quietHours: typeof options.quietHours === 'string' ? options.quietHours : '',
    minTurnSeconds: num(options.minTurnSeconds, 20),
    speak: options.speak === true,
    cooldownMs: num(options.cooldownMs, 300),
    player: pick(options.player, ['auto', 'engine', 'powershell'] as const, 'auto'),
    subagentScope: pick(options.subagentScope, ['all', 'top'] as const, 'all'),
    askVia: pick(options.askVia, ['dialog', 'check'] as const, 'dialog'),
    longToolSeconds: num(options.longToolSeconds, 60),
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      await $.command.register({ name: 'sounds', description: 'Pick, preview and mute the sound for each cue', argumentHint: '[list|test <cue>|set <cue> <sound>|mute [on|off|30m|2h]|rescan]' })
    } catch {
      // `sounds` may be taken: fall back to the long name
      await $.command.register({ name: 'sound-board', description: 'Pick, preview and mute the sound for each cue', argumentHint: '[list|test <cue>|set <cue> <sound>|mute [on|off|30m|2h]|rescan]' }).catch(() => undefined)
    }
    const storedMapping = await $.store.get('mapping')
    await update($, mapping, () => mergeMapping(storedMapping))
    const storedMute = (await $.store.get('mute')) as { until?: unknown } | undefined
    const now = await $.clock.now()
    const until = typeof storedMute?.until === 'number' && storedMute.until > now ? storedMute.until : null
    await update($, mutedUntil, () => until)
    if (until !== null && until < MUTED_FOREVER) $.clock.after(until - now + 50, () => void refreshStatus($))
    const surfaces = await $.session.surfaces().catch(() => [])
    await update($, isHeadless, () => surfaces.length === 0)
    void rescan($)
    $.clock.every(TICK_REFRESH_MS, () => void refreshStatus($))
    await refreshStatus($)

    return started
  })

  on('session.end', async ($, e, next) => {
    if (e.reason !== 'prompt_input_exit' && e.reason !== 'other' && e.reason !== 'logout') return next(e)
    // the chain shares one short bound: play inline, but never hold the exit up
    const room = Math.min(SESSION_END_MS, next.budget.remainingMs > 0 ? next.budget.remainingMs : SESSION_END_MS)
    await Promise.race([fire($, 'session.end'), $.clock.sleep(room)]).catch(() => undefined)

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    try {
      if ('agentId' in r && r.agentId) {
        const input = e as unknown as { description?: string; parentAgentId?: string }
        const entry: KnownAgent = { description: input.description ?? '', isTop: input.parentAgentId === undefined }
        const id = r.agentId
        await update($, known, held => Object.fromEntries(Object.entries({ ...held, [id]: entry }).slice(-200)))
        if (settings.subagentScope === 'all' || entry.isTop) later($, 'agent.spawn')
      }
    } catch {
      // a cue never breaks a spawn
    }

    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    try {
      const agents = await read($, known)
      const cue = turnCue(e, settings.minTurnSeconds, agents, settings.subagentScope)
      if (cue) later($, cue, { description: e.agentId !== undefined ? agents[e.agentId]?.description : undefined })
    } catch {
      // a cue never breaks a turn
    }

    return r
  })

  on('session.compact', { trigger: 'auto' }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && !('skip' in r)) later($, 'session.compactAuto')

    return r
  })

  // The permission dialog was put to the person (auto mode: only when the classifier fell back to it).
  on('classic.PermissionRequest', async ($, e, next) => {
    const r = await next(e)
    if (settings.askVia === 'dialog') later($, 'permission.ask')

    return r
  })

  // askVia "check": the engine's verdict is ask for a real call.
  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    if (settings.askVia === 'check' && askFromCheck(r as { decision?: string }, (e as unknown as { tool_use_id?: string }).tool_use_id)) {
      later($, 'permission.ask')
    }

    return r
  })

  on('classic.PermissionDenied', async ($, e, next) => {
    const r = await next(e)
    denied($, e.tool_use_id)

    return r
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as { tool: string; agentId?: string; tool_use_id?: string; run_in_background?: boolean }
    const t0 = await $.clock.now()
    const r = await next(e)
    try {
      // fallback for the classifier's denial when no PermissionDenied event came
      if (isClassifierDeny(r as { deny?: string; isError?: boolean; text?: string })) denied($, input.tool_use_id)
      else if (input.agentId === undefined && r.deny === undefined && r.isError !== true) {
        const elapsed = (await $.clock.now()) - t0
        if (isLongTool(input.tool, elapsed, settings.longToolSeconds, input)) later($, 'tool.longBash')
      }
    } catch {
      // a cue never breaks a tool call
    }

    return r
  })

  on('command.run', { command: ['sounds', 'sound-board'] }, async ($, e) => {
    const cmd = parseArgs(e.args)
    if (cmd.kind === 'error') return { text: cmd.text }
    if (cmd.kind === 'open') {
      await openPane($)
      return { text: 'Sound board opened.' }
    }
    if (cmd.kind === 'rescan') return { text: `${await rescan($)} user sound(s) in ~/.claude/sounds` }
    if (cmd.kind === 'mute') return { text: await setMute($, cmd.mode) }
    if (cmd.kind === 'list') {
      const lines = await Promise.all(CUES.map(async cue => `${cue.padEnd(22)} ${await soundText($, cue)}`))
      return { text: lines.join('\n') }
    }
    if (cmd.kind === 'test') {
      const result = await fire($, cmd.cue, { isTest: true })
      const note = (await read($, isHeadless)) ? ' (headless: real cues stay silent here)' : ''
      return { text: `${cmd.cue}: ${result === 'played' ? 'played' : result}${note}` }
    }
    const users = await read($, userSounds)
    const sound = cmd.sound.toLowerCase() === 'default' ? DEFAULTS[cmd.cue] : pickSound(cmd.sound, BUILTINS, users)
    if (sound === undefined) return { text: `set: no sound named "${cmd.sound}". Built-ins: ${BUILTINS.map(one => one.name).join(', ')}; yours: ${users.map(one => one.file).join(', ') || 'none (drop files in ~/.claude/sounds, then /sounds rescan)'}` }
    await setCue($, cmd.cue, sound)
    return { text: `${cmd.cue} → ${sound}` }
  })

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
  // mobile draws no Select: a button cycles the choices there
  const Select = e.surface !== 'mobile' && 'Select' in elements ? elements.Select : undefined
  const map = await read($, mapping)
  const users = await read($, userSounds)
  const muteAt = await read($, mutedUntil)
  const health = await read($, audio)
  const now = await $.clock.now()
  const quiet = parseQuiet(settings.quietHours)
  const isMuted = muteAt !== null && now < muteAt
  const isQuiet = inQuiet(quiet, minuteOfDay(now))
  const labelWidth = 22

  return (
    <Box flexDirection="column">
      <Box key="head" flexDirection="row">
        <Box key="title"><Text bold>SOUND BOARD  </Text></Box>
        <Button key="mute" hotkey="m" variant={isMuted ? 'primary' : undefined} onPress={() => void setMute($, 'toggle')}>
          {isMuted ? 'unmute' : 'mute'}
        </Button>
        <Button key="rescan" hotkey="r" onPress={() => void rescan($)}>rescan</Button>
        <Button key="close" hotkey="q" role="dismiss" onPress={() => void $.ui.close({ id: PANE })}>close</Button>
      </Box>
      <Box key="info" flexDirection="row">
        <Text dimColor wrap="truncate">
          {`${statusText({ enabled: settings.enabled, mutedUntil: muteAt, now, quiet }) ?? 'on'} · quiet ${settings.quietHours || 'none'}${isQuiet ? ' (now)' : ''} · player ${settings.player} · ${users.length} user sounds`}
        </Text>
      </Box>
      {health.isUnavailable && (
        <Box key="warn"><Text color="yellow" wrap="truncate">{`audio unavailable: ${health.reason ?? 'unknown'}`}</Text></Box>
      )}
      {CUES.map((one, i) => {
        const id = slug(one)
        const current = map.cues[one] ?? DEFAULTS[one]
        const options = soundOptions(BUILTINS, users, current)
        const labelOf = options.find(option => option.value === current)?.label ?? current
        return (
          <Box key={`row-${id}`} flexDirection="row">
            <Box key={`label-${id}`} width={labelWidth}><Text wrap="truncate">{LABEL[one]}</Text></Box>
            {Select ? (
              <Select key={`pick-${id}`} options={options} value={current} onSelect={(value: string) => void setCue($, one, value)} />
            ) : (
              <Button key={`cycle-${id}`} onPress={() => void setCue($, one, nextOf(options, current))}>{labelOf}</Button>
            )}
            <Button key={`test-${id}`} hotkey={i < 9 ? String(i + 1) : i === 9 ? '0' : undefined} plain dimColor={current === 'off'} onPress={() => void fire($, one, { isTest: true })}>
              ▶ test
            </Button>
          </Box>
        )
      })}
      <Box key="foot"><Text dimColor wrap="truncate">Drop .wav/.mp3 into ~/.claude/sounds, then r to rescan</Text></Box>
    </Box>
  )
}
