import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, Timer } from 'claude-code'

import {
  HELP,
  newDrops,
  ownership,
  parseCommand,
  promptText,
  readConfig,
  recorderNote,
  recorderState,
  short,
  statusLine,
  statusReport,
  storeKey,
} from './walkie'
import type { Command, Config, Owner, Recorder, Snapshot } from './walkie'

// walkie: a recorder outside Claude Code (walkie.py) turns a held mouse button
// into a transcript file under <folder>/drops. This module polls that folder,
// submits each new drop as a prompt, and leaves the answer under
// <folder>/replies for the recorder to read aloud. The session that owns the
// folder (owner.txt, refreshed while it lives) is the one that answers, and it
// starts the recorder itself when none is alive. Any other window shows a band
// with a button that takes the folder over.

const NAME = 'walkie'
const DESCRIPTION = 'Push-to-talk from any app: status, pause, resume, say, drop, start, stop, log, take'
const ARGS = '[status | pause | resume | say <text> | drop <text> | start | stop | log | take]'
const OWNER_BEAT_MS = 5_000
const SPAWN_EVERY_MS = 60_000
const SPAWN_TRIES = 3
const ANOTHER_RECORDER_CODE = 3
const LOG_LINES = 40

type Child = HookStream<ProcessSpawnChunk, ProcessSpawnResult>

const ownerAtom = atom({ plugin: 'walkie', key: 'owner' } as const, 'free' as Owner)

let cfg: Config = readConfig({}, '')
let timer: Timer | undefined
let watermark = ''
let paused = false
let handled = 0
let last: Snapshot['last']
let recorder: Recorder = 'off'
let polling = false
let lastFailure = ''
/** Drops submitted and not yet matched to a turn, oldest first. */
let pending: { stem: string; text: string }[] = []
/** The main turns that carry a voice drop: turnId → drop stem. */
const live = new Map<string, string>()

let me = ''
let owner: Owner = 'free'
let lastOwnerWrite = 0
let ownerSeen = { mtimeMs: -1, text: '' }

let child: Child | undefined
let childLog: string[] = []
let lastSpawnAt = 0
let spawnFailures = 0
/** Set by /walkie stop: no auto-start until /walkie start. */
let held = false

const snapshot = (now: number): Snapshot => ({
  folder: cfg.folder,
  recorder,
  owner,
  child: child !== undefined,
  paused,
  handled,
  pending: pending.length,
  last,
  now,
})

function refreshStatus($: EngineInterface) {
  $.ui.status(statusLine({ paused, recorder, owner }))
}

/** Records who answers the drops; the band above the prompt redraws from the atom. */
async function setOwner($: EngineInterface, who: Owner) {
  if (owner === who) return
  owner = who
  await update($, ownerAtom, () => who)
  refreshStatus($)
}

async function mark($: EngineInterface, stem: string) {
  watermark = stem
  await $.store.set(storeKey(cfg.folder), stem)
}

/** Reads the watermark, never replays drops older than this session, and starts polling. */
async function arm($: EngineInterface) {
  const stored = await $.store.get(storeKey(cfg.folder))
  watermark = typeof stored === 'string' ? stored : ''
  const now = await $.clock.now()
  if (!watermark || Number(watermark) > now) await mark($, String(now))
  timer?.cancel()
  timer = $.clock.every(cfg.pollMs, () => {
    void poll($)
  })
  refreshStatus($)
}

/** Makes this session the one that answers: the owner file is written now, and drops from before are skipped. */
async function takeOwnership($: EngineInterface, now: number) {
  await $.fs.write(`${cfg.folder}/owner.txt`, me)
  lastOwnerWrite = now
  // drops spoken while another window (or nobody) was answering are not replayed here
  if (owner !== 'mine') await mark($, String(now))
  await setOwner($, 'mine')
}

