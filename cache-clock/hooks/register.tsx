import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Reading } from '../types'
import { HELP, INITIAL, advise, parseCommand, phaseAt, readConfig, report, statusText } from './clock'
import type { Config } from './clock'

const NAMES = ['cache', 'cache-clock'] as const
const DESCRIPTION = 'Prompt-cache countdown: status, TTL, the band after a lapse'
const HINT = '[status | ttl <minutes> | band on|off | reset]'
const TICK_MS = 1000

const reading = atom({ plugin: 'cache-clock', key: 'reading' } as const, INITIAL as Reading)
const ttlMinutes = atom({ plugin: 'cache-clock', key: 'ttlMinutes' } as const, 60)
const bandOn = atom({ plugin: 'cache-clock', key: 'bandOn' } as const, true)

// Module variables: a reload starts them over; $.state and $.store stay.
let cfg: Config = readConfig({})
let timer: Timer | undefined
/** What the status line was last pinned to; null = unknown, so the next tick pins whatever it computes. */
let lastText: string | undefined | null = null
let chain: Promise<void> = Promise.resolve()

/** One tick at a time: recompute the phase, write the atom when the band would change, pin the status when it changed. */
function tick($: EngineInterface): Promise<void> {
  chain = chain.then(() => tickNow($)).catch(() => undefined)
  return chain
}

async function tickNow($: EngineInterface) {
  const r = await read($, reading)
  const now = await $.clock.now()
  const minutes = await read($, ttlMinutes)
  const p = phaseAt(r.anchorAt, r.working, now, minutes, cfg.warnMinutes)
  if (p.phase !== r.phase || p.coldMinutes !== r.coldMinutes) {
    let { tokens, percent, hasHandoff } = r
    if (p.phase === 'cold' && r.phase !== 'cold') {
      // Entering cold: read the window and whether /handoff exists, once, for the band.
      try {
        const u = await $.session.usage()
        tokens = u.context.tokens ?? tokens
        percent = u.context.percent ?? percent
      } catch {
        // the estimate stays what the last turn left
      }
      try {
        hasHandoff = (await $.command.list()).some(c => c.name === 'handoff')
      } catch {
        // keep the last answer
      }
    }
    await update($, reading, held => ({ ...held, ...p, tokens, percent, hasHandoff }))
  }
  const text = statusText(p)
  if (text === lastText) return
  lastText = text
  await $.ui.status(text)
}

async function patch($: EngineInterface, fn: (r: Reading) => Partial<Reading>) {
  await update($, reading, held => ({ ...held, ...fn(held) }))
  await tick($)
}

/** After a compact or a clear the prefix is new: nothing to count down until the next answer lands. */
const freshen = ($: EngineInterface) => patch($, () => ({ anchorAt: null, working: false, dismissed: false, coldMinutes: 0 }))

function startTimer($: EngineInterface) {
  timer?.cancel()
  timer = $.clock.every(TICK_MS, () => void tick($))
}

async function pressCompact($: EngineInterface) {
  await patch($, () => ({ dismissed: true }))
  $.ui.toast('cache-clock: compacting; this pays the lapsed context once, then every prompt after is small')
  $.clock.after(0, () => {
    void $.session
      .compact()
      .then(async res => {
        if ('skip' in res && res.skip) $.ui.toast(`cache-clock: compact skipped: ${res.skip}`, { timeoutMs: 8000 })
        else await freshen($)
      })
      .catch(err => $.ui.toast(`cache-clock: compact failed: ${String(err)}`, { timeoutMs: 8000 }))
  })
}

async function pressCommand($: EngineInterface, command: 'handoff' | 'clear') {
  await patch($, () => ({ dismissed: true }))
  $.clock.after(0, () => {
    void $.command.run({ command }).catch(err => $.ui.toast(`cache-clock: could not run /${command} (${String(err)}); run it yourself`, { timeoutMs: 8000 }))
  })
}

async function runCommand($: EngineInterface, args: string | undefined): Promise<{ text: string }> {
  const cmd = parseCommand(args)
  switch (cmd.kind) {
    case 'error':
      return { text: cmd.text }
    case 'help':
      return { text: `cache-clock: ${HELP}` }
    case 'status': {
      await tick($)
      const r = await read($, reading)
      const minutes = await read($, ttlMinutes)
      const p = phaseAt(r.anchorAt, r.working, await $.clock.now(), minutes, cfg.warnMinutes)
      return { text: report({ ...r, ...p }, minutes, await read($, bandOn)) }
    }
    case 'ttl': {
      await $.store.set('ttlMinutes', cmd.minutes)
      await update($, ttlMinutes, () => cmd.minutes)
      lastText = null
      await tick($)
      return { text: `cache-clock: TTL ${cmd.minutes} min. ${cmd.minutes <= 5 ? 'The overage window.' : 'The normal window.'} Kept across sessions; /cache ttl 60 to go back.` }
    }
    case 'band': {
      await $.store.set('bandOn', cmd.on)
      await update($, bandOn, () => cmd.on)
      return { text: `cache-clock: band after a lapse ${cmd.on ? 'on' : 'off'}.` }
    }
    case 'reset': {
      await freshen($)
      return { text: 'cache-clock: countdown reset; it starts again when the next answer lands.' }
    }
  }
}

