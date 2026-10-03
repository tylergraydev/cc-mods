import { expect, test } from 'claude-code/testing'

import type { UnoCard, UnoColor, UnoFace, UnoState } from '../types'
import type { Key } from '../hooks/game'
import { aiPick, aiTurn, bestColor, canPlay, draw1, initUno, legal, playFrom, runAi, seatNames, unoDeck, unoGame, unoTap } from '../hooks/uno'

const card = (t: string): UnoCard => ({ color: t.slice(0, 1) as UnoColor | 'W', face: t.slice(1) as UnoFace })
const cs = (t: string): UnoCard[] => (t ? t.split(' ').map(card) : [])
const text = (rows: { text: string }[][]) => rows.map(r => r.map(s => s.text).join(''))
const total = (s: UnoState): number => s.hands.reduce((a, h) => a + h.length, 0) + s.draw.length + s.discard.length

/** A table with the cards laid out by hand: `hands` per seat (seat 0 is you), the top of the discard and a draw pile. */
function table(hands: string[], top = 'R5', draw = 'B1 B2 B3 B4 B5 B6 B7 B8', over: Partial<UnoState> = {}): UnoState {
  const t = card(top)
  return { ...initUno(11, hands.length - 1), hands: hands.map(cs), discard: [t], color: t.color as UnoColor, draw: cs(draw), turn: 0, dir: 1, phase: 'play', cursor: 0, drawn: null, passes: 0, winner: null, log: [], ...over }
}
const press = (s: UnoState, ...keys: Key[]): UnoState => keys.reduce((a, k) => unoGame.onKey(a, k, 0), s)

test('the deck has 108 cards in the right mix', () => {
  const d = unoDeck()
  expect(d).toHaveLength(108)
  const n = (f: (c: UnoCard) => boolean) => d.filter(f).length
  for (const col of ['R', 'G', 'B', 'Y']) {
    expect(n(c => c.color === col)).toBe(25)
    expect(n(c => c.color === col && c.face === '0')).toBe(1)
    expect(n(c => c.color === col && c.face === '7')).toBe(2)
    for (const f of ['skip', 'reverse', 'draw2']) expect(n(c => c.color === col && c.face === f)).toBe(2)
  }
  expect(n(c => c.face === 'wild')).toBe(4)
  expect(n(c => c.face === 'wild4')).toBe(4)
  expect(n(c => c.color === 'W')).toBe(8)
})

test('a new game deals seven each, flips a number, starts with you and is deterministic', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const s = initUno(seed, 3)
    expect(s.seats).toBe(4)
    expect(s.hands.map(h => h.length)).toEqual([7, 7, 7, 7])
    expect(s.discard).toHaveLength(1)
    expect(s.discard[0]?.face.length).toBe(1)
    expect(s.color).toBe(s.discard[0]?.color)
    expect(s.turn).toBe(0)
    expect(s.phase).toBe('play')
    expect(total(s)).toBe(108)
  }
  expect(initUno(9, 3)).toEqual(initUno(9, 3))
  expect(initUno(9, 3)).not.toEqual(initUno(10, 3))
  expect(initUno(1, 2).seats).toBe(3)
  expect(initUno(1, 1).seats).toBe(2)
  expect(unoGame.init(1, { opponents: '2' }, 0).opponents).toBe(2)
  expect(unoGame.init(1, {}, 0).opponents).toBe(3)
  expect(seatNames(3)).toEqual(['You', 'West', 'North', 'East'])
  expect(seatNames(2)).toEqual(['You', 'West', 'East'])
  expect(seatNames(1)).toEqual(['You', 'North'])
})

