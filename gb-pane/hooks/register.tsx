import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

import type { GbLatch, GbRomEntry, GbStatus } from '../types'
import {
  HOTKEYS,
  MAX_EVENTS,
  blackCells,
  controlText,
  isZip,
  keyAction,
  lastErrorLine,
  mergeRomSources,
  middleTruncate,
  modelName,
  parseCommand,
  parseFrame,
  parsePadMessage,
  parseStatusLine,
  pushRecent,
  resolveRom,
  romFilesIn,
  romKind,
  romTitle,
  samePath,
  screenSize,
} from './gb'
import type { Action, Frame, HelperStatus, GbButton } from './gb'

// The Game Boy runs in bin/gb-cc.exe (binjgb, headless). It streams frames on
// stdout as packed Raster cells, one line each, plus its own status changes,
// and polls run/ctrl.txt for the pane's size, play/pause, the window, the
// buttons and the save slots this module writes there. Adapted from doom-pane.

const PANE = 'gb'
const SCREEN = 'screen'
const PAD = 'pad'
const FRAME_MARK = '\u0001F '
const STATUS_MARK = '\u0001S '
const COMMAND = 'gb'
const FALLBACK = 'gb-pane'
const DESCRIPTION = 'Play Game Boy and Game Boy Color games in a side pane while Claude works (/gb <rom>, list, save, load, window, quit)'
const ARGUMENT_HINT = '<rom> | list | save [n] | load [n] | hd on|off | window [off] | quit'
const DOUBLE_MS = 40
const QUIT_KILL_MS = 1500
const RECENT_KEY = 'recent'
const HD_KEY = 'hd'
const OPEN_TEXT =
  'Game Boy is open: press w/a/s/d j/k p to play, or click the line under the picture once for arrows, Enter and Backspace. Esc gives the keyboard back.'
// The one other process this mod runs: Windows' own bsdtar, which reads zips.
const TAR = 'C:\\Windows\\System32\\tar.exe'
const TAR_MS = 20_000
const NO_ROMS = 'No ROMs found. Put .gb, .gbc or .zip files in a folder and set romDir, or run /gb <path>.'
const ALSO_TEXT = 'Also: /gb <path to .gb, .gbc or .zip> · romDir in /config (gb-pane)'

const status = atom({ plugin: 'gb-pane', key: 'status' } as const, {
  mode: 'off',
  note: 'Type /gb <rom> to play.',
  isWindow: false,
} as GbStatus)

/** The picker's rows: recents, romDir, then the mod's run folder. */
const roms = atom({ plugin: 'gb-pane', key: 'roms' } as const, [] as GbRomEntry[])

type Settings = { romDir: string; hd: boolean; idlePauseSeconds: number }

// The helper process and what was last sent to it. A reload kills the helper
// with the module and these start over with it.
let settings: Settings = { romDir: '', hd: true, idlePauseSeconds: 30 }
let isRunning = false
let runId = 0
let child: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | undefined
let rom: string | undefined
let mode: 'play' | 'pause' = 'pause'
let size = { columns: 80, rows: 36 }
let events: string[] = []
let keySeq = 0
let sent = ''
let isQuitting = false
let isHd = true
let isWindow = false
let frame: Frame | undefined
let lastKeyAt = 0
let latched: GbLatch[] = []
let fatal: string | undefined
let restarted = false
let lastDeny = ''
let lastInput: { id: string; source: 'hotkey' | 'client'; at: number } | undefined
const applied = new Map<string, number>()
// ROMs unzipped from a zip that held several, offered in the picker with the run folder's.
let extracted: string[] = []

function paths($: EngineInterface) {
  const root = $.plugin.root
  const run = `${root}/run`

  return { exe: `${root}/bin/gb-cc.exe`, run, roms: `${run}/roms`, ctrl: `${run}/ctrl.txt`, sav: `${run}/saves` }
}

async function sendControl($: EngineInterface) {
  const text = controlText({ size, mode, hd: isHd, window: isWindow, events, quit: isQuitting })
  if (text === sent) return
  sent = text
  await $.fs.write(paths($).ctrl, text)
}

