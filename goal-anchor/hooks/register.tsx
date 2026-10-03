import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { OpenQuestion } from '../types'
import {
  DRIFT_TURNS,
  EMPTY_DRIFT,
  EMPTY_STATE,
  LABEL_SYSTEM,
  MODEL,
  QUESTION_SYSTEM,
  composeText,
  contextLines,
  describeGoal,
  detectQuestions,
  editedPath,
  finishTurn,
  fit,
  isDriftShown,
  isSubstantive,
  isUserKind,
  kindText,
  labelPrompt,
  learnVocab,
  makeAnchor,
  markAnswered,
  needsCheck,
  needsQuestionCheck,
  parseGoalArgs,
  parseLabel,
  parseYes,
  plural,
  questionPrompt,
  staleQuestions,
  statusText,
  summarizeTool,
  withAnchor,
} from './anchor'
import type { State } from './anchor'

const NAMES = ['goal', 'goal-anchor'] as const

const anchor = atom({ plugin: 'goal-anchor', key: 'anchor' } as const, EMPTY_STATE.anchor)
const isAnchorOff = atom({ plugin: 'goal-anchor', key: 'isAnchorOff' } as const, EMPTY_STATE.isAnchorOff)
const turns = atom({ plugin: 'goal-anchor', key: 'turns' } as const, EMPTY_STATE.turns)
const drift = atom({ plugin: 'goal-anchor', key: 'drift' } as const, EMPTY_STATE.drift)
const recent = atom({ plugin: 'goal-anchor', key: 'recent' } as const, EMPTY_STATE.recent)
const questions = atom({ plugin: 'goal-anchor', key: 'questions' } as const, EMPTY_STATE.questions)
const nextQuestionId = atom({ plugin: 'goal-anchor', key: 'nextQuestionId' } as const, EMPTY_STATE.nextQuestionId)
const lastPromptText = atom({ plugin: 'goal-anchor', key: 'lastPromptText' } as const, EMPTY_STATE.lastPromptText)

/** The whole state as one value. Reads subscribe a render; writes go through `save`. */
async function load($: EngineInterface): Promise<State> {
  return {
    anchor: await read($, anchor),
    isAnchorOff: await read($, isAnchorOff),
    turns: await read($, turns),
    drift: await read($, drift),
    recent: await read($, recent),
    questions: await read($, questions),
    nextQuestionId: await read($, nextQuestionId),
    lastPromptText: await read($, lastPromptText),
  }
}

/** Writes back only what changed. Called from event hooks and press handlers, never while rendering. */
async function save($: EngineInterface, was: State, now: State) {
  if (was.anchor !== now.anchor) await update($, anchor, () => now.anchor)
  if (was.isAnchorOff !== now.isAnchorOff) await update($, isAnchorOff, () => now.isAnchorOff)
  if (was.turns !== now.turns) await update($, turns, () => now.turns)
  if (was.drift !== now.drift) await update($, drift, () => now.drift)
  if (was.recent !== now.recent) await update($, recent, () => now.recent)
  if (was.questions !== now.questions) await update($, questions, () => now.questions)
  if (was.nextQuestionId !== now.nextQuestionId) await update($, nextQuestionId, () => now.nextQuestionId)
  if (was.lastPromptText !== now.lastPromptText) await update($, lastPromptText, () => now.lastPromptText)
}

/** Load, change, write back: the one way a handler touches state. */
async function change($: EngineInterface, fn: (s: State) => State): Promise<State> {
  const was = await load($)
  const now = fn(was)
  await save($, was, now)
  return now
}

async function refreshStatus($: EngineInterface) {
  $.ui.status(statusText(await load($)))
}

/** The model's verdict on a drift streak and on stale questions. One call per crossing, one per question. */
async function ask($: EngineInterface, system: string, prompt: string, maxTokens: number): Promise<string | undefined> {
  const r = await $.model
    .complete({ model: MODEL, effort: 'low', maxTokens, timeoutMs: 15_000, system, prompt })
    .catch(() => undefined)
  return r?.isAnswered ? r.text : undefined
}

// Module variables start over on a hot reload; the turn in flight loses its digest, nothing more.
let pending: string[] = []
let edited: string[] = []
let streakEdits: string[] = []
let isChecking = false

