import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  EMPTY,
  REQUEST_PREFIX,
  bandLine,
  cleared,
  compactLine,
  compacted,
  contextLine,
  currentHandoff,
  fit,
  handoffPath,
  isGitCommit,
  isHandoffPath,
  meterOf,
  normalizePath,
  parseArgs,
  pct,
  readConfig,
  recorded,
  relativeTo,
  requestText,
  resumeKey,
  resumeText,
  stampOf,
  statusReport,
  statusText,
  storeKey,
  turnEnd,
  withCompactInstructions,
} from './watch'
import type { Checkpoint, Config, State } from './watch'

const NAMES = ['handoff', 'handoff-watch'] as const
const DESCRIPTION = 'Write a session handoff doc (or: done | status | resume)'
const HINT = '[focus | TICKET-123 | done | status | resume]'

const meter = atom({ plugin: 'handoff-watch', key: 'meter' } as const, EMPTY.meter)
const lastHandoff = atom({ plugin: 'handoff-watch', key: 'lastHandoff' } as const, EMPTY.lastHandoff)
const nudge = atom({ plugin: 'handoff-watch', key: 'nudge' } as const, EMPTY.nudge)
const firedBand = atom({ plugin: 'handoff-watch', key: 'firedBand' } as const, EMPTY.firedBand)
const urgentFired = atom({ plugin: 'handoff-watch', key: 'urgentFired' } as const, EMPTY.urgentFired)
const turnsWaited = atom({ plugin: 'handoff-watch', key: 'turnsWaited' } as const, EMPTY.turnsWaited)
const turns = atom({ plugin: 'handoff-watch', key: 'turns' } as const, EMPTY.turns)
const lastCheckpointTurn = atom({ plugin: 'handoff-watch', key: 'lastCheckpointTurn' } as const, EMPTY.lastCheckpointTurn)
const requestedPath = atom({ plugin: 'handoff-watch', key: 'requestedPath' } as const, EMPTY.requestedPath)
const compactions = atom({ plugin: 'handoff-watch', key: 'compactions' } as const, EMPTY.compactions)
const lastCompactAt = atom({ plugin: 'handoff-watch', key: 'lastCompactAt' } as const, EMPTY.lastCompactAt)

/** The whole state as one value. Reads subscribe a render; writes go through `save`. */
async function load($: EngineInterface): Promise<State> {
  return {
    meter: await read($, meter),
    lastHandoff: await read($, lastHandoff),
    nudge: await read($, nudge),
    firedBand: await read($, firedBand),
    urgentFired: await read($, urgentFired),
    turnsWaited: await read($, turnsWaited),
    turns: await read($, turns),
    lastCheckpointTurn: await read($, lastCheckpointTurn),
    requestedPath: await read($, requestedPath),
    compactions: await read($, compactions),
    lastCompactAt: await read($, lastCompactAt),
  }
}

/** Writes back only what changed. Called from event hooks and press handlers, never while rendering. */
async function save($: EngineInterface, was: State, now: State) {
  if (was.meter !== now.meter) await update($, meter, () => now.meter)
  if (was.lastHandoff !== now.lastHandoff) await update($, lastHandoff, () => now.lastHandoff)
  if (was.nudge !== now.nudge) await update($, nudge, () => now.nudge)
  if (was.firedBand !== now.firedBand) await update($, firedBand, () => now.firedBand)
  if (was.urgentFired !== now.urgentFired) await update($, urgentFired, () => now.urgentFired)
  if (was.turnsWaited !== now.turnsWaited) await update($, turnsWaited, () => now.turnsWaited)
  if (was.turns !== now.turns) await update($, turns, () => now.turns)
  if (was.lastCheckpointTurn !== now.lastCheckpointTurn) await update($, lastCheckpointTurn, () => now.lastCheckpointTurn)
  if (was.requestedPath !== now.requestedPath) await update($, requestedPath, () => now.requestedPath)
  if (was.compactions !== now.compactions) await update($, compactions, () => now.compactions)
  if (was.lastCompactAt !== now.lastCompactAt) await update($, lastCompactAt, () => now.lastCompactAt)
}

/** Load, change, write back: the one way a handler touches state. */
async function change($: EngineInterface, fn: (s: State) => State): Promise<State> {
  const was = await load($)
  const now = fn(was)
  await save($, was, now)
  return now
}

// Module variables start over on a hot reload; a turn in flight at that moment counts as busy, never quiet.
let cfg: Config = readConfig({})
let cwd = ''
let toolsThisTurn = 0
let commitThisTurn = false
let sawTurnStart = false
// The handoff doc written in the turn under way, if any: the turn's end clears and resumes from it.
let writtenThisTurn: string | null = null
// What the last breakdown call said about the auto-compact point; the plain readings never carry it.
let threshold: number | undefined
let isAutoCompact: boolean | undefined
let sessionStartedAt = 0

