import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AutoDenySession, DecidedBy, Denial } from '../types'
import {
  CLASSIFIER,
  PENDING_MS,
  USAGE,
  addDenial,
  clearAll,
  consume,
  denialText,
  findAllowance,
  grant,
  inputOf,
  isClassifierDeny,
  isHumanOrigin,
  matchKey,
  parseArgs,
  parseConfig,
  pendingList,
  refuse,
  retryText,
  statusLine,
  statusReport,
  sweep,
  toastText,
} from './deny'

const EMPTY: AutoDenySession = { denials: [], allowances: [], seq: 0 }
const session = atom({ plugin: 'ask-on-auto-deny', key: 'session' } as const, EMPTY)

const COMMAND = {
  description: 'Allow once or refuse a tool call auto mode blocked; show recent denials',
  argumentHint: 'status | allow [n] | refuse [n] | clear',
  immediate: true,
} as const

// set by register from the manifest options; a reload runs register again
let cfg = parseConfig({})
// the dialog guard: one question at a time
let asking = false

async function pushStatus($: EngineInterface) {
  $.ui.status(statusLine(await read($, session), await $.clock.now()))
}

/** Drops what expired; pushes the status line when something did. */
async function sweepNow($: EngineInterface) {
  const now = await $.clock.now()
  let changed = false
  await update($, session, s => {
    const r = sweep(s, now)
    changed = r.changed

    return r.state
  })
  if (changed) await pushStatus($)
}

/** Records one denial from either signal; a new one toasts and (optionally) asks in a dialog. */
async function recordDenial($: EngineInterface, raw: Parameters<typeof addDenial>[1]) {
  const now = await $.clock.now()
  let out!: ReturnType<typeof addDenial>
  await update($, session, s => {
    out = addDenial(s, raw, now)

    return out.state
  })
  if (out.isNew) {
    $.ui.toast(toastText(out.entry), { timeoutMs: 8000 })
    $.clock.after(PENDING_MS + 1000, () => void sweepNow($))
    if (cfg.askDialog && !asking) {
      const n = out.entry.n
      $.clock.after(0, () => void askPerson($, n))
    }
  }
  await pushStatus($)
}

/** Allows entry `n` (or the newest pending) once. Resolves to the entry, or the reason it cannot. */
async function allowEntry($: EngineInterface, n: number | undefined, by: DecidedBy): Promise<Denial | string> {
  const now = await $.clock.now()
  let res!: ReturnType<typeof grant>
  await update($, session, s => {
    res = grant(s, n, by, now, cfg.ttlMinutes)

    return res.state
  })
  if (res.error !== undefined || !res.entry) return res.error ?? 'Nothing is pending.'
  await pushStatus($)
  $.clock.after(cfg.ttlMinutes * 60_000 + 1000, () => void sweepNow($))

  return res.entry
}

async function refuseEntry($: EngineInterface, n: number | undefined, by: DecidedBy): Promise<Denial | string> {
  const now = await $.clock.now()
  let res!: ReturnType<typeof refuse>
  await update($, session, s => {
    res = refuse(s, n, by, now)

    return res.state
  })
  await pushStatus($)

  return res.error ?? res.entry ?? 'Nothing is pending.'
}

/** Tells the model to retry; when it cannot be sent, the text waits in the prompt box instead. */
async function deliverRetry($: EngineInterface, text: string) {
  if (cfg.autoSubmit) {
    try {
      const r = await $.prompt.submit({ text })
      if (!r.drop) return
      $.ui.toast(`auto-deny: retry prompt dropped (${r.drop}); it is in the prompt box`)
    } catch {
      $.ui.toast('auto-deny: could not submit the retry prompt; it is in the prompt box')
    }
  }
  const box = await $.prompt.read()
  await $.prompt.fill(box.text.trim() ? { text: `\n\n${text}`, mode: 'append' } : { text, mode: 'replace' })
}

/** The Allow once press, from the band or the dialog. */
async function onAllow($: EngineInterface, n: number, by: DecidedBy) {
  const r = await allowEntry($, n, by)
  if (typeof r === 'string') {
    $.ui.toast(r)

    return
  }
  await deliverRetry($, retryText(r, by, cfg.ttlMinutes))
}

/** Optional dialog: the same two answers as the band, in Claude Code's own question dialog. */
async function askPerson($: EngineInterface, n: number) {
  const entry = (await read($, session)).denials.find(d => d.n === n)
  if (!entry || entry.outcome !== 'pending' || asking) return
  asking = true
  try {
    const answer = await $.ui.ask(`Auto mode blocked ${entry.tool}: ${entry.summary.slice(0, 80)}. Allow it once?`, {
      options: ['Allow once', 'Refuse'],
      header: 'Auto-deny',
    })
    if (answer === 'Allow once') await onAllow($, n, 'dialog')
    else if (answer === 'Refuse') await refuseEntry($, n, 'dialog')
  } catch {
    // dismissed: it stays pending in the band
  } finally {
    asking = false
  }
}