/** Takes the folder when nobody live has it, keeps it while this session lives, and stands back otherwise. */
async function claim($: EngineInterface, now: number) {
  const path = `${cfg.folder}/owner.txt`
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat && stat.mtimeMs !== ownerSeen.mtimeMs) ownerSeen = { mtimeMs: stat.mtimeMs, text: await $.fs.read(path).catch(() => '') }
  const state = ownership(stat?.mtimeMs, stat ? ownerSeen.text : '', now, cfg.staleMs, me)
  if (state === 'other') {
    await setOwner($, 'other')
    return
  }
  if (state === 'free' || owner !== 'mine') {
    await takeOwnership($, now)
    return
  }
  if (now - lastOwnerWrite >= OWNER_BEAT_MS) {
    await $.fs.write(path, me)
    lastOwnerWrite = now
  }
}

/** One poll: ownership, the recorder's heartbeat, then every new drop, oldest first. */
async function poll($: EngineInterface) {
  if (polling) return
  polling = true
  try {
    const now = await $.clock.now()
    await claim($, now)
    const beat = await $.fs.stat(`${cfg.folder}/recorder.json`).catch(() => undefined)
    const state = recorderState(beat?.mtimeMs, now, cfg.staleMs)
    if (state !== recorder) {
      recorder = state
      refreshStatus($)
    }
    if (owner !== 'mine') return
    if (state === 'off' && cfg.autoStart && !held && !child) spawnRecorder($, now)
    if (paused) return
    const dir = `${cfg.folder}/drops`
    if (!(await $.fs.exists(dir))) return
    for (const drop of newDrops(await $.fs.list(dir), watermark)) {
      await mark($, drop.stem)
      const text = (await $.fs.read(`${dir}/${drop.name}`).catch(() => '')).trim()
      if (text) void submitDrop($, drop.stem, text, now)
    }
    lastFailure = ''
  } catch (err) {
    const reason = String(err)
    if (reason !== lastFailure) {
      lastFailure = reason
      $.ui.toast(`walkie: ${reason}`)
    }
  } finally {
    polling = false
  }
}

/** Starts walkie.py as a child of this session, at most once a minute and three failures in a row. */
function spawnRecorder($: EngineInterface, now: number): string {
  if (child) return 'The recorder this session started is still running.'
  if (now - lastSpawnAt < SPAWN_EVERY_MS || spawnFailures >= SPAWN_TRIES) return 'Not retrying yet; /walkie start forces it.'
  lastSpawnAt = now
  const argv = [cfg.python, `${$.plugin.root}/walkie.py`, '--folder', cfg.folder, ...cfg.recorderArgs]
  const stream = $.process.spawn({ argv, cwd: $.plugin.root })
  child = stream
  childLog = []
  void pump($, stream)
  return `Starting the recorder: ${argv.join(' ')}`
}

/** The child's life: its lines go to the debug log and the notable ones to a toast; its exit is counted. */
async function pump($: EngineInterface, stream: Child) {
  let code: number | null = null
  let buffer = ''
  try {
    for (;;) {
      const step = await stream.next()
      if (step.done) {
        code = step.value?.code ?? null
        break
      }
      buffer += step.value.text
      const end = buffer.lastIndexOf('\n')
      if (end < 0) continue
      const lines = buffer.slice(0, end).split('\n')
      buffer = buffer.slice(end + 1)
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '')
        if (!line.trim()) continue
        childLog = [...childLog.slice(-(LOG_LINES - 1)), line]
        $.ui.log(`walkie: ${line}`, { to: 'debug' })
        const note = recorderNote(line)
        if (note) $.ui.toast(note)
      }
    }
  } catch (err) {
    childLog = [...childLog.slice(-(LOG_LINES - 1)), String(err)]
  }
  if (child !== stream) return // stopped on purpose, or replaced
  child = undefined
  if (code === ANOTHER_RECORDER_CODE) return // one is already running outside this session
  spawnFailures += 1
  const givingUp = spawnFailures >= SPAWN_TRIES ? '; giving up, /walkie start to retry' : ''
  $.ui.toast(`walkie: recorder exited (code ${code ?? '?'})${givingUp}`)
}

function stopRecorder(): string {
  held = true
  const stream = child
  child = undefined
  if (!stream) return 'This session has no recorder running. Auto-start is off until /walkie start.'
  void stream.return({ code: null, signal: null }).catch(() => undefined)
  return 'Recorder stopped. Auto-start is off until /walkie start.'
}

