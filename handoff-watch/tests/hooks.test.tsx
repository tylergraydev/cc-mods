import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { resumeText } from '../hooks/watch'

const PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} } as const
const CEILING = 160_000
const WINDOW = 200_000
const at = (fill: number) => Math.round(fill * CEILING)

type Sandbox = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

/** The engine beneath the mod: answers usage from `w.tokens`, records toasts, statuses, prompt fills and compaction instructions. */
function world($: Sandbox, on: On) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-03T14:05:00Z') })
  mock.store(on)
  const w = {
    clock,
    tokens: undefined as number | undefined,
    draft: '',
    denyTools: false,
    breakdownCalls: 0,
    toasts: [] as string[],
    statuses: [] as (string | undefined)[],
    fills: [] as { text: string; mode: string }[],
    instructions: [] as (string | undefined)[],
    contexts: [] as (readonly string[] | undefined)[],
    runs: [] as string[],
    submits: [] as string[],
    dropSubmit: '',
    after: 40_000 as number | undefined,
    turnId: 0,
  }
  on('command.register', async (_, e) => ({ value: { command: e.name } }))
  on('ui.toast', async (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', async (_, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', async () => ({ value: undefined }))
  on('prompt.read', async () => ({ value: { text: w.draft, cursor: w.draft.length } }))
  on('prompt.fill', async (_, e) => {
    w.fills.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })
  on('prompt.submit', async (_, e) => {
    w.contexts.push(e.context)
    w.submits.push(e.text)
    return w.dropSubmit ? { drop: w.dropSubmit } : { text: e.text }
  })
  on('command.run', async (_, e) => {
    w.runs.push(e.command)
    return { text: '' }
  })
  on('session.usage', async (_, e) => {
    if (e.breakdown) w.breakdownCalls += 1
    const percent = w.tokens === undefined ? undefined : Math.round((w.tokens / WINDOW) * 100)
    const breakdown = e.breakdown ? { breakdown: { autoCompactThreshold: CEILING, isAutoCompactEnabled: true } as never } : {}
    return { value: { startedAt: 1, rateLimits: [], context: { window: WINDOW, tokens: w.tokens, percent, ...breakdown } } }
  })
  on('session.measure', async (_, e) => ({ changed: e.changed }))
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('session.end', async () => ({ sessionId: 's1' }))
  on('session.compact', async (_, e) => {
    w.instructions.push(e.instructions)
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] as never, tokensBefore: 160_000, tokensAfter: w.after }
  })
  on('turn.start', async (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_, e) => ({ text: e.answer }))
  on('tool.call', async () => (w.denyTools ? { deny: 'x' } : { result: {} as never, text: 'ok' }))
  on('ui.render', async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })

  const start = () => $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  const measure = async (tokens: number) => {
    w.tokens = tokens
    await $.session.measure({ context: { window: WINDOW, tokens }, rateLimits: [], changed: ['context'] } as never)
  }
  /** One main-loop turn that ends with the context at `fill`. */
  const turn = async (tools: ({ tool: string; [k: string]: unknown } | string)[], fill: number, extra: object = {}) => {
    w.tokens = at(fill)
    w.turnId += 1
    const turnId = `t${w.turnId}`
    await $.turn.start({ text: '', turnId })
    for (const t of tools) await $.tool.call((typeof t === 'string' ? { tool: 'Bash', command: t } : t) as never)
    await $.turn.complete({ answer: 'ok', text: 'ok', reason: 'answer', durationMs: 1, isAborted: false, turnId, ...extra } as Parameters<typeof $.turn.complete>[0])
    await clock.settle()
  }
  const command = (args: string, name = 'handoff') => $.command.run({ command: name, args } as Parameters<typeof $.command.run>[0])
  const mount = (surface: 'terminal' | 'desktop', props: object = PROPS) =>
    $.ui.mount({ plugin: 'handoff-watch', surface, component: 'AbovePrompt', props: props as never } as never)
  return Object.assign(w, { start, measure, turn, command, mount })
}

const MSGS = [{ role: 'user', text: 'x', toolUses: [] }] as never
const NUDGE_63 = 'handoff-watch: context 63% — good moment for a handoff · /handoff'

test('crossing the warn line then a quiet turn gives one toast and the band', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.measure(at(0.63))
  await t.turn([], 0.63)
  expect(t.toasts).toEqual([NUDGE_63])
  const ui = await t.mount('terminal')
  expect((await ui.find({ key: 'band-line' }))?.text).toMatch(/context 63% of 160k/)
  await ui.unmount()
})

test('the same band does not nudge twice, and Later hides the band', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.turn([], 0.63)
  let ui = await t.mount('terminal')
  await ui.press({ key: 'later' })
  expect(await ui.find({ key: 'handoff-band' })).toBeUndefined()
  await ui.unmount()
  await t.turn([], 0.68)
  expect(t.toasts).toHaveLength(1)
  ui = await t.mount('terminal')
  expect(await ui.find({ key: 'handoff-band' })).toBeUndefined()
  await ui.unmount()
})

