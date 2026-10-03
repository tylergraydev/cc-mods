import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { AgentRow, DeckPolicy } from '../types'
import {
  completed,
  counts,
  elapsedText,
  groupDone,
  isRunning,
  judge,
  parseSpawn,
  preset,
  spawned,
  statusText,
  synced,
  tokenText,
  toolEnded,
  toolLabel,
  toolStarted,
  tree,
} from './deck'
import { BENCH, fillSlot, inSlot, slotOf } from './bench'

const PLUGIN = 'agent-deck'
const PANE = 'agent-deck'
const TITLE = 'Agents'
const TICK_MS = 2_000
const NO_POLICY: DeckPolicy = { maxRunning: 0, models: {} }

const agents = atom({ plugin: 'agent-deck', key: 'agents' } as const, [])
const selected = atom({ plugin: 'agent-deck', key: 'selected' } as const, null)
const policy = atom({ plugin: 'agent-deck', key: 'policy' } as const, NO_POLICY)
const clockNow = atom({ plugin: 'agent-deck', key: 'now' } as const, 0)

const HELP = [
  '/deck                                   open the agents pane',
  '/deck spawn <type> [--model m] <prompt> start a background subagent',
  '/deck review [scope]                    fan out 3 reviewers (correctness, security, quality)',
  '/deck nudge <id> <text>                 send a note into a running subagent',
  '/deck cap <n|off>                       cap how many subagents run at once',
  '/deck model <type> <model|off>          force a type onto a model (e.g. Explore haiku)',
  '/deck clear                             drop finished agents from the pane',
].join('\n')

const STATUS_GLYPH: Record<string, { glyph: string; color?: string; dimColor?: boolean }> = {
  running: { glyph: '●', color: 'yellow' },
  pending: { glyph: '○', color: 'yellow' },
  completed: { glyph: '✓', color: 'green' },
  failed: { glyph: '✗', color: 'red' },
  killed: { glyph: '■', dimColor: true },
}

let isTicking = false
let runs = 0
/** Groups whose results were already handed to the main conversation. */
const reported = new Set<string>()

async function setAgents($: EngineInterface, change: (rows: AgentRow[]) => AgentRow[]) {
  const rows = await update($, agents, list => change([...list]))
  $.ui.status(statusText(rows))
  return rows
}

/** Keeps elapsed times moving and picks up status changes the hooks did not see. */
async function tick($: EngineInterface) {
  if (isTicking) return
  isTicking = true
  try {
    const rows = await read($, agents)
    if (!rows.some(isRunning)) return
    await update($, clockNow, () => Date.now())
    const list = await $.agent.list().catch(() => [])
    const now = await $.clock.now()
    const before = new Map(rows.map(row => [row.id, row.status]))
    const next = await setAgents($, held => synced(held, list, now))
    for (const row of next) {
      if (before.get(row.id) === 'running' && row.status !== 'running') void announce($, row, next)
    }
  } finally {
    isTicking = false
  }
}

async function announce($: EngineInterface, row: AgentRow, rows: readonly AgentRow[]) {
  const group = row.group
  if (!group) {
    if (row.status === 'failed') $.ui.toast(`✗ ${row.type} failed: ${row.description}`)
    else if (row.status === 'completed' && row.isBackground) $.ui.toast(`✓ ${row.type} done: ${row.description}`)
    return
  }
  if (!groupDone(rows, group) || reported.has(group)) return
  reported.add(group)
  const members = rows.filter(one => one.group === group)
  const failed = members.filter(one => one.status !== 'completed').length
  $.ui.toast(`${group}: all ${members.length} finished${failed ? `, ${failed} failed` : ''}. Ask Claude to merge the findings.`)
  // the main model never saw these agents start, so hand it their reports
  const body = members
    .map(one => `### ${one.description} (${one.status})\n\n${(one.answer ?? '(no answer)').slice(0, 8000)}`)
    .join('\n\n')
  const text = `[agent-deck] The user's ${group} finished. Reports from the parallel reviewers follow; when the user asks, merge them into one deduplicated list ranked by severity.\n\n${body}`
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(() => undefined)
}

