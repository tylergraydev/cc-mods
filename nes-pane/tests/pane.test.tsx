import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import { blackCells } from '../hooks/nes'

const PROPS = { title: 'NES', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40, contentRows: 40 }, view: {} } as const
const ROM = 'C:/roms/test.nes'
const READY = '\u0001S ready mapper 0 battery 0\n'
const FRAME = `\u0001F 80 30 ${blackCells(80, 30)}\n`

type Opts = {
  exe?: boolean
  rom?: boolean
  out?: string
  code?: number
  hold?: boolean
  /** Folder listings by the end of the folder's path (`/run`, `/run/roms/game`). */
  lists?: Record<string, string[]>
}
type World = {
  clock: ReturnType<typeof mock.clock>
  spawned: string[][]
  writes: string[]
  blits: { requestId: string; key: string; cells?: string }[]
  toasts: string[]
  opened: string[]
  ran: string[][]
  killed: boolean
  release: () => void
}

/** The engine beneath the mod: memory for time and store, stubs for everything it calls out to. */
function world(on: On, o: Opts = {}): World {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  mock.store(on)
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const w: World = { clock, spawned: [], writes: [], blits: [], toasts: [], opened: [], ran: [], killed: false, release: () => release() }
  on('command.register', async () => ({ value: undefined }) as never)
  on('ui.open', async (_, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', async () => ({ value: undefined }))
  on('ui.toast', async (_, e) => {
    w.toasts.push(String((e as { text?: unknown }).text))
    return { value: undefined }
  })
  on('ui.status', async () => ({ value: undefined }))
  on('fs.exists', async (_, e) => {
    const path = String((e as { path?: unknown }).path)
    return { value: path.endsWith('nes-cc.exe') ? o.exe !== false : o.rom !== false }
  })
  on('fs.list', async (_, e) => {
    const dir = String((e as { path?: unknown }).path).replace(/\\/g, '/')
    const hit = Object.entries(o.lists ?? {}).find(([end]) => dir.endsWith(end))
    const names = hit ? hit[1] : []
    return { value: names.map(name => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) } as never
  })
  on('process.run', async (_, e) => {
    w.ran.push([...(e as { argv: readonly string[] }).argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('fs.write', async (_, e) => {
    w.writes.push(String((e as { text?: unknown }).text))
    return { value: undefined }
  })
  on('ui.blit', async (_, e) => {
    w.blits.push(e as never)
    return { value: {} } as never
  })
  // A helper that says it is ready, sends one frame of the mounted size, then
  // stays up until the test lets it go (or exits at once with `code`).
  on('process.spawn', async function* (_, e) {
    w.spawned.push([...e.argv])
    try {
      yield { stream: 'stdout' as const, text: o.out ?? READY + FRAME }
      if (o.hold !== false) await gate
    } finally {
      w.killed = true
    }
    return { code: o.code ?? 0, signal: null } as never
  })
  return w
}

const run = ($: Parameters<TestBody>[0], args: string) => $.command.run({ command: 'nes', args } as Parameters<typeof $.command.run>[0])
const mount = ($: Parameters<TestBody>[0]) => $.ui.mount({ plugin: 'nes-pane', surface: 'terminal', component: 'Pane', requestId: 'nes', props: PROPS })
const mountDesktop = ($: Parameters<TestBody>[0]) => $.ui.mount({ plugin: 'nes-pane', surface: 'desktop', component: 'Pane', requestId: 'nes', props: PROPS })
const lastWrite = (w: World) => w.writes[w.writes.length - 1] ?? ''

/** Waits until the helper's loop has wound down and the pane says the game is off. */
async function settled($: Parameters<TestBody>[0], w: World) {
  const ui = await mount($)
  // A stopped game hands the pane back to the picker, which shows why above the list.
  for (let i = 0; i < 50 && !(await ui.find({ text: /NES (exited|stopped)/ })); i++) await w.clock.advance(10)
  expect(await ui.find({ text: /NES (exited|stopped)/ })).toBeDefined()
  await ui.unmount()
}

test('/nes <path> spawns the helper with the ROM, the control file and the saves folder', async ($, on) => {
  const w = world(on)
  const out = await run($, ROM)
  expect(String(out.text)).toContain('NES is open')
  expect(w.opened).toEqual(['nes'])
  expect(w.spawned).toHaveLength(1)
  expect(w.spawned[0]).toEqual([
    expect.stringMatching(/bin\/nes-cc\.exe$/),
    '-rom',
    ROM,
    '-ctrl',
    expect.stringMatching(/run\/ctrl\.txt$/),
    '-sav',
    expect.stringMatching(/run\/saves$/),
  ])
  w.release()
})

test('a frame on stdout becomes a blit of the screen Raster', async ($, on) => {
  const w = world(on)
  const ui = await mount($)
  await run($, ROM)
  expect(w.blits.length).toBeGreaterThan(0)
  expect(w.blits[0]).toEqual({ requestId: 'nes', key: 'screen', cells: blackCells(80, 30) })
  await ui.unmount()
  w.release()
})

test('the pane draws the picture, the key catcher and the controls', async ($, on) => {
  const w = world(on)
  await run($, ROM)
  const ui = await mount($)
  const screen = await ui.find({ key: 'screen' })
  expect(screen?.type).toBe('Raster')
  expect(screen?.props.columns).toBe(80)
  expect(screen?.props.rows).toBe(30)
  expect((await ui.find({ key: 'pad' }))?.type).toBe('Client')
  expect((await ui.find({ key: 'k-k' }))?.props.hotkey).toBe('k')
  await ui.unmount()
  w.release()
})

test('the end of the turn pauses a running game and says so', async ($, on) => {
  const w = world(on)
  on('turn.complete', async (_, e) => ({ text: e.answer }) as never)
  const ui = await mount($)
  await run($, ROM)
  await ui.press({ key: 'k-k' })
  expect(lastWrite(w)).toContain('mode play')
  await $.turn.complete({ answer: 'ok', text: 'ok', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't' } as never)
  expect(lastWrite(w)).toContain('mode pause')
  expect(w.toasts.some(t => t.includes('Claude finished'))).toBe(true)
  await ui.unmount()
  w.release()
})

// The mod also closes the stream (return()) 1.5 s after quit, which kills a
// real child; the kit's stub, suspended in an await rather than a yield, does
// not see that return(), so only the control file is checked here.
test('/nes quit writes quit to the control file', async ($, on) => {
  const w = world(on)
  await run($, ROM)
  const out = await run($, 'quit')
  expect(String(out.text)).toContain('NES quit')
  expect(lastWrite(w)).toContain('\nquit\n')
  await w.clock.advance(1500)
  w.release()
  await settled($, w)
})

test('a Read tool call passes through untouched', async ($, on) => {
  const w = world(on)
  on('tool.call', async () => ({ result: {} as never, text: 'ok' }) as never)
  await run($, ROM)
  const writes = w.writes.length
  const toasts = w.toasts.length
  const result = await $.tool.call({ tool: 'Read', file_path: 'C:/x.txt' } as never)
  expect((result as { text?: string }).text).toBe('ok')
  expect(w.writes.length).toBe(writes)
  expect(w.toasts.length).toBe(toasts)
  w.release()
})

test('a missing helper says how to build it and spawns nothing', async ($, on) => {
  const w = world(on, { exe: false })
  const out = await run($, ROM)
  expect(String(out.text)).toContain('native\\build.cmd')
  expect(w.spawned).toHaveLength(0)
})

test('a ROM that is not there is named and nothing is spawned', async ($, on) => {
  const w = world(on, { rom: false })
  const out = await run($, 'C:/roms/nope.nes')
  expect(String(out.text)).toContain('No ROM "C:/roms/nope.nes"')
  expect(w.spawned).toHaveLength(0)
})

test('an error from the helper is a toast and no restart', async ($, on) => {
  const w = world(on, {
    out: '\u0001S error unsupported mapper 5 (nes-pane plays mappers 0, 1, 2, 3, 4 and 7)\n',
    code: 4,
    hold: false,
  })
  await run($, 'C:/roms/bad.nes')
  await settled($, w)
  expect(w.toasts.some(t => t.includes('unsupported mapper 5'))).toBe(true)
  expect(w.spawned).toHaveLength(1)
})

test('a helper that exits with an error code is restarted once', async ($, on) => {
  const w = world(on, { out: READY, code: 1, hold: false })
  await run($, ROM)
  await settled($, w)
  expect(w.spawned).toHaveLength(2)
  expect(w.toasts.some(t => t.includes('restarting once'))).toBe(true)
})

test('keys in the key catcher press buttons; Shift+arrow latches', async ($, on) => {
  const w = world(on)
  const ui = await mount($)
  await run($, ROM)
  await ui.press({ key: 'k-k' })
  await w.clock.advance(100)
  await ui.key({ key: 'right', in: 'pad' })
  expect(lastWrite(w)).toMatch(/\nk \d+ right\n/)
  await w.clock.advance(100)
  await ui.key({ key: 'right', shift: true, in: 'pad' })
  expect(lastWrite(w)).toMatch(/\nh \d+ right 1\n/)
  await ui.unmount()
  w.release()
})

test('says it plays in the terminal elsewhere', async ($, on) => {
  world(on)
  const ui = await mountDesktop($)
  expect(await ui.find({ text: /plays in the terminal/ })).toBeDefined()
  await ui.unmount()
})

test('/nes with nothing known opens the picker on the run folder, and a row plays it', async ($, on) => {
  const w = world(on, { lists: { '/run': ['My Game.nes', 'ctrl.txt', 'Pack.zip'] } })
  const out = await run($, '')
  expect(String(out.text)).toContain('NES pane is open: 2 ROMs found')
  expect(w.opened).toEqual(['nes'])
  expect(w.spawned).toHaveLength(0)
  const ui = await mount($)
  expect(await ui.find({ text: /pick a ROM/ })).toBeDefined()
  const first = await ui.find({ key: 'rom-0' })
  expect(first?.type).toBe('Button')
  expect(first?.props.label).toBe('My Game')
  expect(first?.props.hotkey).toBe('1')
  expect((await ui.find({ key: 'rom-1' }))?.props.label).toBe('Pack')
  expect((await ui.find({ key: 'refresh' }))?.props.hotkey).toBe('f')
  expect((await ui.find({ key: 'close' }))?.props.hotkey).toBe('x')
  expect(await ui.find({ key: 'screen' })).toBeUndefined()
  await ui.press({ key: 'rom-0' })
  expect(w.spawned).toHaveLength(1)
  expect(w.spawned[0]?.[2]).toMatch(/run\/My Game\.nes$/)
  expect(w.ran).toHaveLength(0)
  await ui.unmount()
  w.release()
})

test('/nes list returns the list and opens the picker', async ($, on) => {
  const w = world(on, { lists: { '/run/roms': ['Zed.nes'] } })
  const out = await run($, 'list')
  expect(String(out.text)).toMatch(/1\. Zed \(run\)/)
  expect(w.opened).toEqual(['nes'])
  expect(w.spawned).toHaveLength(0)
})

test('/nes <zip> unzips with tar.exe and plays the ROM inside', async ($, on) => {
  const w = world(on, { lists: { '/run/roms/game': ['.keep', 'game.nes', 'readme.txt'] } })
  const out = await run($, 'C:/x/game.zip')
  expect(String(out.text)).toContain('NES is open')
  expect(w.ran).toEqual([['C:\\Windows\\System32\\tar.exe', '-xf', 'C:/x/game.zip', '-C', expect.stringMatching(/run\/roms\/game$/)]])
  expect(w.spawned).toHaveLength(1)
  expect(w.spawned[0]?.[2]).toMatch(/run\/roms\/game\/game\.nes$/)
  w.release()
})

test('a zip without a .nes says so and spawns nothing', async ($, on) => {
  const w = world(on)
  const out = await run($, 'C:/x/empty.zip')
  expect(String(out.text)).toBe('No .nes file inside empty.zip.')
  expect(w.ran).toHaveLength(1)
  expect(w.spawned).toHaveLength(0)
})

test('an empty world draws the no-ROMs text', async ($, on) => {
  const w = world(on)
  const out = await run($, '')
  expect(String(out.text)).toContain('no ROMs found')
  const ui = await mount($)
  expect(await ui.find({ text: /No ROMs found/ })).toBeDefined()
  expect(await ui.find({ key: 'rom-0' })).toBeUndefined()
  expect(w.spawned).toHaveLength(0)
  await ui.unmount()
})
