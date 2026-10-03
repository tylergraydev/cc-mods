import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { ArcadeSaves, UnoState } from '../types'
import { PAYTABLE } from '../hooks/poker'
import { legal } from '../hooks/uno'

const PROPS = { title: 'Arcade', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const
const BOARD = 'arcade-board'
const props = (columns: number) => ({ ...PROPS, bodyColumns: columns })

type Dollar = Parameters<TestBody>[0]

type Bank = { chips: number; peak: number }
type World = { store: Record<string, unknown>; saves: ArcadeSaves }

/** The engine beneath the mod (the same stand-ins as arcade.test.tsx): a store the test can read and seed, and a window on the saves atom. */
function world(on: On, o: { store?: Record<string, unknown> } = {}): World {
  const w: World = { store: { ...o.store }, saves: {} }
  mock.clock(on, { now: 1_700_000_000_000 })
  mock.env(on, { OS: 'Windows_NT' })
  on('store.get', async (_, e) => ({ value: w.store[e.key] }))
  on('store.set', async (_, e) => {
    w.store[e.key] = e.value
    return { value: undefined }
  })
  on('state.set', async (_, e, next) => {
    const write = e as unknown as { plugin: string; key: string; value: unknown }
    if (write.plugin === 'arcade' && write.key === 'saves') w.saves = write.value as ArcadeSaves
    return next(e)
  })
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('ui.close', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('command.register', async () => ({ value: undefined }) as never)
  on('command.list', async () => ({ value: [] }) as never)
  on('fs.exists', async () => ({ value: false }))
  on('process.spawn', async function* () {
    return { code: 0, signal: null } as never
  })
  return w
}

const run = ($: Dollar, args: string) => $.command.run({ command: 'arcade', args } as Parameters<typeof $.command.run>[0])
const mountPane = ($: Dollar, columns = 60) => $.ui.mount({ plugin: 'arcade', surface: 'terminal', component: 'Pane', requestId: 'arcade', props: props(columns) })

const bankOf = (w: World): Bank | undefined => w.store.bankroll as Bank | undefined

test('the picker offers the three card games and each one opens and returns to the picker', async ($, on) => {
  const w = world(on)
  await run($, '')
  const ui = await mountPane($)
  for (const [id, title] of [['poker', 'VIDEO POKER'], ['blackjack', 'BLACKJACK'], ['uno', 'UNO']] as const) {
    expect(await ui.find({ key: `pick-${id}` })).toBeDefined()
    await ui.press({ key: `pick-${id}` })
    expect(await ui.find({ type: 'Text', text: title })).toBeDefined()
    await ui.press({ key: 'ctl-q' })
  }
  expect(await ui.find({ key: 'pick-poker' })).toBeDefined()
  await ui.unmount()
})

test('video poker by keys: deal, hold, draw, and the bankroll follows the payout', async ($, on) => {
  const w = world(on)
  await run($, 'poker')
  const ui = await mountPane($)
  expect(await ui.find({ in: BOARD, text: /Credits 500/ })).toBeDefined()
  await ui.key({ key: 'd', in: BOARD })
  await ui.key({ key: '1', in: BOARD })
  const held = w.saves.poker
  expect(held?.phase).toBe('hold')
  expect(held?.held[0]).toBe(true)
  expect(held?.chips).toBe(499)
  await ui.key({ key: 'd', in: BOARD })
  const done = w.saves.poker
  expect(done?.phase).toBe('done')
  const won = done?.result && done.result !== 'nothing' ? (PAYTABLE[done.result][0] as number) : 0
  expect(done?.won).toBe(won)
  expect(done?.chips).toBe(499 + won)
  expect(bankOf(w)?.chips).toBe(499 + won)
  expect(await ui.find({ in: BOARD, text: new RegExp(`Credits ${499 + won}`) })).toBeDefined()
  await ui.unmount()
})

test('blackjack rounds keep the bankroll in the store and on the board', async ($, on) => {
  const w = world(on)
  await run($, 'blackjack')
  const ui = await mountPane($)
  let rounds = 0
  for (; rounds < 40; rounds++) {
    await ui.key({ key: 'd', in: BOARD })
    await ui.key({ key: 's', in: BOARD })
    const s = w.saves.blackjack
    expect(s?.phase).toBe('done')
    expect(bankOf(w)?.chips).toBe(s?.chips)
    if ((s?.chips ?? 0) > 500) break
  }
  const last = w.saves.blackjack
  expect(last?.phase).toBe('done')
  expect(await ui.find({ in: BOARD, text: new RegExp(`Chips ${last?.chips}`) })).toBeDefined()
  expect(bankOf(w)?.peak).toBeGreaterThanOrEqual(last?.chips ?? 0)
  await ui.unmount()
})

test('a stored bankroll is loaded when a card game starts', async ($, on) => {
  const w = world(on, { store: { bankroll: { chips: 1234, peak: 1234 } } })
  await run($, 'poker')
  const ui = await mountPane($)
  expect(await ui.find({ in: BOARD, text: /Credits 1,234/ })).toBeDefined()
  await ui.unmount()
})

test('a bad stored bankroll is ignored', async ($, on) => {
  const w = world(on, { store: { bankroll: { chips: -5, peak: 'x' } } })
  await run($, 'blackjack')
  const ui = await mountPane($)
  expect(await ui.find({ in: BOARD, text: /Chips 500/ })).toBeDefined()
  await ui.unmount()
})

test('UNO by keys and clicks plays a whole game and records it once', { timeoutMs: 60_000 }, async ($, on) => {
  const w = world(on)
  await run($, 'uno 3')
  const ui = await mountPane($)
  let state: UnoState | undefined
  for (let i = 0; i < 400; i++) {
    state = w.saves.uno
    if (!state || state.phase === 'done') break
    if (state.phase === 'color') {
      await ui.key({ key: 'r', in: BOARD })
      continue
    }
    if (state.drawn !== null) {
      if (legal(state, state.drawn)) await ui.pointer({ type: 'down', x: 1 + 6 * (state.drawn % 6), y: 6 + Math.floor(state.drawn / 6), button: 'left', in: BOARD })
      else await ui.key({ key: 'd', in: BOARD })
      continue
    }
    const hand = state.hands[0] ?? []
    const at = hand.findIndex((_, k) => legal(state as UnoState, k))
    if (at >= 0) await ui.pointer({ type: 'down', x: 1 + 6 * (at % 6), y: 6 + Math.floor(at / 6), button: 'left', in: BOARD })
    else await ui.key({ key: 'd', in: BOARD })
  }
  expect(state?.phase).toBe('done')
  const scores = w.store.scores as { uno?: { played: number; counters: Record<string, number> } } | undefined
  expect(scores?.uno?.played).toBe(1)
  expect(Object.keys(scores?.uno?.counters ?? {})).toHaveLength(1)
  await ui.unmount()
})

test('a malformed board post is ignored: poker and the bankroll stay as they were', async ($, on) => {
  const w = world(on)
  await run($, 'poker')
  const ui = await mountPane($)
  await ui.key({ key: 'd', in: BOARD })
  const before = [JSON.stringify(w.saves.poker), JSON.stringify(bankOf(w))]
  await ui.post({ iid: 7, keys: 'd' }, { in: BOARD })
  await ui.post({ nothing: true }, { in: BOARD })
  expect([JSON.stringify(w.saves.poker), JSON.stringify(bankOf(w))]).toEqual(before)
  await ui.unmount()
})

test('a pane under the minimum width asks to be widened and draws at 40 columns', async ($, on) => {
  const w = world(on)
  await run($, 'poker')
  const narrow = await mountPane($, 30)
  expect(await narrow.find({ type: 'Text', text: 'Widen the pane: Video poker needs 32 columns.' })).toBeDefined()
  await narrow.unmount()
  const ok = await mountPane($, 40)
  expect(await ok.find({ in: BOARD, text: /Credits/ })).toBeDefined()
  await ok.unmount()
})

test('the UNO table size comes from the option', { options: { unoOpponents: '2' } }, async ($, on) => {
  const w = world(on)
  await run($, 'uno')
  const ui = await mountPane($, 40)
  expect(await ui.find({ in: BOARD, text: /W 7 · E 7/ })).toBeDefined()
  expect(await ui.find({ in: BOARD, text: /N 7/ })).toBeUndefined()
  await ui.unmount()
})

test('UNO defaults to three computer players and the command takes 2 or 3', async ($, on) => {
  const w = world(on)
  const bad = await run($, 'uno 5')
  expect(String(bad.text)).toContain('UNO opponents: 2 or 3.')
  await run($, 'uno')
  const ui = await mountPane($, 40)
  expect(await ui.find({ in: BOARD, text: /W 7 · N 7 · E 7/ })).toBeDefined()
  await ui.unmount()
  const unknown = await run($, 'bogus')
  expect(String(unknown.text)).toContain('poker, blackjack, uno')
})
