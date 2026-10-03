import { expect, test } from 'claude-code/testing'

import type { GoalAnchor, OpenQuestion } from '../types'
import {
  EMPTY_STATE,
  classifyTurn,
  composeText,
  contextLines,
  detectQuestions,
  finishTurn,
  isAnswered,
  isSubstantive,
  labelOf,
  makeAnchor,
  parseGoalArgs,
  parseLabel,
  statusText,
  summarizeTool,
  tokens,
} from '../hooks/anchor'
import type { State } from '../hooks/anchor'

const GOAL = 'Fix the video-generation select/button bug in GenerationForm'
const anchor: GoalAnchor = makeAnchor(GOAL, 'auto', 0)
const question = (id: number, text: string, askedAtTurn = 0): OpenQuestion => ({
  id, text, keywords: tokens(text), askedAtTurn, status: 'open', isModelChecked: false,
})
const state = (patch: Partial<State> = {}): State => ({ ...EMPTY_STATE, anchor, ...patch })

test('isSubstantive: real asks anchor, chatter and commands do not', () => {
  for (const text of ['/model', 'hi', 'thanks!', 'continue', 'ok go']) expect(isSubstantive(text, 'composer')).toBe(false)
  expect(isSubstantive(GOAL, 'composer')).toBe(true)
  expect(isSubstantive(GOAL, 'task-notification')).toBe(false)
})

test('the first substantive prompt is the anchor, labelled short', () => {
  const prompts = ['/clear', 'hi', 'ok', GOAL]
  const picked = prompts.find(text => isSubstantive(text, 'composer'))
  expect(picked).toBe(GOAL)
  expect(labelOf('Fix the video-generation select/button bug')).toBe('fix video-generation…')
  expect(labelOf('please fix the login')).toBe('fix login')
})

test('tokens drop filler, split names and stem', () => {
  expect(tokens('please fix the bug')).toEqual([])
  expect(tokens('GenerationForm.tsx')).toEqual(['generation', 'form', 'tsx'])
  expect(tokens('buttons')).toEqual(['button'])
  expect(tokens('video_generation/select')).toEqual(['video', 'generation', 'select'])
})

test('classifyTurn leans toward on-goal', () => {
  expect(classifyTurn(anchor, ['npm install', 'taskkill /F /PID 4120', 'netstat -ano | findstr :3001'], [], 'Port freed.')).toEqual({
    label: 'prerequisite', isOnGoal: false,
  })
  expect(classifyTurn(anchor, ['Edit src/GenerationForm.tsx'], ['src/GenerationForm.tsx'], '').isOnGoal).toBe(true)
  // an answer about the goal does not rescue a turn of environment tools
  expect(classifyTurn(anchor, ['npm install', 'kill 123'], [], 'Now the video select works again.').isOnGoal).toBe(false)
  expect(classifyTurn(anchor, [], [], 'The video select was reading the wrong generation id.').isOnGoal).toBe(true)
  expect(classifyTurn(anchor, ['Read docs/changelog.md'], [], 'Nothing there.')).toEqual({ label: 'other', isOnGoal: false })
  // vocabulary learned from goal turns widens "the goal's files"
  const learned = { ...anchor, vocab: ['queue'] }
  expect(classifyTurn(learned, ['Edit lib/queue.ts'], ['lib/queue.ts'], '').isOnGoal).toBe(true)
})

test('summarizeTool', () => {
  expect(summarizeTool({ tool: 'Bash', command: 'npm  run\n dev' })).toBe('npm run dev')
  expect(summarizeTool({ tool: 'Edit', file_path: 'a/b.ts' })).toBe('Edit a/b.ts')
  expect(summarizeTool({ tool: 'Grep', pattern: 'foo', path: 'src' })).toBe('Grep foo src')
  expect(summarizeTool({ tool: 'mcp__x__y' })).toBe('mcp__x__y')
  expect(summarizeTool({ tool: 'Bash', command: 'x'.repeat(300) })).toHaveLength(120)
})

test('detectQuestions', () => {
  expect(detectQuestions('Can we do this in a worktree? Also fix the port.').map(q => q.text)).toEqual(['Can we do this in a worktree?'])
  expect(detectQuestions('right?')).toEqual([])
  expect(detectQuestions('Look:\n```\nwhy is this a question?\n```\nthanks')).toEqual([])
  expect(detectQuestions('> why does this break?\nok')).toEqual([])
  expect(detectQuestions('the port is 3001?')).toEqual([])
  expect(detectQuestions('Why does GenerationForm.tsx re-render?').map(q => q.text)).toEqual(['Why does GenerationForm.tsx re-render?'])
  const open = [question(1, 'Can we do this in a worktree?')]
  expect(detectQuestions('Could we do this in a worktree instead?', open)).toEqual([])
  expect(detectQuestions('Why does alpha fail often? Why does bravo crash today? Why does charlie hang forever? Why does delta leak memory?')).toHaveLength(3)
})

