import { expect, test } from 'claude-code/testing'

import type { DoctorMarkers, DoctorResult, DoctorRun } from '../types'
import { composeText, psq, statusLine, summaryForModel, toastText } from '../hooks/summary'

const BARE: DoctorMarkers = { isWindows: true, isGit: false, hasGlobalJson: false, isDotnet: false, isNode: false, hasCompose: false }
const NODE: DoctorMarkers = { ...BARE, isNode: true }

const res = (id: DoctorResult['id'], status: DoctorResult['status'], extra: Partial<DoctorResult> = {}): DoctorResult => ({
  id,
  name: id,
  status,
  evidence: `${id} ${status}`,
  gate: 'test',
  ms: 0,
  at: 0,
  ...extra,
})
const runOf = (results: DoctorResult[], markers: DoctorMarkers = NODE): DoctorRun => ({
  root: 'C:/repo',
  reason: 'command',
  startedAt: 0,
  finishedAt: 0,
  markers,
  results,
})

test('status line: skips are left out, warn counts as ok, the mark follows the fails', () => {
  expect(statusLine(runOf([res('bash', 'pass'), res('node', 'warn'), res('docker', 'skip')]))).toBe('doctor: 2/2 ✓')
  expect(statusLine(runOf([res('bash', 'pass'), res('ports', 'fail'), res('docker', 'skip')]))).toBe('doctor: 1/2 ✗')
})

test('quiet rule: no project marker and nothing failed shows nothing', () => {
  expect(statusLine(runOf([res('bash', 'pass')], BARE))).toBe(undefined)
  expect(statusLine(runOf([res('bash', 'fail')], BARE))).toBe('doctor: 0/1 ✗')
})

test('toast: only when a fail id is new', () => {
  expect(toastText(['node', 'ports'], [])).toBe('dev-doctor FAIL: node, ports — /dev-doctor')
  expect(toastText(['node', 'ports'], ['ports', 'node'])).toBe(undefined)
  expect(toastText(['node'], ['node', 'ports'])).toBe(undefined)
  expect(toastText(['node', 'docker'], ['node'])).toContain('docker')
  expect(toastText([], ['node'])).toBe(undefined)
})

test('compose: empty with no fails, sorted, no ages, at most 4 lines', () => {
  expect(composeText([res('bash', 'pass'), res('node', 'warn')])).toBe('')
  const holders = [
    { port: 3001, pid: 2210, image: 'node.exe', isOwn: true },
    { port: 3000, pid: 18232, image: 'node.exe', isOwn: false },
  ]
  const a = [
    res('ports', 'fail', { holders, evidence: '3000: node.exe PID 18232, up 3d, cmd outside repo' }),
    res('dotnet-sdk', 'fail'),
    res('bash', 'pass'),
  ]
  const b = [...a].reverse().map(r => (r.holders ? { ...r, holders: [...r.holders].reverse(), evidence: 'up 9h' } : r))
  const text = composeText(a)
  expect(text).toBe(composeText(b))
  expect(text).toContain('FAIL dotnet-sdk, ports')
  expect(text).toContain('3001 node.exe PID 2210')
  expect(text).toContain('do not kill or restart')
  expect(text.split('\n').length).toBeLessThanOrEqual(4)
  expect(text).not.toMatch(/\bup\b|ago|\d+[smhd]\b/)
})

test('compose: an own-app port warning alone still speaks', () => {
  const holders = [{ port: 3001, pid: 2210, image: 'node.exe', isOwn: true }]
  expect(composeText([res('ports', 'warn', { holders })])).toContain('watched ports are in use')
})

test('the model summary lists names, statuses and evidence', () => {
  const text = summaryForModel(runOf([res('bash', 'pass'), res('ports', 'fail')]))
  expect(text.split('\n')[1]).toBe('FAIL ports: ports fail')
  expect(summaryForModel(null)).toContain('not run')
})

test('psq quotes for PowerShell', () => {
  expect(psq('C:\\Program Files\\x')).toBe("'C:\\Program Files\\x'")
  expect(psq("it's")).toBe("'it''s'")
})
