import type { GameKey } from './game'

// The controller helper's text protocol, pure: split its output into lines,
// parse a line, map a button to a GameKey and decide which repeats a game
// takes. The helper (native/pad.c) does the auto-repeat; the mod never does.

export type PadButton = 'up' | 'down' | 'left' | 'right' | 'a' | 'b' | 'x' | 'y' | 'lb' | 'rb' | 'lt' | 'rt' | 'start' | 'back' | 'ls' | 'rs'
const BUTTONS: readonly string[] = ['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'start', 'back', 'ls', 'rs']

export type PadEvent =
  | { kind: 'ready' }
  | { kind: 'hello'; pad: number }
  | { kind: 'bye' }
  | { kind: 'alive' }
  | { kind: 'down' | 'up' | 'repeat'; button: PadButton }

/** Whole lines from pieces that end wherever the child's writes did; `rest` is the unfinished tail. */
export function splitLines(rest: string, text: string): { lines: string[]; rest: string } {
  const all = (rest + text).split('\n')
  const tail = all.pop() ?? ''
  return { lines: all.map(l => l.replace(/\r$/, '')).filter(l => l.length > 0), rest: tail }
}

/** One protocol line as an event; undefined for anything else. */
export function parsePadLine(line: string): PadEvent | undefined {
  const [word, arg] = line.trim().split(/\s+/)
  if (word === 'ready') return { kind: 'ready' }
  if (word === 'bye') return { kind: 'bye' }
  if (word === 'alive') return { kind: 'alive' }
  if (word === 'hello') {
    const m = /^pad=(\d)$/.exec(arg ?? '')
    return m ? { kind: 'hello', pad: Number(m[1]) } : undefined
  }
  if ((word === 'down' || word === 'up' || word === 'repeat') && arg && BUTTONS.includes(arg)) return { kind: word, button: arg as PadButton }
  return undefined
}

const KEYS: Partial<Record<PadButton, GameKey>> = {
  up: 'up', down: 'down', left: 'left', right: 'right', a: 'a', b: 'b', x: 'select', back: 'select', start: 'start',
}

/** The GameKey a button stands for; Y, bumpers, triggers and sticks are reserved. */
export const padToKey = (button: PadButton): GameKey | undefined => KEYS[button]

/** The key a down/repeat event gives a game, or undefined when the game does not take that repeat. */
export function acceptPad(ev: PadEvent, repeatable: readonly GameKey[] | undefined): GameKey | undefined {
  if (ev.kind !== 'down' && ev.kind !== 'repeat') return undefined
  const key = padToKey(ev.button)
  if (!key) return undefined
  if (ev.kind === 'repeat' && !(repeatable ?? []).includes(key)) return undefined
  return key
}