/** Runs off turn.complete on a timer: the model verdicts, then the one toast per streak. */
async function check($: EngineInterface) {
  if (isChecking) return
  isChecking = true
  try {
    let s = await load($)
    if (s.anchor && s.drift.confirmation === 'pending') {
      const verdict = parseLabel((await ask($, LABEL_SYSTEM, labelPrompt(s.anchor, s.recent), 16)) ?? '')
      // The model took a while: apply it only if the streak still stands.
      await change($, fresh => {
        if (!fresh.anchor || fresh.drift.confirmation !== 'pending') return fresh
        if (verdict === 'goal') {
          const vocab = learnVocab(fresh.anchor.vocab, streakEdits)
          streakEdits = []
          return { ...fresh, anchor: { ...fresh.anchor, vocab }, drift: { ...EMPTY_DRIFT } }
        }
        // No verdict (model down, odd reply) keeps the heuristic's kind and fires the alarm anyway.
        const kind = verdict ?? fresh.drift.kind
        return { ...fresh, drift: { ...fresh.drift, kind, confirmation: verdict ? 'confirmed' : 'heuristic' } }
      })
    }
    s = await load($)
    for (const q of needsQuestionCheck(s)) {
      const reply = await ask($, QUESTION_SYSTEM, questionPrompt(q, s.recent), 8)
      const isYes = reply !== undefined && parseYes(reply)
      await change($, fresh => ({
        ...fresh,
        questions: fresh.questions.map(one =>
          one.id === q.id ? { ...one, isModelChecked: true, status: isYes && one.status === 'open' ? 'answered' : one.status } : one,
        ),
      }))
    }
    s = await load($)
    if (s.anchor && !s.isAnchorOff && !s.drift.isToasted && (s.drift.confirmation === 'confirmed' || s.drift.confirmation === 'heuristic')) {
      $.ui.toast(`goal-anchor: ${plural(s.drift.turnsAway, 'turn')} on ${kindText(s.drift.kind)} since "${s.anchor.label}"`, { timeoutMs: 8000 })
      await change($, fresh => ({ ...fresh, drift: { ...fresh.drift, isToasted: true } }))
    }
    await refreshStatus($)
  } finally {
    isChecking = false
  }
}

