import type { GoalAnchor, OpenQuestion, TurnLabel, TurnRecord } from '../types'

export const DRIFT_TURNS = 5
export const ENV_TURNS = 3
export const QUESTION_STALE = 2
export const RECENT_KEEP = 10
export const MODEL = 'haiku'

/** Everything goal-anchor keeps in `$.state`, as one value for the pure functions. */
export type State = import('claude-code').PluginState['goal-anchor']

export type Classified = { label: TurnLabel; isOnGoal: boolean }
export type TurnInput = { toolLines: string[]; editedPaths: string[]; answer: string }
export type GoalCommand =
  | { kind: 'show' }
  | { kind: 'off' }
  | { kind: 'answered'; target: number | 'all' }
  | { kind: 'set'; text: string }
  | { kind: 'error'; text: string }

export const EMPTY_DRIFT = { turnsAway: 0, kind: null, confirmation: 'none', isToasted: false, snoozedUntil: 0 } as const

export const EMPTY_STATE: State = {
  anchor: null,
  isAnchorOff: false,
  turns: 0,
  drift: { ...EMPTY_DRIFT },
  recent: [],
  questions: [],
  nextQuestionId: 1,
  lastPromptText: '',
}

const STOP = new Set(
  (
    'the and for are but not you all any can had her was one our out has him his how its may who did get let say she too use ' +
    'that with have this will your from they know want been good much some time very when come here just like long make many over such take than them well were ' +
    'what which would there their about could other into more then these those where while should because before after again does done doing being ' +
    'also still only even ever each both either neither via per ' +
    'fix bug issue error problem work please need help using run check update change add new thing now file code ' +
    'files things wants needs makes made'
  ).split(/\s+/),
)

const FILLER = /^(please|can you|could you|would you|i need (you )?to|i want (you )?to|help me|let's|lets|we need to)\s+/i
const DROP = new Set(['the', 'a', 'an', 'my', 'our', 'this'])
const GREETING = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|y|n|sure|continue|go on|go ahead|proceed|lgtm|retry|try again)\b[\s.!]*$/i
const ENV =
  /\b(npm|pnpm|yarn|pip|uv)\s+(i|install|ci|add)\b|\bport\b|:\d{4}\b|\b(kill|taskkill|stop-process|lsof|netstat|kill-port)\b|EADDRINUSE|node_modules|lock(file)?\b|package-lock|\.env\b|docker|restart|venv|sdk|version/i
const QUESTION_STARTS = new Set(
  ('what why how when where which who whose can could would should is are was were do does did will have has shall may any ' +
    "isn't aren't doesn't don't won't").split(' '),
)
const LEAD = /^(so|ok|okay|and|but|also|then|,)[,\s]+/i
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

export const LABEL_SYSTEM =
  "You label what a coding assistant's recent turns were spent on, relative to the user's goal. Reply with exactly one word: GOAL, PREREQUISITE, or OTHER."
export const QUESTION_SYSTEM = "Reply YES if the assistant's replies directly answer the user's question, otherwise NO."

const stem = (word: string): string => {
  const tries: [RegExp, string][] = [
    [/ies$/, 'y'],
    [/ing$/, ''],
    [/ed$/, ''],
    [/(ch|sh|x|ss)es$/, '$1'],
    [/([^su])s$/, '$1'],
  ]
  for (const [re, to] of tries) {
    if (re.test(word)) {
      const out = word.replace(re, to)
      if (out.length >= 3) return out
    }
  }
  return word
}

/** Content tokens: split camelCase, snake_case, paths and punctuation; drop stopwords; stem. */
export function tokens(text: string): string[] {
  const out: string[] = []
  for (const raw of text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue
    const token = stem(raw)
    if (token.length >= 3 && !STOP.has(token) && !out.includes(token)) out.push(token)
  }
  return out
}

const sentences = (text: string): string[] =>
  text
    .replace(/([.!?]+)(\s|$)/g, '$1\u0000')
    .split(/[\n\u0000]/)
    .map(one => one.trim())
    .filter(Boolean)

/** The goal text: the prompt's first line or sentence, at most 200 chars. */
export function goalText(text: string): string {
  return (sentences(text)[0] ?? text.trim()).slice(0, 200)
}

/** The short form for the status line: filler and articles dropped, at most 24 chars. */
export function labelOf(text: string): string {
  let first = goalText(text)
  while (FILLER.test(first)) first = first.replace(FILLER, '')
  const words = first.split(/\s+/).filter(word => word && !DROP.has(word.toLowerCase()))
  let label = ''
  for (const word of words) {
    const next = label ? `${label} ${word.toLowerCase()}` : word.toLowerCase()
    if (next.length > 24) return `${(label || word.toLowerCase()).slice(0, 23)}…`
    label = next
  }
  return label
}

