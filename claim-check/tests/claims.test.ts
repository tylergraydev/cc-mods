import { expect, test } from 'claude-code/testing'

import { findClaims, formatReport, isEvidence, splitSentences, statusText, summarizeToolCall, toastText } from '../hooks/claims'

const only = (text: string) => {
  const found = findClaims(text)
  expect(found.length).toBe(1)
  return found[0]!
}

test('positive: a flat "never ran in prod"', async () => {
  const c = only('The correction utility never ran in prod.')
  expect([c.marker, c.noun]).toEqual(['never-ran', 'prod'])
})

test('positive: the noun can sit in the previous sentence', async () => {
  const c = only('Looking at the prod error counts. The problem is getting worse.')
  expect([c.marker, c.noun]).toEqual(['worse', 'prod'])
})

test('positive: no record in the database', async () => {
  const c = only('There is no record of the bulk update in the database.')
  expect([c.marker, c.noun]).toEqual(['no-record', 'data'])
})

test('positive: "confirmed that" with nothing behind it', async () => {
  const c = only('I confirmed that the pipeline deployed build 4512.')
  expect([c.marker, c.noun]).toEqual(['confirmed', 'deploy'])
})

test('positive: has not run', async () => {
  const c = only('The job has not run since Tuesday.')
  expect([c.marker, c.noun]).toEqual(['not-run', 'deploy'])
})

test('positive: a bug never reproduced in staging', async () => {
  const c = only('Bug 2279 was never reproduced in staging.')
  expect(c.marker).toBe('was-never')
  expect(['ticket', 'prod']).toContain(c.noun)
})

test('positive: definitely in a resource group', async () => {
  const c = only('This definitely lives in the rg-claims-prod resource group.')
  expect([c.marker, c.noun]).toEqual(['definitely', 'azure'])
})

test('positive: App Insights says always', async () => {
  const c = only('App Insights shows no exceptions; it always succeeds.')
  expect([c.marker, c.noun]).toEqual(['always', 'telemetry'])
})

const quiet: [string, string][] = [
  ['would verify', "I'd verify this never ran before concluding."],
  ['labelled UNVERIFIED', 'UNVERIFIED: the utility never ran in prod.'],
  ['labelled hypothesis', 'Hypothesis: the utility never ran in prod.'],
  ['says it did not check', "I haven't checked, but it may never have run in prod."],
  ['conditional', 'If the utility never ran in prod, the rows would still be stale.'],
  ['question', 'Did the utility ever run in prod?'],
  ['code claim', 'This function never returns null.'],
  ['attributed to the user', "You said the job never ran in prod, so I'll start there."],
  ['fenced code', '```sql\nselect * from runs where never_ran = 1\n```'],
  ['about to check', 'Let me check whether the job ran in prod.'],
  ['unit tests', 'The unit tests always pass locally.'],
  ['inline code is dropped', 'Run `az devops` to confirm it was never deployed.'],
]

for (const [name, text] of quiet) {
  test(`negative: ${name}`, async () => {
    expect(findClaims(text)).toEqual([])
  })
}

test('splitter: bullets, headings and numbered lists split', async () => {
  expect(splitSentences('# Findings here\n- first bullet point\n* second bullet point\n1. numbered item one\n2. numbered item two')).toEqual([
    'Findings here',
    'first bullet point',
    'second bullet point',
    'numbered item one',
    'numbered item two',
  ])
})

test('splitter: two sentences on one line split; quotes and tables are dropped', async () => {
  expect(splitSentences('The first sentence ends. The second one ends too!')).toEqual(['The first sentence ends.', 'The second one ends too!'])
  expect(splitSentences('> quoted line that is long\n| a | b |\nkept sentence here')).toEqual(['kept sentence here'])
})

test('the same sentence from two sources is one candidate', async () => {
  const s = 'The correction utility never ran in prod.'
  expect(findClaims(`${s}\n${s}`).length).toBe(1)
})

test('evidence: queries and data reads count', async () => {
  const bash = (input: string, isOk = true) => ({ tool: 'Bash', input, isOk })
  expect(isEvidence(bash('sqlcmd -S prod -Q "select count(*) from Fixes"'))).toBe(true)
  expect(isEvidence({ tool: 'PowerShell', input: 'Invoke-Sqlcmd -Query "SELECT TOP 5 * FROM dbo.Runs"', isOk: true })).toBe(true)
  expect(isEvidence(bash('az devops invoke --area wit --resource workItems'))).toBe(true)
  expect(isEvidence(bash('az monitor app-insights query --app x'))).toBe(true)
  expect(isEvidence({ tool: 'mcp__AzureMCPServer__monitor_log_query', input: '{}', isOk: true })).toBe(true)
  expect(isEvidence({ tool: 'mcp__ado__wit_get_work_item', input: '{}', isOk: true })).toBe(true)
  expect(isEvidence({ tool: 'Read', input: 'C:/tmp/export/runs.csv', isOk: true })).toBe(true)
})

test('evidence: ordinary tools and failures do not', async () => {
  const no = (tool: string, input: string) => isEvidence({ tool, input, isOk: true })
  expect(no('Bash', 'git status')).toBe(false)
  expect(no('Bash', 'npm test')).toBe(false)
  expect(no('Edit', 'src/a.ts')).toBe(false)
  expect(no('mcp__claude-in-chrome__navigate', '{"url":"https://example.com"}')).toBe(false)
  expect(isEvidence({ tool: 'Bash', input: 'sqlcmd -Q "select 1"', isOk: false })).toBe(false)
})

test('summarizeToolCall maps a deny and an error to isOk false', async () => {
  const call = { tool: 'Bash', command: 'sqlcmd -Q "select 1"' }
  expect(summarizeToolCall(call, { result: 'ok' } as never).isOk).toBe(true)
  expect(summarizeToolCall(call, { deny: 'no' }).isOk).toBe(false)
  expect(summarizeToolCall(call, { isError: true }).isOk).toBe(false)
  expect(summarizeToolCall(call, {}).input).toBe('sqlcmd -Q "select 1"')
  expect(summarizeToolCall({ tool: 'mcp__a__b', x: 1 } as never, {}).input).toBe('{"x":1}')
})

test('toast and status text', async () => {
  expect(toastText([{ sentence: 'It never ran in prod.' }])).toBe('claim-check: unverified — "It never ran in prod."')
  expect(toastText([{ sentence: 'A one.' }, { sentence: 'B' }, { sentence: 'C' }])).toBe('claim-check: unverified — "A one." (+2 more)')
  expect(statusText(0)).toBe(undefined)
  expect(statusText(2)).toBe('claims: 2 unverified')
})

test('the report lists flags, labels turns by first appearance and ends with the last turn', async () => {
  const flag = (turnId: string, sentence: string) => ({ at: 0, turnId, sentence, marker: 'never-ran', noun: 'prod' })
  const out = formatReport([flag('t-9', 'One.'), flag('t-9', 'Two.'), flag('t-12', 'Three.')], { turnId: 't-12', candidates: 1, evidence: 0, flagged: 1 })
  expect(out).toContain('3 unverified this session')
  expect(out).toContain('1. [turn 1, never-ran/prod] "One."')
  expect(out).toContain('3. [turn 2, never-ran/prod] "Three."')
  expect(out).toContain('Last turn: 1 candidates, 0 evidence calls → flagged.')
  expect(out).toContain('`/claim-check clear`')
})
