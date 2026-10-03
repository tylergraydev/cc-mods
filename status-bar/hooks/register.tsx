import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BarPrefs, BarSegment } from '../types'
import {
  cellWidth,
  clipCells,
  colorAt,
  composeLine,
  parseCommand,
  readConfig,
  record,
  report,
  resolvePrefs,
  visible,
} from './bar'
import type { Config } from './bar'

const NAMES = ['statusbar', 'status-bar'] as const
const DESCRIPTION = 'Show or change the combined status line'
const HINT = '[mode status|band | on | off | hide <plugin> | show <plugin>]'
/** A plugin that updates ten times a second still costs one state write and one pin per window. */
const DEBOUNCE_MS = 150

const segments = atom({ plugin: 'status-bar', key: 'segments' } as const, {} as Record<string, BarSegment>)
const prefs = atom({ plugin: 'status-bar', key: 'prefs' } as const, null as BarPrefs | null)

// Module variables: a reload starts them over; $.state and $.store stay.
let cfg: Config = readConfig({})
const pending = new Map<string, string | undefined>()
let flushTimer: { cancel: () => void } | undefined
/** Terminal width as the band hook last saw it. */
let columns: number | undefined
/** What the status line was last pinned to; null = unknown, so the next flush pins whatever it computes. */
let lastLine: string | undefined | null = null
let chain: Promise<void> = Promise.resolve()

/** The prefs in force: the loaded ones, or the options' until session.start has read the store. */
async function effective($: EngineInterface): Promise<BarPrefs> {
  return (await read($, prefs)) ?? resolvePrefs(undefined, cfg)
}

function schedule($: EngineInterface) {
  if (flushTimer) return
  flushTimer = $.clock.after(DEBOUNCE_MS, () => void flush($))
}

/** Folds what arrived into $.state, then pins the combined line when it changed. Runs one at a time. */
function flush($: EngineInterface): Promise<void> {
  chain = chain.then(() => flushNow($)).catch(() => undefined)
  return chain
}

async function flushNow($: EngineInterface) {
  flushTimer?.cancel()
  flushTimer = undefined
  if (pending.size > 0) {
    const batch = [...pending]
    pending.clear()
    const at = await $.clock.now()
    await update($, segments, held => batch.reduce((acc, [plugin, text]) => record(acc, plugin, text, at), held))
  }
  const p = await effective($)
  const line = p.isOn && p.mode === 'status' ? composeLine(visible(await read($, segments), p, cfg), columns ?? cfg.width) : undefined
  if (line === lastLine) return
  lastLine = line
  await $.ui.status(line)
}

/** What the store holds, and the same with `patch` on top; the atom takes the resolved result. */
async function savePrefs($: EngineInterface, patch: Partial<BarPrefs>) {
  const stored = ((await $.store.get('prefs')) ?? {}) as Partial<BarPrefs>
  const next = { ...stored, ...patch }
  await $.store.set('prefs', next)
  await update($, prefs, () => resolvePrefs(next, cfg))
}

async function runCommand($: EngineInterface, args: string | undefined): Promise<{ text: string }> {
  const cmd = parseCommand(args)
  if (cmd.kind === 'error') return { text: cmd.text }
  await flush($)
  const p = await effective($)
  switch (cmd.kind) {
    case 'report':
      return { text: report(visible(await read($, segments), p, cfg), p) }
    case 'on':
      await savePrefs($, { isOn: true })
      lastLine = null
      await flush($)
      return { text: 'status-bar: on. Other plugins\' status lines are folded into one again.' }
    case 'off':
      await savePrefs($, { isOn: false })
      lastLine = null
      await flush($)
      return { text: 'status-bar: off. The combined line is cleared; each mod\'s own line returns the next time it updates.' }
    case 'mode':
      await savePrefs($, { mode: cmd.mode })
      lastLine = null
      await flush($)
      return { text: `status-bar: mode ${cmd.mode}` }
    case 'hide': {
      await savePrefs($, { hidden: [...new Set([...p.hidden, cmd.plugin])] })
      await flush($)
      return { text: `status-bar: ${cmd.plugin} hidden` }
    }
    case 'show': {
      await savePrefs($, { hidden: p.hidden.filter(name => name !== cmd.plugin) })
      await flush($)
      return { text: `status-bar: ${cmd.plugin} shown` }
    }
  }
}

/** True when the tree beneath drew nothing: nothing, or a Box with no children. */
function isEmpty(tree: unknown): boolean {
  if (tree === null || tree === undefined) return true
  // A drawn tree holds its children beside `props`: { type, props, children }.
  const el = tree as { type?: string; children?: unknown }
  if (el.type !== 'Box') return false
  return el.children === undefined || el.children === null || (Array.isArray(el.children) && el.children.length === 0)
}

export const register: Register = (on, options) => {
  cfg = readConfig(options as Record<string, unknown>)

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // `statusbar` may be a built-in's name: the engine refuses it, and /status-bar stands in.
    try {
      await $.command.register({ name: NAMES[0], description: DESCRIPTION, argumentHint: HINT })
    } catch {
      await $.command.register({ name: NAMES[1], description: DESCRIPTION, argumentHint: HINT })
    }
    const stored = (await $.store.get('prefs')) as Partial<BarPrefs> | undefined
    await update($, prefs, () => resolvePrefs(stored && typeof stored === 'object' ? stored : undefined, cfg))
    lastLine = null
    await flush($)

    return r
  })

  // Every other plugin's status line comes through here: record it, and keep it off the screen
  // by rewriting it to a clear (core clears that plugin's line). Our own line passes untouched.
  on('ui.status', async ($, e, next) => {
    const who = next.origin.plugin
    if (who === 'status-bar' || who === 'engine' || who === 'client') return next(e)
    pending.set(who, e.text)
    schedule($)
    const p = await effective($)
    if (!p.isOn) return next(e)

    return next({ ...e, text: undefined })
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'terminal' && e.viewport) columns = e.viewport.columns
    const p = await effective($)
    if (!p.isOn || p.mode !== 'band' || e.props.hasSurvey) return next(e)
    const list = visible(await read($, segments), p, cfg)
    if (list.length === 0) return next(e)

    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const ours = (
      <Box key="status-bar" flexDirection="row" flexWrap="wrap" columnGap={2}>
        {list.map((s, i) => {
          const label = s.label ? `${s.label}: ` : ''
          return (
            <Box key={`seg-${s.plugin}`} flexDirection="row">
              {label ? (
                <Text key="label" dimColor>
                  {label}
                </Text>
              ) : null}
              <Text key="body" color={colorAt(i)} wrap="truncate">
                {clipCells(s.body, Math.max(8, e.props.bodyColumns - cellWidth(label)))}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
    if (isEmpty(below)) return ours

    return (
      <Box key="status-bar-stack" flexDirection="column">
        {ours}
        {below as never}
      </Box>
    )
  })

  on('command.run', { command: 'statusbar' }, async ($, e) => runCommand($, e.args))
  on('command.run', { command: 'status-bar' }, async ($, e) => runCommand($, e.args))

  on('session.end', async ($, e, next) => {
    await flush($)

    return next(e)
  })
}
