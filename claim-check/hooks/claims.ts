// Pure logic for claim-check: no `$`, no state. Everything here is a heuristic
// built from regex tables; see the README for what it misses and what it flags
// wrongly.

import type { ClaimFlag, ClaimTurn } from '../types'

type Pattern = { readonly id: string; readonly re: RegExp }

/** One sentence that looks like a confident claim about external state. */
export type Candidate = { sentence: string; marker: string; noun: string }

/** What a tool call came to, as far as the evidence test cares. */
export type ToolSummary = { tool: string; input: string; isOk: boolean }

/** Words that make a sentence sound certain. Table order is the order of preference. */
export const CERTAINTY: readonly Pattern[] = [
  { id: 'never-ran', re: /\b(never|not once)\s+(ran|run|executed|fired|triggered|deployed|happened|been\s+(run|executed|deployed))\b/i },
  { id: 'not-run', re: /\b(has|have|had|did|was|were)\s*(n't|\s+not)\s+(been\s+)?(run|ran|execute[d]?|deployed|triggered|fired)\b/i },
  { id: 'was-never', re: /\b(was|were|has|have|is|are)\s+never\b/i },
  { id: 'never', re: /\bnever\b/i },
  { id: 'always', re: /\balways\b/i },
  { id: 'definitely', re: /\b(definitely|certainly|undoubtedly|unquestionably|without\s+(a\s+)?doubt|for\s+sure)\b|\b100%/i },
  { id: 'worse', re: /\b(is|are|keeps?)\s+getting\s+(worse|better)\b|\b(is|are)\s+(increasing|growing|trending\s+(up|down))\b/i },
  { id: 'no-record', re: /\bno\s+records?\s+of\b|\bthere\s+(are|were)\s+no\s+(rows|records|entries|errors|failures|runs|deployments)\b/i },
  { id: 'confirmed', re: /\b(confirmed|confirms|verified)\s+that\b|\b(is|was|has\s+been)\s+confirmed\b/i },
  { id: 'not-deployed', re: /\b(is|was|has)\s*(n't|\s+not)\s+(been\s+)?(deployed|released|promoted)\b/i },
  { id: 'root-cause', re: /\b(the\s+root\s+cause\s+is|this\s+is\s+(caused|because)\s+(by|of))\b/i },
]

/**
 * Things a claim can be about. `azure` comes before `prod` so that a resource
 * group named `rg-x-prod` reads as the more specific of the two.
 */
export const STATE: readonly Pattern[] = [
  { id: 'azure', re: /\b(resource\s+group|subscription|key\s*vault|storage\s+account|azure)\b/i },
  { id: 'prod', re: /\b(prod|production|prd|live\s+(site|environment|data)|stage|staging|uat|qa\s+env)\b/i },
  { id: 'data', re: /\b(database|db|table|tables|rows?|records?|sql|stored\s+proc(edure)?|schema|data\s*set|dataset)\b/i },
  { id: 'deploy', re: /\b(deployed|deployment|deploys?|release[sd]?|pipeline|build|slot|app\s+service|function\s+app|web\s*job|job|scheduler|cron|utility|script)\b/i },
  { id: 'ticket', re: /\b(ticket|work\s*item|story|bug|task|ado|azure\s+devops|backlog|sprint|pr|pull\s+request)\b|#\d{3,}\b|\b(story|bug|item)\s+\d{3,}\b/i },
  { id: 'telemetry', re: /\b(app(lication)?\s*insights|telemetry|logs?|log\s+analytics|kusto|kql|traces?|exceptions?|alerts?|metrics?)\b/i },
]

/** Any match drops the sentence: it is labelled, conditional, a question or about code. */
export const HEDGE: readonly Pattern[] = [
  { id: 'label', re: /\bunverified\b|\bunconfirmed\b|\bnot\s+(yet\s+)?verified\b|\bhypothes(is|es|ize)\b/i },
  { id: 'unchecked', re: /\bI\s+(have\s*n['o]?t|haven't|did\s*n't|did\s+not)\s+(yet\s+)?(checked|verified|queried|confirmed|looked)\b/i },
  { id: 'would-verify', re: /\b(I'?d|I\s+would|we\s+should|I\s+should|need\s+to|needs\s+to|want\s+to|let\s+me|I'?ll|I\s+will|going\s+to)\s+(verify|check|confirm|query|look)\b|\bbefore\s+concluding\b|\bto\s+(verify|confirm)\b/i },
  { id: 'modal', re: /\b(might|may|could|possibly|probably|likely|perhaps|presumably|seems?|appears?|suggests?|I\s+think|I\s+suspect|I\s+believe|my\s+guess|assum(e|ing))\b/i },
  { id: 'conditional', re: /^\s*(if|whether|unless)\b|\bif\s+(it|this|the)\b/i },
  { id: 'question', re: /\?\s*$/ },
  { id: 'attribution', re: /\b(you\s+(said|mentioned|noted|told)|per\s+your|according\s+to\s+(you|the\s+ticket|the\s+(query|log|output)))\b/i },
  { id: 'code-claim', re: /\b(the\s+code|this\s+function|the\s+method|the\s+test|unit\s+tests?|in\s+the\s+repo|locally)\b/i },
]

/** Commands that read external state. */
const SHELL_QUERY =
  /\b(?:sqlcmd|invoke-sqlcmd|invoke-dbaquery|psql|mysql|sqlite3|bcp|az\s+(?:devops|boards|repos|pipelines|monitor|webapp|functionapp|sql|group|resource|deployment|graph|storage|keyvault|account)|func\s+azure|get-az\w+|search-azgraph|invoke-restmethod|invoke-webrequest|kusto|kql)\b|\b(?:azd|kubectl|curl)\s|\bselect\b[\s\S]{1,400}?\bfrom\b|\bupdate\b[\s\S]{1,200}?\bset\b/i
const MCP_SERVER = /(ado|devops|azure|insights|appinsights|kusto|monitor|log-?analytics|sql|mssql|postgres|cosmos|dataverse|db)/i
const MCP_TOOL = /(query|kql|sql|work_?item|wit_|get_?logs?|search_?logs?|logs?_query|pipeline|build|release|deployment|run_?history)/i
// Only logs and exported query results count; a plain .json/.xml read (package.json,
// a csproj) says nothing about prod.
const DATA_FILE = /\.log$|[\\/](logs?|exports?|output)[\\/]/i

const MIN_SENTENCE = 12
const MAX_SENTENCE = 300

/** Prose sentences of a response, with code, quotes and tables removed. */
export function splitSentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?(```|$)/g, '\n')
    .replace(/`[^`\n]*`/g, '')
    .replace(/^\s*>.*$/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map(piece => piece.replace(/^\s*([-*+]|\d+\.|#+)\s+/, '').replace(/\s+/g, ' ').trim())
    .filter(piece => piece.length >= MIN_SENTENCE)
}

const firstMatch = (table: readonly Pattern[], text: string) => table.find(one => one.re.test(text))

/** The confident, unhedged sentences about external state, one entry per distinct sentence. */
export function findClaims(text: string): Candidate[] {
  const sentences = splitSentences(text)
  const seen = new Set<string>()
  const found: Candidate[] = []
  sentences.forEach((sentence, i) => {
    if (seen.has(sentence)) return
    seen.add(sentence)
    if (HEDGE.some(one => one.re.test(sentence))) return
    const marker = firstMatch(CERTAINTY, sentence)
    if (!marker) return
    const noun = firstMatch(STATE, sentence) ?? (i > 0 ? firstMatch(STATE, sentences[i - 1] ?? '') : undefined)
    if (!noun) return
    found.push({ sentence: sentence.slice(0, MAX_SENTENCE), marker: marker.id, noun: noun.id })
  })
  return found
}

/** What a finished tool call comes to: its name, the part that says what it touched, and whether it worked. */
export function summarizeToolCall(
  call: { tool: string },
  ran: { deny?: unknown; isError?: unknown },
): ToolSummary {
  const args = call as unknown as Record<string, unknown>
  const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : undefined)
  const tool = String(call.tool)
  let input: string
  if (tool === 'Bash' || tool === 'PowerShell') {
    input = text('command') ?? ''
  } else if (tool === 'Read' || tool === 'Grep') {
    input = text('file_path') ?? text('path') ?? text('pattern') ?? ''
  } else {
    const { tool: _tool, tool_use_id: _id, agentId: _agent, ...rest } = args
    input = JSON.stringify(rest).slice(0, 400)
  }
  return { tool, input, isOk: ran.deny === undefined && ran.isError !== true }
}

/** Does this successful call look like it read the state a claim is about? */
export function isEvidence(call: ToolSummary): boolean {
  if (!call.isOk) return false
  if (call.tool === 'Bash' || call.tool === 'PowerShell') return SHELL_QUERY.test(call.input)
  if (call.tool === 'Read' || call.tool === 'Grep') return DATA_FILE.test(call.input)
  const mcp = /^mcp__(.+?)__(.+)$/.exec(call.tool)
  if (mcp) return MCP_SERVER.test(mcp[1] ?? '') || MCP_TOOL.test(mcp[2] ?? '')
  return false
}

/** One toast for a whole turn: the first flagged sentence and how many more. */
export function toastText(flagged: readonly { sentence: string }[]): string {
  const first = flagged[0]?.sentence ?? ''
  const cut = first.length > 80 ? `${first.slice(0, 80)}…` : first
  const more = flagged.length > 1 ? ` (+${flagged.length - 1} more)` : ''
  return `claim-check: unverified — "${cut}"${more}`
}

export function statusText(count: number): string | undefined {
  return count > 0 ? `claims: ${count} unverified` : undefined
}

const LIST_LIMIT = 20

/** The `/claim-check` answer. `total` is the session count, which can exceed the kept flags. */
export function formatReport(flags: readonly ClaimFlag[], last: ClaimTurn | null, total = flags.length): string {
  const lines: string[] = []
  if (total === 0) {
    lines.push('claim-check: nothing flagged this session (heuristic; a quiet turn is not a verified turn)')
  } else {
    lines.push(`claim-check: ${total} unverified this session (heuristic)`)
    const turns: string[] = []
    for (const flag of flags) if (!turns.includes(flag.turnId)) turns.push(flag.turnId)
    const shown = flags.slice(-LIST_LIMIT)
    const offset = flags.length - shown.length
    shown.forEach((flag, i) => {
      const label = turns.indexOf(flag.turnId) + 1
      lines.push(`${offset + i + 1}. [turn ${label}, ${flag.marker}/${flag.noun}] "${flag.sentence}"`)
    })
  }
  if (last) {
    const verdict =
      last.flagged > 0 ? 'flagged'
      : last.candidates > 0 ? 'cleared by evidence'
      : 'quiet'
    lines.push(`Last turn: ${last.candidates} candidates, ${last.evidence} evidence calls → ${verdict}.`)
  }
  lines.push('`/claim-check clear` resets the count.')
  return lines.join('\n')
}
