import { expect, mock, test } from 'claude-code/testing'
import type { Plugin, TestBody } from 'claude-code/testing'

const PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} } as const

type Sandbox = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

/** Stand-ins for other mods. `/fake-a text` pins `text` as fake-a's status (`-` clears it); `toast:hi` raises a toast. Each register is self-contained. */
const fakeA: Plugin = {
  name: 'fake-a',
  register(on) {
    on('command.run', { command: 'fake-a' }, async ($, e) => {
      const args = (e as { args?: string }).args ?? ''
      if (args.startsWith('toast:')) await $.ui.toast(args.slice(6))
      else await $.ui.status(args === '-' ? undefined : args)
      return { text: '' }
    })
  },
}
const fakeP: Plugin = {
  name: 'fake-p',
  tier: 'prepend',
  register(on) {
    on('command.run', { command: 'fake-p' }, async ($, e) => {
      const args = (e as { args?: string }).args ?? ''
      await $.ui.status(args === '-' ? undefined : args)
      return { text: '' }
    })
  },
}
const fakeX: Plugin = {
  name: 'fake-x',
  tier: 'append',
  register(on) {
    on('command.run', { command: 'fake-x' }, async ($, e) => {
      const args = (e as { args?: string }).args ?? ''
      await $.ui.status(args === '-' ? undefined : args)
      return { text: '' }
    })
  },
}
/** Another mod's band: answers AbovePrompt without `next`. */
const fakeBand: Plugin = {
  name: 'fake-band',
  tier: 'append',
  register(on) {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box key="other-band">
          <Text key="t">x</Text>
        </Box>
      )
    })
  },
}

/** The engine beneath the mod: records what reaches the bottom, which is what the screen would show. */
function world($: Sandbox, on: On) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-03T14:05:00Z') })
  mock.store(on)
  const w = {
    clock,
    /** Every ui.status that got through, with the plugin that raised it. */
    statuses: [] as { plugin: string; text: string | undefined }[],
    toasts: [] as string[],
    registered: [] as string[],
    refuse: '',
  }
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('session.end', async () => ({ sessionId: 's1' }))
  on('command.register', async (_, e) => {
    if (e.name === w.refuse) throw new Error('name taken')
    w.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.toast', async (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async (_, e, next) => {
    w.statuses.push({ plugin: next.origin.plugin, text: e.text })
    return { value: undefined }
  })
  on('ui.render', async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })

  const start = () => $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true })
  /** A fake plugin pins `text`, then the debounce window passes. */
  const say = async (plugin: string, text: string) => {
    await $.command.run({ command: plugin, args: text } as never)
    await clock.advance(200)
  }
  const cmd = async (args: string, name = 'statusbar') =>
    ((await $.command.run({ command: name, args } as never)) as { text: string }).text
  const pins = () => w.statuses.filter(s => s.plugin === 'status-bar').map(s => s.text)
  const from = (plugin: string) => w.statuses.filter(s => s.plugin === plugin)
  const mount = (surface: 'terminal' | 'desktop', props: object = PROPS, columns = 120) =>
    $.ui.mount({
      plugin: 'status-bar',
      surface,
      component: 'AbovePrompt',
      props: props as never,
      viewport: { columns, rows: 30 },
    } as never)
  return Object.assign(w, { start, say, cmd, pins, from, mount })
}

const CLAIMS = 'claims: 1 unverified'

test('E1 swallow: another mod\'s status never reaches the engine, its line is cleared', { plugins: [fakeA] }, async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.say('fake-a', CLAIMS)
  expect(t.statuses.some(s => s.text === CLAIMS)).toBe(false)
  expect(t.from('fake-a')).toEqual([{ plugin: 'fake-a', text: undefined }])
})

test('E2 own line passes: the combined line is pinned under our own name', { plugins: [fakeA] }, async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.say('fake-a', CLAIMS)
  expect(t.statuses[t.statuses.length - 1]).toEqual({ plugin: 'status-bar', text: `fake-a: ${CLAIMS}` })
})

