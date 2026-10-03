import { expect, test } from 'claude-code/testing'

import { acceptPad, padToKey, parsePadLine, splitLines } from '../hooks/pad'
import type { PadEvent } from '../hooks/pad'
import { sudokuGame } from '../hooks/sudoku'
import { tetrisGame } from '../hooks/tetris'

test('lines come out whole across split pieces, CRLF and several to a piece', () => {
  let r = splitLines('', 'dow')
  expect(r).toEqual({ lines: [], rest: 'dow' })
  r = splitLines(r.rest, 'n left\nup le')
  expect(r).toEqual({ lines: ['down left'], rest: 'up le' })
  r = splitLines(r.rest, 'ft\n')
  expect(r).toEqual({ lines: ['up left'], rest: '' })
  expect(splitLines('', 'ready\r\nhello pad=0\r\nalive\r\n')).toEqual({ lines: ['ready', 'hello pad=0', 'alive'], rest: '' })
})

test('protocol lines parse, garbage does not', () => {
  expect(parsePadLine('ready')).toEqual({ kind: 'ready' })
  expect(parsePadLine('hello pad=1')).toEqual({ kind: 'hello', pad: 1 })
  expect(parsePadLine('bye')).toEqual({ kind: 'bye' })
  expect(parsePadLine('down a')).toEqual({ kind: 'down', button: 'a' })
  expect(parsePadLine('up lb')).toEqual({ kind: 'up', button: 'lb' })
  expect(parsePadLine('repeat left')).toEqual({ kind: 'repeat', button: 'left' })
  expect(parsePadLine('alive')).toEqual({ kind: 'alive' })
  for (const bad of ['', 'garbage', 'down', 'down banana', 'hello', 'hello pad=x', 'repeat']) expect(parsePadLine(bad)).toBeUndefined()
})

test('buttons map to game keys; Y, bumpers, triggers and sticks are reserved', () => {
  expect(['up', 'down', 'left', 'right', 'a', 'b', 'x', 'back', 'start'].map(b => padToKey(b as never))).toEqual([
    'up', 'down', 'left', 'right', 'a', 'b', 'select', 'select', 'start',
  ])
  for (const b of ['y', 'lb', 'rb', 'lt', 'rt', 'ls', 'rs']) expect(padToKey(b as never)).toBeUndefined()
})

test('a held direction is one press plus five repeats: six tetris moves', () => {
  const events: PadEvent[] = [{ kind: 'down', button: 'left' }, ...Array.from({ length: 5 }, () => ({ kind: 'repeat', button: 'left' }) as PadEvent)]
  let s = tetrisGame.init(4, {}, 0)
  const x0 = s.piece.x
  const seen = events.map(ev => acceptPad(ev, tetrisGame.repeatable)).filter(k => k !== undefined)
  expect(seen).toHaveLength(6)
  for (const k of seen) s = tetrisGame.onKey(s, k, 0)
  expect(s.piece.x).toBeLessThan(x0 - 1)
})

test('repeat up is dropped in tetris (no hard-drop stutter) and kept in sudoku', () => {
  const rep: PadEvent = { kind: 'repeat', button: 'up' }
  expect(acceptPad(rep, tetrisGame.repeatable)).toBeUndefined()
  expect(acceptPad(rep, sudokuGame.repeatable)).toBe('up')
  expect(acceptPad({ kind: 'down', button: 'up' }, tetrisGame.repeatable)).toBe('up')
  expect(acceptPad({ kind: 'up', button: 'up' }, sudokuGame.repeatable)).toBeUndefined()
  expect(acceptPad({ kind: 'alive' }, undefined)).toBeUndefined()
})