function pushEvents(lines: string[]) {
  events = [...events, ...lines].slice(-MAX_EVENTS)
}

async function setMode($: EngineInterface, next: 'play' | 'pause', note: string) {
  mode = next
  // The helper lets go of every latch on pause; so does the pane.
  if (next === 'pause') latched = []
  await update($, status, (st): GbStatus => ({ ...st, mode: next === 'play' ? 'playing' : 'paused', note, isWindow, latched }))
  await sendControl($)
  $.ui.status(next === 'play' ? 'Game Boy ▶' : undefined)
}

async function pauseFor($: EngineInterface, note: string, toast?: string) {
  if (!isRunning || mode !== 'play') return
  await setMode($, 'pause', note)
  if (toast) $.ui.toast(toast)
}

const isDirection = (b: GbButton) => b === 'up' || b === 'down' || b === 'left' || b === 'right'

/** One button, latch or clear from a hotkey or the key catcher. */
async function applyAction($: EngineInterface, action: Action, source: 'hotkey' | 'client') {
  if (!isRunning) return
  const now = await $.clock.now()
  // A key typed on the focused key catcher may also press its matching hotkey Button: one of the two counts.
  const id = JSON.stringify(action)
  if (lastInput && lastInput.id === id && lastInput.source !== source && now - lastInput.at < DOUBLE_MS) return
  lastInput = { id, source, at: now }
  lastKeyAt = now
  if (mode !== 'play') {
    // The key that resumes is swallowed, so it does not also act.
    await setMode($, 'play', '')
    return
  }
  const lines: string[] = []
  const unlatch = (which: (l: GbLatch) => boolean) => {
    for (const l of latched.filter(which)) lines.push(`h ${++keySeq} ${l} 0`)
    latched = latched.filter(l => !which(l))
  }
  if ('press' in action) {
    if (isDirection(action.press)) unlatch(l => l !== 'b')
    lines.push(`k ${++keySeq} ${action.press}`)
  } else if ('latch' in action) {
    const l = action.latch
    if (latched.includes(l)) {
      unlatch(x => x === l)
    } else {
      if (l !== 'b') unlatch(x => x !== 'b')
      lines.push(`h ${++keySeq} ${l} 1`)
      latched = [...latched, l]
    }
  } else {
    unlatch(l => l !== 'b')
  }
  pushEvents(lines)
  await update($, status, st => ({ ...st, latched }))
  await sendControl($)
}

async function onHelperStatus($: EngineInterface, s: HelperStatus) {
  switch (s.kind) {
    case 'ready':
      if (mode !== 'play') await update($, status, st => ({ ...st, note: `Ready · ${modelName(s.model)} · ${s.mbc.toUpperCase()}` }))
      return
    case 'error':
      fatal = s.text
      $.ui.toast(`Game Boy: ${s.text}`)
      await update($, status, st => ({ ...st, note: `Game Boy stopped: ${s.text}` }))
      return
    case 'play':
      lastKeyAt = await $.clock.now()
      await setMode($, 'play', '')
      return
    case 'input':
      // The controller is in use: keys the idle pause cannot otherwise see.
      lastKeyAt = await $.clock.now()
      return
    case 'windowOff':
      isWindow = false
      await update($, status, st => ({ ...st, isWindow }))
      await sendControl($)
      return
    case 'saved':
      $.ui.toast(`Game Boy: saved slot ${s.slot}`)
      return
    case 'loaded':
      $.ui.toast(`Game Boy: loaded slot ${s.slot}`)
      return
    case 'nostate':
      $.ui.toast(`Game Boy: slot ${s.slot} is empty`)
      return
    case 'stateError':
      $.ui.toast(`Game Boy: slot ${s.slot}: ${s.text}`)
      return
  }
}