async function savePolicy($: EngineInterface, change: (held: DeckPolicy) => DeckPolicy) {
  const next = await update($, policy, change)
  await $.store.set('policy', next)
  return next
}

async function nudge($: EngineInterface, idPrefix: string, text: string): Promise<string> {
  const rows = await read($, agents)
  const row = rows.find(one => one.id === idPrefix) ?? rows.find(one => one.id.startsWith(idPrefix))
  if (!row) return `No agent ${idPrefix}.`
  const note = `[note from the user, via agent-deck] ${text}`
  try {
    const sent = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] }, agentId: row.id })
    if ('deny' in sent && sent.deny) return `Refused: ${sent.deny}`
    return `Sent to ${row.type} (${row.description}).`
  } catch {
    // not running any more: queue it as a message, which a named agent picks up when continued
    await $.session.send({ to: { agentId: row.id }, text: note })
    return `${row.type} is not running; queued the note as a message.`
  }
}

function policyText(held: DeckPolicy): string {
  const parts: string[] = []
  if (held.maxRunning > 0) parts.push(`cap ${held.maxRunning}`)
  for (const [type, model] of Object.entries(held.models)) parts.push(`${type}→${model}`)
  return parts.join(' · ')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'deck',
      description: 'Agent deck: watch, launch and steer subagents',
      argumentHint: '[spawn|nudge|cap|model|clear] …',
    })
    const stored = (await $.store.get('policy')) as DeckPolicy | undefined
    if (stored && typeof stored === 'object' && typeof stored.maxRunning === 'number') {
      await update($, policy, () => ({ ...NO_POLICY, ...stored }))
    }
    $.clock.every(TICK_MS, () => void tick($))

    return started
  })

  on('agent.spawn', async ($, e, next) => {
    const rows = await read($, agents)
    const verdict = judge(await read($, policy), e, counts(rows).running)
    if ('deny' in verdict) {
      $.ui.toast(`agent-deck held back a ${e.subagentType} spawn (cap)`)
      return { deny: verdict.deny }
    }
    const result = await next(verdict.model ? { ...e, model: verdict.model } : e)
    if (result.agentId) {
      const now = await $.clock.now()
      await update($, clockNow, () => now)
      await setAgents($, held =>
        spawned(held, {
          id: result.agentId!,
          type: e.subagentType,
          description: e.description,
          model: result.model,
          parentId: e.parentAgentId,
          isBackground: e.background,
          startedAt: now,
        }),
      )
      if (rows.length === 0) void $.ui.open({ id: PANE, title: TITLE })
    }

    return result
  })

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (!agentId || !(await read($, agents)).some(row => row.id === agentId)) return next(e)
    const callId = e.tool_use_id ?? `${agentId}:${Date.now()}`
    await setAgents($, rows =>
      toolStarted(rows, agentId, { id: callId, label: toolLabel(e.tool, e as Record<string, unknown>), at: Date.now() }),
    )
    let isError = true
    try {
      const ran = await next(e)
      isError = Boolean(ran.deny || ran.isError)
      return ran
    } finally {
      await setAgents($, rows => toolEnded(rows, agentId, callId, isError))
    }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const agentId = e.agentId
    if (agentId && (await read($, agents)).some(row => row.id === agentId)) {
      const usage = e.usage
      const tokens = usage
        ? usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
        : undefined
      const now = await $.clock.now()
      const rows = await setAgents($, held => completed(held, agentId, { reason: e.reason, answer: e.answer, tokens }, now))
      const row = rows.find(one => one.id === agentId)
      if (row) await announce($, row, rows)
    }

    return result
  })

  on('command.run', { command: 'deck' }, async ($, e) => {
    const [verb = '', ...restWords] = e.args.trim().split(/\s+/)
    const rest = e.args.trim().slice(verb.length).trim()

    if (verb === '') {
      await update($, clockNow, () => Date.now())
      await $.ui.open({ id: PANE, title: TITLE, focus: true })
      return { text: 'Agent deck opened.' }
    }
    if (verb === 'help') return { text: HELP }
    if (verb === 'spawn') {
      const parsed = parseSpawn(rest)
      if ('error' in parsed) return { text: parsed.error }
      const description = parsed.prompt.split(/\s+/).slice(0, 5).join(' ')
      const result = await $.agent.spawn({
        subagentType: parsed.type,
        prompt: parsed.prompt,
        description,
        model: parsed.model,
      })
      if (result.deny) return { text: `Not started: ${result.deny}` }
      await setAgents($, held =>
        spawned(held, {
          id: result.agentId!,
          type: parsed.type,
          description,
          model: result.model,
          isBackground: true,
          spawnedBy: PLUGIN,
          startedAt: Date.now(),
        }),
      )
      void $.ui.open({ id: PANE, title: TITLE })
      return { text: `Started ${parsed.type} (${result.agentId}) on ${result.model}.` }
    }
    const agentsOf = preset(verb, rest)
    if (agentsOf) {
      runs += 1
      const group = `${verb} #${runs}`
      const started: string[] = []
      for (const one of agentsOf) {
        const result = await $.agent.spawn({ subagentType: one.type, prompt: one.prompt, description: one.description })
        if (result.deny) {
          started.push(`✗ ${one.description}: ${result.deny}`)
          continue
        }
        await setAgents($, held =>
          spawned(held, {
            id: result.agentId!,
            type: one.type,
            description: one.description,
            model: result.model,
            isBackground: true,
            spawnedBy: PLUGIN,
            group,
            startedAt: Date.now(),
          }),
        )
        started.push(`● ${one.description} (${result.agentId})`)
      }
      void $.ui.open({ id: PANE, title: TITLE })
      return {
        text: `${group}${rest ? ` of ${rest}` : ''}:\n${started.join('\n')}\nWhen all finish, their reports are added to this conversation.`,
      }
    }
    if (verb === 'nudge') {
      const [id, ...words] = restWords
      if (!id || words.length === 0) return { text: 'usage: /deck nudge <id> <text>' }
      return { text: await nudge($, id, words.join(' ')) }
    }
    if (verb === 'cap') {
      const value = restWords[0]
      const cap = value === 'off' ? 0 : Number(value)
      if (!Number.isInteger(cap) || cap < 0) return { text: 'usage: /deck cap <n|off>' }
      await savePolicy($, held => ({ ...held, maxRunning: cap }))
      return { text: cap ? `At most ${cap} subagents run at once.` : 'No cap on running subagents.' }
    }
    if (verb === 'model') {
      const [type, model] = restWords
      if (!type || !model) return { text: 'usage: /deck model <type> <model|off>' }
      await savePolicy($, held => {
        const models = { ...held.models }
        if (model === 'off') delete models[type]
        else models[type] = model
        return { ...held, models }
      })
      return { text: model === 'off' ? `${type} uses its own model again.` : `${type} agents run on ${model} unless the call names one.` }
    }
    if (verb === 'clear') {
      await setAgents($, rows => rows.filter(isRunning))
      await update($, selected, () => null)
      return { text: 'Cleared finished agents.' }
    }
    return { text: HELP }
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
  // mobile draws no Input; the nudge box is left out there
  const Input = 'Input' in elements ? elements.Input : undefined
  const rows = await read($, agents)
  const pick = await read($, selected)
  const held = await read($, policy)
  const now = Math.max(await read($, clockNow), ...rows.map(row => row.startedAt))
  const width = Math.max(30, (e.viewport?.columns ?? 60) - 2)
  const { running, done, failed } = counts(rows)
  const rules = policyText(held)

  const header = (
    <Box key="head" flexDirection="row" marginBottom={1}>
      <Text bold color="#D97757">AGENTS </Text>
      <Text color="yellow">{running} running</Text>
      <Text dimColor>{` · ${done} done`}</Text>
      {failed > 0 && <Text color="red">{` · ${failed} failed`}</Text>}
      {rules && <Text dimColor>{`   ${rules}`}</Text>}
    </Box>
  )

  if (rows.length === 0) {
    return (
      <Box flexDirection="column">
        {header}
        <Text dimColor>No subagents yet this session.</Text>
        <Text dimColor>They show here as they start. /deck help for commands.</Text>
      </Box>
    )
  }

  const line = (row: AgentRow, depth: number) => {
    const mark = STATUS_GLYPH[row.status] ?? { glyph: '?', dimColor: true }
    const isOpen = pick === row.id
    const isLive = isRunning(row)
    const took = elapsedText((row.endedAt ?? now) - row.startedAt)
    const last = row.calls[row.calls.length - 1]
    const indent = depth > 0 ? `${'  '.repeat(depth - 1)}└ ` : ''
    const name = `${isOpen ? '▾' : '▸'} ${indent}${row.type}`
    const descRoom = Math.max(8, width - name.length - 32)
    const desc = row.description.length > descRoom ? `${row.description.slice(0, descRoom - 1)}…` : row.description

    return (
      <Box key={row.id} flexDirection="column">
        <Box key="line" flexDirection="row">
          <Text color={mark.color} dimColor={mark.dimColor}>{`${mark.glyph} `}</Text>
          <Button
            key={`row:${row.id}`}
            plain
            dimColor={!isLive && !isOpen}
            onPress={() => void update($, selected, held => (held === row.id ? null : row.id))}
          >
            {name}
          </Button>
          <Text dimColor wrap="truncate">{`  ${row.group ? `[${row.group}] ` : ''}${desc}  ${took} · ${row.toolCount} tools${row.errorCount ? ` · ${row.errorCount} err` : ''}`}</Text>
        </Box>
        {isLive && last && !isOpen && (
          <Text key="now" dimColor wrap="truncate">{`    ${'  '.repeat(depth)}↳ ${last.label}`}</Text>
        )}
        {isOpen && detail(row)}
      </Box>
    )
  }

  const detail = (row: AgentRow) => (
    <Box key="detail" flexDirection="column" marginLeft={4} marginBottom={1}>
      <Text key="meta" dimColor wrap="truncate">
        {[
          `id ${row.id}`,
          row.model,
          row.tokens ? `${tokenText(row.tokens)} tokens` : undefined,
          row.isBackground ? 'background' : 'foreground',
          row.spawnedBy ? `by ${row.spawnedBy}` : undefined,
        ]
          .filter(Boolean)
          .join(' · ')}
      </Text>
      {row.calls.map(call => (
        <Text key={call.id} wrap="truncate" color={call.isError ? 'red' : undefined} dimColor={call.isDone && !call.isError}>
          {`${call.isDone ? (call.isError ? '✗' : '·') : '…'} ${call.label}`}
        </Text>
      ))}
      {row.answer && (
        <Box key="answer" flexDirection="column" marginTop={1}>
          <Text key="label" bold>Answer</Text>
          <Text key="text" wrap="wrap">
            {row.answer.length > 1200 ? `${row.answer.slice(0, 1200)}…` : row.answer}
          </Text>
        </Box>
      )}
      {Input && isRunning(row) && (
        <Input
          key={`nudge:${row.id}`}
          placeholder="send a note to this agent…"
          submitLabel="Send"
          onSubmit={(value: string) => {
            if (value.trim()) void nudge($, row.id, value.trim()).then(text => $.ui.toast(text))
          }}
        />
      )}
    </Box>
  )

  return (
    <Box flexDirection="column">
      {header}
      {tree(rows).map(({ row, depth }) => line(row, depth))}
      <Box key="foot" flexDirection="row" marginTop={1}>
        {done + failed > 0 && (
          <Button key="clear" hotkey="c" onPress={() => void setAgents($, list => list.filter(isRunning))}>
            Clear finished
          </Button>
        )}
        <Text dimColor>{'  click a row for details · /deck help'}</Text>
      </Box>
    </Box>
  )
}