export function isUserKind(kind: string): boolean {
  return kind === 'composer' || kind === 'bridge' || kind === 'sdk'
}

/** Whether a prompt is worth anchoring on: a real ask, typed by a person or host. */
export function isSubstantive(text: string, originKind: string): boolean {
  const t = text.trim()
  if (!isUserKind(originKind) || t.startsWith('/') || GREETING.test(t)) return false
  return t.split(/\s+/).length >= 4 && t.length >= 20 && tokens(t).length >= 2
}

export function makeAnchor(text: string, source: GoalAnchor['source'], turn: number): GoalAnchor {
  const goal = goalText(text)
  return { text: goal, label: labelOf(goal), keywords: tokens(goal).slice(0, 12), vocab: [], source, setAtTurn: turn }
}

/** One line for the model's digest of what a tool call did (at most 120 chars). */
export function summarizeTool(e: Record<string, unknown>): string {
  const str = (key: string) => (typeof e[key] === 'string' ? (e[key] as string) : '')
  const tool = String(e.tool)
  let line: string
  if (tool === 'Bash' || tool === 'PowerShell') line = str('command')
  else if (EDIT_TOOLS.includes(tool) || tool === 'Read') line = `${tool} ${str('file_path') || str('notebook_path')}`
  else if (tool === 'Grep') line = `Grep ${str('pattern')} ${str('path')}`
  else if (tool === 'Glob') line = `Glob ${str('pattern')}`
  else if (tool === 'WebFetch') line = str('url')
  else if (tool === 'Agent' || tool === 'Task') line = str('description')
  else line = tool
  return (line.trim() || tool).replace(/\s+/g, ' ').slice(0, 120)
}

/** The path an edit tool wrote, or undefined for any other call. */
export function editedPath(e: Record<string, unknown>): string | undefined {
  if (!EDIT_TOOLS.includes(String(e.tool))) return undefined
  const path = e.file_path ?? e.notebook_path
  return typeof path === 'string' && path ? path : undefined
}

/** Tokens of file names without extension: what a goal-turn edit teaches the anchor. */
export function learnVocab(vocab: string[], paths: string[]): string[] {
  const out = [...vocab]
  for (const path of paths) {
    const base = (path.split(/[\\/]/).pop() ?? '').replace(/\.[^.]*$/, '')
    for (const token of tokens(base)) if (!out.includes(token)) out.push(token)
  }
  return out.slice(-30)
}

const hits = (words: string[], from: Set<string>) => words.filter(word => from.has(word)).length

/** Biased against false alarms: any sign of the goal counts the turn as on it. */
export function classifyTurn(anchor: GoalAnchor, toolLines: string[], editedPaths: string[], answer: string): Classified {
  const keywords = new Set(anchor.keywords)
  const known = new Set([...anchor.keywords, ...anchor.vocab])
  const need = Math.min(anchor.keywords.length <= 2 ? 1 : 2, anchor.keywords.length)
  if (editedPaths.some(path => hits(tokens(path), known) > 0)) return { label: 'goal', isOnGoal: true }
  if (toolLines.length > 0 && need > 0 && hits(tokens(toolLines.join(' ')), keywords) >= need) return { label: 'goal', isOnGoal: true }
  if (toolLines.length === 0 && need > 0 && hits(tokens(answer), keywords) >= need) return { label: 'goal', isOnGoal: true }
  const envLines = toolLines.filter(line => ENV.test(line)).length
  return { label: toolLines.length > 0 && envLines * 2 >= toolLines.length ? 'prerequisite' : 'other', isOnGoal: false }
}

const overlap = (a: string[], b: string[]) => (a.length === 0 || b.length === 0 ? 0 : hits(a, new Set(b)) / Math.min(a.length, b.length))

/** Direct questions in a prompt (at most 3), skipping ones already open. Known miss: "the port is 3001?". */
export function detectQuestions(text: string, open: OpenQuestion[] = []): { text: string; keywords: string[] }[] {
  const body = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .split('\n')
    .filter(line => !line.trimStart().startsWith('>'))
    .join('\n')
  const found: { text: string; keywords: string[] }[] = []
  for (const raw of sentences(body)) {
    if (!raw.endsWith('?')) continue
    let sentence = raw
    while (LEAD.test(sentence)) sentence = sentence.replace(LEAD, '')
    const words = sentence.replace(/[?,]+$/, '').split(/\s+/)
    if (words.length < 3 || !QUESTION_STARTS.has((words[0] ?? '').toLowerCase())) continue
    const clipped = sentence.slice(0, 160)
    const keywords = tokens(clipped).slice(0, 12)
    const known = [...open.filter(q => q.status === 'open'), ...found]
    if (known.some(q => (keywords.length > 0 ? overlap(keywords, q.keywords) >= 0.6 : q.text.toLowerCase() === clipped.toLowerCase()))) continue
    found.push({ text: clipped, keywords })
    if (found.length === 3) break
  }
  return found
}

