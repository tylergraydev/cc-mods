import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, RenderInput, Timer } from 'claude-code'

import type { ArcadeBank, ArcadePad, ArcadeSaves, ArcadeScores, ArcadeSession, GameId } from '../types'
import { BENCH, fillSlot, inSlot, slotOf } from './bench'
import { blackjackGame } from './blackjack'
import { START_CHIPS } from './cards'
import { SHELL_CONTROLS, clock, entryKey, fmtNum, mergeScore, parseBoardMessage } from './game'
import type { Game, GameControl, Key, Seg, View } from './game'
import { acceptPad, parsePadLine, splitLines } from './pad'
import type { PadEvent } from './pad'
import { pokerGame } from './poker'
import { sudokuGame } from './sudoku'
import { tetrisGame } from './tetris'
import { tttGame } from './ttt'
import { unoGame } from './uno'

// The shell: it owns every atom, the one ticker, the key path, the controller
// bridge and the drawing. The game modules are pure (state in, state out, a
// plain View back); everything that touches `$` stays in this file.

const PANE = 'arcade'
const BOARD = 'arcade-board'
const TITLE = 'Arcade'
const COMMAND = 'arcade'
const FALLBACK_COMMAND = 'arcade-games'
const IDLE_MS = 30_000
const DOUBLE_MS = 40
const SCORES_KEY = 'scores'
const SUDOKU_KEY = 'sudoku'
const BANK_KEY = 'bankroll'
const DESCRIPTION = 'Play tic-tac-toe, sudoku, tetris, video poker, blackjack and UNO in a side pane (keyboard, mouse or an Xbox controller)'
const HINT = 'click the board for arrow keys'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGame = Game<any, any>
// The registry: a new game is added here and to ArcadeSaves, nothing else.
const GAMES: AnyGame[] = [tttGame, sudokuGame, tetrisGame, pokerGame, blackjackGame, unoGame]
const gameOf = (id: string | undefined): AnyGame | undefined => GAMES.find(g => g.id === id)

const session = atom({ plugin: 'arcade', key: 'session' } as const, {
  screen: 'picker',
  showHelp: false,
  paused: false,
  isOpen: false,
  lastInputAt: 0,
  pickCursor: 0,
} as ArcadeSession)
const saves = atom({ plugin: 'arcade', key: 'saves' } as const, {} as ArcadeSaves)
const scores = atom({ plugin: 'arcade', key: 'scores' } as const, {} as ArcadeScores)
const pad = atom({ plugin: 'arcade', key: 'pad' } as const, { status: 'off' } as ArcadePad)
// The play chips poker and blackjack share; $.store key bankroll keeps them across sessions.
const bank = atom({ plugin: 'arcade', key: 'bank' } as const, { chips: START_CHIPS, peak: START_CHIPS } as ArcadeBank)

type Source = 'client' | 'button' | 'pad'

// Module variables: they start over on a reload (the atoms above do not).
let settings: Record<string, unknown> = {}
let ticker: Timer | undefined
let tickerMs = 0
let idleTimer: Timer | undefined
let counter = 0
let lastKey: { key: Key; source: Source; at: number } | undefined
let size = { cols: 48, rows: 30 }
const applied = new Map<string, number>()
let padStream: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | undefined
let padFailed = false
let bankLoaded = false

const str = (name: string, fallback: string): string => {
  const v = settings[name]
  return typeof v === 'string' && v ? v : fallback
}

/** The options a new game of `id` starts with, from the settings. */
function defaultOpts(id: string): Record<string, string> {
  if (id === 'ttt') return { level: str('tttLevel', 'hard') }
  if (id === 'sudoku') return { difficulty: str('sudokuDifficulty', 'medium') }
  if (id === 'poker' || id === 'blackjack') return {}
  if (id === 'uno') return { opponents: str('unoOpponents', '3') }
  return { mode: str('tetrisSpeed', 'normal') }
}

