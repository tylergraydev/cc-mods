import { expect, mock, test } from 'claude-code/testing'
import type { On, PluginOptions } from 'claude-code'
import type { TestBody } from 'claude-code/testing'

const NOW = Date.parse('2026-10-03T10:00:00Z')
const SYNC = 'pwsh -File scripts/data/sync-prod-to-stage.ps1'
const BAND = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} } as const

type Result = { deny?: string; isError?: boolean; text?: string }
const reasonOf = (r: Result) => r.deny ?? (r.isError ? r.text : undefined)

/** The world beneath the module: the command "runs" (and is recorded), toasts and status lines are captured, the clock stands still. */
function world($: Parameters<TestBody>[0], on: On) {
  const clock = mock.clock(on, { now: NOW })
  const ran: string[] = []
  const toasts: string[] = []
  const state = { fail: false, status: '' }
  on('tool.call', async (_, e) => {
    ran.push(String((e as { command?: string }).command))
    return state.fail
      ? { isError: true as const, result: 'exit 1', text: 'Exit code 1' }
      : { result: { stdout: 'ok', stderr: '', interrupted: false } as never }
  })
  on('ui.toast', async (_, e) => {
    toasts.push(String((e as { text?: unknown }).text))
    return { value: undefined }
  })
  on('ui.status', async (_, e) => {
    state.status = String((e as { text?: unknown }).text ?? '')
    return { value: undefined }
  })
  // the engine's own AbovePrompt: a bare line
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">engine</Text>
  })
  const call = (command: string, tool: 'Bash' | 'PowerShell' = 'Bash') => $.tool.call({ tool, command } as Parameters<typeof $.tool.call>[0]) as Promise<Result>
  const run = (args: string) => $.command.run({ command: 'guardrail', args } as Parameters<typeof $.command.run>[0])
  return { clock, ran, toasts, state, call, run }
}

const OPEN: PluginOptions = { requireTypedAllow: false }

test('git push --no-verify is denied, with a toast and a status count', async ($, on) => {
  const w = world($, on)
  const r = await w.call('git push --no-verify')
  expect(reasonOf(r)).toContain('guardrail')
  expect(reasonOf(r)).toContain('ask')
  expect(w.ran).toEqual([])
  expect(w.toasts[0]).toContain('git push --no-verify')
  expect(w.state.status).toContain('1 blocked')
})

test('git commit --no-verify is denied through the PowerShell tool', async ($, on) => {
  const w = world($, on)
  expect(reasonOf(await w.call('git commit --no-verify -m x', 'PowerShell'))).toContain('guardrail')
  expect(w.ran).toEqual([])
})

test('a live data command with no dry run is denied', async ($, on) => {
  const w = world($, on)
  const reason = reasonOf(await w.call(SYNC, 'PowerShell'))
  expect(reason).toContain('live data operation')
  expect(reason).toContain('/guardrail allow')
  expect(w.ran).toEqual([])
})

test('a dry run reaches the command and unlocks the live run', async ($, on) => {
  const w = world($, on)
  await w.call(`${SYNC} -WhatIf`, 'PowerShell')
  expect(w.ran).toEqual([`${SYNC} -WhatIf`])
  expect(w.state.status).toContain('dry-run ✓ sync-prod-to-stage.ps1')
  expect(reasonOf(await w.call(SYNC, 'PowerShell'))).toBeUndefined()
  expect(w.ran).toHaveLength(2)
})

test('a failed dry run does not unlock', async ($, on) => {
  const w = world($, on)
  w.state.fail = true
  await w.call(`${SYNC} -WhatIf`, 'PowerShell')
  w.state.fail = false
  expect(reasonOf(await w.call(SYNC, 'PowerShell'))).toContain('guardrail')
})

test('a dry run of one script does not unlock another', async ($, on) => {
  const w = world($, on)
  await w.call('./sync-a.ps1 -WhatIf')
  expect(reasonOf(await w.call('./sync-a.ps1'))).toBeUndefined()
  expect(reasonOf(await w.call('./sync-b.ps1'))).toContain('guardrail')
})