test('E3 position: calls from the prepend, user and append tiers are all collected and none leaks', { plugins: [fakeP, fakeA, fakeX] }, async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.say('fake-p', 'p text')
  await t.say('fake-a', 'u text')
  await t.say('fake-x', 'x text')
  for (const name of ['fake-p', 'fake-a', 'fake-x']) {
    expect(t.from(name).every(s => s.text === undefined)).toBe(true)
    expect(t.from(name)).toHaveLength(1)
  }
  const last = t.pins()[t.pins().length - 1]
  expect(last).toBe('fake-a: u text │ fake-p: p text │ fake-x: x text')
})

test('E4 clear: a cleared status leaves the line, the last one pins undefined', { plugins: [fakeA, fakeX] }, async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.say('fake-a', 'one')
  await t.say('fake-x', 'two')
  expect(t.pins()[t.pins().length - 1]).toBe('fake-a: one │ fake-x: two')
  await t.say('fake-a', '-')
  expect(t.pins()[t.pins().length - 1]).toBe('fake-x: two')
  await t.say('fake-x', '-')
  expect(t.pins()[t.pins().length - 1]).toBeUndefined()
})

test('E5 debounce: ten updates 100 ms apart pin a handful of times, the last text wins, repeats pin nothing', { plugins: [fakeA] }, async ($, on) => {
  const t = world($, on)
  await t.start()
  const before = t.pins().length
  for (let i = 0; i < 10; i += 1) {
    await $.command.run({ command: 'fake-a', args: `tick ${i}` } as never)
    await t.clock.advance(100)
  }
  await t.clock.advance(200)
  const pinned = t.pins().slice(before)
  expect(pinned.length).toBeGreaterThan(0)
  expect(pinned.length).toBeLessThanOrEqual(7)
  expect(pinned[pinned.length - 1]).toBe('fake-a: tick 9')
  const count = t.pins().length
  await t.say('fake-a', 'tick 9')
  await t.say('fake-a', 'tick 9')
  expect(t.pins()).toHaveLength(count)
})

test('E6 off and on: off clears the line and lets statuses through, on takes over again, the choice is stored', { plugins: [fakeA] }, async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.say('fake-a', 'first')
  expect(t.pins()[t.pins().length - 1]).toBe('fake-a: first')
  expect(await t.cmd('off')).toMatch(/off/)
  expect(t.pins()[t.pins().length - 1]).toBeUndefined()
  await t.say('fake-a', 'second')
  expect(t.from('fake-a')[t.from('fake-a').length - 1]).toEqual({ plugin: 'fake-a', text: 'second' })
  // The choice is in the store: a fresh session.start reads it back.
  await t.start()
  expect(await t.cmd('')).toMatch(/^status-bar: off/)
  expect(await t.cmd('on')).toMatch(/on/)
  await t.say('fake-a', 'third')
  expect(t.from('fake-a')[t.from('fake-a').length - 1]).toEqual({ plugin: 'fake-a', text: undefined })
  expect(t.pins()[t.pins().length - 1]).toBe('fake-a: third')
})

test('E7 hide and show: a hidden mod is cleared and not in the line, show brings it back', { plugins: [fakeA, fakeX] }, async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.say('fake-a', 'aaa')
  await t.say('fake-x', 'xxx')
  await t.cmd('hide fake-a')
  expect(t.pins()[t.pins().length - 1]).toBe('fake-x: xxx')
  await t.say('fake-a', 'bbb')
  expect(t.from('fake-a').every(s => s.text === undefined)).toBe(true)
  expect(t.pins()[t.pins().length - 1]).toBe('fake-x: xxx')
  expect(await t.cmd('')).toMatch(/hidden: fake-a/)
  await t.cmd('show fake-a')
  expect(t.pins()[t.pins().length - 1]).toBe('fake-a: bbb │ fake-x: xxx')
})

test('E8 reload stand-in: session.start pins the same combined line from the kept state', { plugins: [fakeA, fakeX] }, async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.say('fake-a', 'aaa')
  await t.say('fake-x', 'xxx')
  const line = t.pins()[t.pins().length - 1]
  const count = t.pins().length
  await t.start()
  expect(t.pins()).toHaveLength(count + 1)
  expect(t.pins()[t.pins().length - 1]).toBe(line)
})