/** A reply answers a question when it is long enough and covers its keywords; age 1 is the next turn. */
export function isAnswered(q: OpenQuestion, answer: string, age: number): boolean {
  if (answer.length < 40) return false
  if (q.keywords.length === 0) return age <= 1 && answer.length >= 80
  return hits(q.keywords, new Set(tokens(answer))) / Math.min(q.keywords.length, 4) >= 0.5
}

export const ageOf = (q: OpenQuestion, turns: number) => turns - q.askedAtTurn

export const openQuestions = (s: State) => s.questions.filter(q => q.status === 'open')
export const staleQuestions = (s: State) => openQuestions(s).filter(q => ageOf(q, s.turns) > QUESTION_STALE && q.isModelChecked)
export const needsQuestionCheck = (s: State) => openQuestions(s).filter(q => ageOf(q, s.turns) > QUESTION_STALE && !q.isModelChecked)

/** The drift alarm: far enough away, confirmed, and not snoozed. */
export function isDriftShown(s: State): boolean {
  const d = s.drift
  return d.turnsAway >= DRIFT_TURNS && (d.confirmation === 'confirmed' || d.confirmation === 'heuristic') && d.turnsAway >= d.snoozedUntil
}

export const needsCheck = (s: State) => s.drift.confirmation === 'pending' || needsQuestionCheck(s).length > 0

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const flat = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max)
export const kindText = (kind: 'prerequisite' | 'other' | null) => (kind === 'prerequisite' ? 'environment work' : 'other work')

/** One finished main-loop turn: classify it, move the drift counter, settle questions. */
export function finishTurn(s: State, t: TurnInput): State {
  const turns = s.turns + 1
  let { anchor, drift } = s
  let label: TurnLabel = 'other'
  if (anchor) {
    const c = classifyTurn(anchor, t.toolLines, t.editedPaths, t.answer)
    label = c.label
    if (c.isOnGoal) {
      anchor = { ...anchor, vocab: learnVocab(anchor.vocab, t.editedPaths) }
      drift = { ...drift, turnsAway: 0, kind: null, confirmation: 'none', isToasted: false, snoozedUntil: 0 }
    } else {
      const turnsAway = drift.turnsAway + 1
      const streak = [...s.recent.map(r => r.label), label].slice(-turnsAway)
      const prereq = streak.filter(one => one === 'prerequisite').length
      const kind = prereq > streak.length - prereq ? 'prerequisite' : 'other'
      const confirmation = turnsAway === DRIFT_TURNS && drift.confirmation === 'none' ? 'pending' : drift.confirmation
      drift = { ...drift, turnsAway, kind, confirmation }
    }
  }
  const record: TurnRecord = { turn: turns, label, digest: t.toolLines.join('; ').slice(0, 400), answer: flat(t.answer, 600) }
  const questions = s.questions
    .map(q => (q.status === 'open' && isAnswered(q, t.answer, turns - q.askedAtTurn) ? { ...q, status: 'answered' as const } : q))
    .slice(-20)
  return { ...s, turns, anchor, drift, questions, recent: [...s.recent, record].slice(-RECENT_KEEP) }
}

export const statusText = (s: State): string | undefined => {
  if (!s.anchor || s.isAnchorOff) return undefined
  const n = s.drift.turnsAway
  const open = openQuestions(s).length
  return `goal: ${s.anchor.label} · ${n === 0 ? 'on track' : `${plural(n, 'turn')} away`}${open > 0 ? ` · ${plural(open, 'open Q', 'open Qs')}` : ''}`
}

/** Static while the goal stands: it changes only when the goal does, so the cache holds. */
export const composeText = (anchor: GoalAnchor): string =>
  [
    '# Session goal (goal-anchor)',
    `The user opened this session to: "${anchor.text.replace(/\s+/g, ' ')}"`,
    `- Keep work pointed at this goal. Environment or setup work (servers, ports, installs, SDK versions, file locks) is a prerequisite, not the goal: if it has taken more than ${ENV_TURNS} turns, stop and report what is blocking the goal and what you propose instead of continuing.`,
    "- Answer the user's direct questions before continuing other work.",
  ].join('\n')

