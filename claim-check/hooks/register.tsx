import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ClaimFlag, ClaimTurn } from '../types'
import { findClaims, formatReport, isEvidence, statusText, summarizeToolCall, toastText } from './claims'
import type { ToolSummary } from './claims'

const unverified = atom({ plugin: 'claim-check', key: 'unverified' } as const, 0)
const flags = atom({ plugin: 'claim-check', key: 'flags' } as const, [] as ClaimFlag[])
const lastTurn = atom({ plugin: 'claim-check', key: 'lastTurn' } as const, null as ClaimTurn | null)

const KEEP = 50

const RULE = {
  id: 'claim-check:verify-rule',
  scope: 'session' as const,
  text: "State facts about prod, databases, deployments, tickets or what ran when only after verifying them with a query, log read or tool call in this same turn. Otherwise prefix the sentence with UNVERIFIED: (or say you haven't checked). Never present a guess about external state as a finding.",
}

async function reset($: EngineInterface) {
  await update($, unverified, () => 0)
  await update($, flags, () => [])
  await update($, lastTurn, () => null)
}

export const register: Register = (on, options) => {
  // Per-turn buffers: the main loop's response text and tool calls so far.
  let text: string[] = []
  let tools: ToolSummary[] = []
  let evidence = 0

  on('turn.start', ($, e, next) => {
    text = []
    tools = []
    evidence = 0

    return next(e)
  })

  // Text written between tool calls never reaches `turn.complete`'s `answer`.
  on('session.append', { door: 'response' }, ($, e, next) => {
    if (e.agentId === undefined) {
      const content: unknown = e.message.content
      if (typeof content === 'string') {
        text.push(content)
      } else if (Array.isArray(content)) {
        for (const block of content as { type?: string; text?: unknown }[]) {
          if (block.type === 'text' && typeof block.text === 'string') text.push(block.text)
        }
      }
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const summary = summarizeToolCall(e, ran)
    tools.push(summary)
    if (isEvidence(summary)) evidence += 1

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') return result

    const candidates = findClaims([...text, e.answer].join('\n'))
    const flagged = evidence > 0 ? [] : candidates
    const turn: ClaimTurn = { turnId: e.turnId, candidates: candidates.length, evidence, flagged: flagged.length }
    await update($, lastTurn, () => turn)

    if (flagged.length > 0) {
      const now = await $.clock.now()
      const raised: ClaimFlag[] = flagged.map(c => ({ at: now, turnId: e.turnId, ...c }))
      await update($, flags, list => [...(list ?? []), ...raised].slice(-KEEP))
      await update($, unverified, k => (k ?? 0) + raised.length)
      $.ui.toast(toastText(flagged), { timeoutMs: 8000 })
      $.ui.status(statusText(await read($, unverified)))
    }

    return result
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (options.injectRule === false) return composed

    return { sections: [...composed.sections, RULE] }
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'claim-check',
      description: 'List claims about prod/data/tickets flagged as unverified this session',
      argumentHint: '[clear]',
    })
    $.ui.status(statusText(await read($, unverified)))

    return started
  })

  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    await reset($)
    $.ui.status(undefined)

    return next(e)
  })

  on('command.run', { command: 'claim-check' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await reset($)
      $.ui.status(undefined)

      return { text: 'claim-check: cleared.' }
    }

    return { text: formatReport(await read($, flags), await read($, lastTurn), await read($, unverified)) }
  })
}