test('session scope: any dry run unlocks', { options: { dryRunScope: 'session' } }, async ($, on) => {
  const w = world($, on)
  await w.call('./sync-a.ps1 -WhatIf')
  expect(reasonOf(await w.call('./sync-b.ps1'))).toBeUndefined()
})

test('a dry run chained with its live run is denied', async ($, on) => {
  const w = world($, on)
  const r = await w.call('./sync-a.ps1 -WhatIf && ./sync-a.ps1')
  expect(reasonOf(r)).toContain('own command')
  expect(w.ran).toEqual([])
})

test('/guardrail allow lets one live command through once', { options: OPEN }, async ($, on) => {
  const w = world($, on)
  expect(reasonOf(await w.call('./sync-a.ps1'))).toContain('guardrail')
  expect(String((await w.run('allow')).text)).toContain('allowed once')
  expect(reasonOf(await w.call('./sync-a.ps1'))).toBeUndefined()
  expect(w.toasts.some(t => t.includes('through once'))).toBe(true)
  expect(reasonOf(await w.call('./sync-a.ps1'))).toContain('guardrail')
})

test('allow no-verify is kind-specific', { options: OPEN }, async ($, on) => {
  const w = world($, on)
  await w.run('allow')
  expect(reasonOf(await w.call('git push --no-verify'))).toContain('guardrail')
  await w.run('allow no-verify')
  expect(reasonOf(await w.call('git push --no-verify'))).toBeUndefined()
  expect(w.ran).toEqual(['git push --no-verify'])
})

test('with typed allow required, the kit origin is not a person', async ($, on) => {
  const w = world($, on)
  await w.call('./sync-a.ps1')
  const r = await w.run('allow')
  expect([String(r.text).includes('allowed once'), String(r.text).includes('has to be typed')].filter(Boolean)).toHaveLength(1)
})

test('an allowance expires', { options: OPEN }, async ($, on) => {
  const w = world($, on)
  await w.run('allow')
  await w.clock.advance(11 * 60_000)
  expect(reasonOf(await w.call('./sync-a.ps1'))).toContain('guardrail')
})

test('the band offers Allow once after a block', { options: OPEN }, async ($, on) => {
  const w = world($, on)
  await w.call('./sync-a.ps1')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'guardrail', surface, component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ key: 'allow' })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'guardrail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await ui.press({ key: 'allow' })
  expect(reasonOf(await w.call('./sync-a.ps1'))).toBeUndefined()
  await ui.unmount()
  const after = await $.ui.mount({ plugin: 'guardrail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await after.find({ key: 'allow' })).toBeUndefined()
  await after.unmount()
})

test('commands that are none of its business pass through untouched', async ($, on) => {
  const w = world($, on)
  const commands = ['ls -la', 'git push origin main', 'git push -n', 'git commit -m "mention --no-verify"', 'Invoke-Sqlcmd -Query "SELECT 1"', 'rsync -a a b']
  for (const command of commands) {
    const r = await w.call(command)
    expect(reasonOf(r)).toBeUndefined()
  }
  expect(w.ran).toEqual(commands)
  expect(w.toasts).toEqual([])
  expect(String((await w.run('status')).text)).toContain('blocked: 0')
})

test('/guardrail status lists dry runs and the blocked count', async ($, on) => {
  const w = world($, on)
  await w.call('./sync-a.ps1 -WhatIf')
  await w.call('git push --no-verify')
  const text = String((await w.run('status')).text)
  expect(text).toContain('sync-a.ps1')
  expect(text).toContain('blocked: 1')
})

test('/guardrail reset clears dry runs', async ($, on) => {
  const w = world($, on)
  await w.call('./sync-a.ps1 -WhatIf')
  await w.run('reset')
  expect(reasonOf(await w.call('./sync-a.ps1'))).toContain('guardrail')
  expect(w.state.status).toContain('no dry-run yet')
})
