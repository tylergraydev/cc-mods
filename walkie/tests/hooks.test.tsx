import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { DEFAULT_HINT, promptText } from '../hooks/walkie'

type Sandbox = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const HOME = 'C:\\Users\\t'
const FOLDER = 'C:/Users/t/.claude/walkie'
const START = 1_700_000_000_000
const ME = 'session-me'
const READY = '08:35:41 ready: hold F13 to talk · drops → C:\\x\n'

/** The engine beneath the mod: a fake file system, a store, a clock, a recorder child, and a record of what the mod did. */
function world($: Sandbox, on: On) {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  mock.env(on, { USERPROFILE: HOME })
  const files = new Map<string, { text: string; mtimeMs: number }>()
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const w = {
    clock,
    files,
    toasts: [] as string[],
    statuses: [] as (string | undefined)[],
    submitted: [] as string[],
    fills: [] as string[],
    spawned: [] as string[][],
    killed: 0,
    /** When set, the next prompt.submit is dropped with this reason. */
    dropNext: '',
    box: '',
    turnId: 0,
    release: () => release(),
  }
  // the kit hands the stubs absolute Windows paths; the fake file system keys on forward slashes
  const norm = (path: string) => path.replace(/\\/g, '/')
  const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/'))

  on('command.register', async (_, e) => ({ value: { command: e.name } }))
  on('session.id', async () => ({ value: ME }))
  on('ui.toast', async (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', async (_, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', async () => ({ value: undefined }))
  on('prompt.submit', async (_, e) => {
    if (w.dropNext) {
      const reason = w.dropNext
      w.dropNext = ''
      return { drop: reason }
    }
    w.submitted.push(e.text)
    return { text: e.text }
  })
  on('prompt.read', async () => ({ value: { text: w.box, cursor: 0 } }))
  on('prompt.fill', async (_, e) => {
    w.fills.push(e.text)
    return { isFilled: true }
  })
  on('fs.exists', async (_, e) => {
    const path = norm(e.path)
    return { value: files.has(path) || [...files.keys()].some(k => k.startsWith(`${path}/`)) }
  })
  on('fs.list', async (_, e) => {
    const path = norm(e.path)
    return {
      value: [...files.entries()]
        .filter(([k]) => dirOf(k) === path)
        .map(([k, f]) => ({ name: k.slice(path.length + 1), kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false })),
    }
  })
  on('fs.read', async (_, e) => {
    const f = files.get(norm(e.path))
    return f ? { value: f.text } : { deny: `ENOENT ${e.path}` }
  })
  on('fs.stat', async (_, e) => {
    const f = files.get(norm(e.path))
    return f ? { value: { kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } } : { deny: `ENOENT ${e.path}` }
  })
  on('fs.write', async (_, e) => {
    files.set(norm(e.path), { text: e.text, mtimeMs: clock.now() })
    return { value: undefined }
  })
  // The recorder child: says it is ready, then stays up until the test lets it go.
  on('process.spawn', async function* (_, e) {
    w.spawned.push([...e.argv])
    try {
      yield { stream: 'stdout' as const, text: READY }
      await gate
    } finally {
      w.killed += 1
    }
    return { code: 0, signal: null } as never
  })
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('turn.start', async (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_, e) => ({ text: e.answer }))

  const start = () => $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true })
  /** The recorder dropped a transcript, stamped `at` (default: now). */
  const drop = (text: string, at = clock.now()) => files.set(`${FOLDER}/drops/${at}.txt`, { text, mtimeMs: at })
  /** The recorder's heartbeat, as of now. */
  const beat = () => files.set(`${FOLDER}/recorder.json`, { text: '{}', mtimeMs: clock.now() })
  /** Another session's owner file, as of now. */
  const otherOwner = () => files.set(`${FOLDER}/owner.txt`, { text: 'session-other', mtimeMs: clock.now() })
  /** Lets the poll fire and whatever it started settle. */
  const tick = async (ms = 600) => {
    await clock.advance(ms)
    await clock.settle()
  }
  const turn = async (text: string, answer = 'ok') => {
    w.turnId += 1
    const turnId = `t${w.turnId}`
    await $.turn.start({ text, turnId })
    await $.turn.complete({ answer, text: answer, reason: 'answer', durationMs: 1, isAborted: false, turnId } as Parameters<typeof $.turn.complete>[0])
    await clock.settle()
  }
  const command = async (args: string) => String((await $.command.run({ command: 'walkie', args } as Parameters<typeof $.command.run>[0])).text)
  const replies = () => [...files.keys()].filter(k => k.startsWith(`${FOLDER}/replies/`)).sort()
  const owner = () => files.get(`${FOLDER}/owner.txt`)?.text
  return Object.assign(w, { start, drop, beat, otherOwner, tick, turn, command, replies, owner })
}

test('a new drop is submitted with the hint, and the answer to its turn comes back as a reply', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.tick()
  expect(t.submitted).toEqual([])

  await t.clock.advance(1000)
  t.drop('what time is it')
  await t.tick()
  expect(t.submitted).toEqual([promptText('what time is it', DEFAULT_HINT)])
  expect(t.toasts).toContain('🎙 what time is it')

  await t.turn(t.submitted[0]!, 'It is noon.')
  expect(t.replies()).toEqual([`${FOLDER}/replies/${START + 1600}.txt`])
  expect(t.files.get(`${FOLDER}/replies/${START + 1600}.txt`)?.text).toBe('It is noon.')
  expect(await t.command('')).toContain('drops handled this session: 1')
  expect(await t.command('')).toContain('last: "what time is it"')
})