/** The options a restart keeps from the game in progress. */
function restartOpts(id: string, state: unknown): Record<string, string> {
  const s = state as { level?: string; difficulty?: string; mode?: string; bet?: number; opponents?: number } | undefined
  if (id === 'ttt' && s?.level) return { level: s.level }
  if (id === 'sudoku' && s?.difficulty) return { difficulty: s.difficulty }
  if (id === 'tetris' && s?.mode) return { mode: s.mode }
  if ((id === 'poker' || id === 'blackjack') && s?.bet) return { bet: String(s.bet) }
  if (id === 'uno' && s?.opponents) return { opponents: String(s.opponents) }
  return defaultOpts(id)
}

// ---------- the bankroll ----------

/** Reads the stored bankroll into the atom once; a missing, negative or non-numeric one is ignored (a fresh 500 stays). */
async function loadBank($: EngineInterface) {
  if (bankLoaded) return
  bankLoaded = true
  const stored = (await $.store.get(BANK_KEY)) as Partial<ArcadeBank> | undefined
  if (stored && typeof stored === 'object' && Number.isFinite(stored.chips) && (stored.chips as number) >= 0) {
    const chips = Math.floor(stored.chips as number)
    const peak = Number.isFinite(stored.peak) ? Math.max(chips, stored.peak as number) : chips
    await update($, bank, () => ({ chips, peak }))
  }
}

/** Writes a game's chips into the bankroll (the atom and the store) when they changed. */
async function saveBank($: EngineInterface, chips: number) {
  const held = await read($, bank)
  if (chips === held.chips) return
  const merged = await update($, bank, b => ({ chips, peak: Math.max(b.peak, chips) }))
  await $.store.set(BANK_KEY, merged)
}

// ---------- the games' state ----------

/** Runs `fn` over the current game's state (inside the atom write) and then records a finished game. */
async function step($: EngineInterface, fn: (game: AnyGame, state: unknown, now: number) => unknown) {
  const s = await read($, session)
  const game = gameOf(s.current)
  if (!game) return
  const now = await $.clock.now()
  const all = await update($, saves, held => {
    const state = held[game.id as GameId]
    return state ? { ...held, [game.id]: fn(game, state, now) } : held
  })
  const state = all[game.id as GameId]
  if (state) await afterChange($, game, state as { recorded: boolean })
}

async function afterChange($: EngineInterface, game: AnyGame, state: { recorded: boolean }) {
  if (game.bank) await saveBank($, game.bank.get(state))
  if (game.isOver(state) && !state.recorded) {
    const delta = game.score(state)
    if (delta) {
      const merged = mergeScore(await read($, scores), game.id, delta)
      await update($, scores, () => merged)
      await $.store.set(SCORES_KEY, merged)
    }
    const all = await update($, saves, held => ({ ...held, [game.id]: { ...(held[game.id as GameId] as object), recorded: true } }))
    state = all[game.id as GameId] as { recorded: boolean }
  }
  if (game.id === 'sudoku') await $.store.set(SUDOKU_KEY, state)
}

async function startGame($: EngineInterface, id: string, opts: Record<string, string>) {
  const game = gameOf(id)
  if (!game) return
  const now = await $.clock.now()
  counter += 1
  const seed = (now ^ Math.imul(counter, 0x9e3779b1)) | 0
  const before = await read($, session)
  if (before.current && before.current !== id) await pauseGame($, undefined)
  const fresh = game.init(seed, opts, now)
  if (game.bank) await loadBank($)
  const state = game.bank ? game.bank.set(fresh, (await read($, bank)).chips) : fresh
  await update($, saves, held => ({ ...held, [id]: state }))
  await update<ArcadeSession>($, session, s => ({ ...s, screen: 'play', current: id as GameId, showHelp: false, paused: false, pauseNote: undefined, lastInputAt: now }))
  if (id === 'sudoku') await $.store.set(SUDOKU_KEY, state)
  await armTicker($)
}