async function showFrame($: EngineInterface, line: string) {
  const next = parseFrame(line)
  if (!next) return
  frame = next
  if (next.columns !== size.columns || next.rows !== size.rows) {
    await sendControl($)
    return
  }
  const blit = await $.ui.blit({ requestId: PANE, key: SCREEN, cells: next.cells })
  const deny = 'deny' in blit ? (blit.deny ?? 'refused') : ''
  if (deny !== lastDeny) {
    lastDeny = deny
    if (deny) $.ui.status(`Game Boy: blit refused: ${deny}`)
  }
}

/** Starts the helper on `path`; false (and says why) when it is not built. */
async function start($: EngineInterface, path: string): Promise<boolean> {
  if (isRunning) return true
  const p = paths($)
  if (!(await $.fs.exists(p.exe))) {
    const text = `gb-cc.exe is not built: run cmd //c native\\build.cmd in ${$.plugin.root}`
    await update($, status, (st): GbStatus => ({ ...st, mode: 'off', note: text }))
    $.ui.toast(text)
    return false
  }
  isRunning = true
  isQuitting = false
  fatal = undefined
  events = []
  sent = ''
  mode = 'pause'
  latched = []
  frame = undefined
  rom = path
  const run = ++runId
  // The pane leaves the picker for the picture before the first frame arrives.
  await update($, status, (st): GbStatus => ({ ...st, mode: 'paused', note: 'Starting…', rom: romTitle(path), latched: [] }))
  await sendControl($)
  const stream = $.process.spawn({ argv: [p.exe, '-rom', path, '-ctrl', p.ctrl, '-sav', p.sav], cwd: p.run })
  child = stream
  // The loop is the child's life; it runs on after the command returns.
  void pump($, stream, run, path)

  return true
}

async function pump($: EngineInterface, stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>, run: number, path: string) {
  let errors = ''
  let code: number | null = null
  try {
    let buffer = ''
    // Read by hand rather than with for-await, so the child's exit code (the
    // generator's return value) is kept.
    for (;;) {
      const step = await stream.next()
      if (step.done) {
        code = step.value?.code ?? null
        break
      }
      const piece = step.value
      if (piece.stream === 'stderr') {
        errors = (errors + piece.text).slice(-2000)
        continue
      }
      buffer += piece.text
      const end = buffer.lastIndexOf('\n')
      if (end < 0) continue
      const lines = buffer.slice(0, end).split('\n')
      buffer = buffer.slice(end + 1)
      // Of several frames that piled up, only the newest is drawn.
      let frameLine = ''
      for (const line of lines) {
        if (line.startsWith(FRAME_MARK)) frameLine = line.slice(FRAME_MARK.length)
        else if (line.startsWith(STATUS_MARK)) {
          const s = parseStatusLine(line.slice(STATUS_MARK.length))
          if (s) await onHelperStatus($, s)
        }
      }
      if (frameLine) await showFrame($, frameLine)
    }
  } catch (error) {
    errors += `\n${String(error)}`
  }
  if (run !== runId) return // a newer helper took over
  if (child === stream) child = undefined
  isWindow = false
  mode = 'pause'
  frame = undefined
  latched = []
  $.ui.status(undefined)
  if (!isQuitting && !fatal && code !== 0 && !restarted) {
    restarted = true
    isRunning = false
    $.ui.toast('Game Boy helper stopped; restarting once')
    try {
      await start($, path)
    } catch {
      // The module is going away.
    }
    return
  }
  const lastError = lastErrorLine(errors)
  const note = fatal
    ? `Game Boy stopped: ${fatal}`
    : isQuitting || !lastError
      ? 'Game Boy exited. /gb to start again.'
      : `Game Boy stopped: ${lastError}`
  await update($, status, (): GbStatus => ({ mode: 'off', note, isWindow }))
  isRunning = false
}

/** Asks the helper to quit; after QUIT_KILL_MS the stream is closed, which kills it. */
async function quitHelper($: EngineInterface) {
  isQuitting = true
  await sendControl($)
  const stream = child
  if (stream) $.clock.after(QUIT_KILL_MS, () => void stream.return({ code: null, signal: null }).catch(() => undefined))
}

