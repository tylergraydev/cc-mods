import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} } as const
const MIN = 60_000

type Sandbox = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

/** The engine beneath the mod: a clock the test moves, a store, and recorders for statuses, toasts, command runs and compactions. */
function world($: Sandbox, on: On, opts: { handoff?: boolean; tokens?: number } = {}) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-07T14:00:00Z') })
  mock.store(on)
  const w = {
    clock,
    tokens: opts.tokens ?? 142_000,
    statuses: [] as (string | undefined)[],
    toasts: [] as string[],
    runs: [] as string[],
    compacts: 0,
    turnId: 0,
  }
  on('command.register', async (_, e) => ({ value: { command: e.name } }))
  on('command.list', async () => ({ value: (opts.handoff === false ? [] : [{ name: 'handoff', description: 'x' }]) as never }))
  on('ui.toast', async (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', async (_, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', async () => ({ value: undefined }))
  on('command.run', async (_, e) => {
    w.runs.push(e.command)
    return { text: '' }
  })
  on('session.usage', async () => ({
    value: { startedAt: 1, rateLimits: [], context: { window: 1_000_000, tokens: w.tokens, percent: Math.round(w.tokens / 10_000) } },
  }))
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('session.end', async () => ({ sessionId: 's1' }))
  on('session.compact', async () => {
    w.compacts += 1
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] as never, tokensBefore: w.tokens, tokensAfter: 8_000 }
  })
  on('turn.start', async (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_, e) => ({ text: e.answer }))
  on('ui.render', async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })

  const start = () => $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  const last = () => w.statuses[w.statuses.length - 1]
  /** One main-loop turn, started and completed. */
  const turn = async (extra: object = {}) => {
    w.turnId += 1
    const turnId = `t${w.turnId}`
    await $.turn.start({ text: 'hi', turnId })
    await $.turn.complete({ answer: 'ok', text: 'ok', reason: 'answer', durationMs: 1, isAborted: false, turnId, ...extra } as Parameters<typeof $.turn.complete>[0])
    await clock.settle()
  }
  const command = (args: string) => $.command.run({ command: 'cache', args } as Parameters<typeof $.command.run>[0])
  const mount = (props: object = PROPS) => $.ui.mount({ plugin: 'cache-clock', surface: 'terminal', component: 'AbovePrompt', props: props as never } as never)
  return Object.assign(w, { start, last, turn, command, mount })
}

test('an answer starts a 60 minute countdown that counts down in the status line', async ($, on) => {
  const t = world($, on)
  await t.start()
  expect(t.last()).toBeUndefined()
  await t.turn()
  expect(t.last()).toBe('60m left')
  await t.clock.advance(30 * MIN)
  expect(t.last()).toBe('30m left')
  await t.clock.advance(25 * MIN + 1000)
  expect(t.last()).toBe('4:59 left ⚠')
  await t.clock.advance(4 * MIN + 59_000)
  expect(t.last()).toBe('cold 0m · /cache')
  await t.clock.advance(13 * MIN)
  expect(t.last()).toBe('cold 13m · /cache')
})

test('while a turn runs the status reads warming, and the band stays down', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.turn()
  await t.clock.advance(61 * MIN)
  expect(t.last()).toBe('cold 1m · /cache')
  await $.turn.start({ text: 'next', turnId: 'x' })
  await t.clock.settle()
  expect(t.last()).toBe('warming')
  const ui = await t.mount()
  expect(await ui.find({ key: 'cache-clock-band' })).toBeUndefined()
  await ui.unmount()
})

test('after a lapse the band names the re-send and offers Compact (primary), Handoff, Clear and Keep going', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.turn()
  let ui = await t.mount()
  expect(await ui.find({ key: 'cache-clock-band' })).toBeUndefined()
  await ui.unmount()
  await t.clock.advance(63 * MIN)
  ui = await t.mount()
  const line = await ui.find({ key: 'cache-line' })
  expect(line?.text).toContain('lapsed 3 min ago')
  expect(line?.text).toContain('~142k tokens')
  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons.map(b => b.key)).toEqual(['compact', 'handoff', 'clear', 'keep'])
  expect(buttons[0].props.variant).toBe('primary')
  expect(buttons[3].props.variant).toBeUndefined()
  await ui.unmount()
})

