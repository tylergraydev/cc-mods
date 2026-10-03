import { expect, mock, test } from 'claude-code/testing'

const PROPS = { title: 'Sounds', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const

type Rig = {
  clips: { clip: Record<string, unknown>; gain?: number }[]
  spoken: string[]
  runs: { argv: readonly string[]; env?: Record<string, string> }[]
  toasts: string[]
  statuses: (string | undefined)[]
  registered: string[]
  reads: string[]
  opens: string[]
  commands: string[]
  store: Map<string, unknown>
}

/** Stubs every op the mod touches and records what it asked for. */
function rig(on: any, over: { surfaces?: string[]; playDeny?: string; commands?: string[]; clock?: ReturnType<typeof mock.clock> } = {}): Rig {
  const r: Rig = { clips: [], spoken: [], runs: [], toasts: [], statuses: [], registered: [], reads: [], opens: [], commands: over.commands ?? [], store: new Map() }
  on('store.get', async (_: unknown, e: any) => ({ value: r.store.get(String(e.key)) }))
  on('store.set', async (_: unknown, e: any) => {
    r.store.set(String(e.key), JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('session.start', async (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.end', async (_: unknown, e: any) => ({ sessionId: e.sessionId ?? 's' }))
  on('session.compact', async (_: unknown, e: any) => ({ messages: e.messages }))
  on('classic.PermissionRequest', async () => ({}))
  on('classic.PermissionDenied', async () => ({}))
  mock.env(on, { USERPROFILE: 'C:/Users/t' })
  on('session.surfaces', async () => ({ value: over.surfaces ?? ['terminal'] }))
  on('audio.play', async (_: unknown, e: any) => {
    r.clips.push({ clip: e.clip, gain: e.gain })
    return over.playDeny ? { deny: over.playDeny } : { value: undefined }
  })
  on('audio.speak', async (_: unknown, e: any) => {
    r.spoken.push(String(e.text))
    return { value: { via: 'system' as const } }
  })
  on('process.run', async (_: unknown, e: any) => {
    r.runs.push({ argv: e.argv, env: e.init?.env })
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('fs.exists', async () => ({ value: true }))
  on('fs.list', async () => ({
    value: ['my ding.wav', 'notes.txt'].map(name => ({ name, kind: 'file' as const, size: 1000, mtimeMs: 1, isLink: false })),
  }))
  on('fs.read', async (_: unknown, e: any) => {
    r.reads.push(String(e.path))
    return { value: { base64: 'UklGRg==' } }
  })
  on('ui.toast', async (_: unknown, e: any) => {
    r.toasts.push(String(e.text))
    return { value: undefined }
  })
  on('ui.status', async (_: unknown, e: any) => {
    r.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.open', async (_: unknown, e: any) => {
    r.opens.push(String(e.id))
    return { value: { isPlaced: true as const } }
  })
  on('command.register', async (_: unknown, e: any) => {
    r.registered.push(String(e.name))
    return { value: { command: String(e.name) } }
  })
  on('command.list', async () => ({ value: r.commands.map(name => ({ name, description: '', source: 'plugin' })) }))
  on('agent.spawn', async () => ({ model: 'm', agentId: 'a1' }))
  on('turn.complete', async (_: unknown, e: any) => ({ text: String(e.answer ?? '') }))
  return r
}

const SPAWN = { description: 'scan the repo', prompt: 'p', subagentType: 'Explore' } as const
const spawn = ($: any, over: Record<string, unknown> = {}) => $.agent.spawn({ ...SPAWN, ...over })
const done = ($: any, over: Record<string, unknown> = {}) =>
  $.turn.complete({ reason: 'answer', answer: 'ok', text: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', ...over })
const run = ($: any, args: string) => $.command.run({ command: 'sounds', args })
const assets = (r: Rig) => r.clips.map(c => String(c.clip.asset))
const ENGINE = { options: { player: 'engine' } } as const

test('an agent spawn plays the spawn sound once', ENGINE, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const r = rig(on)
  await $.session.start({ cwd: 'C:/work' } as never)
  await spawn($)
  await clock.settle()
  expect(assets(r)).toEqual(['assets/sounds/agent-spawn.wav'])
  expect(r.clips[0]?.gain).toBe(1)
})

test('a burst of spawns is one sound, and the next after the cooldown plays', ENGINE, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const r = rig(on)
  await $.session.start({ cwd: 'C:/work' } as never)
  for (let i = 0; i < 5; i += 1) await spawn($)
  await clock.settle()
  expect(r.clips).toHaveLength(1)
  await clock.advance(400)
  await spawn($)
  await clock.settle()
  expect(r.clips).toHaveLength(2)
})

test('agent finish and failure, and speaking the result', ENGINE, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const r = rig(on)
  await $.session.start({ cwd: 'C:/work' } as never)
  await spawn($)
  await clock.settle()
  await clock.advance(1000)
  await done($, { agentId: 'a1' })
  await clock.settle()
  await clock.advance(1000)
  await done($, { agentId: 'a1', reason: 'error' })
  await clock.settle()
  expect(assets(r)).toEqual(['assets/sounds/agent-spawn.wav', 'assets/sounds/agent-done.wav', 'assets/sounds/agent-failed.wav'])
  expect(r.spoken).toEqual([])
})

test('speak says the agent description', { options: { player: 'engine', speak: true } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const r = rig(on)
  await $.session.start({ cwd: 'C:/work' } as never)
  await spawn($)
  await clock.settle()
  await done($, { agentId: 'a1' })
  await clock.settle()
  expect(r.spoken).toEqual(['agent done: scan the repo'])
})

test('a permission dialog plays the ask sound', ENGINE, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const r = rig(on)
  await $.session.start({ cwd: 'C:/work' } as never)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} })
  await clock.settle()
  expect(assets(r)).toEqual(['assets/sounds/permission-ask.wav'])
})

test('auto mode denials play the denied sound, from the event or the classifier text, once per call', ENGINE, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const r = rig(on)
  let reply: Record<string, unknown> = { isError: true, result: 'x', text: 'Permission denied by the Claude Code auto mode classifier' }
  on('tool.call', async () => reply as never)
  await $.session.start({ cwd: 'C:/work' } as never)
  await $.classic.PermissionDenied({ tool_name: 'Bash', tool_input: {}, tool_use_id: 't1', reason: 'risky' })
  await clock.settle()
  expect(assets(r)).toEqual(['assets/sounds/permission-denied.wav'])
  await clock.advance(1000)
  await $.tool.call({ tool: 'Bash', command: 'rm -rf /', tool_use_id: 't2' } as never)
  await clock.settle()
  expect(r.clips).toHaveLength(2)
  // the same call reported twice is one sound
  await clock.advance(1000)
  await $.tool.call({ tool: 'Bash', command: 'rm -rf /', tool_use_id: 't2' } as never)
  await clock.settle()
  expect(r.clips).toHaveLength(2)
  // an ordinary error is silent
  reply = { isError: true, result: 'x', text: 'ENOENT: no such file' }
  await clock.advance(1000)
  await $.tool.call({ tool: 'Bash', command: 'cat nope', tool_use_id: 't3' } as never)
  await clock.settle()
  expect(r.clips).toHaveLength(2)
})

test('askVia check is documented as untestable engine-side: no play from a bare query', { options: { player: 'engine', askVia: 'check' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const r = rig(on)
  await $.session.start({ cwd: 'C:/work' } as never)
  // a test's $.tool.check is a query, with no tool_use_id
  await $.tool.check({ tool: 'Bash', command: 'ls' } as never).catch(() => undefined)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} })
  await clock.settle()
  expect(r.clips).toHaveLength(0)
})

