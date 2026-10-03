import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const USAGE = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const GOAL = 'Fix the video-generation select/button bug in GenerationForm'
const PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} } as const

type Sandbox = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

/** The engine beneath the mod: records toasts, statuses and prompt context, answers the model. */
function world($: Sandbox, on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = {
    clock,
    reply: 'OTHER',
    isModelDown: false,
    modelCalls: [] as string[],
    toasts: [] as string[],
    statuses: [] as (string | undefined)[],
    contexts: [] as (readonly string[] | undefined)[],
    fills: [] as string[],
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
  on('prompt.submit', async (_, e) => {
    w.contexts.push(e.context)
    return { text: e.text }
  })
  on('prompt.fill', async (_, e) => {
    w.fills.push(e.text)
    return { isFilled: true }
  })
  on('ui.render', async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('turn.start', async (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_, e) => ({ text: e.answer }))
  on('tool.call', async () => ({ deny: 'test' }))
  on('model.complete', async (_, e) => {
    w.modelCalls.push(e.prompt)
    return { value: w.isModelDown ? { isAnswered: false as const, reason: 'api-error' as const, status: 500, error: 'server_error' as const, usage: USAGE } : { isAnswered: true as const, text: w.reply, usage: USAGE } }
  })

  const prompt = async (text: string) => {
    await $.prompt.submit({ text, origin: { kind: 'composer' } } as unknown as Parameters<typeof $.prompt.submit>[0])
  }
  /** One main-loop turn: start, each tool call, complete, then let scheduled work run. */
  const turn = async (tools: ({ tool: string; [k: string]: unknown } | string)[], answer = 'ok') => {
    w.turnId += 1
    const turnId = `t${w.turnId}`
    await $.turn.start({ text: '', turnId })
    for (const t of tools) {
      const call = typeof t === 'string' ? { tool: 'Bash', command: t } : t
      await $.tool.call(call as never)
    }
    await $.turn.complete({ answer, text: answer, reason: 'answer', durationMs: 1, isAborted: false, turnId } as Parameters<typeof $.turn.complete>[0])
    await clock.settle()
  }
  const env = (n: number) => (async () => {
    for (let i = 0; i < n; i += 1) await turn(['npm install', 'taskkill /F /PID 4120'])
  })()
  const goalEdit = { tool: 'Edit', file_path: 'src/GenerationForm.tsx' }
  const command = (args: string, name = 'goal') => $.command.run({ command: name, args } as Parameters<typeof $.command.run>[0])
  return Object.assign(w, { prompt, turn, env, goalEdit, command })
}

test('the first substantive prompt becomes the anchor; chatter and framed plugin prompts do not', async ($, on) => {
  const t = world($, on)
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true })
  await t.prompt('hi')
  expect(String((await t.command('')).text)).toContain('No goal yet')
  await $.prompt.submit({ text: GOAL, origin: { kind: 'task-notification' } } as unknown as Parameters<typeof $.prompt.submit>[0])
  expect(String((await t.command('')).text)).toContain('No goal yet')
  await t.prompt(GOAL)
  expect(String((await t.command('')).text)).toContain(`Goal (auto, set turn 1): ${GOAL}`)
  expect(t.statuses.at(-1)).toBe('goal: fix video-generation… · on track')
})

test('/goal sets, prints and switches off', async ($, on) => {
  const t = world($, on)
  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true })
  expect(String((await t.command('')).text)).toContain('No goal yet')
  const set = await t.command('answer the worktree question')
  expect(String(set.text)).toBe('Goal set: answer the worktree question')
  expect(String((await t.command('')).text)).toContain('On track.')
  expect(String((await t.command('', 'goal-anchor')).text)).toContain('Goal (set by you, set turn 1): answer the worktree question')
  await t.command('off')
  expect(t.statuses.at(-1)).toBeUndefined()
  expect(String((await t.command('')).text)).toContain('No goal yet')
})

test('drift counts every turn and one goal edit resets it', async ($, on) => {
  const t = world($, on)
  await t.prompt(GOAL)
  await t.env(3)
  expect(t.statuses.at(-1)).toBe('goal: fix video-generation… · 3 turns away')
  expect(t.modelCalls).toHaveLength(0)
  await t.turn([t.goalEdit], 'Fixed the select.')
  expect(t.statuses.at(-1)).toBe('goal: fix video-generation… · on track')
})

test('the model confirms at the threshold: one toast per streak, one Haiku call per crossing', async ($, on) => {
  const t = world($, on)
  t.reply = 'PREREQUISITE'
  await t.prompt(GOAL)
  await t.env(5)
  expect(t.toasts).toEqual(['goal-anchor: 5 turns on environment work since "fix video-generation…"'])
  expect(t.modelCalls).toHaveLength(1)
  expect(t.modelCalls[0]).toContain(`Goal: "${GOAL}"`)
  await t.env(2)
  expect(t.toasts).toHaveLength(1)
  expect(t.modelCalls).toHaveLength(1)
  await t.turn([t.goalEdit], 'Fixed the select.')
  await t.env(5)
  expect(t.toasts).toHaveLength(2)
  expect(t.modelCalls).toHaveLength(2)
})