test('a card is legal on its colour or face, a wild always, and after a draw only the drawn card', () => {
  const s = table(['R9 G5 G9 Wwild', 'R1'])
  expect([0, 1, 2, 3].map(i => legal(s, i))).toEqual([true, true, false, true])
  expect(canPlay(s, card('Y5'))).toBe(true)
  expect(canPlay(s, card('Y6'))).toBe(false)
  const drew = { ...s, drawn: 2 }
  expect([0, 1, 2, 3].map(i => legal(drew, i))).toEqual([false, false, false, false])
  expect(legal({ ...drew, drawn: 3 }, 3)).toBe(true)
  expect(legal({ ...drew, drawn: 1 }, 0)).toBe(false)
})

test('skip, reverse and draw two move the turn and the draw penalty as the rules say', () => {
  const four = ['Rskip R1', 'G1 G2', 'G3 G4', 'G5 G6']
  const skip = playFrom(table(four), 0, 0)
  expect(skip.turn).toBe(2)
  expect(skip.hands[0]).toHaveLength(1)
  const rev = playFrom(table(['Rreverse R1', 'G1 G2', 'G3 G4', 'G5 G6']), 0, 0)
  expect(rev.dir).toBe(-1)
  expect(rev.turn).toBe(3)
  const two = playFrom(table(['Rreverse R1', 'G5']), 0, 0)
  expect(two.dir).toBe(-1)
  expect(two.turn).toBe(0)
  const d2 = playFrom(table(['Rdraw2 R1', 'G1 G2', 'G3 G4', 'G5 G6']), 0, 0)
  expect(d2.hands[1]).toHaveLength(4)
  expect(d2.turn).toBe(2)
  expect(d2.draw).toHaveLength(6)
})

test('there is no stacking: a draw two on a hand holding a draw two still draws and is skipped', () => {
  const s = playFrom(table(['Rdraw2 R1', 'Gdraw2 G2', 'G3 G4', 'G5 G6']), 0, 0)
  expect(s.hands[1]).toHaveLength(4)
  expect(s.turn).toBe(2)
  expect(s.discard.at(-1)).toEqual(card('Rdraw2'))
})

test('a wild waits for your colour, then the computer seats play on', () => {
  let s = table(['Wwild R1', 'G5 G6', 'G7 G8', 'G9 G1'])
  s = press(s, 'a')
  expect(s.phase).toBe('color')
  expect(s.pending).toBe('wild')
  expect(press(s, 'c:d')).toBe(s)
  const g = press(s, 'c:g')
  expect(g.phase).toBe('play')
  expect(g.turn).toBe(0)
  expect(g.color).toBe('G')
  expect(g.discard.slice(-4).map(c => `${c.color}${c.face}`)).toEqual(['Wwild', 'G6', 'G8', 'G9'])
  const arrows = press(s, 'right', 'right', 'a')
  expect(arrows.color).toBe('B')
  const left = press(s, 'right', 'left', 'a')
  expect(left.color).toBe('R')
})

test('a wild draw four makes the next seat draw four and lose its turn, with the colour set', () => {
  const s = press(table(['Wwild4 R1', 'G1 G2', 'B3', 'G5 G6']), 'a')
  expect(s.phase).toBe('color')
  const b = press(s, 'c:b')
  expect(b.hands[1]).toHaveLength(6)
  expect(b.color).toBe('B')
  expect(b.winner).toBe(2)
  expect(b.phase).toBe('done')
})

test('the computer prefers draw two, skip, reverse, the highest number, wild, then wild four', () => {
  const t = (hand: string) => table(['R1', hand, 'G1'], 'R5')
  const pick = (hand: string) => aiPick(t(hand), cs(hand))
  expect(pick('R3 R9 Rdraw2 Rskip')).toBe(2)
  expect(pick('R3 R9 Rskip Rreverse')).toBe(2)
  expect(pick('R3 R9 Rreverse')).toBe(2)
  expect(pick('R3 R9 Wwild')).toBe(1)
  expect(pick('Wwild4 Wwild R3')).toBe(2)
  expect(pick('Wwild4 Wwild')).toBe(1)
  expect(pick('Wwild4')).toBe(0)
  expect(pick('G3 B4')).toBe(-1)
  expect(bestColor(cs('G1 G2 B3'))).toBe('G')
  expect(bestColor([])).toBe('R')
  expect(bestColor(cs('B1 G1'))).toBe('G')
  expect(bestColor(cs('Y1 Y2 B1 B2 R1'))).toBe('B')
})