test('busy turns wait for a checkpoint, then nudge on the third', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.turn(['npm test'], 0.63)
  await t.turn(['npm test'], 0.64)
  expect(t.toasts).toHaveLength(0)
  await t.turn(['npm test'], 0.65)
  expect(t.toasts).toEqual(['handoff-watch: context 65% — good moment for a handoff · /handoff'])
})

test('a commit is a checkpoint; a denied commit is not', async ($, on) => {
  const t = world($, on)
  await t.start()
  t.denyTools = true
  await t.turn(['git commit -m x'], 0.63)
  expect(t.toasts).toHaveLength(0)
  t.denyTools = false
  await t.turn(['git commit -m x'], 0.64)
  expect(t.toasts).toHaveLength(1)
  expect(t.toasts[0]).toContain('committed')
})

test('Write handoff fills the prompt, appending after a draft instead of replacing it', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.turn([], 0.63)
  let ui = await t.mount('terminal')
  await ui.press({ key: 'write' })
  await ui.unmount()
  expect(t.fills[0]!.text.startsWith('Write a handoff document for this session to `.claude/handoffs/HANDOFF-')).toBe(true)
  expect(t.fills[0]!.text).toContain('How to resume')
  expect(t.fills[0]!.mode).toBe('replace')
  await t.command('')
  t.draft = 'wip'
  await t.command('')
  expect(t.fills[2]!.mode).toBe('append')
  expect(t.fills[2]!.text.startsWith('\n\n')).toBe(true)
})

test('a written handoff doc is detected and clears the nudge', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.turn([], 0.63)
  await $.tool.call({ tool: 'Write', file_path: 'C:\\repo\\.claude\\handoffs\\HANDOFF-2026-10-03-1405.md', content: 'x' } as never)
  expect(t.toasts.at(-1)).toContain('handoff saved')
  expect(t.statuses.at(-1)).toBe('ctx 63% · handoff 63%')
  const ui = await t.mount('terminal')
  expect(await ui.find({ key: 'handoff-band' })).toBeUndefined()
  await ui.unmount()
})

test('a HANDOFF file with no request is recorded; other files are ignored', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.measure(at(0.5))
  await $.tool.call({ tool: 'Write', file_path: 'src/handoffs.ts', content: 'x' } as never)
  expect(t.toasts).toHaveLength(0)
  await $.tool.call({ tool: 'Write', file_path: 'C:/repo/HANDOFF-PROJ-9.md', content: 'x' } as never)
  expect(t.toasts).toEqual(['handoff saved: HANDOFF-PROJ-9.md'])
})

test('an auto compaction is steered, toasted, and counted; subagents and precompute behave', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.measure(at(0.8))
  await $.session.compact({ trigger: 'auto', messages: MSGS, instructions: 'keep the plan' } as never)
  expect(t.instructions[0]!.startsWith('keep the plan')).toBe(true)
  expect(t.instructions[0]).toContain('[handoff-watch] In the summary, keep as explicit lists')
  expect(t.toasts).toContain('handoff-watch: auto-compact starting — no recent handoff')
  expect(String((await t.command('status')).text)).toContain('compactions   1')
  const ui = await t.mount('terminal')
  expect(await ui.find({ key: 'handoff-band' })).toBeUndefined()
  await ui.unmount()

  await $.session.compact({ trigger: 'auto', agentId: 'sub', messages: MSGS, instructions: 'x' } as never)
  expect(t.instructions[1]).toBe('x')

  const toasts = t.toasts.length
  await $.session.compact({ trigger: 'precompute', messages: MSGS } as never)
  expect(t.instructions[2]).toContain('[handoff-watch]')
  expect(t.toasts).toHaveLength(toasts)
  expect(String((await t.command('status')).text)).toContain('compactions   1')
})

test('compactInstructions off leaves the instructions alone', { options: { compactInstructions: false } }, async ($, on) => {
  const t = world($, on)
  await t.start()
  await $.session.compact({ trigger: 'manual', messages: MSGS, instructions: 'keep the plan' } as never)
  expect(t.instructions[0]).toBe('keep the plan')
})

test('the status line is empty below showAt and shows ctx from there', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.measure(at(0.2))
  expect(t.statuses.at(-1)).toBeUndefined()
  await t.measure(at(0.4))
  expect(t.statuses.at(-1)).toBe('ctx 40%')
})

test('/handoff names the doc by ticket, takes a focus, marks done, reports status', async ($, on) => {
  const t = world($, on)
  await t.start()
  expect(t.breakdownCalls).toBeGreaterThan(0)
  await t.measure(at(0.5))
  await t.command('PROJ-123 the auth bug')
  expect(t.fills[0]!.text).toContain('`.claude/handoffs/HANDOFF-PROJ-123.md`')
  expect(t.fills[0]!.text).toContain('Focus especially on: the auth bug')
  expect(String((await t.command('status')).text)).toContain('of the 160k auto-compact point')
  await t.command('done')
  expect(t.statuses.at(-1)).toContain('· handoff')
  expect(String((await t.command('status', 'handoff-watch')).text)).toContain('last handoff  marked done at 50%')
})

