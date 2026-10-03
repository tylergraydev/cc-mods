/** The session's goal: what the first substantive prompt (or /goal) asked for. */
export type GoalAnchor = {
  text: string // the goal, first line/sentence of the prompt, <= 200 chars
  label: string // short form for the status line, <= 24 chars
  keywords: string[] // content tokens of text (<= 12)
  vocab: string[] // learned tokens: basenames of files edited on confirmed-goal turns (<= 30)
  source: 'auto' | 'command'
  setAtTurn: number
}

export type TurnLabel = 'goal' | 'prerequisite' | 'other'

/** One finished main-loop turn, kept short for the model check. */
export type TurnRecord = { turn: number; label: TurnLabel; digest: string; answer: string; prompt?: string } // digest <= 400, answer <= 600

export type OpenQuestion = {
  id: number
  text: string
  keywords: string[]
  askedAtTurn: number
  status: 'open' | 'answered' | 'dismissed'
  isModelChecked: boolean
}

export type Drift = {
  turnsAway: number
  kind: 'prerequisite' | 'other' | null
  confirmation: 'none' | 'pending' | 'confirmed' | 'heuristic' // 'heuristic' = model unavailable/failed
  isToasted: boolean
  snoozedUntil: number // band hidden while turnsAway < this
}

declare module 'claude-code' {
  interface PluginState {
    'goal-anchor': {
      anchor: GoalAnchor | null
      isAnchorOff: boolean
      turns: number // main-loop turns completed
      drift: Drift
      recent: TurnRecord[] // last 10
      questions: OpenQuestion[]
      nextQuestionId: number
      lastPromptText: string // for the "Make latest prompt the goal" button
    }
  }
}