test('isAnswered needs a real reply that covers the question', () => {
  const q = question(1, 'Should this run in a worktree?')
  expect(isAnswered(q, 'Yes.', 1)).toBe(false)
  expect(isAnswered(q, 'Yes, a worktree is the right call here since this run is risky and touches many files.', 1)).toBe(true)
  expect(isAnswered(q, 'I rebuilt the thing and restarted the dev server on a fresh port so it should be fine now.', 1)).toBe(false)
  const bare = { ...q, keywords: [] }
  expect(isAnswered(bare, 'x'.repeat(90), 1)).toBe(true)
  expect(isAnswered(bare, 'x'.repeat(90), 3)).toBe(false)
})

test('finishTurn counts drift, flags the crossing once, resets on goal', () => {
  let s = state()
  for (let i = 0; i < 4; i += 1) s = finishTurn(s, { toolLines: ['npm install'], editedPaths: [], answer: 'ok' })
  expect(s.drift).toMatchObject({ turnsAway: 4, kind: 'prerequisite', confirmation: 'none' })
  s = finishTurn(s, { toolLines: ['npm install'], editedPaths: [], answer: 'ok' })
  expect(s.drift).toMatchObject({ turnsAway: 5, confirmation: 'pending' })
  s = finishTurn(s, { toolLines: ['Edit src/GenerationForm.tsx'], editedPaths: ['src/GenerationForm.tsx'], answer: 'done' })
  expect(s.drift).toMatchObject({ turnsAway: 0, kind: null, confirmation: 'none' })
  expect(s.anchor?.vocab).toEqual(['generation', 'form'])
  expect(s.recent).toHaveLength(6)
})

test('statusText', () => {
  expect(statusText(EMPTY_STATE)).toBeUndefined()
  expect(statusText(state({ isAnchorOff: true }))).toBeUndefined()
  expect(statusText(state())).toBe('goal: fix video-generation… · on track')
  expect(statusText(state({ drift: { ...EMPTY_STATE.drift, turnsAway: 1 } }))).toBe('goal: fix video-generation… · 1 turn away')
  expect(statusText(state({ drift: { ...EMPTY_STATE.drift, turnsAway: 6 }, questions: [question(1, 'Why x y?')] }))).toBe(
    'goal: fix video-generation… · 6 turns away · 1 open Q',
  )
  expect(statusText(state({ questions: [question(1, 'Why x y?'), question(2, 'Why z w?')] }))).toBe('goal: fix video-generation… · on track · 2 open Qs')
})

test('composeText is four static lines', () => {
  const text = composeText(anchor)
  expect(text.split('\n')).toHaveLength(4)
  expect(text).toBe(composeText(makeAnchor(GOAL, 'command', 9)))
  expect(text).toContain(`"${GOAL}"`)
  expect(text).toContain('more than 3 turns')
})

test('contextLines: the nudge only once drift is confirmed, questions once asked before', () => {
  const away = { turnsAway: 6, kind: 'prerequisite' as const, confirmation: 'confirmed' as const, isToasted: true, snoozedUntil: 0 }
  expect(contextLines(state())).toEqual([])
  expect(contextLines(state({ drift: { ...away, confirmation: 'pending' } }))).toEqual([])
  expect(contextLines(state({ drift: { ...away, snoozedUntil: 11 } }))).toEqual([])
  const lines = contextLines(state({ drift: away, turns: 8, questions: [question(1, 'Should this be in a worktree?', 5), question(2, 'Why now?', 8)] }))
  expect(lines).toHaveLength(2)
  expect(lines[0]).toContain('The last 6 turns went to environment/prerequisite work')
  expect(lines[1]).toContain('1. "Should this be in a worktree?" (asked 3 turns ago)')
  expect(lines[1]).not.toContain('Why now')
})

test('parseLabel and parseGoalArgs', () => {
  expect(parseLabel('PREREQUISITE.')).toBe('prerequisite')
  expect(parseLabel('Goal')).toBe('goal')
  expect(parseLabel('hmm')).toBeUndefined()
  expect(parseGoalArgs('')).toEqual({ kind: 'show' })
  expect(parseGoalArgs('off')).toEqual({ kind: 'off' })
  expect(parseGoalArgs('answered 2')).toEqual({ kind: 'answered', target: 2 })
  expect(parseGoalArgs('answered all')).toEqual({ kind: 'answered', target: 'all' })
  expect(parseGoalArgs('answered').kind).toBe('error')
  expect(parseGoalArgs(' ship the beta ')).toEqual({ kind: 'set', text: 'ship the beta' })
})