/** The /goal command: show, set, switch off, or mark questions answered. */
async function runGoal($: EngineInterface, args: string) {
  const cmd = parseGoalArgs(args)
  if (cmd.kind === 'show') return { text: describeGoal(await load($)) }
  if (cmd.kind === 'error') return { text: cmd.text }
  if (cmd.kind === 'off') {
    await change($, s => ({ ...s, anchor: null, isAnchorOff: true, drift: { ...EMPTY_DRIFT } }))
    $.ui.status(undefined)
    return { text: 'Goal tracking off for this session.' }
  }
  if (cmd.kind === 'answered') {
    const s = await load($)
    const done = markAnswered(s, cmd.target)
    await save($, s, done.state)
    await refreshStatus($)
    return { text: done.count > 0 ? `Marked ${plural(done.count, 'question')} answered.` : 'No matching open question.' }
  }
  const now = await change($, s => withAnchor(s, cmd.text, 'command'))
  streakEdits = []
  $.ui.status(statusText(now))

  return {
    text: `Goal set: ${now.anchor?.text ?? cmd.text}`,
    context: [`The user set this session's goal: "${now.anchor?.text ?? cmd.text}". Keep work pointed at it.`],
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // `goal` may be a built-in's name: the engine refuses it, and /goal-anchor stands in.
    try {
      await $.command.register({
        name: NAMES[0],
        description: 'Show or set the session goal goal-anchor keeps Claude on',
        argumentHint: '[text | off | answered <n|all>]',
      })
    } catch {
      await $.command.register({
        name: NAMES[1],
        description: 'Show or set the session goal goal-anchor keeps Claude on',
        argumentHint: '[text | off | answered <n|all>]',
      })
    }
    await refreshStatus($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await save($, await load($), EMPTY_STATE)
      pending = []
      edited = []
      streakEdits = []
      $.ui.status(undefined)
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin.kind
    if (!isUserKind(kind) || e.text.trimStart().startsWith('/')) return next(e)

    let lines: string[] = []
    const now = await change($, s => {
      let t = s
      if (!t.anchor && !t.isAnchorOff && isSubstantive(e.text, kind)) {
        t = { ...t, anchor: makeAnchor(e.text, 'auto', t.turns) }
      }
      // The notes cover what was asked before this prompt; this prompt's own questions join after.
      lines = contextLines(t)
      let id = t.nextQuestionId
      const asked: OpenQuestion[] = detectQuestions(e.text, t.questions).map(q => ({
        id: id++,
        text: q.text,
        keywords: q.keywords,
        askedAtTurn: t.turns,
        status: 'open',
        isModelChecked: false,
      }))
      return { ...t, lastPromptText: e.text, questions: [...t.questions, ...asked].slice(-20), nextQuestionId: id }
    })
    $.ui.status(statusText(now))

    return next(lines.length > 0 ? { ...e, context: [...(e.context ?? []), ...lines] } : e)
  })

  on('turn.start', ($, e, next) => {
    pending = []
    edited = []

    return next(e)
  })

  on('tool.call', ($, e, next) => {
    const call = e as unknown as Record<string, unknown>
    pending.push(summarizeTool(call))
    const path = editedPath(call)
    if (path) edited.push(path)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId || isChecking) return next(e)
    if (e.reason !== 'answer') {
      pending = []
      edited = []
      return next(e)
    }

    const s = await change($, was => finishTurn(was, { toolLines: pending, editedPaths: edited, answer: e.answer }))
    streakEdits = s.drift.turnsAway === 0 ? [] : [...streakEdits, ...edited].slice(-30)
    pending = []
    edited = []
    // The model never runs inside this hook: it is scheduled, and `check` guards itself.
    if (needsCheck(s)) $.clock.after(0, () => void check($))
    $.ui.status(statusText(s))

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const goal = await read($, anchor)
    if (!goal || e.traits.includes('bare')) return result

    return { sections: [...result.sections, { id: 'goal-anchor:goal', text: composeText(goal), scope: 'session' }] }
  })

  on('command.run', { command: 'goal' }, ($, e) => runGoal($, e.args))
  on('command.run', { command: 'goal-anchor' }, ($, e) => runGoal($, e.args))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await load($)
    if (e.props.hasSurvey || e.props.view.agentId || !s.anchor) return next(e)
    const isDrift = isDriftShown(s)
    const stale = staleQuestions(s)
    if (!isDrift && stale.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const cols = e.props.bodyColumns
    const goalText = s.anchor.text
    const lastPrompt = s.lastPromptText

    return (
      <Box key="goal-band" flexDirection="column">
        <Text key="goal" bold wrap="truncate">
          {fit(`◆ goal: ${goalText}`, cols)}
        </Text>
        {isDrift ? (
          <Text key="drift" color="yellow" wrap="truncate">
            {fit(`  ${s.drift.turnsAway} turns on ${kindText(s.drift.kind)} since it was last touched`, cols)}
          </Text>
        ) : null}
        {stale.slice(0, 2).map(q => (
          <Text key={`q${q.id}`} dimColor wrap="truncate">
            {fit(`  ? "${q.text}" · unanswered for ${plural(s.turns - q.askedAtTurn, 'turn')}`, cols)}
          </Text>
        ))}
        {stale.length > 2 ? (
          <Text key="more" dimColor wrap="truncate">
            {`  +${stale.length - 2} more`}
          </Text>
        ) : null}
        <Box key="buttons" flexDirection="row">
          {isDrift ? (
            <Button
              key="back"
              label="Back to goal"
              hotkey="g"
              variant="primary"
              onPress={() =>
                $.prompt.fill({
                  text: `Pause the current detour. In two lines: what is blocking "${goalText}", and what you propose. Then get back to it.`,
                  mode: 'replace',
                })
              }
            />
          ) : null}
          {lastPrompt ? (
            <Button
              key="retarget"
              label="Make latest prompt the goal"
              hotkey="m"
              onPress={async () => {
                await change($, fresh => withAnchor(fresh, fresh.lastPromptText, 'command'))
                streakEdits = []
                await refreshStatus($)
              }}
            />
          ) : null}
          {isDrift ? (
            <Button
              key="snooze"
              label="Snooze"
              hotkey="s"
              onPress={() => change($, fresh => ({ ...fresh, drift: { ...fresh.drift, snoozedUntil: fresh.drift.turnsAway + DRIFT_TURNS } }))}
            />
          ) : null}
          {stale.length > 0 ? (
            <Button
              key="answered"
              label="Answered"
              hotkey="a"
              onPress={async () => {
                const ids = new Set(staleQuestions(await load($)).map(q => q.id))
                await change($, fresh => ({
                  ...fresh,
                  questions: fresh.questions.map(q => (ids.has(q.id) && q.status === 'open' ? { ...q, status: 'dismissed' as const } : q)),
                }))
                await refreshStatus($)
              }}
            />
          ) : null}
        </Box>
      </Box>
    )
  })
}