test('the computer draws when nothing fits, plays what it drew if legal, and a wild takes its majority colour', () => {
  const draws = aiTurn(table(['R1', 'G3 B4', 'G1'], 'R5', 'Y1 Y2', { turn: 1 }))
  expect(draws.hands[1]).toHaveLength(3)
  expect(draws.turn).toBe(2)
  expect(draws.discard).toHaveLength(1)
  const plays = aiTurn(table(['R1', 'G3 B4', 'G1'], 'R5', 'R8 Y2', { turn: 1 }))
  expect(plays.hands[1]).toHaveLength(2)
  expect(plays.discard.at(-1)).toEqual(card('R8'))
  const wild = aiTurn(table(['R1', 'Wwild B1 B2', 'G1'], 'G5', 'Y1', { turn: 1 }))
  expect(wild.color).toBe('B')
  expect(wild.turn).toBe(2)
})

test('an empty draw pile is refilled from the discard except the top and all 108 cards are kept', () => {
  const g = initUno(21, 3)
  const top = g.discard[0] as UnoCard
  const s: UnoState = { ...g, discard: [...g.draw, top], draw: [] }
  const r = draw1(s)
  expect(r.card).toBeDefined()
  expect(r.s.discard).toEqual([top])
  expect(total({ ...r.s, hands: [...r.s.hands, r.card ? [r.card] : []] })).toBe(108)
  const none = draw1({ ...s, discard: [top] })
  expect(none.card).toBeUndefined()
})

test('with nothing to draw anywhere the game ends by stalemate and the fewest cards win', () => {
  const s = table(['G1 G2 G3', 'G4 G5', 'B1 B2 B3 B4 B6', 'Y1 Y2'], 'R5', '', { passes: 3 })
  const done = press(s, 'c:d')
  expect(done.phase).toBe('done')
  expect(done.winner).toBe(1)
  expect(done.log.at(-1)).toContain('Stalemate')
  const settled = runAi(table(['G1 G2 G3', 'G4 G6', 'B1 B2 B3 B4 B6', 'Y1 Y2'], 'R5', '', { turn: 1, passes: 1 }))
  expect(settled.phase).toBe('done')
  expect(settled.winner).toBe(1)
})

test('your last card ends the game and records a win; the computer emptying its hand records a loss', () => {
  const won = press(table(['R7', 'G1 G2', 'G3', 'G4']), 'a')
  expect(won.phase).toBe('done')
  expect(won.winner).toBe(0)
  expect(unoGame.isOver(won)).toBe(true)
  expect(unoGame.score(won)).toEqual({ counters: { 'vs3.w': 1 } })
  expect(unoGame.score({ ...won, recorded: true })).toBeUndefined()
  const lastDraw = press(table(['Rdraw2', 'G1 G2', 'G3', 'G4']), 'a')
  expect(lastDraw.winner).toBe(0)
  expect(lastDraw.hands[1]).toHaveLength(2)
  const lost = runAi(table(['R1 R2', 'R9', 'G3', 'G4'], 'R5', 'B1', { turn: 1 }))
  expect(lost.phase).toBe('done')
  expect(lost.winner).toBe(1)
  expect(unoGame.score(lost)).toEqual({ counters: { 'vs3.l': 1 } })
  expect(unoGame.score(table(['R1'], 'R5'))).toBeUndefined()
  expect(press(won, 'a').phase).toBe('play')
  expect(press(won, 'a').opponents).toBe(3)
})