/** Pauses the current game (a clock-keeping game folds its time); false when there was nothing to pause. */
async function pauseGame($: EngineInterface, note: string | undefined): Promise<boolean> {
  const s = await read($, session)
  const game = gameOf(s.current)
  if (!game?.pause || s.screen !== 'play' || s.paused) return false
  const state = (await read($, saves))[game.id as GameId] as { recorded: boolean } | undefined
  if (!state || game.isOver(state)) return false
  await step($, (g, st, now) => g.pause?.(st, now) ?? st)
  await update($, session, held => ({ ...held, paused: true, pauseNote: note }))
  await armTicker($)
  return true
}

async function resumeGame($: EngineInterface) {
  const now = await $.clock.now()
  await step($, (g, st, t) => g.resume?.(st, t) ?? st)
  await update($, session, s => ({ ...s, paused: false, pauseNote: undefined, lastInputAt: now }))
  await armTicker($)
}

async function toPicker($: EngineInterface, screen: 'picker' | 'scores' = 'picker') {
  await pauseGame($, undefined)
  await update($, session, s => ({ ...s, screen, showHelp: false }))
  await armTicker($)
}

// ---------- the one ticker ----------

/** (Re)arms the single timer for the current game: only while open, playing and not paused. */
async function armTicker($: EngineInterface) {
  const s = await read($, session)
  const game = gameOf(s.current)
  const state = game ? (await read($, saves))[game.id as GameId] : undefined
  const want = game && state && s.isOpen && s.screen === 'play' && !s.paused ? (game.tickMs?.(state) ?? 0) : 0
  if (want === tickerMs && (want === 0 || ticker)) return
  ticker?.cancel()
  ticker = undefined
  tickerMs = want
  if (want > 0) ticker = $.clock.every(want, () => void tick($))
}

async function tick($: EngineInterface) {
  const s = await read($, session)
  if (!s.isOpen || s.paused || s.screen !== 'play') return
  await step($, (g, st, now) => (g.onTick ? g.onTick(st, now) : st))
  await armTicker($)
}

async function idleCheck($: EngineInterface) {
  const s = await read($, session)
  if (!s.isOpen || s.paused || s.screen !== 'play') return
  if ((await $.clock.now()) - s.lastInputAt > IDLE_MS) await pauseGame($, 'no keys for 30s')
}

// ---------- keys ----------

async function pickGame($: EngineInterface, id: string) {
  const game = gameOf(id)
  if (!game) return
  const held = (await read($, saves))[id as GameId] as { recorded: boolean } | undefined
  if (held && !game.isOver(held)) {
    // An unfinished game carries on where it was, with the bankroll as it is now.
    const b = game.bank
    if (b) {
      await loadBank($)
      const chips = (await read($, bank)).chips
      await update($, saves, all => ({ ...all, [id]: b.set(all[id as GameId], chips) }))
    }
    await update<ArcadeSession>($, session, s => ({ ...s, screen: 'play', current: id as GameId, showHelp: false }))
    await resumeGame($)
  } else await startGame($, id, defaultOpts(id))
}

async function pickerKey($: EngineInterface, key: Key) {
  const s = await read($, session)
  if (key === 'up' || key === 'down') {
    const n = GAMES.length
    await update($, session, held => ({ ...held, pickCursor: (held.pickCursor + (key === 'down' ? 1 : n - 1)) % n }))
  } else if (key === 'a') await pickGame($, (GAMES[s.pickCursor] ?? GAMES[0])?.id ?? 'ttt')
  else if (key === 'c:s') await update<ArcadeSession>($, session, held => ({ ...held, screen: 'scores' }))
  else if (key.startsWith('c:')) {
    const i = Number(key.slice(2)) - 1
    if (i >= 0 && i < GAMES.length) await pickGame($, (GAMES[i] as AnyGame).id)
  }
}