function resetTurn() {
  toolsThisTurn = 0
  commitThisTurn = false
  sawTurnStart = false
  writtenThisTurn = null
}

async function refreshStatus($: EngineInterface) {
  const s = await load($)
  $.ui.status(statusText({ ...s, cfg }))
}

/** Reads the window. With `withCeiling` it also asks for the breakdown, which carries the auto-compact point. */
async function refreshMeter($: EngineInterface, opts: { withCeiling?: boolean; keepTokens?: boolean } = {}) {
  const u = await $.session.usage(opts.withCeiling ? { breakdown: 'summary' } : undefined).catch(() => undefined)
  if (!u) return
  const b = u.context.breakdown
  if (opts.withCeiling && b) {
    threshold = b.autoCompactThreshold
    isAutoCompact = b.isAutoCompactEnabled
    $.ui.log(`handoff-watch: breakdown autoCompactThreshold=${String(b.autoCompactThreshold)} isAutoCompactEnabled=${String(b.isAutoCompactEnabled)} window=${u.context.window}`, { to: 'debug' })
  }
  sessionStartedAt = u.startedAt
  const now = await $.clock.now()
  await change($, s => ({
    ...s,
    meter: meterOf(s.meter, u.context, { threshold, isAutoCompact, now, keepTokens: opts.keepTokens }),
  }))
}

type Stored = { path: string | null; at: number; fill: number | null; epoch: number; compactions: number; sessionStartedAt: number }

async function writeStore($: EngineInterface, s: State) {
  const h = s.lastHandoff
  if (!h || !cwd) return
  const stored: Stored = { path: h.path, at: h.at, fill: h.fill, epoch: h.epoch, compactions: s.compactions, sessionStartedAt }
  await $.store.set(storeKey(cwd), stored)
}

/** A resumed session starts with empty state: take the last handoff back when the store's is this session's. */
async function restoreFromStore($: EngineInterface) {
  const stored = (await $.store.get(storeKey(cwd))) as Stored | undefined
  if (!stored || typeof stored !== 'object' || stored.sessionStartedAt !== sessionStartedAt) return
  await change($, s =>
    s.lastHandoff
      ? s
      : { ...s, compactions: stored.compactions, lastHandoff: { fill: stored.fill, path: stored.path, at: stored.at, epoch: stored.epoch, source: 'detected' } },
  )
}

/** A handoff was written (path) or marked done (null). */
async function recordHandoff($: EngineInterface, path: string | null, source: 'detected' | 'done') {
  const now = await $.clock.now()
  const s = await change($, was => recorded(was, path, source, now))
  const at = s.lastHandoff?.fill ?? null
  $.ui.toast(path ? `handoff saved: ${relativeTo(path, cwd)}` : `handoff-watch: marked a handoff${at === null ? '' : ` at ${pct(at)}`}`)
  await writeStore($, s)
  await refreshStatus($)
}

/** Puts the handoff request into the prompt box, after whatever draft is there. */
async function writeRequest($: EngineInterface, focus?: string, id?: string) {
  const now = await $.clock.now()
  const path = handoffPath(cfg.handoffDir, stampOf(new Date(now)), id)
  const stored = (await $.store.get(storeKey(cwd))) as Stored | undefined
  const text = requestText({ path, focus, previous: stored?.path })
  const box = await $.prompt.read()
  const r = await $.prompt.fill(box.text.trim() ? { text: `\n\n${text}`, mode: 'append' } : { text, mode: 'replace' })
  await change($, s => ({ ...s, requestedPath: path, nudge: null }))
  await refreshStatus($)
  return { path, text, isFilled: r.isFilled, refusal: r.refusal }
}

/** The /handoff command: request a doc, mark one done, or report. */
async function runHandoff($: EngineInterface, args: string) {
  const cmd = parseArgs(args)
  if (cmd.kind === 'status') return { text: statusReport(await load($), cfg, await $.clock.now()) }
  if (cmd.kind === 'done') {
    await recordHandoff($, null, 'done')
    const at = (await load($)).meter.fill
    return { text: `Marked a handoff${at === null ? '' : ` at ${pct(at)} context`}.` }
  }
  if (cmd.kind === 'resume') {
    const stored = (await $.store.get(storeKey(cwd))) as Stored | undefined
    if (!stored?.path) return { text: 'No handoff doc recorded for this project yet.' }
    // A prompt cannot enter from the command's own hook (the host refuses it); it goes once this run is over.
    const path = stored.path
    $.clock.after(0, () => void submitResume($, path))
    return { text: `Resuming from ${relativeTo(path, cwd)}.` }
  }
  const r = await writeRequest($, cmd.focus, cmd.id)
  return {
    text: r.isFilled
      ? `Handoff request is in the prompt → ${r.path}. Edit it and press Enter.`
      : `Could not fill the prompt (${r.refusal ?? 'no prompt box'}). Request:\n\n${r.text}`,
  }
}