/** True when the tree beneath drew nothing: nothing, or a Box with no children. */
function isEmpty(tree: unknown): boolean {
  if (tree === null || tree === undefined) return true
  const el = tree as { type?: string; children?: unknown }
  if (el.type !== 'Box') return false
  return el.children === undefined || el.children === null || (Array.isArray(el.children) && el.children.length === 0)
}

export const register: Register = (on, options) => {
  cfg = readConfig(options as Record<string, unknown>)

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // `cache` may be a built-in's name: the engine refuses it, and /cache-clock stands in.
    try {
      await $.command.register({ name: NAMES[0], description: DESCRIPTION, argumentHint: HINT })
    } catch {
      await $.command.register({ name: NAMES[1], description: DESCRIPTION, argumentHint: HINT })
    }
    const storedTtl = await $.store.get('ttlMinutes')
    await update($, ttlMinutes, () => (typeof storedTtl === 'number' && storedTtl >= 1 ? storedTtl : cfg.ttlMinutes))
    const storedBand = await $.store.get('bandOn')
    await update($, bandOn, () => (typeof storedBand === 'boolean' ? storedBand : cfg.showBand))
    let hasHandoff = false
    try {
      hasHandoff = (await $.command.list()).some(c => c.name === 'handoff')
    } catch {
      // no list: the band simply omits the Handoff button
    }
    await update($, reading, held => ({ ...held, hasHandoff }))
    lastText = null
    startTimer($)
    await tick($)

    return r
  })

  // A main-loop turn: every request in it refreshes the cache, so the clock waits for its end.
  on('turn.start', async ($, e, next) => {
    await patch($, () => ({ working: true }))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    const r = await next(e)
    const now = await $.clock.now()
    let tokens: number | null = null
    let percent: number | null = null
    try {
      const u = await $.session.usage()
      tokens = u.context.tokens ?? null
      percent = u.context.percent ?? null
    } catch {
      // the band falls back to words without a figure
    }
    // An interrupted turn still made its requests; a dead one (API error) may not have reached the cache at all.
    await patch($, held => ({
      working: false,
      dismissed: false,
      anchorAt: e.reason === 'error' ? held.anchorAt : now,
      tokens: tokens ?? held.tokens,
      percent: percent ?? held.percent,
    }))

    return r
  })

  // A compaction (the person's, the engine's, another plugin's) replaces the prefix: nothing to count until the next answer.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.trigger !== 'precompute' && !e.agentId && !('skip' in r && r.skip)) await freshen($)

    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const r = await read($, reading)
    const show = r.phase === 'cold' && !r.dismissed && !e.props.hasSurvey && !e.props.isWorking && (await read($, bandOn))
    if (!show) return next(e)

    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const advice = advise(r.tokens, cfg.compactAbove, r.coldMinutes)
    const primary = (which: 'compact' | 'continue') => (advice.primary === which ? 'primary' : undefined)
    const ours = (
      <Box key="cache-clock-band" flexDirection="column">
        <Box key="cache-line" flexDirection="row">
          <Text key="t" color="yellow" wrap="truncate">
            {advice.line}
          </Text>
        </Box>
        <Box key="cache-buttons" flexDirection="row" columnGap={2}>
          <Button key="compact" hotkey="c" variant={primary('compact')} onPress={() => pressCompact($)}>
            Compact
          </Button>
          {r.hasHandoff ? (
            <Button key="handoff" hotkey="h" onPress={() => pressCommand($, 'handoff')}>
              Handoff
            </Button>
          ) : null}
          <Button key="clear" hotkey="x" onPress={() => pressCommand($, 'clear')}>
            Clear
          </Button>
          <Button key="keep" hotkey="k" variant={primary('continue')} role="dismiss" onPress={() => patch($, () => ({ dismissed: true }))}>
            Keep going
          </Button>
        </Box>
      </Box>
    )
    if (isEmpty(below)) return ours

    return (
      <Box key="cache-clock-stack" flexDirection="column">
        {ours}
        {below as never}
      </Box>
    )
  })

  on('command.run', { command: 'cache' }, async ($, e) => runCommand($, e.args))
  on('command.run', { command: 'cache-clock' }, async ($, e) => runCommand($, e.args))

  // A /clear keeps the process and the plugin: the new conversation starts cold, and the next answer re-arms the clock.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await freshen($)
    } else {
      timer?.cancel()
      timer = undefined
      lastText = undefined
      await $.ui.status(undefined)
    }

    return next(e)
  })
}