/** Every input lands here: a Client key, a pressed Button, a controller line. */
async function applyKey($: EngineInterface, key: Key, source: Source) {
  const s = await read($, session)
  if (!s.isOpen) return
  const now = await $.clock.now()
  // A key typed on the focused board may also press its matching hotkey Button: one of the two counts.
  if (lastKey && lastKey.key === key && lastKey.source !== source && now - lastKey.at < DOUBLE_MS) return
  lastKey = { key, source, at: now }
  await update($, session, held => ({ ...held, lastInputAt: now }))

  if (s.showHelp) {
    await update($, session, held => ({ ...held, showHelp: false }))
    return
  }
  if (s.screen === 'picker') return pickerKey($, key)
  if (s.screen === 'scores') {
    if (key === 'a' || key === 'b' || key === 'start' || key === 'c:q' || key === 'c:s') await update<ArcadeSession>($, session, held => ({ ...held, screen: 'picker' }))
    return
  }

  const game = gameOf(s.current)
  if (!game) return
  if (key === 'c:q') return toPicker($)
  if (key === 'c:i' || key === 'c:?') {
    await update($, session, held => ({ ...held, showHelp: true }))
    return
  }
  const state = (await read($, saves))[game.id as GameId]
  if (key === 'c:n' || (s.paused && key === 'select')) {
    await startGame($, game.id, restartOpts(game.id, state))
    return
  }
  if (s.paused) {
    if (key === 'start' || key === 'a' || key === 'c:p') await resumeGame($)
    else if (key === 'b') await toPicker($)
    else if (game.softPause) {
      await resumeGame($)
      await step($, (g, st, t) => g.onKey(st, key, t))
    }
    return
  }
  if (key === 'start') {
    if (game.pause) await pauseGame($, 'paused')
    return
  }
  await step($, (g, st, t) => g.onKey(st, key, t))
  await armTicker($)
}

// ---------- the controller ----------

async function setPad($: EngineInterface, status: ArcadePad['status'], slot?: number) {
  await update($, pad, () => ({ status, ...(slot === undefined ? {} : { slot }) }))
}

async function onPadLine($: EngineInterface, line: string) {
  const ev: PadEvent | undefined = parsePadLine(line)
  if (!ev) return
  if (ev.kind === 'hello') {
    await setPad($, 'connected', ev.pad)
    $.ui.status('🎮')
    return
  }
  if (ev.kind === 'bye') {
    await setPad($, 'waiting')
    $.ui.status(undefined)
    if (await pauseGame($, 'controller disconnected')) $.ui.toast('Controller disconnected: game paused')
    return
  }
  const s = await read($, session)
  if (!s.isOpen || s.screen === 'scores' && ev.kind === 'repeat') return
  const game = gameOf(s.current)
  const key = acceptPad(ev, s.screen === 'play' ? game?.repeatable : undefined)
  if (key) await applyKey($, key, 'pad')
}

async function startPad($: EngineInterface) {
  if (padStream || padFailed || settings.controller === false) return
  if ((await $.env.get('OS')) !== 'Windows_NT') {
    await setPad($, 'off')
    return
  }
  const exe = `${$.plugin.root}/bin/pad.exe`
  if (!(await $.fs.exists(exe))) {
    await setPad($, 'missing')
    return
  }
  const stream = $.process.spawn({ argv: [exe] })
  padStream = stream
  const startedAt = await $.clock.now()
  await setPad($, 'waiting')
  // The loop is the child's life; it runs on after the command returns.
  void (async () => {
    let rest = ''
    try {
      for await (const chunk of stream) {
        if (chunk.stream === 'stderr') continue
        const r = splitLines(rest, chunk.text)
        rest = r.rest
        for (const line of r.lines) await onPadLine($, line)
      }
    } catch {
      // The child's end is handled below.
    } finally {
      if (padStream === stream) padStream = undefined
      $.ui.status(undefined)
      await setPad($, 'off')
      // A helper that dies at once is not restarted in a loop.
      if ((await $.clock.now()) - startedAt < 2000) padFailed = true
    }
  })()
}

function stopPad() {
  const stream = padStream
  padStream = undefined
  if (stream) void stream.return({ code: null, signal: null }).catch(() => undefined)
}