test('drawing a playable card lets you play it or pass; an unplayable draw passes at once', () => {
  const s = table(['G1 G2', 'B1'], 'R5', 'R9 B8')
  const drew = press(s, 'c:d')
  expect(drew.hands[0]).toHaveLength(3)
  expect(drew.drawn).toBe(2)
  expect(drew.cursor).toBe(2)
  expect(drew.turn).toBe(0)
  expect(legal(drew, 0)).toBe(false)
  expect(press(drew, 'a').discard.at(-1)).toEqual(card('R9'))
  expect(press({ ...drew, cursor: 0 }, 'a').hands[0]).toHaveLength(3)
  const passed = press(drew, 'select')
  expect(passed.drawn).toBeNull()
  expect(passed.hands[0]).toHaveLength(3)
  const miss = press(table(['G1 G2', 'R4'], 'R5', 'B9 B8'), 'c:d')
  expect(miss.hands[0]).toHaveLength(3)
  expect(miss.winner).toBe(1)
})

test('taps map to your hand cells, the deck and the colour row, and other keys do nothing', () => {
  const hand = 'R1 R2 R3 R4 R6 R7 R8 R9'
  const s = table([hand, 'G1', 'G2', 'G3'], 'R5', 'B1 B2 B3')
  expect(unoTap(1, 6, s)).toEqual({ kind: 'card', index: 0 })
  expect(unoTap(7, 6, s)).toEqual({ kind: 'card', index: 1 })
  expect(unoTap(31, 6, s)).toEqual({ kind: 'card', index: 5 })
  expect(unoTap(6, 6, s)).toBeUndefined()
  expect(unoTap(1, 7, s)).toEqual({ kind: 'card', index: 6 })
  expect(unoTap(7, 7, s)).toEqual({ kind: 'card', index: 7 })
  expect(unoTap(13, 7, s)).toBeUndefined()
  expect(unoTap(1, 5, s)).toBeUndefined()
  const row = text(unoGame.view(s, 38, 30).board)[1] as string
  const x = row.indexOf('[draw]')
  expect(unoTap(x, 1, s)).toEqual({ kind: 'draw' })
  expect(unoTap(x - 1, 1, s)).toBeUndefined()
  expect(unoTap(1, 8, s)).toBeUndefined()
  const picking = { ...s, phase: 'color' as const, pending: 'wild' as const }
  expect([1, 7, 13, 19].map(cx => unoTap(cx, 8, picking))).toEqual(['R', 'G', 'B', 'Y'].map(color => ({ kind: 'color', color })))
  expect(unoTap(1, 6, picking)).toBeUndefined()
  expect(press(s, 'tap:7:6').hands[0]).toHaveLength(7)
  for (const k of ['start', 'c:z', 'b', 'c:r', 'tap:0:0'] as Key[]) expect(press(s, k)).toBe(s)
})

test('the board fits 38 columns and shows the seats, the top card, the log and the hand', () => {
  const s = playFrom(table(['R7 R8 R9', 'G1 G2', 'G3 G4', 'G5 G6']), 0, 1)
  const v = unoGame.view(s, 38, 30)
  const rows = text(v.board)
  for (const line of rows) expect(line.length).toBeLessThanOrEqual(38)
  expect(rows[0]).toContain('W 2')
  expect(rows[5]).toContain('Your hand (2)')
  expect(rows[1]).toContain('[R8]')
  expect(rows.slice(2, 5).some(l => l.includes('You: [R8]'))).toBe(true)
  expect(text(unoGame.view(s, 60, 30).board)[0]).toContain('West')
  expect(v.controls?.map(c => c.hotkey)).toEqual(['h', 'l', 'p', 'd'])
  const picking = unoGame.view({ ...table(['Wwild R1', 'G1', 'G2', 'G3']), phase: 'color' as const, pending: 'wild' as const }, 38, 30)
  expect(picking.controls?.map(c => c.hotkey)).toEqual(['r', 'g', 'b', 'y'])
  expect(text(picking.board).at(-1)).toContain('[R]')
})