test('a main turn chimes only past the threshold', ENGINE, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const r = rig(on)
  await $.session.start({ cwd: 'C:/work' } as never)
  await done($, { durationMs: 5000 })
  await clock.settle()
  expect(r.clips).toHaveLength(0)
  await done($, { durationMs: 30_000 })
  await clock.settle()
  expect(assets(r)).toEqual(['assets/sounds/turn-done.wav'])
})

test('/sounds mute silences cues, shows a status, and ends on time', ENGINE, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-03T10:00:00') })
  const r = rig(on)
  await $.session.start({ cwd: 'C:/work' } as never)
  const out = await run($, 'mute 30m')
  expect(String(out.text)).toContain('30 min')
  expect(r.statuses[r.statuses.length - 1]).toMatch(/^🔇 until 10:30$/)
  await spawn($)
  await clock.settle()
  expect(r.clips).toHaveLength(0)
  await clock.advance(31 * 60_000)
  await clock.settle()
  expect(r.statuses[r.statuses.length - 1]).toBeUndefined()
  await spawn($)
  await clock.settle()
  expect(r.clips).toHaveLength(1)
})

test('/sounds set persists, silences, and plays a user file through fs.read', ENGINE, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const r = rig(on, {})
  await $.session.start({ cwd: 'C:/work' } as never)
  expect(String((await run($, 'set agent.spawn off')).text)).toContain('off')
  expect(JSON.stringify(await r.store.get('mapping'))).toContain('"agent.spawn":"off"')
  await spawn($)
  await clock.settle()
  expect(r.clips).toHaveLength(0)
  expect(String((await run($, 'set agent.done my ding')).text)).toContain('user:my ding.wav')
  await done($, { agentId: 'a1' }) // unknown agent: silent
  await spawn($, { description: 'again' })
  await clock.settle()
  await done($, { agentId: 'a1' })
  await clock.settle()
  expect(r.reads.length).toBe(1)
  expect(r.clips[0]?.clip).toEqual({ base64: 'UklGRg==', mime: 'audio/wav' })
  expect(String((await run($, 'set nope x')).text)).toContain('unknown cue')
  expect(String((await run($, 'list')).text)).toContain('agent.spawn')
})