test('a small context makes Keep going the primary press', async ($, on) => {
  const t = world($, on, { tokens: 12_400 })
  await t.start()
  await t.turn()
  await t.clock.advance(60 * MIN)
  const ui = await t.mount()
  expect((await ui.find({ key: 'cache-line' }))?.text).toContain('small miss')
  expect((await ui.find({ key: 'keep' }))?.props.variant).toBe('primary')
  expect((await ui.find({ key: 'compact' }))?.props.variant).toBeUndefined()
  await ui.unmount()
})

test('without a /handoff command the Handoff button is left out', async ($, on) => {
  const t = world($, on, { handoff: false })
  await t.start()
  await t.turn()
  await t.clock.advance(60 * MIN)
  const ui = await t.mount()
  expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['compact', 'clear', 'keep'])
  await ui.unmount()
})

test('Keep going hides the band until the next answer re-arms the clock', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.turn()
  await t.clock.advance(60 * MIN)
  let ui = await t.mount()
  await ui.press({ key: 'keep' })
  expect(await ui.find({ key: 'cache-clock-band' })).toBeUndefined()
  await ui.unmount()
  expect(t.last()).toBe('cold 0m · /cache')
  await t.clock.advance(5 * MIN)
  ui = await t.mount()
  expect(await ui.find({ key: 'cache-clock-band' })).toBeUndefined()
  await ui.unmount()
  await t.turn()
  expect(t.last()).toBe('60m left')
  await t.clock.advance(60 * MIN)
  ui = await t.mount()
  expect(await ui.find({ key: 'cache-clock-band' })).toBeDefined()
  await ui.unmount()
})

test('Compact compacts the session and the clock goes idle until the next answer', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.turn()
  await t.clock.advance(60 * MIN)
  const ui = await t.mount()
  await ui.press({ key: 'compact' })
  await t.clock.settle()
  expect(t.compacts).toBe(1)
  expect(t.toasts[0]).toContain('compacting')
  expect(t.last()).toBeUndefined()
  expect(await ui.find({ key: 'cache-clock-band' })).toBeUndefined()
  await ui.unmount()
  await t.turn()
  expect(t.last()).toBe('60m left')
})

test('Handoff and Clear run those commands', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.turn()
  await t.clock.advance(60 * MIN)
  let ui = await t.mount()
  await ui.press({ key: 'handoff' })
  await t.clock.settle()
  expect(t.runs).toEqual(['handoff'])
  await ui.unmount()
  await t.turn()
  await t.clock.advance(60 * MIN)
  ui = await t.mount()
  await ui.press({ key: 'clear' })
  await t.clock.settle()
  expect(t.runs).toEqual(['handoff', 'clear'])
  await ui.unmount()
})

test('a compaction from elsewhere and a /clear both reset the clock', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.turn()
  expect(t.last()).toBe('60m left')
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'x', toolUses: [] }] } as never)
  await t.clock.settle()
  expect(t.last()).toBeUndefined()
  await t.turn()
  expect(t.last()).toBe('60m left')
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  await t.clock.settle()
  expect(t.last()).toBeUndefined()
  // The timer survives the clear: the next answer counts again.
  await t.turn()
  expect(t.last()).toBe('60m left')
})

test('/cache ttl 5 shortens the window and is kept in the store; /cache reports; band off hides the band', async ($, on) => {
  const t = world($, on)
  await t.start()
  const r = await t.command('ttl 5')
  expect(r.text).toContain('TTL 5 min')
  await t.turn()
  expect(t.last()).toBe('5:00 left ⚠')
  const status = await t.command('')
  expect(status.text).toContain('holds for another 5:00 (TTL 5 min)')
  expect(status.text).toContain('~142k tokens')
  await t.clock.advance(5 * MIN)
  expect(t.last()).toBe('cold 0m · /cache')
  const bad = await t.command('ttl 0')
  expect(bad.text).toContain('1 to 1440')
  await t.command('band off')
  const ui = await t.mount()
  expect(await ui.find({ key: 'cache-clock-band' })).toBeUndefined()
  await ui.unmount()
})

test('an API-error turn does not re-arm the clock; an aborted one does', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.turn({ reason: 'error' })
  expect(t.last()).toBeUndefined()
  await t.turn({ reason: 'aborted', isAborted: true })
  expect(t.last()).toBe('60m left')
})