// ---------- commands ----------

type Parsed =
  | { kind: 'open' }
  | { kind: 'scores' }
  | { kind: 'game'; id: string; opts: Record<string, string> }
  | { kind: 'error'; text: string }

function parseArgs(raw: string): Parsed {
  const words = raw.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const [name, arg] = words
  if (!name) return { kind: 'open' }
  if (name === 'scores') return { kind: 'scores' }
  if (name === 'ttt' || name === 'tic-tac-toe') {
    if (arg && arg !== 'easy' && arg !== 'hard') return { kind: 'error', text: 'Tic-tac-toe levels: easy, hard.' }
    return { kind: 'game', id: 'ttt', opts: { level: arg ?? str('tttLevel', 'hard') } }
  }
  if (name === 'sudoku') {
    if (arg && arg !== 'easy' && arg !== 'medium' && arg !== 'hard') return { kind: 'error', text: 'Sudoku difficulties: easy, medium, hard.' }
    return { kind: 'game', id: 'sudoku', opts: { difficulty: arg ?? str('sudokuDifficulty', 'medium') } }
  }
  if (name === 'tetris') {
    if (arg && arg !== 'zen' && arg !== 'normal') return { kind: 'error', text: 'Tetris speeds: normal, zen.' }
    return { kind: 'game', id: 'tetris', opts: { mode: arg ?? str('tetrisSpeed', 'normal') } }
  }
  if (name === 'poker' || name === 'video-poker' || name === 'jacks') return { kind: 'game', id: 'poker', opts: {} }
  if (name === 'blackjack' || name === 'bj' || name === '21') return { kind: 'game', id: 'blackjack', opts: {} }
  if (name === 'uno') {
    if (arg && arg !== '2' && arg !== '3') return { kind: 'error', text: 'UNO opponents: 2 or 3.' }
    return { kind: 'game', id: 'uno', opts: { opponents: arg ?? str('unoOpponents', '3') } }
  }
  return { kind: 'error', text: `No game "${name}". Try: ttt, sudoku, tetris, poker, blackjack, uno, scores.` }
}

/** The bankroll as one line. */
const bankLine = (b: ArcadeBank): string => `Bankroll ${fmtNum(b.chips)} chips (peak ${fmtNum(b.peak)})`

function scoreLines(all: ArcadeScores): string[] {
  return GAMES.map(g => {
    const sc = all[g.id]
    if (!sc) return `${g.title}: no games yet`
    const counters = Object.entries(sc.counters).map(([k, v]) => `${k} ${v}`).join(', ')
    const bests = Object.entries(sc.bests).map(([k, v]) => `${k} ${g.id === 'sudoku' ? clock(v) : fmtNum(v)}`).join(', ')
    return `${g.title}: ${sc.played} played${counters ? ` · ${counters}` : ''}${bests ? ` · best ${bests}` : ''}`
  })
}

async function runCommand($: EngineInterface, args: string) {
  const parsed = parseArgs(args)
  if (parsed.kind === 'error') return { text: parsed.text }
  if (parsed.kind === 'scores') {
    await update<ArcadeSession>($, session, s => ({ ...s, screen: 'scores' }))
  }
  // Dock first: with the workbench loaded, its pane opens before this one so
  // arcade lands in its slot instead of a tab of its own.
  try {
    if ((await $.command.list()).some(c => c.name === 'workbench')) await $.ui.open({ id: 'workbench', title: 'Workbench', focus: true })
  } catch {
    // No workbench: arcade opens on its own.
  }
  await update($, session, s => ({ ...s, isOpen: true }))
  if (parsed.kind === 'game') await startGame($, parsed.id, parsed.opts)
  else {
    // Reopening with a game in progress: it waits, paused, where it was.
    const s = await read($, session)
    if (s.screen === 'play') await pauseGame($, 'welcome back')
  }
  const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true, columns: 48 })
  if (!opened.isPlaced) $.ui.toast(`Arcade waits: ${opened.reason}`)
  await startPad($)
  await armTicker($)
  if (parsed.kind === 'scores') return { text: ['Arcade scores:', ...scoreLines(await read($, scores)), bankLine(await read($, bank))].join('\n') }
  return { text: 'Arcade is open. Click the board once for arrow keys; the letter and digit keys work as soon as the pane has the keyboard.' }
}