test('/clear starts over', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.turn([], 0.63)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)
  await t.clock.settle()
  expect(t.statuses.at(-1)).toBeUndefined()
  expect(t.submits).toEqual([])
  const ui = await t.mount('terminal')
  expect(await ui.find({ key: 'handoff-band' })).toBeUndefined()
  await ui.unmount()
})

const DOC = 'C:/repo/.claude/handoffs/HANDOFF-2026-10-03-1405.md'

test('a written handoff doc ends the turn with /clear, and that /clear resumes from the doc once', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.turn([{ tool: 'Write', file_path: DOC, content: 'x' }], 0.63)
  expect(t.runs).toEqual(['clear'])
  expect(t.toasts.at(-1)).toBe('handoff-watch: handoff saved — clearing and resuming from .claude/handoffs/HANDOFF-2026-10-03-1405.md')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)
  await t.clock.settle()
  expect(t.submits).toEqual([resumeText('.claude/handoffs/HANDOFF-2026-10-03-1405.md')])
  await $.session.end({ reason: 'clear', sessionId: 's2', resume: {} } as never)
  await t.clock.settle()
  expect(t.submits).toHaveLength(1)
})

test('autoClear off: no /clear, but a typed /clear after a handoff still resumes', { options: { autoClear: false } }, async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.turn([{ tool: 'Write', file_path: 'C:/repo/HANDOFF-PROJ-9.md', content: 'x' }], 0.5)
  expect(t.runs).toEqual([])
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)
  await t.clock.settle()
  expect(t.submits).toEqual([resumeText('HANDOFF-PROJ-9.md')])
})

test('autoResume off: /clear runs and nothing is submitted', { options: { autoResume: false } }, async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.turn([{ tool: 'Write', file_path: 'C:/repo/HANDOFF-PROJ-9.md', content: 'x' }], 0.5)
  expect(t.runs).toEqual(['clear'])
  expect(t.toasts.at(-1)).toBe('handoff-watch: handoff saved — clearing')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)
  await t.clock.settle()
  expect(t.submits).toEqual([])
})

test('/handoff resume submits the last doc; a dropped prompt lands in the box', async ($, on) => {
  const t = world($, on)
  await t.start()
  expect((await t.command('resume')).text).toBe('No handoff doc recorded for this project yet.')
  await $.tool.call({ tool: 'Write', file_path: 'C:/repo/HANDOFF-PROJ-9.md', content: 'x' } as never)
  expect((await t.command('resume')).text).toBe('Resuming from HANDOFF-PROJ-9.md.')
  await t.clock.settle()
  expect(t.submits).toEqual([resumeText('HANDOFF-PROJ-9.md')])
  t.dropSubmit = 'busy'
  await t.command('resume')
  await t.clock.settle()
  expect(t.toasts.at(-1)).toBe('handoff-watch: resume prompt was dropped (busy)')
  expect(t.fills.at(-1)).toEqual({ text: resumeText('HANDOFF-PROJ-9.md'), mode: 'replace' })
})

test('urgent fires on a busy turn after the band was nudged', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.turn([], 0.62)
  await t.turn(['npm test'], 0.86)
  expect(t.toasts.at(-1)).toContain('auto-compact is close')
})

test('a subagent turn ends without a decision', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.turn([], 0.7, { agentId: 'sub' })
  expect(t.toasts).toHaveLength(0)
})

test('the band shows on both surfaces, and not under a survey or on a subagent view', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.turn([], 0.63)
  for (const surface of ['terminal', 'desktop'] as const) {
    let ui = await t.mount(surface)
    expect(await ui.find({ key: 'write' })).toBeDefined()
    expect(await ui.find({ key: 'later' })).toBeDefined()
    expect(await ui.find({ key: 'done' })).toBeDefined()
    await ui.unmount()
    ui = await t.mount(surface, { ...PROPS, hasSurvey: true })
    expect(await ui.find({ key: 'handoff-band' })).toBeUndefined()
    await ui.unmount()
    ui = await t.mount(surface, { ...PROPS, view: { agentId: 'x' } })
    expect(await ui.find({ key: 'handoff-band' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a prompt about a handoff gets the path hint; a slash command does not', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.measure(at(0.5))
  await $.prompt.submit({ text: 'please write a hand-off', origin: { kind: 'composer' } } as never)
  expect(t.contexts[0]?.[0]).toContain('.claude/handoffs/HANDOFF-')
  await $.prompt.submit({ text: '/handoff', origin: { kind: 'composer' } } as never)
  expect(t.contexts[1]).toBeUndefined()
})