type Relay = () => Promise<{ deny?: unknown; isError?: boolean }>

/** A commit that went through is a natural stopping point. */
async function afterCommit($: EngineInterface, e: { agentId?: string; command: string }, next: Relay) {
  const r = await next()
  if (!e.agentId && isGitCommit(e.command) && !r.deny && !r.isError) {
    commitThisTurn = true
    await change($, s => ({ ...s, lastCheckpointTurn: s.turns + 1 }))
  }
  return r
}

/** A write of a handoff doc, from any loop: a subagent may write it. */
async function afterWrite($: EngineInterface, filePath: string, next: Relay) {
  const r = await next()
  if (!r.deny && !r.isError && isHandoffPath(filePath, (await load($)).requestedPath, cfg.handoffDir)) {
    await recordHandoff($, normalizePath(filePath), 'detected')
    writtenThisTurn = normalizePath(filePath)
  }
  return r
}

/** Submits the resume prompt as a turn of its own; when it cannot enter, it is left in the prompt box instead. */
async function submitResume($: EngineInterface, path: string) {
  const text = resumeText(relativeTo(path, cwd))
  try {
    const r = await $.prompt.submit({ text })
    if (!r.drop) return
    $.ui.toast(`handoff-watch: resume prompt was dropped (${r.drop})`)
  } catch (err) {
    $.ui.toast(`handoff-watch: could not submit the resume prompt (${String(err)})`)
  }
  const box = await $.prompt.read()
  if (!box.text.trim()) await $.prompt.fill({ text, mode: 'replace' })
}

/** After a /clear: the doc to resume from, left by an auto-clear or written in the context that just ended. */
async function resumePathAfterClear($: EngineInterface, s: State): Promise<string | null> {
  const key = resumeKey(cwd)
  const armed = (await $.store.get(key)) as { path?: unknown } | undefined
  if (armed) await $.store.delete(key)
  if (!cfg.autoResume) return null
  if (armed && typeof armed.path === 'string') return armed.path
  const h = currentHandoff(s)
  return h !== null && h.source === 'detected' && h.path ? h.path : null
}

/** Runs /clear, queued until the session is idle; the resume was armed in the store before this. */
async function clearAfterHandoff($: EngineInterface) {
  try {
    await $.command.run({ command: 'clear' })
  } catch (err) {
    $.ui.toast(`handoff-watch: could not run /clear (${String(err)}) — run it yourself; the resume is armed`, { timeoutMs: 10_000 })
  }
}