// ---------- drawing ----------

const widthOf = (lines: Seg[][]) => lines.reduce((w, l) => Math.max(w, l.reduce((a, s) => a + s.text.length, 0)), 0)

function helpLines(game: AnyGame): Seg[][] {
  const line = (text: string, dim = false): Seg[] => [{ text, ...(dim ? { dim: true } : {}) }]
  const kb = (game.controls as GameControl[]).filter(c => c.kb).map(c => line(` ${c.kb}`))
  const pads = (game.controls as GameControl[]).filter(c => c.pad).map(c => line(` 🎮 ${c.pad}`, true))
  return [
    [{ text: ` ${game.title}`, bold: true }],
    ...kb,
    line(' n new · q games · i or ? help'),
    ...pads,
    line(' 🎮 start pauses; then a resumes, b games, select new', true),
    line(' (any key closes help)', true),
  ]
}

/** What the current game shows, for the pane and for the board's replies. */
async function playModel($: EngineInterface, cols: number, rows: number) {
  const s = await read($, session)
  const game = gameOf(s.current)
  const state = game ? (await read($, saves))[game.id as GameId] : undefined
  if (!game || !state) return undefined
  const score = (await read($, scores))[game.id]
  const view: View = game.view(state, cols, Math.max(4, rows - 5), score)
  const lines = s.showHelp ? helpLines(game) : view.board
  const status = s.paused
    ? `⏸ ${s.pauseNote ?? 'paused'} · ${game.softPause ? 'any key resumes' : 'p/start resumes'} · n new · q games`
    : view.status
  return { s, game, state, view, lines, status }
}

const acksOf = () => Object.fromEntries([...applied.entries()].slice(-4))

/** The board's props: its lines, the hint and which posts have been applied. */
async function boardProps($: EngineInterface) {
  const m = await playModel($, size.cols, size.rows)
  return { lines: m?.lines ?? [], hint: HINT, acks: acksOf() }
}