test('the PowerShell player runs one fixed script with the path in env', { options: { player: 'powershell' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const r = rig(on)
  await $.session.start({ cwd: 'C:/work' } as never)
  await spawn($)
  await clock.settle()
  expect(r.clips).toHaveLength(0)
  expect(r.runs).toHaveLength(1)
  expect(r.runs[0]?.argv[0]).toBe('powershell.exe')
  expect(r.runs[0]?.env?.SB_FILE?.endsWith('assets\\sounds\\agent-spawn.wav')).toBe(true)
  expect(r.runs[0]?.argv.join(' ')).not.toContain('agent-spawn')
})

test('a player that fails toasts once for the whole session', ENGINE, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const r = rig(on, { playDeny: 'no device' })
  await $.session.start({ cwd: 'C:/work' } as never)
  await spawn($)
  await clock.settle()
  await clock.advance(1000)
  await done($, { agentId: 'a1' })
  await clock.settle()
  expect(r.clips.length).toBeGreaterThanOrEqual(2)
  expect(r.toasts).toHaveLength(1)
  expect(r.toasts[0]).toContain('audio unavailable')
})

test('headless: every cue stays silent', ENGINE, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const r = rig(on, { surfaces: [] })
  await $.session.start({ cwd: 'C:/work' } as never)
  await spawn($)
  await clock.settle()
  expect(r.clips).toHaveLength(0)
  expect(String((await run($, 'test spawn')).text)).toContain('headless')
})

test('/sounds opens the pane after docking the workbench when it exists', ENGINE, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const r = rig(on, { commands: ['workbench'] })
  await $.session.start({ cwd: 'C:/work' } as never)
  await run($, '')
  expect(r.opens).toEqual(['workbench', 'sound-board'])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane on ${surface}: pick, test and mute`, ENGINE, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
      const r = rig(on)
    await $.session.start({ cwd: 'C:/work' } as never)
    const ui = await $.ui.mount({ plugin: 'sound-board', surface, component: 'Pane', requestId: 'sound-board', props: PROPS })
    expect(await ui.find({ key: 'pick-agent-spawn' })).toBeDefined()
    await ui.select({ key: 'pick-agent-spawn', value: 'builtin:bell' })
    expect(JSON.stringify(await r.store.get('mapping'))).toContain('builtin:bell')
    await ui.press({ key: 'mute' })
    expect(r.statuses[r.statuses.length - 1]).toBe('🔇 muted')
    await ui.press({ key: 'test-turn-done' })
    await clock.settle()
    expect(assets(r)).toEqual(['assets/sounds/turn-done.wav'])
    await ui.unmount()
  })
}

test('the pane on mobile cycles with a button instead of a select', ENGINE, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const r = rig(on, { surfaces: ['mobile'] })
  await $.session.start({ cwd: 'C:/work' } as never)
  const ui = await $.ui.mount({ plugin: 'sound-board', surface: 'mobile', component: 'Pane', requestId: 'sound-board', props: PROPS })
  expect(await ui.find({ key: 'cycle-agent-spawn' })).toBeDefined()
  expect(await ui.find({ key: 'pick-agent-spawn' })).toBeUndefined()
  await ui.press({ key: 'cycle-agent-spawn' })
  expect(JSON.stringify(await r.store.get('mapping'))).not.toContain('builtin:agent-spawn')
  await ui.unmount()
})

test('inside the workbench the board fills its own slot and leaves the rest of the frame', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  rig(on)
  on('ui.render', { component: 'Pane', requestId: 'workbench' }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row">
        <Box key="slot-usage-tracker" width={50}><Text>usage placeholder</Text></Box>
        <Box key="slot-sound-board" width={50}><Text>board placeholder</Text></Box>
      </Box>
    )
  })
  await $.session.start({ cwd: 'C:/work' } as never)
  const ui = await $.ui.mount({ plugin: 'sound-board', surface: 'terminal', component: 'Pane', requestId: 'workbench', props: { ...PROPS, title: 'Workbench', bodyColumns: 101 } })
  expect(await ui.find({ type: 'Text', text: /SOUND BOARD/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /board placeholder/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /usage placeholder/ })).toBeDefined()
})

test('an auto compaction and the end of a session each play their sound', ENGINE, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const r = rig(on)
  await $.session.start({ cwd: 'C:/work' } as never)
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'x', toolUses: [] }] } as never).catch(() => undefined)
  await clock.settle()
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's', resume: {} } as never).catch(() => undefined)
  await clock.settle()
  expect(assets(r)).toEqual(['assets/sounds/compact.wav', 'assets/sounds/session-end.wav'])
})