/** Per-prompt notes for the model: the drift nudge and the questions still open. */
export function contextLines(s: State): string[] {
  const lines: string[] = []
  if (s.anchor && !s.isAnchorOff && isDriftShown(s)) {
    const what = s.drift.kind === 'prerequisite' ? 'environment/prerequisite work' : 'other work'
    lines.push(
      `[goal-anchor] The last ${s.drift.turnsAway} turns went to ${what}, not the session goal ("${s.anchor.text}"). Before continuing, state in one or two lines what is blocking the goal and whether to keep going.`,
    )
  }
  const asked = openQuestions(s).filter(q => ageOf(q, s.turns) >= 1).slice(0, 3)
  if (asked.length > 0) {
    lines.push(
      `[goal-anchor] Unanswered questions from the user. Answer these first, briefly:\n${asked
        .map((q, i) => `${i + 1}. "${q.text}" (asked ${plural(ageOf(q, s.turns), 'turn')} ago)`)
        .join('\n')}`,
    )
  }
  return lines
}

export const labelPrompt = (anchor: GoalAnchor, recent: TurnRecord[]): string =>
  `Goal: "${anchor.text}"\n\nRecent turns, oldest first:\n${recent
    .slice(-DRIFT_TURNS)
    .map((r, i) => `${i + 1}. tools: ${r.digest || 'none'} | reply: ${r.answer.slice(0, 300)}`)
    .join('\n')}\n\nGOAL = working on the goal itself. PREREQUISITE = environment or setup work in service of the goal (servers, ports, installs, SDK versions, config, file locks). OTHER = unrelated. Which describes these turns overall?`

export const questionPrompt = (q: OpenQuestion, recent: TurnRecord[]): string =>
  `Question: "${q.text}"\nReplies:\n${recent
    .filter(r => r.turn > q.askedAtTurn)
    .slice(-3)
    .map(r => r.answer.slice(0, 600))
    .join('\n---\n')}`

export function parseLabel(text: string): TurnLabel | undefined {
  const found = /\b(GOAL|PREREQUISITE|OTHER)\b/i.exec(text)?.[1]
  return found ? (found.toLowerCase() as TurnLabel) : undefined
}

export const parseYes = (text: string): boolean => /^\W*yes\b/i.test(text)

export function parseGoalArgs(args: string): GoalCommand {
  const t = args.trim()
  if (t === '') return { kind: 'show' }
  if (t.toLowerCase() === 'off') return { kind: 'off' }
  if (/^answered\b/i.test(t)) {
    const m = /^answered\s+#?(\d+|all)$/i.exec(t)
    return m?.[1] ? { kind: 'answered', target: m[1].toLowerCase() === 'all' ? 'all' : Number(m[1]) } : { kind: 'error', text: 'Usage: /goal answered <n|all>' }
  }
  return { kind: 'set', text: t }
}

/** Marks open questions answered by id (or all); returns how many changed. */
export function markAnswered(s: State, target: number | 'all'): { state: State; count: number } {
  let count = 0
  const questions = s.questions.map(q => {
    if (q.status !== 'open' || (target !== 'all' && q.id !== target)) return q
    count += 1
    return { ...q, status: 'answered' as const }
  })
  return { state: { ...s, questions }, count }
}

/** A goal set or changed: drift starts over and tracking is back on. */
export const withAnchor = (s: State, text: string, source: GoalAnchor['source']): State => ({
  ...s,
  anchor: makeAnchor(text, source, s.turns),
  isAnchorOff: false,
  drift: { ...EMPTY_DRIFT },
})

/** The text `/goal` prints with no arguments. */
export function describeGoal(s: State): string {
  if (!s.anchor || s.isAnchorOff) return 'No goal yet: the first substantive prompt becomes it, or set one with /goal <text>.'
  const d = s.drift
  const lines = [`Goal (${s.anchor.source === 'auto' ? 'auto' : 'set by you'}, set turn ${s.anchor.setAtTurn + 1}): ${s.anchor.text}`]
  lines.push(
    d.turnsAway === 0
      ? 'On track.'
      : `${plural(d.turnsAway, 'turn')} away: ${kindText(d.kind)} (${d.confirmation === 'none' ? 'unconfirmed' : d.confirmation})`,
  )
  const open = openQuestions(s)
  if (open.length > 0) {
    lines.push('Open questions:')
    for (const q of open) lines.push(`  ${q.id}. "${q.text}" (asked ${plural(ageOf(q, s.turns), 'turn')} ago)`)
  }
  lines.push('/goal <text> to change · /goal off · /goal answered <n|all>')
  return lines.join('\n')
}

/** A line cut to fit the band's width. */
export const fit = (text: string, columns: number): string => {
  const max = Math.max(10, columns - 2)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
