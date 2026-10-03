import { expect, test } from 'claude-code/testing'

import { completed, counts, groupDone, judge, preset, parseSpawn, spawned, statusText, synced, toolEnded, toolLabel, toolStarted, tree } from '../hooks/deck'

const T = 1_000_000

test('a subagent goes from spawned to completed, its tool calls counted', async () => {
  let rows = spawned([], { id: 'a1', type: 'Explore', description: 'find auth', startedAt: T })
  rows = toolStarted(rows, 'a1', { id: 'c1', label: 'Grep login', at: T + 1 })
  rows = toolEnded(rows, 'a1', 'c1', false)
  rows = toolStarted(rows, 'a1', { id: 'c2', label: 'Read auth.ts', at: T + 2 })
  rows = toolEnded(rows, 'a1', 'c2', true)
  rows = completed(rows, 'a1', { reason: 'answer', answer: 'It is in auth.ts', tokens: 1200 }, T + 5000)
  const [row] = rows
  expect(row?.status).toBe('completed')
  expect(row?.toolCount).toBe(2)
  expect(row?.errorCount).toBe(1)
  expect(row?.answer).toBe('It is in auth.ts')
  expect(row?.endedAt).toBe(T + 5000)
  expect(statusText(rows)).toBe('agents 0 running · 1 done')
})

test('aborted and errored turns read as killed and failed', async () => {
  let rows = spawned([], { id: 'a', type: 'x', description: '', startedAt: T })
  rows = spawned(rows, { id: 'b', type: 'x', description: '', startedAt: T })
  rows = completed(rows, 'a', { reason: 'aborted', answer: '' }, T)
  rows = completed(rows, 'b', { reason: 'error', answer: '' }, T)
  expect(rows.map(one => one.status)).toEqual(['killed', 'failed'])
  expect(counts(rows)).toEqual({ running: 0, done: 0, failed: 2 })
})

test("the engine's list adds missed agents and settles statuses", async () => {
  const rows = spawned([], { id: 'a', type: 'Explore', description: 'one', startedAt: T })
  const next = synced(
    rows,
    [
      { id: 'a', type: 'Explore', description: 'one', status: 'killed' },
      { id: 'b', type: 'Plan', description: 'two', status: 'running', parentId: 'a' },
    ],
    T + 10,
  )
  expect(next.map(one => [one.id, one.status])).toEqual([['a', 'killed'], ['b', 'running']])
  expect(next[0]?.endedAt).toBe(T + 10)
  expect(tree(next).map(one => [one.row.id, one.depth])).toEqual([['a', 0], ['b', 1]])
})

test('tool labels name the main argument', async () => {
  expect(toolLabel('Grep', { pattern: 'login' })).toBe('Grep login')
  expect(toolLabel('Read', { file_path: 'C:\\code\\src\\auth.ts' })).toBe('Read auth.ts')
  expect(toolLabel('mcp__github__search', {})).toBe('github:search')
})

test('/deck spawn parsing', async () => {
  expect(parseSpawn('Explore --model haiku find the auth code')).toEqual({ type: 'Explore', model: 'haiku', prompt: 'find the auth code' })
  expect('error' in parseSpawn('Explore')).toBe(true)
})

test('policy: a cap refuses, a model rule applies when the call names none', async () => {
  const policy = { maxRunning: 2, models: { Explore: 'haiku' } }
  expect('deny' in judge(policy, { subagentType: 'Explore', fork: false }, 2)).toBe(true)
  expect(judge(policy, { subagentType: 'Explore', fork: false }, 1)).toEqual({ model: 'haiku' })
  expect(judge(policy, { subagentType: 'Explore', model: 'opus', fork: false }, 1)).toEqual({})
  expect(judge(policy, { subagentType: 'Explore', fork: true }, 1)).toEqual({})
})

test('review preset fans out three read-only reviewers, scoped when asked', async () => {
  const agents = preset('review', 'hooks/register.tsx')
  expect(agents?.map(one => one.description)).toEqual(['review: correctness', 'review: security', 'review: quality & tests'])
  expect(agents?.every(one => one.prompt.includes('Do NOT edit') && one.prompt.includes('hooks/register.tsx'))).toBe(true)
  expect(preset('nope', '')).toBe(undefined)
})

test('a group is done once every member has ended', async () => {
  let rows = spawned([], { id: 'a', type: 'g', description: '', startedAt: T, group: 'review #1' })
  rows = spawned(rows, { id: 'b', type: 'g', description: '', startedAt: T, group: 'review #1' })
  rows = completed(rows, 'a', { reason: 'answer', answer: 'ok' }, T)
  expect(groupDone(rows, 'review #1')).toBe(false)
  rows = completed(rows, 'b', { reason: 'error', answer: '' }, T)
  expect(groupDone(rows, 'review #1')).toBe(true)
})