export const register: Register = (on, options) => {
  cfg = readConfig(options as Record<string, unknown>)
  resetTurn()

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    cwd = e.cwd
    // `handoff` may be a built-in's name: the engine refuses it, and /handoff-watch stands in.
    try {
      await $.command.register({ name: NAMES[0], description: DESCRIPTION, argumentHint: HINT })
    } catch {
      await $.command.register({ name: NAMES[1], description: DESCRIPTION, argumentHint: HINT })
    }
    await refreshMeter($, { withCeiling: true })
    await restoreFromStore($)
    await refreshStatus($)

    return r
  })

  // Only the meter moves here; decisions wait for the turn to end.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      const was = await read($, meter)
      if (e.context.window !== was.window) {
        await refreshMeter($, { withCeiling: true })
      } else {
        const now = await $.clock.now()
        await update($, meter, m => meterOf(m, e.context, { threshold, isAutoCompact, now }))
      }
      await refreshStatus($)
    }

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    resetTurn()
    sawTurnStart = true

    return next(e)
  })

  on('tool.call', ($, e, next) => {
    if (!e.agentId) toolsThisTurn += 1

    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, ($, e, next) => afterCommit($, e, () => next(e)) as never)
  on('tool.call', { tool: 'PowerShell' }, ($, e, next) => afterCommit($, e, () => next(e)) as never)
  on('tool.call', { tool: 'Write' }, ($, e, next) => afterWrite($, e.file_path, () => next(e)) as never)
  on('tool.call', { tool: 'Edit' }, ($, e, next) => afterWrite($, e.file_path, () => next(e)) as never)

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    if (e.reason !== 'answer') {
      resetTurn()
      return next(e)
    }
    await refreshMeter($)
    const checkpoint: Checkpoint = !sawTurnStart ? 'busy' : commitThisTurn ? 'commit' : toolsThisTurn === 0 ? 'quiet' : 'busy'
    const now = await $.clock.now()
    let toast: { text: string; timeoutMs: number } | undefined
    await change($, s => {
      const r = turnEnd(s, { checkpoint, now, cfg })
      toast = r.toast
      return r.state
    })
    if (toast) $.ui.toast(toast.text, { timeoutMs: toast.timeoutMs })
    await refreshStatus($)
    const written = writtenThisTurn
    resetTurn()
    const r = await next(e)
    // The doc is on disk and the answer is out: the context has served its purpose.
    if (written && cfg.autoClear) {
      if (cfg.autoResume) await $.store.set(resumeKey(cwd), { path: written, at: now })
      $.ui.toast(`handoff-watch: handoff saved — clearing${cfg.autoResume ? ` and resuming from ${relativeTo(written, cwd)}` : ''}`, { timeoutMs: 8000 })
      $.clock.after(0, () => void clearAfterHandoff($))
    }

    return r
  })

  // Only a plain composer prompt about a handoff gets the path hint; slash commands and our own request do not.
  on('prompt.submit', async ($, e, next) => {
    const text = e.text.trimStart()
    if (e.origin.kind !== 'composer' || text.startsWith('/') || text.startsWith(REQUEST_PREFIX) || !/\bhand-?off\b/i.test(text)) return next(e)
    const s = await load($)
    const path = s.requestedPath ?? handoffPath(cfg.handoffDir, stampOf(new Date(await $.clock.now())))
    await update($, requestedPath, () => path)

    return next({ ...e, context: [...(e.context ?? []), contextLine(s.meter.fill, path)] })
  })

  // The summary is steered, never skipped: a plugin cannot hold an auto-compaction for the model to write a doc.
  on('session.compact', async ($, e, next) => {
    if (e.agentId || e.trigger === 'plugin') return next(e)
    const s = await load($)
    const ref = currentHandoff(s)
    const isRecent = ref !== null && ref.fill !== null && (s.meter.fill ?? 1) < ref.fill + cfg.remindEvery
    if (e.trigger === 'auto' && !isRecent) $.ui.toast('handoff-watch: auto-compact starting — no recent handoff', { timeoutMs: 8000 })
    const r = await next(cfg.compactInstructions ? { ...e, instructions: withCompactInstructions(e.instructions, compactLine(s.lastHandoff)) } : e)
    if (e.trigger !== 'precompute' && !('skip' in r)) {
      const now = await $.clock.now()
      const done = await change($, was => compacted(was, r.tokensAfter, now))
      await refreshMeter($, { withCeiling: true, keepTokens: true })
      await writeStore($, done)
      await refreshStatus($)
    }

    return r
  })

  // A /clear keeps the process and the plugin: once the engine's end step is done, the fresh conversation can be given the doc.
  on('session.end', async ($, e, next) => {
    let resume: string | null = null
    if (e.reason === 'clear' || e.reason === 'resume') {
      if (e.reason === 'clear') resume = await resumePathAfterClear($, await load($))
      await change($, cleared)
      resetTurn()
      $.ui.status(undefined)
    }
    const r = await next(e)
    const path = resume
    if (path) $.clock.after(0, () => void submitResume($, path))

    return r
  })

  on('command.run', { command: 'handoff' }, ($, e) => runHandoff($, e.args))
  on('command.run', { command: 'handoff-watch' }, ($, e) => runHandoff($, e.args))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await load($)
    if (e.props.hasSurvey || e.props.view.agentId || s.nudge === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box key="handoff-band" flexDirection="column">
        <Box key="band-line">
          <Text bold color={s.nudge.reason === 'urgent' ? 'yellow' : undefined} wrap="truncate">
            {fit(bandLine(s), e.props.bodyColumns)}
          </Text>
        </Box>
        <Box key="buttons" flexDirection="row">
          <Button
            key="write"
            label="Write handoff"
            hotkey="h"
            variant="primary"
            onPress={async () => {
              const r = await writeRequest($)
              if (!r.isFilled) $.ui.toast('handoff-watch: prompt box busy — run /handoff')
            }}
          />
          <Button key="later" label="Later" hotkey="l" onPress={() => change($, was => ({ ...was, nudge: null }))} />
          <Button key="done" label="Done" hotkey="d" role="dismiss" onPress={() => recordHandoff($, null, 'done')} />
        </Box>
      </Box>
    )
  })
}