async function stopAndWait($: EngineInterface) {
  await quitHelper($)
  for (let i = 0; i < 20 && isRunning; i++) await $.clock.sleep(100)
  if (isRunning) {
    // It did not go: forget it and start over.
    void child?.return({ code: null, signal: null }).catch(() => undefined)
    runId++
    isRunning = false
    child = undefined
  }
}

async function readRecent($: EngineInterface): Promise<string[]> {
  const stored = await $.store.get(RECENT_KEY)
  return Array.isArray(stored) ? stored.filter((p): p is string => typeof p === 'string') : []
}

async function listRoms($: EngineInterface, dir: string): Promise<string[]> {
  try {
    return (await $.fs.list(dir)).filter(e => e.kind !== 'dir').map(e => e.name)
  } catch {
    return []
  }
}

async function fileExists($: EngineInterface, path: string): Promise<boolean> {
  try {
    return await $.fs.exists(path)
  } catch {
    return false
  }
}

/** Rebuilds the picker's list: recents still on disk, romDir, then run/roms and run (one level each). */
async function refreshRoms($: EngineInterface): Promise<GbRomEntry[]> {
  const p = paths($)
  const recent: string[] = []
  for (const r of await readRecent($)) if (await fileExists($, r)) recent.push(r)
  const fromDir = settings.romDir ? romFilesIn(settings.romDir, await listRoms($, settings.romDir)) : []
  const fromRun = [...extracted, ...romFilesIn(p.roms, await listRoms($, p.roms)), ...romFilesIn(p.run, await listRoms($, p.run))]
  const list = mergeRomSources([
    { source: 'recent', paths: recent },
    { source: 'romDir', paths: fromDir },
    { source: 'run', paths: fromRun },
  ])
  await update($, roms, () => list)

  return list
}

/** Opens the pane on the picker, with a fresh list. */
async function openPicker($: EngineInterface): Promise<GbRomEntry[]> {
  const list = await refreshRoms($)
  await update($, status, (st): GbStatus => ({ ...st, mode: 'pick', note: '', latched: [] }))
  const opened = await $.ui.open({ id: PANE, title: 'Game Boy', focus: true })
  if (!opened.isPlaced) $.ui.toast(`Game Boy pane waits: ${opened.reason}`)

  return list
}

/** Unzips into run/roms/<zip name> with tar.exe, then plays the one ROM inside or offers several. */
async function playZip($: EngineInterface, zip: string): Promise<{ text: string }> {
  const name = zip.split(/[\\/]/).pop() ?? zip
  const dir = `${paths($).roms}/${romTitle(zip)}`
  try {
    // $.fs has no mkdir: a write makes the folder.
    await $.fs.write(`${dir}/.keep`, '')
    const r = await $.process.run([TAR, '-xf', zip, '-C', dir], { timeoutMs: TAR_MS })
    if (r.exitCode !== 0) {
      const why = r.stderr.trim().split('\n').pop()?.trim() || `tar exited ${r.exitCode}`
      return { text: `Could not unzip ${name}: ${why}` }
    }
  } catch (error) {
    return { text: `Could not unzip ${name}: ${String(error)}` }
  }
  const found = romFilesIn(dir, await listRoms($, dir)).filter(f => !isZip(f))
  if (found.length === 0) {
    await refreshRoms($)
    return { text: `No .gb or .gbc file inside ${name}.` }
  }
  if (found.length === 1) {
    const out = await openRom($, found[0] as string)
    await refreshRoms($)
    return out
  }
  extracted = [...found, ...extracted.filter(x => !found.some(f => samePath(f, x)))]
  if (isRunning) {
    await refreshRoms($)
    return { text: `${name} holds ${found.length} ROMs: /gb quit, then pick one in the Game Boy pane.` }
  }
  await openPicker($)

  return { text: `${name} holds ${found.length} ROMs: pick one in the Game Boy pane.` }
}