// The test's own `$` has no ui.status (it is a plugin's call), so the engine-origin pass-through is not testable here.
test('E9 pass-through: other calls from a mod are untouched', { plugins: [fakeA] }, async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.say('fake-a', 'toast:hi')
  expect(t.toasts).toEqual(['hi'])
  expect(t.statuses.every(s => s.plugin !== 'fake-a')).toBe(true)
})

test('E10 band: one wrapped row of segments, clipped to the width, nothing pinned', { plugins: [fakeA, fakeP, fakeX], options: { mode: 'band' } }, async ($, on) => {
  const t = world($, on)
  await t.start()
  const long = 'a status text that is much longer than the room the band has for it ok'
  await t.say('fake-a', long)
  await t.say('fake-p', 'p text')
  await t.say('fake-x', 'x text')
  expect(t.pins().every(p => p === undefined)).toBe(true)
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const bodyColumns of [40, 120]) {
      const ui = await t.mount(surface, { ...PROPS, bodyColumns }, bodyColumns)
      expect(await ui.find({ key: 'status-bar' })).toBeDefined()
      const a = (await ui.find({ key: 'seg-fake-a' }))?.text ?? ''
      expect(a).toMatch(/fake-a: /)
      expect((await ui.find({ key: 'seg-fake-p' }))?.text).toMatch(/p text/)
      expect((await ui.find({ key: 'seg-fake-x' }))?.text).toMatch(/x text/)
      if (bodyColumns === 40) {
        expect(a).toMatch(/…/)
        expect(a.length).toBeLessThanOrEqual(40)
      }
      await ui.unmount()
    }
    const quiet = await t.mount(surface, { ...PROPS, hasSurvey: true })
    expect(await quiet.find({ key: 'status-bar' })).toBeUndefined()
    await quiet.unmount()
  }
})

test('E10b band: no statuses, no row', { options: { mode: 'band' } }, async ($, on) => {
  const t = world($, on)
  await t.start()
  const ui = await t.mount('terminal')
  expect(await ui.find({ key: 'status-bar' })).toBeUndefined()
  await ui.unmount()
})

test('E11 band stacking: our row and another mod\'s band both draw', { plugins: [fakeA, fakeBand], options: { mode: 'band' } }, async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.say('fake-a', CLAIMS)
  const ui = await t.mount('terminal')
  expect(await ui.find({ key: 'status-bar' })).toBeDefined()
  expect(await ui.find({ key: 'status-bar-stack' })).toBeDefined()
  expect(await ui.find({ key: 'other-band' })).toBeDefined()
  await ui.unmount()
})

test('E12 mode switch: band clears the pinned line, status pins it again', { plugins: [fakeA] }, async ($, on) => {
  const t = world($, on)
  await t.start()
  await t.say('fake-a', CLAIMS)
  expect(await t.cmd('mode band')).toMatch(/band/)
  expect(t.pins()[t.pins().length - 1]).toBeUndefined()
  const ui = await t.mount('terminal')
  expect(await ui.find({ key: 'seg-fake-a' })).toBeDefined()
  await ui.unmount()
  await t.cmd('mode status')
  expect(t.pins()[t.pins().length - 1]).toBe(`fake-a: ${CLAIMS}`)
})

test('E13 command output, and /status-bar when /statusbar is refused', { plugins: [fakeA] }, async ($, on) => {
  const t = world($, on)
  t.refuse = 'statusbar'
  await t.start()
  expect(t.registered).toEqual(['status-bar'])
  await t.say('fake-a', CLAIMS)
  const text = await t.cmd('', 'status-bar')
  expect(text).toMatch(/^status-bar: on · mode status · 1 status/)
  expect(text).toContain(`  fake-a → fake-a: ${CLAIMS}`)
  expect(await t.cmd('frob', 'status-bar')).toMatch(/^usage:/)
})