/** Submits one transcript as a turn of its own; when it cannot enter, the prompt box gets it instead. */
async function submitDrop($: EngineInterface, stem: string, text: string, now: number) {
  handled += 1
  last = { text, at: now }
  pending.push({ stem, text })
  $.ui.toast(`🎙 ${short(text)}`)
  const body = promptText(text, cfg.hint)
  let reason: string | undefined
  try {
    const r = await $.prompt.submit(cfg.asUser ? { text: body, asUser: true } : { text: body })
    reason = r.drop
  } catch (err) {
    reason = String(err)
  }
  if (reason === undefined) return
  pending = pending.filter(p => p.stem !== stem)
  $.ui.toast(`walkie: prompt not sent (${reason})`)
  const box = await $.prompt.read()
  if (!box.text.trim()) await $.prompt.fill({ text: body, mode: 'replace' })
}

async function runCommand($: EngineInterface, c: Command): Promise<string> {
  const now = await $.clock.now()
  switch (c.kind) {
    case 'status':
      return statusReport(snapshot(now))
    case 'pause':
      paused = true
      refreshStatus($)
      return 'walkie paused: drops are ignored until /walkie resume.'
    case 'resume':
      paused = false
      await mark($, String(now))
      refreshStatus($)
      return 'walkie listening again.'
    case 'say':
      await $.fs.write(`${cfg.folder}/replies/${now}.txt`, c.text)
      return 'Handed to the recorder to read aloud.'
    case 'drop':
      await $.fs.write(`${cfg.folder}/drops/${now}.txt`, c.text)
      return 'Dropped; the next poll submits it as a voice prompt.'
    case 'start':
      held = false
      spawnFailures = 0
      lastSpawnAt = 0
      if (recorder === 'on' && !child) return 'A recorder is already running outside this session.'
      return spawnRecorder($, now)
    case 'stop':
      return stopRecorder()
    case 'log':
      return childLog.length ? childLog.slice(-15).join('\n') : 'No recorder output in this session yet.'
    case 'take':
      await takeOwnership($, now)
      return 'This session now answers the drops.'
    case 'help':
      return HELP
  }
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    cfg = readConfig(options, home)
    try {
      me = await $.session.id()
    } catch {
      me = ''
    }
    if (!me) me = `walkie-${Math.random().toString(36).slice(2)}`
    try {
      await $.command.register({ name: NAME, description: DESCRIPTION, argumentHint: ARGS })
    } catch {
      // the name is taken; the folder still works without the command
    }
    await arm($)
    return r
  })

  // A voice drop's turn is known by its text: the drop's words are in the prompt as submitted.
  on('turn.start', ($, e, next) => {
    const p = pending.find(one => e.text.includes(one.text))
    if (p) {
      pending = pending.filter(one => one !== p)
      live.set(e.turnId, p.stem)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const stem = e.agentId ? undefined : live.get(e.turnId)
    if (stem === undefined) return r
    live.delete(e.turnId)
    if (cfg.speak && e.reason === 'answer' && e.answer.trim()) {
      await $.fs.write(`${cfg.folder}/replies/${stem}.txt`, e.answer).catch(err => {
        $.ui.toast(`walkie: could not write the reply (${String(err)})`)
      })
    }
    return r
  })

  // In a window that is not the target: one line and a button that makes it the target.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const who = await read($, ownerAtom)
    if (who !== 'other' || e.props.hasSurvey || e.props.view.agentId) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box key="walkie-band" flexDirection="row">
        <Box key="band-text">
          <Text dimColor>🎙 walkie answers in another window </Text>
        </Box>
        <Button
          key="take"
          label="Answer here"
          hotkey="w"
          variant="primary"
          onPress={async () => {
            await takeOwnership($, await $.clock.now())
          }}
        />
      </Box>
    )
  })

  on('command.run', { command: NAME }, async ($, e) => ({ text: await runCommand($, parseCommand(e.args)) }))
}