/** A `.gb`, `.gbc` or `.zip`, as `/gb <path>` and the picker start it. */
async function playPath($: EngineInterface, path: string): Promise<{ text: string }> {
  return isZip(path) ? playZip($, path) : openRom($, path)
}

/** A picker row pressed: start it; say why when it did not start. */
async function pickRom($: EngineInterface, path: string) {
  const out = await playPath($, path)
  if (out.text !== OPEN_TEXT) $.ui.toast(out.text)
}

async function openRom($: EngineInterface, path: string) {
  restarted = false
  if (isRunning && rom && !samePath(rom, path)) await stopAndWait($)
  if (!(await start($, path))) return { text: (await read($, status)).note }
  await $.store.set(RECENT_KEY, pushRecent(await readRecent($), path))
  const title = romTitle(path)
  if (mode !== 'play') await update($, status, (st): GbStatus => ({ ...st, mode: 'paused', note: st.note.startsWith('Ready') ? st.note : 'Ready', rom: title }))
  const opened = await $.ui.open({ id: PANE, title: `Game Boy · ${title}`, focus: true })
  if (!opened.isPlaced) $.ui.toast(`Game Boy pane waits: ${opened.reason}`)

  return { text: OPEN_TEXT }
}

function listText(list: readonly GbRomEntry[]): string {
  const lines = list.length
    ? [`ROMs (${list.length}):`, ...list.map((r, i) => `  ${i + 1}. ${r.title} (${r.source}): ${r.path}`)]
    : [NO_ROMS]
  if (!settings.romDir) lines.push('No ROM folder set: romDir in /config (gb-pane).')

  return lines.join('\n')
}

function foundText(count: number): string {
  const found = count === 0 ? 'no ROMs found' : `${count} ROM${count === 1 ? '' : 's'} found`

  return `Game Boy pane is open: ${found}. Pick one there (1-9 or click), or /gb <path to .gb, .gbc or .zip>.`
}

async function runCommand($: EngineInterface, args: string) {
  const c = parseCommand(args)
  switch (c.kind) {
    case 'bad':
      return { text: c.text }
    case 'hd':
      isHd = c.on
      await $.store.set(HD_KEY, isHd)
      if (isRunning) await sendControl($)
      return { text: isHd ? 'Game Boy draws 2x2 pixels a cell.' : 'Game Boy draws 1x2 pixels a cell (half blocks).' }
    case 'window': {
      if (c.on && !isRunning) {
        if (!rom) return { text: 'Start a game first: /gb <rom>.' }
        if (!(await start($, rom))) return { text: (await read($, status)).note }
      }
      isWindow = c.on
      await update($, status, st => ({ ...st, isWindow }))
      await sendControl($)
      return {
        text: isWindow
          ? 'Game Boy opened in its own window: arrows move, Z/J is B, X/K is A, Enter is Start, Backspace is Select. It still pauses when Claude needs you; any key there resumes.'
          : 'Game Boy window closed.',
      }
    }
    case 'quit':
      if (!isRunning) return { text: 'Game Boy is not running.' }
      await quitHelper($)
      await $.ui.close({ id: PANE })
      return { text: 'Game Boy quit.' }
    case 'save':
    case 'load':
      if (!isRunning) return { text: 'Nothing is running.' }
      pushEvents([`${c.kind} ${++keySeq} ${c.slot}`])
      await sendControl($)
      return { text: `${c.kind === 'save' ? 'Saving' : 'Loading'} slot ${c.slot}…` }
    case 'list': {
      // A running game keeps the pane; the list is still refreshed for after it.
      const list = isRunning ? await refreshRoms($) : await openPicker($)
      return { text: listText(list) }
    }
    case 'open': {
      if (c.rom) {
        const found = await resolveRom(c.rom, settings.romDir, {
          exists: p => $.fs.exists(p),
          list: d => listRoms($, d),
        })
        if ('path' in found) return playPath($, found.path)
        if ('ambiguous' in found) return { text: `"${c.rom}" matches several ROMs: ${found.ambiguous.join(', ')}. Type more of the name.` }
        const where = found.tried.length ? found.tried.join(', ') : 'nowhere: no ROM folder is set'
        return { text: `No ROM "${c.rom}" (looked in ${where}). /gb list shows romDir.` }
      }
      if (isRunning && rom) return openRom($, rom)
      const list = await openPicker($)
      return { text: foundText(list.length) }
    }
  }
}