async function drawPane($: EngineInterface, e: RenderInput<'Pane'>, o: { inBench: boolean }) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const cols = e.props.bodyColumns || e.viewport?.columns || 40
  const rows = e.props.scroll.bodyRows
  size = { cols, rows }
  if (e.surface === 'mobile') return <Text>Arcade needs a keyboard: open it in the terminal or the desktop app.</Text>

  const s = await read($, session)
  // Hotkeys belong to the whole site and a later one wins: none inside the workbench.
  const hk = (hotkey?: string) => (hotkey && !o.inBench ? { hotkey } : {})
  const segRow = (segs: Seg[], key: string) => {
    const shown = segs.filter(x => x.text !== '')
    return (
      <Box key={key}>
        {shown.length === 0 ? (
          <Text key="seg-0"> </Text>
        ) : (
          shown.map((x, j) => (
            <Text key={`seg-${j}`} color={x.color} backgroundColor={x.bg} dimColor={x.dim} bold={x.bold} inverse={x.inverse} underline={x.underline} wrap="truncate">
              {x.text}
            </Text>
          ))
        )}
      </Box>
    )
  }
  const buttons = (list: readonly GameControl[]) => (
    <Box key="controls" flexDirection="row" flexWrap="wrap" columnGap={1}>
      {list.map(c => (
        <Button key={`ctl-${c.hotkey ?? c.label}`} label={c.label} {...hk(c.hotkey)} plain onPress={() => applyKey($, c.key, 'button')} />
      ))}
    </Box>
  )

  if (s.screen === 'picker') {
    if (cols < 24) return <Text>Widen the pane: Arcade needs 24 columns.</Text>
    const p = await read($, pad)
    const padNote =
      p.status === 'connected' ? '🎮 controller connected: d-pad + a'
        : p.status === 'waiting' ? '🎮 waiting for a controller...'
          : p.status === 'missing' ? 'Controller: build native\\build.cmd to enable it.'
            : ''
    const all = await read($, scores)
    const held = await read($, bank)
    return (
      <Box flexDirection="column">
        <Text key="title" bold color="cyan">
          ARCADE
        </Text>
        {GAMES.map((g, i) => (
          <Box key={`row-${g.id}`} flexDirection="column">
            <Button key={`pick-${g.id}`} label={`${i + 1}. ${g.title}`} {...hk(String(i + 1))} variant={i === s.pickCursor ? 'primary' : 'secondary'} onPress={() => pickGame($, g.id)} />
            <Text key={`blurb-${g.id}`} dimColor wrap="truncate">
              {`   ${g.blurb}`}
            </Text>
          </Box>
        ))}
        <Button key="pick-scores" label="scores" {...hk('s')} plain onPress={() => update<ArcadeSession>($, session, held => ({ ...held, screen: 'scores' }))} />
        {padNote ? (
          <Text key="pad" dimColor wrap="truncate">
            {padNote}
          </Text>
        ) : null}
        <Text key="scores-line" dimColor wrap="truncate">
          {scoreLines(all).slice(0, 1).join('')}
        </Text>
        <Text key="bank-line" dimColor wrap="truncate">
          {bankLine(held)}
        </Text>
      </Box>
    )
  }

  if (s.screen === 'scores') {
    const all = await read($, scores)
    const held = await read($, bank)
    return (
      <Box flexDirection="column">
        <Text key="title" bold color="cyan">
          SCORES
        </Text>
        {scoreLines(all).map((l, i) => (
          <Text key={`score-${i}`} wrap="wrap">
            {l}
          </Text>
        ))}
        <Text key="bank-line" wrap="wrap">
          {bankLine(held)}
        </Text>
        <Button key="back" label="back" {...hk('q')} plain onPress={() => update<ArcadeSession>($, session, held => ({ ...held, screen: 'picker' }))} />
      </Box>
    )
  }

  const m = await playModel($, cols, rows)
  if (!m) return <Text>No game running. Press a game on the picker.</Text>
  if (cols < m.game.minColumns) return <Text>{`Widen the pane: ${m.game.title} needs ${m.game.minColumns} columns.`}</Text>

  const header = segRow(m.view.header, 'hdr')
  const status = (
    <Box key="status">
      <Text key="status-text" dimColor={!m.s.paused} color={m.s.paused ? 'yellow' : undefined} wrap="truncate">
        {m.status}
      </Text>
    </Box>
  )
  const controls = buttons(m.game.id === 'ttt' ? SHELL_CONTROLS : [...(m.view.controls ?? (m.game.controls as GameControl[])), ...SHELL_CONTROLS])

  // Tic-tac-toe is Buttons: it needs no keyboard on the board.
  if (m.view.grid && !m.s.showHelp) {
    const grid = m.view.grid
    return (
      <Box flexDirection="column">
        {header}
        {grid.map((row, r) => (
          <Box key={`grid-${r}`} flexDirection="row">
            {row.map(cell => (
              <Button key={cell.key} label={cell.label} {...hk(cell.hotkey)} variant={cell.highlight ? 'primary' : 'secondary'} onPress={() => applyKey($, cell.press, 'button')} />
            ))}
          </Box>
        ))}
        {status}
        {controls}
      </Box>
    )
  }

  // Sudoku and tetris: a Client takes the keys and clicks; the rest of the
  // surfaces (VS Code) draw the lines as Text and play on hotkeys.
  if (e.surface === 'terminal' || e.surface === 'desktop') {
    const { Client } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {header}
        <Client key={BOARD} module="./board.tsx" width={Math.min(cols, Math.max(widthOf(m.lines), HINT.length + 1))} height={m.lines.length + 1} props={{ lines: m.lines, hint: HINT, acks: acksOf() }} />
        {status}
        {controls}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {header}
      {m.lines.map((segs, i) => segRow(segs, `row-${i}`))}
      {status}
      {controls}
    </Box>
  )
}