test('the model saying GOAL resets the streak and teaches the vocabulary', async ($, on) => {
  const t = world($, on)
  t.reply = 'GOAL'
  await t.prompt(GOAL)
  for (let i = 0; i < 5; i += 1) await t.turn(['npm install', { tool: 'Edit', file_path: 'lib/render-queue.ts' }])
  expect(t.toasts).toHaveLength(0)
  expect(t.statuses.at(-1)).toBe('goal: fix video-generation… · on track')
  // the files edited during the confirmed-goal streak now count as the goal's
  await t.turn([{ tool: 'Edit', file_path: 'lib/render-queue.ts' }])
  expect(t.statuses.at(-1)).toBe('goal: fix video-generation… · on track')
})

test('a failed model call falls back to the heuristic and still alarms', async ($, on) => {
  const t = world($, on)
  t.isModelDown = true
  await t.prompt(GOAL)
  await t.env(5)
  expect(String((await t.command('')).text)).toContain('5 turns away: environment work (heuristic)')
  expect(t.toasts).toHaveLength(1)
})

test('questions: asked, answered by a real reply, or stale and kept open after the model says no', async ($, on) => {
  const t = world($, on)
  await t.prompt(GOAL)
  await t.prompt('Should this run in a worktree?')
  expect(t.statuses.at(-1)).toBe('goal: fix video-generation… · on track · 1 open Q')
  await t.turn([t.goalEdit], 'Yes, this should run in a worktree: it touches many files and a worktree keeps the main checkout clean.')
  expect(t.statuses.at(-1)).toBe('goal: fix video-generation… · on track')

  t.reply = 'NO'
  await t.prompt('Why is the selector slow on mobile?')
  for (let i = 0; i < 3; i += 1) await t.turn([t.goalEdit], 'Edited.')
  expect(t.statuses.at(-1)).toBe('goal: fix video-generation… · on track · 1 open Q')
  expect(String((await t.command('')).text)).toContain('Why is the selector slow on mobile?')
  expect(t.modelCalls.filter(c => c.startsWith('Question:'))).toHaveLength(1)
  await t.turn([t.goalEdit], 'Edited again.')
  expect(t.modelCalls.filter(c => c.startsWith('Question:'))).toHaveLength(1)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the band shows on drift or a stale question, hides when snoozed or in a survey (${surface})`, async ($, on) => {
    const t = world($, on)
    t.reply = 'PREREQUISITE'
    const mount = (props: object) => $.ui.mount({ plugin: 'goal-anchor', surface, component: 'AbovePrompt', props: props as never } as never)
    await t.prompt(GOAL)
    let ui = await mount(PROPS)
    expect(await ui.find({ key: 'goal-band' })).toBeUndefined()
    await ui.unmount()

    await t.env(6)
    ui = await mount(PROPS)
    expect((await ui.find({ key: 'goal-band' }))?.text).toMatch(/6 turns on environment work/)
    expect(await ui.find({ key: 'back' })).toBeDefined()
    await ui.press({ key: 'back' })
    expect(t.fills[0]).toContain(`what is blocking "${GOAL}"`)
    await ui.press({ key: 'snooze' })
    expect(await ui.find({ key: 'goal-band' })).toBeUndefined()
    await ui.unmount()

    ui = await mount({ ...PROPS, hasSurvey: true })
    expect(await ui.find({ key: 'goal-band' })).toBeUndefined()
    await ui.unmount()
  })
}

test('the next prompt carries the nudge and the open questions as context, not as system text', async ($, on) => {
  const t = world($, on)
  t.reply = 'PREREQUISITE'
  await t.prompt(GOAL)
  await t.prompt('Can we move this to a worktree?')
  await t.env(5)
  await t.prompt('ok keep going with the next step please')
  const context = (t.contexts.at(-1) ?? []).join('\n')
  expect(context).toContain('The last 5 turns went to environment/prerequisite work')
  expect(context).toContain('Unanswered questions from the user')
  expect(context).toContain('Can we move this to a worktree?')
})

test('the system prompt gains one static session section once a goal exists', async ($, on) => {
  on('prompt.compose', async () => ({ sections: [{ id: 'base', text: 'base', scope: 'shared' as const }] }))
  const t = world($, on)
  expect((await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })).sections.map(s => s.id)).toEqual(['base'])
  await t.prompt(GOAL)
  const sections = (await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })).sections
  const last = sections.at(-1)
  expect(last?.id).toBe('goal-anchor:goal')
  expect(last?.scope).toBe('session')
  expect(last?.text.split('\n')).toHaveLength(4)
  await t.env(5)
  expect((await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })).sections.at(-1)?.text).toBe(last?.text)
})
