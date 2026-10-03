import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GuardSession } from '../types'
import {
  POLICY,
  USAGE,
  consume,
  grant,
  isHumanOrigin,
  judge,
  parseArgs,
  parseConfig,
  recordBlock,
  recordDryRuns,
  reset,
  statusReport,
  statusText,
  succeeded,
  toastAllowed,
  toastBlocked,
} from './guard'
import type { Verdict } from './guard'

const TOAST_MS = 8000

const EMPTY: GuardSession = { dryRuns: [], blocked: 0, pending: null, allowance: null, allowed: 0 }
const session = atom({ plugin: 'guardrail', key: 'session' } as const, EMPTY)

async function pushStatus($: EngineInterface) {
  $.ui.status(statusText(await read($, session), await $.clock.now()))
}

export const register: Register = (on, options) => {
  const cfg = parseConfig(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'guardrail',
      description: 'Show or allow what guardrail blocked: git hook skips and live data runs without a dry run',
      argumentHint: 'status | allow [no-verify] | reset',
      immediate: true,
    })
    for (const name of cfg.invalid) $.ui.toast(`guardrail: ${name} is not a valid regex; ignored`)
    // a hot reload fires this again: the state stays, only the status line is pushed
    await pushStatus($)

    return started
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, session, () => EMPTY)
      await pushStatus($)
    }

    return next(e)
  })

  on('tool.call', { tool: ['Bash', 'PowerShell', 'Monitor'] }, async ($, e, next) => {
    const command = e.command
    if (!command) return next(e)
    const now = await $.clock.now()
    const verdict = judge(command, e.tool === 'PowerShell' ? 'pwsh' : 'bash', cfg, await read($, session), now)

    const refuse = async (v: Extract<Verdict, { kind: 'deny' | 'allow-once' }>) => {
      await update($, session, s => recordBlock(s, v.block))
      $.ui.toast(toastBlocked(v.block), { timeoutMs: TOAST_MS })
      await pushStatus($)

      return { deny: v.message }
    }

    if (verdict.kind === 'pass') return next(e)
    if (verdict.kind === 'deny') return refuse(verdict)

    if (verdict.kind === 'allow-once') {
      // consumed inside the update so two parallel calls cannot both use one allowance
      let used = false
      await update($, session, s => {
        const spent = consume(s, verdict.what, now)
        used = spent.used

        return spent.state
      })
      if (!used) return refuse(verdict)
      $.ui.toast(toastAllowed(verdict.label), { timeoutMs: TOAST_MS })
      await pushStatus($)

      return next(e)
    }

    const pendingKey = (await read($, session)).pending?.key
    const ran = await next(e)
    const clears = verdict.live.some(h => h.key === pendingKey)
    if (succeeded(e.tool, ran) && (verdict.dry.length > 0 || clears)) {
      await update($, session, s => recordDryRuns(s, verdict, now))
      await pushStatus($)
    }

    return ran
  })

  on('command.run', { command: 'guardrail' }, async ($, e) => {
    const now = await $.clock.now()
    const parsed = parseArgs(e.args)

    if (parsed.kind === 'usage') return { text: USAGE }
    if (parsed.kind === 'status') return { text: statusReport(await read($, session), now, cfg) }
    if (parsed.kind === 'reset') {
      await update($, session, reset)
      await pushStatus($)

      return { text: 'guardrail: dry runs, pending block and allowance cleared.' }
    }

    if (cfg.requireTypedAllow && !isHumanOrigin(e.origin)) {
      return { text: `guardrail: /guardrail allow has to be typed by you (this came from ${e.origin?.kind ?? 'an unknown source'}).` }
    }
    const what = parsed.what === 'live' ? 'live data operation' : 'git hook skip'
    await update($, session, s => grant(s, parsed.what, 'command', now, cfg.allowMinutes))
    await pushStatus($)

    return {
      text: `guardrail: the next ${what} is allowed once (expires in ${cfg.allowMinutes} min).`,
      context: [`The user typed /guardrail allow: the next ${what} is allowed once. Retry the blocked command unchanged.`],
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const pending = (await read($, session)).pending
    if (!pending || e.props.hasSurvey) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const why = pending.kind === 'live' ? 'no dry run yet' : 'hook skip needs your OK'
    const line = `⛔ guardrail blocked ${pending.label}: ${why}`
    const allow = async () => {
      const now = await $.clock.now()
      await update($, session, s => grant(s, pending.kind, 'band', now, cfg.allowMinutes))
      await pushStatus($)
    }
    const dismiss = async () => {
      await update($, session, s => ({ ...s, pending: null }))
    }

    return (
      <Box flexDirection="row">
        <Text key="msg" color="red" wrap="truncate-end">
          {line.slice(0, Math.max(20, e.props.bodyColumns - 24))}{' '}
        </Text>
        <Button key="allow" label="Allow once" hotkey="a" onPress={allow} />
        <Button key="dismiss" label="Dismiss" role="dismiss" onPress={dismiss} />
      </Box>
    )
  })

  if (cfg.announce) {
    on('prompt.compose', async ($, e, next) => {
      const composed = await next(e)

      return { ...composed, sections: [...composed.sections, { id: 'guardrail:policy', scope: 'session', text: POLICY }] }
    })
  }
}