const acksOf = () => Object.fromEntries([...applied.entries()].slice(-4))

/** The line under the picture: what the game is doing and how to go on. */
function padLine(st: GbStatus): { line: string; color: string } {
  if (st.isWindow) {
    return st.mode === 'playing'
      ? { line: '▶ Playing in the Game Boy window', color: 'green' }
      : { line: `⏸ ${st.note || 'Paused'} · press a key in the Game Boy window to play`, color: 'yellow' }
  }
  if (st.mode === 'playing') {
    const held = st.latched ?? []
    const parts = [
      held.includes('left') ? ' · ← held (q)' : '',
      held.includes('right') ? ' · → held (e)' : '',
      held.includes('b') ? ' · B held (r)' : '',
    ].join('')
    return { line: `▶ Playing${parts} · Esc → prompt`, color: 'green' }
  }
  if (st.mode === 'paused') return { line: `⏸ ${st.note || 'Paused'} · press a key to play`, color: 'yellow' }

  return { line: st.note, color: 'yellow' }
}

async function padProps($: EngineInterface) {
  return { ...padLine(await read($, status)), acks: acksOf() }
}

export const register: Register = (on, options) => {
  settings = {
    romDir: typeof options.romDir === 'string' ? options.romDir : '',
    hd: options.hd !== false,
    idlePauseSeconds: typeof options.idlePauseSeconds === 'number' ? options.idlePauseSeconds : 30,
  }
  isHd = settings.hd

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: COMMAND, description: DESCRIPTION, argumentHint: ARGUMENT_HINT })
    } catch {
      // The name is taken by something else: the same command under another name.
      await $.command.register({ name: FALLBACK, description: DESCRIPTION, argumentHint: ARGUMENT_HINT })
    }
    const storedHd = await $.store.get(HD_KEY)
    if (typeof storedHd === 'boolean') isHd = storedHd
    // A reload killed the helper: say so rather than show a frozen game.
    const st = await read($, status)
    if (st.mode === 'playing' || st.mode === 'paused') await update($, status, (s): GbStatus => ({ ...s, mode: 'off', note: 'Reloaded: /gb to continue', latched: [] }))
    $.clock.every(5_000, () => {
      void (async () => {
        const secs = settings.idlePauseSeconds
        if (secs > 0 && mode === 'play' && !isWindow && (await $.clock.now()) - lastKeyAt > secs * 1000) {
          await pauseFor($, `Paused: no input for ${secs}s`)
        }
      })()
    })

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => runCommand($, e.args))
  on('command.run', { command: FALLBACK }, async ($, e) => runCommand($, e.args))

  // The key catcher's posts: apply what has not been applied, answer with its next props at once.
  on('ui.message', async ($, e, next) => {
    if (e.element !== PAD) return next(e)
    const msg = parsePadMessage(e.data)
    if (!msg) return {}
    const last = applied.get(msg.iid) ?? 0
    let top = last
    for (const entry of msg.keys) {
      if (entry.n <= last) continue
      top = Math.max(top, entry.n)
      const action = keyAction({ key: entry.k, ctrl: entry.ctrl, shift: entry.shift, meta: entry.meta })
      if (action) await applyAction($, action, 'client')
    }
    if (top > last) {
      applied.delete(msg.iid)
      applied.set(msg.iid, top)
    }

    return { props: await padProps($) }
  })

  // Pause whenever Claude needs the person: a permission prompt, a question,
  // a plan to approve, or the end of the turn.
  on('tool.check', async ($, e, next) => {
    const result = await next(e)
    if (e.tool_use_id && result.decision === 'ask') {
      await pauseFor($, 'Paused: Claude needs your permission', 'Claude needs your permission: Game Boy paused')
    }

    return result
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    await pauseFor($, 'Paused: Claude has a question', 'Claude has a question: Game Boy paused')

    return next(e)
  })

  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    await pauseFor($, 'Paused: Claude has a plan for you', 'Claude has a plan for you: Game Boy paused')

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await pauseFor($, 'Paused: Claude finished', 'Claude finished: Game Boy paused')

    return result
  })

  // Esc taking the keyboard back to the prompt pauses the game.
  on('ui.focus', async ($, e, next) => {
    const result = await next(e)
    if (e.requestId === PANE && e.element === undefined && !isWindow) await pauseFor($, 'Paused')

    return result
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && !isWindow) await pauseFor($, 'Paused: pane closed')

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const st = await read($, status)
    if (e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)
      return <Text>Game Boy plays in the terminal.</Text>
    }
    const { Box, Button, Client, Raster, Text } = $.ui.resolve(e)
    const bodyColumns = e.props.bodyColumns
    const bodyRows = e.props.scroll.bodyRows

    if (st.mode === 'off' || st.mode === 'pick') {
      // No game: the picker. Digits pick the first nine rows; no game key is drawn, so none reaches the game.
      const list = await read($, roms)
      return (
        <Box flexDirection="column" width={Math.max(8, bodyColumns)}>
          <Text bold>Game Boy · pick a ROM</Text>
          {st.mode === 'off' && st.note !== '' && (
            <Text dimColor wrap="wrap">
              {st.note}
            </Text>
          )}
          {list.length === 0 && <Text wrap="wrap">{NO_ROMS}</Text>}
          {list.map((r, i) => {
            const hotkey = i < 9 ? String(i + 1) : undefined
            const tag = `${romKind(r.path)} · ${r.source}`
            const room = Math.max(8, bodyColumns - 4 - (hotkey ? 3 : 0) - tag.length - 1)
            return (
              <Box key={`row-${i}`} flexDirection="row" columnGap={1}>
                <Button
                  key={`rom-${i}`}
                  label={middleTruncate(r.title, room)}
                  {...(hotkey ? { hotkey } : {})}
                  plain
                  onPress={() => pickRom($, r.path)}
                />
                <Text dimColor>{tag}</Text>
              </Box>
            )
          })}
          <Text dimColor wrap="wrap">
            {ALSO_TEXT}
          </Text>
          <Box key="actions" flexDirection="row" columnGap={2}>
            <Button
              key="refresh"
              label="refresh"
              hotkey="f"
              plain
              onPress={async () => {
                await refreshRoms($)
              }}
            />
            <Button key="close" label="close" hotkey="x" plain onPress={() => $.ui.close({ id: PANE })} />
          </Box>
        </Box>
      )
    }

    if (bodyColumns < 16 || bodyRows < 8) return <Text>Widen the pane to play (16x8 cells at least).</Text>

    const wanted = screenSize(bodyColumns, bodyRows)
    if (wanted.columns !== size.columns || wanted.rows !== size.rows) {
      size = wanted
      if (isRunning) void sendControl($)
    }
    const cells =
      frame && frame.columns === size.columns && frame.rows === size.rows ? frame.cells : blackCells(size.columns, size.rows)
    const { line, color } = padLine(st)

    return (
      <Box flexDirection="column" width={size.columns}>
        <Raster key={SCREEN} columns={size.columns} rows={size.rows} cells={cells} />
        <Client key={PAD} module="./pad.tsx" width={size.columns} height={1} props={{ line, color, acks: acksOf() }} />
        <Box key="controls" flexDirection="row" flexWrap="wrap" columnGap={1}>
          {HOTKEYS.map(k => (
            <Button key={`k-${k.hotkey}`} label={k.label} hotkey={k.hotkey} plain onPress={() => applyAction($, k.action, 'hotkey')} />
          ))}
        </Box>
      </Box>
    )
  })
}
