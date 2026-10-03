import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const NOW = Date.parse('2026-10-03T10:00:00Z')

type Kit = Engine

/** The engine beneath the plugin: bottoms for the events the mod calls. */
function setup(on: On) {
  mock.clock(on, { now: NOW })
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  on('turn.start', async (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_, e) => ({ text: e.answer }))
  on('ui.toast', async (_, e) => {
    toasts.push(String((e as { text?: unknown }).text))
    return { value: undefined }
  })
  on('ui.status', async (_, e) => {
    statuses.push((e as { text?: string }).text)
    return { value: undefined }
  })
  on('tool.call', async (_, e) =>
    String((e as { command?: string }).command ?? '').includes('FAIL')
      ? { isError: true as const, result: 'x', text: 'boom' }
      : { result: 'ok', text: 'ok' },
  )
  return { toasts, statuses }
}

const FLAGGED = 'The correction utility never ran in prod.'
const THREE = [
  'The correction utility never ran in prod.',
  'The nightly job has not run since Tuesday.',
  'There is no record of the bulk update in the database.',
].join('\n')

let counter = 0
const start = ($: Kit, text = 'go') => $.turn.start({ text, turnId: `t${++counter}` } as Parameters<typeof $.turn.start>[0])
const finish = ($: Kit, answer: string, extra: Record<string, unknown> = {}) =>
  $.turn.complete({ answer, turnId: `t${counter}`, reason: 'answer', durationMs: 1, isAborted: false, ...extra } as Parameters<typeof $.turn.complete>[0])
const turn = async ($: Kit, answer: string) => {
  await start($)
  return finish($, answer)
}
const command = ($: Kit, args = '') => $.command.run({ command: 'claim-check', args } as Parameters<typeof $.command.run>[0])

test('three flagged sentences make one toast and a status', async ($, on) => {
  const { toasts, statuses } = setup(on)
  await turn($, THREE)
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('(+2 more)')
  expect(statuses[statuses.length - 1]).toBe('claims: 3 unverified')
})

test('the count carries across turns and /claim-check lists every flag', async ($, on) => {
  const { statuses } = setup(on)
  await turn($, THREE)
  await turn($, FLAGGED.replace('correction utility', 'backfill'))
  expect(statuses[statuses.length - 1]).toBe('claims: 4 unverified')
  const out = String((await command($)).text)
  expect(out).toContain('4 unverified this session')
  expect(out).toContain('4. [turn 2')
  expect(out).toContain('backfill')
})

test('a successful query in the turn suppresses the flags', async ($, on) => {
  const { toasts } = setup(on)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'sqlcmd -Q "select 1"' } as Parameters<typeof $.tool.call>[0])
  await finish($, FLAGGED)
  expect(toasts).toEqual([])
  expect(String((await command($)).text)).toContain('cleared by evidence')
})

test('a failed query does not suppress', async ($, on) => {
  const { toasts } = setup(on)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'sqlcmd -Q "select 1" FAIL' } as Parameters<typeof $.tool.call>[0])
  await finish($, FLAGGED)
  expect(toasts.length).toBe(1)
})

test('subagent turns are ignored', async ($, on) => {
  const { toasts } = setup(on)
  await start($)
  await finish($, FLAGGED, { agentId: 'a1' })
  expect(toasts).toEqual([])
})

test('aborted turns are ignored', async ($, on) => {
  const { toasts } = setup(on)
  await start($)
  await finish($, FLAGGED, { reason: 'aborted', isAborted: true })
  expect(toasts).toEqual([])
})

test('clean answers stay quiet', async ($, on) => {
  const { toasts, statuses } = setup(on)
  await turn($, 'I updated the parser and the unit tests pass.')
  expect(toasts).toEqual([])
  expect(statuses).toEqual([])
})

test('/claim-check clear resets the status and the count', async ($, on) => {
  const { statuses } = setup(on)
  await turn($, FLAGGED)
  const out = await command($, 'clear')
  expect(String(out.text)).toContain('cleared')
  expect(statuses[statuses.length - 1]).toBe(undefined)
  expect(String((await command($)).text)).toContain('nothing flagged')
})

test('the prompt rule is added once, last', async ($, on) => {
  setup(on)
  on('prompt.compose', async () => ({ sections: [{ id: 'base', text: 'base', scope: 'session' as const }] }))
  const out = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as unknown as Parameters<typeof $.prompt.compose>[0])
  const ids = out.sections.map(s => s.id)
  expect(ids.filter(id => id === 'claim-check:verify-rule').length).toBe(1)
  expect(ids[ids.length - 1]).toBe('claim-check:verify-rule')
})

test('injectRule false adds no section', { options: { injectRule: false } }, async ($, on) => {
  setup(on)
  on('prompt.compose', async () => ({ sections: [{ id: 'base', text: 'base', scope: 'session' as const }] }))
  const out = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as unknown as Parameters<typeof $.prompt.compose>[0])
  expect(out.sections.map(s => s.id)).toEqual(['base'])
})
