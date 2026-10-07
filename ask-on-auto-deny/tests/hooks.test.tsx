import { expect, mock, test } from 'claude-code/testing'
import type { On, PluginOptions } from 'claude-code'
import type { TestBody } from 'claude-code/testing'

const NOW = Date.parse('2026-10-07T10:00:00Z')
const SED = "sed -i 's/old/new/' ~/.claude/agents/codex-runner.md"
const BAND = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} } as const
const BLOCKED = 'Permission for this action has been denied by the auto mode classifier. Reason: [Self-Modification] edits agent config'

/** The world beneath the module: the tool "runs" (and is recorded), the verdict is the engine's, prompts and toasts are captured. */
function world($: Parameters<TestBody>[0], on: On) {
  const clock = mock.clock(on, { now: NOW })
  const toasts: string[] = []
  const submitted: string[] = []
  const filled: string[] = []
  const calls: string[] = []
  const state: { status: string; toolResult: Record<string, unknown>; verdict: Record<string, unknown> } = {
    status: '',
    toolResult: { result: { stdout: 'ok', stderr: '', interrupted: false } },
    verdict: { decision: 'ask', reason: 'bottom' },
  }
  on('tool.call', async (_, e) => {
    calls.push(String((e as { tool?: string }).tool))

    return state.toolResult as never
  })
  on('tool.check', async () => state.verdict as never)
  on('classic.PermissionDenied', async () => ({}))
  on('ui.toast', async (_, e) => {
    toasts.push(String((e as { text?: unknown }).text))

    return { value: undefined }
  })
  on('ui.status', async (_, e) => {
    state.status = String((e as { text?: unknown }).text ?? '')

    return { value: undefined }
  })
  on('prompt.submit', async (_, e) => {
    submitted.push(e.text)

    return { text: e.text }
  })
  on('prompt.read', async () => ({ value: { text: '', cursor: 0 } }) as never)
  on('prompt.fill', async (_, e) => {
    filled.push(String((e as { text?: unknown }).text))

    return { isFilled: true } as never
  })
  // the engine's own AbovePrompt: a bare line
  on('ui.render', async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box key="engine">
        <Text>engine</Text>
      </Box>
    )
  })

  const deny = (id: string, command: string, extra: Record<string, unknown> = {}) =>
    $.classic.PermissionDenied({
      tool_name: 'Bash',
      tool_input: { command, description: 'x' },
      tool_use_id: id,
      reason: '[Self-Modification] edits agent config',
      permission_mode: 'auto',
      ...extra,
    } as never)
  const check = (command: string, id?: string) =>
    $.tool.check({ tool: 'Bash', input: { command, description: 'other' }, ...(id ? { tool_use_id: id } : {}) } as never) as Promise<{ decision: string; reason?: string }>
  const run = (args: string) => $.command.run({ command: 'auto-allow', args } as Parameters<typeof $.command.run>[0])
  const text = async (args: string) => String((await run(args)).text)
  const mount = (surface: 'terminal' | 'desktop' = 'terminal') =>
    $.ui.mount({ plugin: 'ask-on-auto-deny', surface, component: 'AbovePrompt', props: BAND })

  return { clock, toasts, submitted, filled, calls, state, deny, check, run, text, mount }
}

test('a denial shows in the band and toasts', async ($, on) => {
  const w = world($, on)
  await w.deny('tu-1', SED)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await w.mount(surface)
    expect(await ui.find({ key: 'allow-1' })).toBeDefined()
    expect(await ui.find({ key: 'refuse-1' })).toBeDefined()
    await ui.unmount()
  }
  expect(w.toasts).toEqual(['Auto mode blocked Bash: Self-Modification. Allow once above the prompt or /auto-allow.'])
  expect(w.state.status).toBe('auto-deny: 1 pending')
})