export const register: Register = (on, options) => {
  cfg = parseConfig(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      await $.command.register({ name: 'auto-allow', ...COMMAND })
    } catch {
      await $.command.register({ name: 'ask-on-auto-deny', ...COMMAND })
    }
    // a hot reload fires this again: the state stays, only the status line is pushed
    await sweepNow($)
    await pushStatus($)

    return started
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      const now = await $.clock.now()
      await update($, session, s => clearAll(s, now))
      await pushStatus($)
    }

    return next(e)
  })

  // signal one: the classifier's denial as a settings hook sees it
  on('classic.PermissionDenied', async ($, e, next) => {
    const r = await next(e)
    try {
      if (e.permission_mode === undefined || e.permission_mode === 'auto') {
        await recordDenial($, { id: e.tool_use_id, tool: e.tool_name, input: e.tool_input, reason: e.reason, agentId: e.agent_id, source: 'classic' })
      }
    } catch {
      // observing must never break the denial
    }

    return r
  })

  // signal two: the denial as the tool result says it. Observes only: never denies or rewrites.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    try {
      if (isClassifierDeny(r)) {
        await recordDenial($, {
          id: e.tool_use_id,
          tool: e.tool,
          input: inputOf(e as unknown as Record<string, unknown>),
          reason: denialText(r) ?? '',
          agentId: e.agentId,
          source: 'tool-result',
        })
      }
    } catch {
      // observing must never break the call
    }

    return r
  })

  // the one hook that loosens anything: an exact, live, single-use allowance answers `allow` where the classifier would decide
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    // a settings rule, a hook or an organization ceiling is never overridden
    const overridable =
      e.ceiling === undefined &&
      (verdict.decision === 'ask' ||
        (verdict.decision === 'deny' && !verdict.rule && !verdict.hook && CLASSIFIER.test(verdict.reason ?? '')))
    if (!overridable) return verdict

    const now = await $.clock.now()
    const key = matchKey(e.tool, e.input)
    const live = findAllowance(await read($, session), e.tool, key, now)
    if (!live) return verdict
    // a query (no tool_use_id) is answered but never consumes
    if (e.tool_use_id === undefined) return { decision: 'allow' as const, reason: `ask-on-auto-deny: allowed once by the user (#${live.n})` }

    // consumed inside the update, so two parallel identical calls cannot share one allowance
    let used = false
    await update($, session, s => {
      const c = consume(s, e.tool, key, now)
      used = c.used

      return c.state
    })
    if (!used) return verdict
    $.ui.toast(`Allowed once: ${e.tool} ${live.summary.slice(0, 60)}`, { timeoutMs: 6000 })
    await pushStatus($)

    return { decision: 'allow' as const, reason: `ask-on-auto-deny: the user allowed this exact call once (#${live.n})` }
  })

  on('command.run', { command: ['auto-allow', 'ask-on-auto-deny'] }, async ($, e) => {
    const now = await $.clock.now()
    const parsed = parseArgs(e.args)

    if (parsed.kind === 'usage') return { text: USAGE }
    if (parsed.kind === 'status') {
      await sweepNow($)

      return { text: statusReport(await read($, session), now, cfg) }
    }
    if (parsed.kind === 'clear') {
      await update($, session, s => clearAll(s, now))
      await pushStatus($)

      return { text: 'auto-deny: pending denials and allowances cleared.' }
    }
    if (parsed.kind === 'refuse') {
      // any origin: refusing only tightens
      const r = await refuseEntry($, parsed.n, 'command')

      return { text: typeof r === 'string' ? r : `auto-deny: refused #${r.n} (${r.tool}).` }
    }

    if (!isHumanOrigin(e.origin)) {
      return { text: `auto-deny: /auto-allow allow has to be typed by you (this came from ${e.origin?.kind ?? 'an unknown source'}).` }
    }
    const r = await allowEntry($, parsed.n, 'command')
    if (typeof r === 'string') return { text: r }
    // a prompt cannot enter from the command's own hook; it goes once this run is over
    $.clock.after(0, () => void deliverRetry($, retryText(r, 'command', cfg.ttlMinutes)))

    return {
      text: `auto-deny: #${r.n} ${r.tool} is allowed once (expires in ${cfg.ttlMinutes} min). ${cfg.autoSubmit ? 'Asking Claude to retry it.' : 'The retry request is in the prompt box; press Enter.'}`,
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const now = await $.clock.now()
    const rows = pendingList(await read($, session), now)
    if (rows.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns - 28)
    const line = (d: Denial) => {
      const text = `⛔ auto mode blocked ${d.tool} [${d.tag}]${d.agentId ? ' (subagent)' : ''}${d.times > 1 ? ` ×${d.times}` : ''}: ${d.summary}`

      return text.length > width ? `${text.slice(0, width - 1)}…` : text
    }
    const shown = rows.slice(0, cfg.maxPending)
    const more = rows.length - shown.length

    const ours = (
      <Box key="aoad" flexDirection="column">
        {shown.map((d, i) => (
          <Box key={`row-${d.n}`} flexDirection="row">
            <Text color="yellow" wrap="truncate-end">
              {line(d)}{' '}
            </Text>
            <Button key={`allow-${d.n}`} label="Allow once" variant="primary" {...(i === 0 ? { hotkey: 'p' } : {})} onPress={() => onAllow($, d.n, 'band')} />
            <Button key={`refuse-${d.n}`} label="Refuse" {...(i === 0 ? { hotkey: 'x' } : {})} onPress={() => void refuseEntry($, d.n, 'band')} />
          </Box>
        ))}
        {more > 0 ? (
          <Box key="more">
            <Text dimColor>+{more} more · /auto-allow status</Text>
          </Box>
        ) : null}
      </Box>
    )

    // sit above whatever the engine or another mod draws there
    const below = await next(e)

    return (
      <Box key="aoad-wrap" flexDirection="column">
        {ours}
        {below}
      </Box>
    )
  })
}