// ---------- hooks ----------

export const register: Register = (on, options) => {
  settings = options as Record<string, unknown>

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: COMMAND,
        description: DESCRIPTION,
        argumentHint: '[ttt | sudoku [easy|medium|hard] | tetris [zen] | poker | blackjack | uno [2|3] | scores]',
      })
    } catch {
      // The name is taken by something else: the same command under another name.
      await $.command.register({ name: FALLBACK_COMMAND, description: DESCRIPTION })
    }
    const stored = (await $.store.get(SCORES_KEY)) as ArcadeScores | undefined
    if (stored && typeof stored === 'object') await update($, scores, () => stored)
    await loadBank($)
    const held = await read($, saves)
    if (!held.sudoku) {
      const save = (await $.store.get(SUDOKU_KEY)) as ArcadeSaves['sudoku'] | undefined
      if (save && typeof save === 'object' && Array.isArray(save.cells)) await update($, saves, all => ({ ...all, sudoku: save }))
    }
    // A reload kills the timers: a game that cannot be left running comes back paused.
    const s = await read($, session)
    const game = gameOf(s.current)
    if (s.screen === 'play' && game?.pauseOnReload && !s.paused) {
      const state = (await read($, saves))[game.id as GameId] as { recorded: boolean } | undefined
      if (state && !game.isOver(state)) await update($, session, held2 => ({ ...held2, paused: true, pauseNote: 'reloaded: press p / start' }))
    }
    idleTimer?.cancel()
    idleTimer = $.clock.every(5000, () => void idleCheck($))
    await armTicker($)
    if (s.isOpen) await startPad($)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => runCommand($, e.args))
  on('command.run', { command: FALLBACK_COMMAND }, async ($, e) => runCommand($, e.args))

  // The board's posts: apply what has not been applied, answer with the next frame at once.
  on('ui.message', async ($, e, next) => {
    if (e.element !== BOARD) return next(e)
    const msg = parseBoardMessage(e.data)
    if (!msg) return {}
    const last = applied.get(msg.iid) ?? 0
    let top = last
    const s = await read($, session)
    const game = gameOf(s.current)
    for (const entry of msg.keys) {
      if (entry.n <= last) continue
      top = Math.max(top, entry.n)
      const key = entryKey(entry, game?.keyboard)
      if (key) await applyKey($, key, 'client')
    }
    if (top > last) {
      applied.delete(msg.iid)
      applied.set(msg.iid, top)
    }
    return { props: await boardProps($) }
  })

  // Esc (or anything else) taking the keyboard back to the prompt pauses the game.
  on('ui.focus', async ($, e, next) => {
    const result = await next(e)
    if ((e.requestId === PANE || e.requestId === BENCH) && e.element === undefined) await pauseGame($, 'paused')
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (settings.pauseOnTurnEnd !== false && (await read($, session)).isOpen && (await pauseGame($, 'Claude finished'))) $.ui.toast('Claude finished: game paused')
    return result
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      await pauseGame($, 'pane closed')
      await update($, session, s => ({ ...s, isOpen: false }))
      await armTicker($)
      stopPad()
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    stopPad()
    ticker?.cancel()
    ticker = undefined
    tickerMs = 0
    idleTimer?.cancel()
    idleTimer = undefined
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e, { inBench: false }))

  // Inside the workbench: fill this pane's slot in its frame.
  on('ui.render', { component: 'Pane', requestId: BENCH }, async ($, e, next) => {
    const frame = await next(e)
    const slot = slotOf(frame, PANE)
    return slot ? fillSlot(frame, PANE, await drawPane($, inSlot(e, slot.columns), { inBench: true })) : frame
  })
}