test('drops from before the session are not replayed, and a turn typed by hand gets no reply', async ($, on) => {
  const t = world($, on)
  t.drop('old words', START - 5000)
  await t.start()
  await t.tick()
  expect(t.submitted).toEqual([])
  await t.turn('hello typed', 'hi')
  expect(t.replies()).toEqual([])
})

test('the owning session starts the recorder when no heartbeat is fresh, once, and /walkie stop ends it', async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.tick()
  expect(t.owner()).toBe(ME)
  expect(t.spawned.length).toBe(1)
  const argv = t.spawned[0]!
  expect(argv[0]).toBe('python.exe')
  expect(argv[1]!.replace(/\\/g, '/').endsWith('/walkie.py')).toBe(true)
  expect(argv.slice(2)).toEqual(['--folder', FOLDER])
  expect(t.toasts).toContain('walkie: ready: hold F13 to talk · drops → C:\\x')
  expect(await t.command('log')).toContain('ready: hold F13')
  expect(await t.command('status')).toContain('recorder off')
  t.beat()
  await t.tick()
  expect(await t.command('status')).toContain('recorder on (started by this session)')
  await t.tick(61_000)
  expect(t.spawned.length).toBe(1)

  expect(await t.command('stop')).toContain('stopped')
  await t.clock.settle()
  // the kit's stub never sees return(); the mod has let go of the child either way
  expect(await t.command('status')).not.toContain('started by this session')
  await t.tick(61_000)
  expect(t.spawned.length).toBe(1)
  expect(await t.command('start')).toContain('Starting the recorder')
  expect(t.spawned.length).toBe(2)
})

test('a session that is not the owner leaves the drops alone until the owner goes stale', async ($, on) => {
  const t = world($, on)
  t.otherOwner()
  await t.start()
  await t.clock.advance(1000)
  t.drop('for the other session')
  await t.tick()
  expect(t.submitted).toEqual([])
  expect(t.spawned).toEqual([])
  expect(t.statuses.at(-1)).toBeUndefined()
  expect(await t.command('')).toContain('another session')

  await t.tick(20_000)
  expect(t.owner()).toBe(ME)
  expect(t.submitted).toEqual([])
  await t.clock.advance(1000)
  t.drop('for me now')
  await t.tick()
  expect(t.submitted).toEqual([promptText('for me now', DEFAULT_HINT)])
})

test('/walkie take claims the folder from a live session', async ($, on) => {
  const t = world($, on)
  t.otherOwner()
  await t.start()
  await t.tick()
  expect(await t.command('take')).toContain('now answers')
  expect(t.owner()).toBe(ME)
  await t.clock.advance(1000)
  t.drop('mine')
  await t.tick()
  expect(t.submitted.length).toBe(1)
})

test('the status line follows the recorder heartbeat', async ($, on) => {
  const t = world($, on)
  await t.start()
  expect(t.statuses.at(-1)).toBeUndefined()
  expect(await t.command('status')).toContain('recorder off')
  t.beat()
  await t.tick()
  expect(t.statuses.at(-1)).toBe('🎙 walkie')
  expect(await t.command('')).toContain('recorder on')
  await t.tick(20_000)
  expect(t.statuses.at(-1)).toBeUndefined()
})

test('/walkie pause mutes drops; resume skips what arrived meanwhile', async ($, on) => {
  const t = world($, on)
  await t.start()
  expect(await t.command('pause')).toContain('paused')
  expect(t.statuses.at(-1)).toBe('walkie: paused')
  await t.clock.advance(1000)
  t.drop('ignored')
  await t.tick()
  expect(t.submitted).toEqual([])
  await t.clock.advance(1000)
  expect(await t.command('resume')).toContain('listening')
  await t.tick()
  expect(t.submitted).toEqual([])
  await t.clock.advance(1000)
  t.drop('heard')
  await t.tick()
  expect(t.submitted).toEqual([promptText('heard', DEFAULT_HINT)])
})

test('a prompt the engine drops lands in the empty prompt box instead', async ($, on) => {
  const t = world($, on)
  await t.start()
  t.dropNext = 'busy'
  await t.clock.advance(1000)
  t.drop('fallback words')
  await t.tick()
  expect(t.submitted).toEqual([])
  expect(t.fills).toEqual([promptText('fallback words', DEFAULT_HINT)])
  expect(t.toasts.at(-1)).toBe('walkie: prompt not sent (busy)')
})

test('/walkie say hands text to the speaker; /walkie drop goes through the drop folder', async ($, on) => {
  const t = world($, on)
  await t.start()
  expect(await t.command('say read this')).toContain('read aloud')
  expect(t.replies()).toEqual([`${FOLDER}/replies/${START}.txt`])
  await t.clock.advance(1000)
  expect(await t.command('drop spoken by hand')).toContain('Dropped')
  await t.tick()
  expect(t.submitted).toEqual([promptText('spoken by hand', DEFAULT_HINT)])
  expect(await t.command('help')).toContain('/walkie say <text>')
})
