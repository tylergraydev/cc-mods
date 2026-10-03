import { expect, test } from 'claude-code/testing'

import { current, DAY, duration, fromClaude, fromCodexLog, HOUR, project, record, sparkline } from '../hooks/usage'

const NOW = Date.parse('2026-10-02T12:00:00Z')

const codexLine = (at: string, primary: unknown, secondary: unknown) =>
  JSON.stringify({
    timestamp: at,
    type: 'event_msg',
    payload: { type: 'token_count', rate_limits: { limit_id: 'codex', primary, secondary, plan_type: 'prolite' } },
  })

test('Codex: the last rate_limits record wins, windows labelled by length', async () => {
  const text = [
    'cut-off half line {"rate_limits":{',
    codexLine('2026-10-02T10:00:00Z', { used_percent: 10, window_minutes: 300, resets_at: 1791000000 }, null),
    codexLine('2026-10-02T11:00:00Z', { used_percent: 12, window_minutes: 300, resets_at: 1791000000 }, { used_percent: 52, window_minutes: 10080, resets_at: 1791053257 }),
    '{"type":"response_item","payload":{}}',
  ].join('\n')
  const source = fromCodexLog(text)
  expect(source?.plan).toBe('prolite')
  expect(source?.seenAt).toBe(Date.parse('2026-10-02T11:00:00Z'))
  expect(source?.windows.map(w => [w.label, w.percent])).toEqual([['5h', 12], ['7d', 52]])
  expect(source?.windows[1]?.resetsAt).toBe(1791053257000)
})

test('Codex: a record with no windows is skipped, a file with none is null', async () => {
  const text = [
    codexLine('2026-10-02T10:00:00Z', { used_percent: 40, window_minutes: 10080, resets_at: 1 }, null),
    codexLine('2026-10-02T11:00:00Z', null, null),
  ].join('\n')
  expect(fromCodexLog(text)?.windows[0]?.percent).toBe(40)
  expect(fromCodexLog('{"type":"x"}\n')).toBe(null)
})

test('Claude Code: five_hour and seven_day become 5h and 7d', async () => {
  const source = fromClaude(
    [
      { kind: 'seven_day', percentUsed: 61, resetsAt: '2026-10-05T00:00:00Z' },
      { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-02T14:00:00Z' },
    ],
    NOW,
  )
  expect(source?.windows.map(w => w.label)).toEqual(['5h', '7d'])
  expect(source?.windows[0]?.lengthMs).toBe(5 * HOUR)
  expect(fromClaude([], NOW)).toBe(null)
})

test('a window past its reset reads 0', async () => {
  const win = current({ label: '5h', percent: 80, resetsAt: NOW - 1, lengthMs: 5 * HOUR }, NOW)
  expect(win.percent).toBe(0)
  expect(win.isReset).toBe(true)
})

test('projection: a fast burn hits 100% before the reset', async () => {
  const win = { label: '5h', percent: 50, resetsAt: NOW + 3 * HOUR, lengthMs: 5 * HOUR }
  const series = [{ t: NOW - HOUR, p: 25 }, { t: NOW, p: 50 }]
  const forecast = project(win, series, NOW)
  expect(forecast.kind).toBe('cap')
  if (forecast.kind === 'cap') expect(Math.round(forecast.inMs / HOUR)).toBe(2)
})

test('projection: a slow burn lands under 100% at the reset', async () => {
  const win = { label: '7d', percent: 20, resetsAt: NOW + 2 * DAY, lengthMs: 7 * DAY }
  const series = [{ t: NOW - DAY, p: 10 }, { t: NOW, p: 20 }]
  const forecast = project(win, series, NOW)
  expect(forecast).toEqual({ kind: 'land', percent: 40 })
})

test('history keeps changes and drops repeats', async () => {
  let series = record([], { t: NOW, p: 10 })
  series = record(series, { t: NOW + 60_000, p: 10 })
  series = record(series, { t: NOW + 120_000, p: 11 })
  expect(series.map(one => one.p)).toEqual([10, 11])
})

test('sparkline and durations', async () => {
  const line = sparkline([{ t: NOW - HOUR, p: 0 }, { t: NOW, p: 100 }], 2 * HOUR, NOW, 4)
  expect(line).toBe('  ▁█')
  expect(duration(2 * HOUR + 13 * 60_000)).toBe('2h 13m')
  expect(duration(4 * DAY + 6 * HOUR)).toBe('4d 6h')
})