test('the tool result is a second signal, and the two are de-duplicated', async ($, on) => {
  const w = world($, on)
  w.state.toolResult = { isError: true as const, result: 'denied', text: BLOCKED }
  const r = (await $.tool.call({ tool: 'Bash', command: SED, tool_use_id: 'tu-1' } as Parameters<typeof $.tool.call>[0])) as { isError?: boolean; text?: string }
  expect(r.text).toBe(BLOCKED)
  const ui = await w.mount()
  expect(await ui.find({ key: 'allow-1' })).toBeDefined()
  await ui.unmount()
  expect(w.toasts).toHaveLength(1)
  await w.deny('tu-1', SED)
  expect(w.toasts).toHaveLength(1)
  expect(((await w.text('status')).match(/#1 /g) ?? []).length).toBe(1)
})

test('Allow once submits a specific retry prompt', async ($, on) => {
  const w = world($, on)
  await w.deny('tu-1', SED)
  const ui = await w.mount()
  await ui.press({ key: 'allow-1' })
  expect(w.submitted).toHaveLength(1)
  expect(w.submitted[0]).toContain('Bash')
  expect(w.submitted[0]).toContain("sed -i 's/old/new/'")
  expect(w.submitted[0]).toContain('Retry it unchanged; it is allowed once')
  expect(w.state.status).toContain('1 allowed')
  await ui.unmount()
  const after = await w.mount()
  expect(await after.find({ key: 'allow-1' })).toBeUndefined()
  await after.unmount()
})

test('the retry is allowed once, then the allowance is gone', async ($, on) => {
  const w = world($, on)
  await w.deny('tu-1', SED)
  const ui = await w.mount()
  await ui.press({ key: 'allow-1' })
  await ui.unmount()
  const first = await w.check(`  ${SED} `, 'tu-2')
  expect(first.decision).toBe('allow')
  expect(first.reason).toContain('ask-on-auto-deny')
  expect(await w.check(SED, 'tu-3')).toEqual({ decision: 'ask', reason: 'bottom' })
  expect(await w.text('status')).toContain('used')
})

test('what does not match passes through untouched', async ($, on) => {
  const w = world($, on)
  await w.deny('tu-1', SED)
  const ui = await w.mount()
  await ui.press({ key: 'allow-1' })
  await ui.unmount()
  const toasts = w.toasts.length

  expect(await w.check('rm -rf build', 'tu-4')).toEqual({ decision: 'ask', reason: 'bottom' })
  const r = await $.tool.call({ tool: 'Bash', command: 'ls -la' } as Parameters<typeof $.tool.call>[0])
  expect((r as { result?: unknown }).result).toEqual({ stdout: 'ok', stderr: '', interrupted: false })
  expect(w.toasts).toHaveLength(toasts)

  // a settings rule is never overridden, and the denied check does not consume the allowance
  w.state.verdict = { decision: 'deny', rule: 'Bash(sed:*)', reason: 'rule' }
  expect(await w.check(SED, 'tu-5')).toEqual({ decision: 'deny', rule: 'Bash(sed:*)', reason: 'rule' })
  w.state.verdict = { decision: 'ask', reason: 'bottom' }
  expect((await w.check(SED, 'tu-6')).decision).toBe('allow')
})

test('a classifier deny verdict is overridable, a hook deny is not', async ($, on) => {
  const w = world($, on)
  await w.deny('tu-1', SED)
  const ui = await w.mount()
  await ui.press({ key: 'allow-1' })
  await ui.unmount()
  w.state.verdict = { decision: 'deny', hook: 'PreToolUse', reason: BLOCKED }
  expect((await w.check(SED, 'tu-2')).decision).toBe('deny')
  w.state.verdict = { decision: 'deny', reason: BLOCKED }
  expect((await w.check(SED, 'tu-3')).decision).toBe('allow')
})

test('a query does not consume', async ($, on) => {
  const w = world($, on)
  await w.deny('tu-1', SED)
  const ui = await w.mount()
  await ui.press({ key: 'allow-1' })
  await ui.unmount()
  expect((await w.check(SED)).decision).toBe('allow')
  expect((await w.check(SED, 'tu-7')).decision).toBe('allow')
})

test('Refuse clears the row and grants nothing', async ($, on) => {
  const w = world($, on)
  await w.deny('tu-1', SED)
  const ui = await w.mount()
  await ui.press({ key: 'refuse-1' })
  expect(w.submitted).toEqual([])
  expect(w.state.status).toBe('')
  expect(await ui.find({ key: 'allow-1' })).toBeUndefined()
  await ui.unmount()
  expect(await w.text('status')).toContain('refused')
  expect((await w.check(SED, 'tu-8')).decision).toBe('ask')
})

test('an allowance expires', async ($, on) => {
  const w = world($, on)
  await w.deny('tu-1', SED)
  const ui = await w.mount()
  await ui.press({ key: 'allow-1' })
  await ui.unmount()
  await w.clock.advance(11 * 60_000)
  expect((await w.check(SED, 'tu-9')).decision).toBe('ask')
  expect(await w.text('status')).toContain('expired')
  expect(w.state.status).toBe('')
})

test('a command that is not typed by a person cannot allow, but can refuse', async ($, on) => {
  const w = world($, on)
  await w.deny('tu-1', SED)
  expect(await w.text('allow')).toContain('has to be typed by you')
  expect((await w.check(SED, 'tu-2')).decision).toBe('ask')
  expect(w.submitted).toEqual([])
  expect(await w.text('refuse')).toContain('refused #1')
})

test('the band allows the entry it was pressed on, a typed-only allow refuses a stranger, and clear empties the rows', async ($, on) => {
  const w = world($, on)
  await w.deny('tu-1', SED)
  await w.deny('tu-2', 'rm old.txt')
  const ui = await w.mount()
  await ui.press({ key: 'allow-1' })
  expect(w.submitted[0]).toContain('sed')
  await ui.unmount()
  expect(await w.text('allow 7')).toContain('has to be typed')
  expect(await w.text('clear')).toContain('cleared')
  const empty = await w.mount()
  expect(await empty.find({ key: 'allow-2' })).toBeUndefined()
  await empty.unmount()
  expect(w.state.status).toBe('')
})

test('autoSubmit off puts the retry in the prompt box', { options: { autoSubmit: false } as PluginOptions }, async ($, on) => {
  const w = world($, on)
  await w.deny('tu-1', SED)
  const ui = await w.mount()
  await ui.press({ key: 'allow-1' })
  await ui.unmount()
  expect(w.filled[0]).toContain('Retry it unchanged')
  expect(w.submitted).toEqual([])
})

test('a subagent denial is marked, and the retry says so', async ($, on) => {
  const w = world($, on)
  await w.deny('tu-s', SED, { agent_id: 'agent-1' })
  const ui = await w.mount()
  expect(await ui.find({ type: 'Text', text: /\(subagent\)/ })).toBeDefined()
  await ui.press({ key: 'allow-1' })
  expect(w.submitted[0]).toContain('A subagent made this call')
  await ui.unmount()
})

test('more than maxPending rows folds into a count', async ($, on) => {
  const w = world($, on)
  for (const i of [1, 2, 3, 4]) await w.deny(`tu-${i}`, `rm file${i}`)
  const ui = await w.mount()
  expect(await ui.find({ key: 'more' })).toBeDefined()
  expect(await ui.find({ key: 'allow-1' })).toBeUndefined()
  expect(await ui.find({ key: 'allow-4' })).toBeDefined()
  await ui.unmount()
})

test('askDialog asks in the question dialog', { options: { askDialog: true } as PluginOptions }, async ($, on) => {
  const w = world($, on)
  await w.deny('tu-1', SED)
  await w.clock.advance(1)
  expect(w.calls).toContain('AskUserQuestion')
})
