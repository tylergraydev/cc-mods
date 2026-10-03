import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { backCells, cellsArgv } from '../hooks/art'

const PROPS = { title: 'Booster', isFocused: true, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

type Sandbox = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]
type Reply = { status: number; text: string }

const SET = { id: 'base1', name: 'Base', series: 'Base', printedTotal: 102, total: 102, releaseDate: '1999/01/09' }
const RARITIES = ['Common', 'Common', 'Common', 'Common', 'Common', 'Common', 'Uncommon', 'Uncommon', 'Uncommon', 'Rare', 'Rare', 'Rare Holo']
const row = (i: number) => ({
  id: `base1-${i}`, name: `Testmon ${i}`, number: String(i), rarity: RARITIES[i % RARITIES.length], supertype: 'Pokémon',
  images: { small: `https://images.pokemontcg.io/base1/${i}.png` },
})
const CELLS = new Uint8Array(Uint32Array.from({ length: 36 * 25 * 3 }, (_, i) => (i % 3 === 0 ? 0x2588 : 0x203040)).buffer) as Uint8Array & { toBase64(): string }

/** The engine beneath the mod, answering from memory and recording what the mod did. */
function world($: Sandbox, on: On) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-03T14:05:00Z') })
  mock.store(on)
  const files = new Map<string, string>()
  const w = {
    clock,
    files,
    opened: [] as string[],
    toasts: [] as string[],
    logs: [] as string[],
    commands: [] as string[],
    http: [] as { url: string; headers: Record<string, string>; method: string; body: string }[],
    runs: [] as string[][],
    hasBench: true,
    python: 'ok' as 'ok' | 'fail',
    answer: (url: string): Reply => {
      if (url.startsWith('https://api.pokemontcg.io/v2/sets')) return { status: 200, text: JSON.stringify({ data: [SET] }) }
      if (url.includes('/v2/cards?')) {
        const page = Number(/page=(\d+)/.exec(url)?.[1] ?? '1')
        return { status: 200, text: JSON.stringify({ totalCount: 12, data: Array.from({ length: 12 }, (_, i) => row(i + 1)), page }) }
      }
      return { status: 404, text: '' }
    },
  }
  // the engine hands the hooks absolute paths; key the files from run/ on
  const norm = (p: string) => {
    const slashed = p.split('\\').join('/')
    const at = slashed.indexOf('run/')
    return at >= 0 ? slashed.slice(at) : slashed
  }
  w.files = files
  on('command.register', async (_, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('command.list', async () => ({ value: (w.hasBench ? [{ name: 'workbench', description: '', source: 'plugin' }] : []) as never }))
  on('ui.open', async (_, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.toast', async (_, e) => {
    w.toasts.push(String((e as { text?: unknown }).text))
    return { value: undefined }
  })
  on('ui.log', async (_, e) => {
    w.logs.push(String((e as { text?: unknown }).text))
    return { value: undefined }
  })
  on('fs.exists', async (_, e) => ({ value: files.has(norm(e.path)) }))
  on('fs.read', async (_, e) => (files.has(norm(e.path)) ? { value: files.get(norm(e.path)) as string } : { deny: 'ENOENT' }))
  on('fs.write', async (_, e) => {
    files.set(norm(e.path), e.text)
    return { value: undefined }
  })
  on('http.fetch', async (_, e) => {
    const init = (e.init ?? {}) as { headers?: Record<string, string>; method?: string; body?: string }
    w.http.push({ url: e.url, headers: init.headers ?? {}, method: init.method ?? 'GET', body: init.body ?? '' })
    const r = w.answer(e.url)
    return { value: { status: r.status, ok: r.status >= 200 && r.status < 300, headers: {}, text: r.text } }
  })
  on('process.run', async (_, e) => {
    w.runs.push([...e.argv])
    const failed = w.python === 'fail'
    if (!failed && e.argv.includes('--png')) {
      const out = e.argv[e.argv.length - 1] as string
      files.set(norm(out), JSON.stringify({ v: 1, cols: 36, rows: 25, mode: 'card', cells: CELLS.toBase64() }))
    }
    return { value: { exitCode: failed ? 1 : 0, stdout: failed ? '' : '{"ok":true}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.run', async () => ({ text: 'bottom' }))
  on('tool.call', async () => ({ result: {} as never, text: 'ok' }))
  on('session.start', async (_, e) => ({ cwd: e.cwd }))
  on('session.end', async () => ({ sessionId: 's1' }))

  const drain = async () => {
    for (let i = 0; i < 12; i++) await clock.settle()
  }
  const run = (args: string, name = 'booster') => $.command.run({ command: name, args } as Parameters<typeof $.command.run>[0])
  const mount = (surface: 'terminal' | 'desktop', props: object = PROPS) =>
    $.ui.mount({ plugin: 'booster-pane', surface, component: 'Pane', requestId: 'booster-pane', props: props as never } as never)
  return Object.assign(w, { drain, run, mount, norm })
}

const OPTIONS = { options: { apiKey: 'test-key', source: 'pokemontcg' } }

/** `set base1` then `open`, the engine drained. */
async function openedPack(t: ReturnType<typeof world>) {
  await t.run('set base1')
  await t.drain()
  const opened = await t.run('open')
  await t.drain()
  return opened
}

test('/booster opens the workbench dock and then its own pane', async ($, on) => {
  const t = world($, on)
  await $.session.start({ cwd: 'C:/repo', surface: 'terminal', isInteractive: true } as never)
  expect(t.commands).toEqual(['booster'])
  expect(t.opened).toEqual([])
  const r = await t.run('')
  expect(String(r.text)).toContain('Booster is open')
  expect(t.opened).toEqual(['workbench', 'booster-pane'])
  const other = await t.run('bogus')
  expect(String(other.text)).toContain('Unknown booster command')
})

test('set base1 fetches the cards with the key header and caches them whole', { ...OPTIONS }, async ($, on) => {
  const t = world($, on)
  const r = await t.run('set base1')
  expect(String(r.text)).toContain('set list')
  await t.drain()
  const cards = t.http.find(h => h.url.includes('/v2/cards?'))
  expect(cards?.url).toBe('https://api.pokemontcg.io/v2/cards?q=set.id:base1&pageSize=250&page=1&select=id,name,number,rarity,supertype,subtypes,images')
  expect(cards?.headers['X-Api-Key']).toBe('test-key')
  const cached = JSON.parse(t.files.get('run/cache/sets/base1.json') ?? '{}')
  expect(cached.cards).toHaveLength(12)
  expect(cached.source).toBe('pokemontcg')
  expect(t.files.has('run/cache/catalog.json')).toBe(true)
})

test('with no key there is no key header', { options: { apiKey: '', source: 'pokemontcg' } }, async ($, on) => {
  const t = world($, on)
  await t.run('set base1')
  await t.drain()
  expect(t.http.length).toBeGreaterThan(1)
  expect(t.http.every(h => !('X-Api-Key' in h.headers))).toBe(true)
})

test('a set of 260 cards is fetched in two pages', { ...OPTIONS }, async ($, on) => {
  const t = world($, on)
  t.answer = url => {
    if (url.startsWith('https://api.pokemontcg.io/v2/sets')) return { status: 200, text: JSON.stringify({ data: [{ ...SET, total: 260, printedTotal: 260 }] }) }
    const page = Number(/page=(\d+)/.exec(url)?.[1] ?? '1')
    const rows = Array.from({ length: page === 1 ? 250 : 10 }, (_, i) => row(page === 1 ? i + 1 : 250 + i + 1))
    return { status: 200, text: JSON.stringify({ totalCount: 260, data: rows }) }
  }
  await t.run('set base1')
  await t.drain()
  expect(t.http.filter(h => h.url.includes('/v2/cards?')).map(h => /page=\d+/.exec(h.url)?.[0])).toEqual(['page=1', 'page=2'])
  expect(JSON.parse(t.files.get('run/cache/sets/base1.json') ?? '{}').cards).toHaveLength(260)
})

test('open builds a pack, records it in the collection and shows the card back', { ...OPTIONS }, async ($, on) => {
  const t = world($, on)
  const opened = await openedPack(t)
  expect(String(opened.text)).toContain('Opened a Base pack (11 cards)')
  expect(JSON.parse(t.files.get('run/collection.json') ?? '{}').packs.base1).toBe(1)
  const ui = await t.mount('terminal')
  expect((await ui.find({ key: 'head' }))?.text).toContain('card 0/11')
  const raster = await ui.find({ key: 'booster-card' })
  expect(raster?.type).toBe('Raster')
  expect(raster?.props.columns).toBe(36)
  expect(raster?.props.rows).toBe(25)
  expect(raster?.props.cells).toBe(backCells(36, 25))
  await ui.unmount()
})

test('flipping a card draws its art from the helper', { ...OPTIONS }, async ($, on) => {
  const t = world($, on)
  await openedPack(t)
  const ui = await t.mount('terminal')
  await t.drain()
  await ui.press({ key: 'flip' })
  await t.drain()
  expect((await ui.find({ key: 'head' }))?.text).toContain('card 1/11')
  const first = t.runs[0] as string[]
  const root = (first[1] as string).slice(0, -'/scripts/card_cells.py'.length)
  const url = first[2] as string
  const id = /base1\/(\d+)\.png$/.exec(url)?.[1]
  expect(first).toEqual(cellsArgv('python', root, url, 36, 25, 'card', `base1-${id}`))
  expect(t.runs.every(a => a[0] === 'python' && a[3] === '36' && a[4] === '25' && a[6] === 'card')).toBe(true)
  const raster = await ui.find({ key: 'booster-card' })
  expect(raster?.props.columns).toBe(36)
  expect(raster?.props.cells).toBe(CELLS.toBase64())
  await ui.unmount()
})

test('other surfaces draw a framed text card and run no helper', { ...OPTIONS }, async ($, on) => {
  const t = world($, on)
  await openedPack(t)
  const ui = await t.mount('desktop')
  await t.drain()
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  await ui.press({ key: 'flip' })
  await t.drain()
  const card = await ui.find({ key: 'card' })
  expect(card?.type).toBe('Box')
  expect(card?.props.borderStyle).toBe('round')
  expect(card?.text).toContain('Testmon')
  expect(t.runs).toHaveLength(0)
  await ui.unmount()
})

test('commands and tool calls for others pass through to what is beneath', async ($, on) => {
  const t = world($, on)
  const r = await t.run('', 'other')
  expect(String(r.text)).toBe('bottom')
  const call = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect((call as { text?: string }).text).toBe('ok')
  expect(t.opened).toEqual([])
})

test('a failing source gives one note after three tries and at most one toast', { options: { source: 'tcgdex' } }, async ($, on) => {
  const t = world($, on)
  t.answer = () => ({ status: 500, text: '' })
  await t.run('set base1')
  await t.drain()
  await t.clock.advance(1000)
  await t.drain()
  await t.clock.advance(3000)
  await t.drain()
  expect(t.http).toHaveLength(3)
  expect(t.http.every(h => h.url === 'https://api.tcgdex.net/v2/graphql' && h.method === 'POST')).toBe(true)
  expect(t.toasts.length).toBeLessThanOrEqual(1)
  const ui = await t.mount('terminal')
  expect((await ui.find({ key: 'note' }))?.text).toContain('did not answer')
  await ui.unmount()
})

test('auto mode asks TCGdex first and falls back to pokemontcg.io', async ($, on) => {
  const t = world($, on)
  const base = t.answer
  t.answer = url => (url.includes('tcgdex.net') ? { status: 502, text: '' } : base(url))
  await t.run('set base1')
  for (let i = 0; i < 4; i++) {
    await t.clock.advance(3000)
    await t.drain()
  }
  expect(t.http[0]?.url).toBe('https://api.tcgdex.net/v2/graphql')
  expect(t.http.some(h => h.url.startsWith('https://api.pokemontcg.io/v2/sets'))).toBe(true)
  expect(t.files.has('run/cache/catalog.json')).toBe(true)
  expect(JSON.parse(t.files.get('run/cache/catalog.json') ?? '{}').source).toBe('pokemontcg')
})

test('a failing helper leaves text cards and one note', { ...OPTIONS }, async ($, on) => {
  const t = world($, on)
  t.python = 'fail'
  await openedPack(t)
  const ui = await t.mount('terminal')
  await t.drain()
  await ui.press({ key: 'flip' })
  await t.drain()
  expect((await ui.find({ key: 'note' }))?.text).toContain('Card art failed')
  expect((await ui.find({ key: 'card' }))?.type).toBe('Box')
  expect(await ui.find({ key: 'booster-card' })).toBeUndefined()
  await ui.press({ key: 'flip' })
  await t.drain()
  expect(await ui.findAll({ key: 'note' })).toHaveLength(1)
  await ui.unmount()
})

test('the API key goes only into the request header', { options: { apiKey: 'secret-key-123', source: 'pokemontcg' } }, async ($, on) => {
  const t = world($, on)
  await openedPack(t)
  const ui = await t.mount('terminal')
  await t.drain()
  await ui.press({ key: 'flip' })
  await ui.press({ key: 'flip-all' })
  await t.drain()
  await t.run('stats')
  await t.run('collection base1')
  await ui.unmount()
  const secret = 'secret-key-123'
  expect(t.http.some(h => h.headers['X-Api-Key'] === secret)).toBe(true)
  expect(t.http.every(h => !h.url.includes(secret) && !h.body.includes(secret))).toBe(true)
  for (const [path, text] of t.files) {
    expect(path.includes(secret)).toBe(false)
    expect(text.includes(secret)).toBe(false)
  }
  expect(t.toasts.join('\n').includes(secret)).toBe(false)
  expect(t.logs.join('\n').includes(secret)).toBe(false)
  expect(t.runs.flat().join('\n').includes(secret)).toBe(false)
  expect(t.commands.join('\n').includes(secret)).toBe(false)
})

test('stats, collection and clear-cache answer in text', { ...OPTIONS }, async ($, on) => {
  const t = world($, on)
  await openedPack(t)
  const stats = String((await t.run('stats')).text)
  expect(stats).toContain('Packs opened: 1 (Base 1)')
  expect(stats).toContain('Cards pulled: 11')
  const coll = String((await t.run('collection base1')).text)
  expect(coll).toContain('Base:')
  const cleared = String((await t.run('clear-cache')).text)
  expect(cleared).toContain('Cleared the image and card-list cache')
  expect(t.runs[t.runs.length - 1]?.[2]).toBe('--clear-cache')
  expect(t.runs[t.runs.length - 1]?.[3]?.endsWith('run/cache') || t.runs[t.runs.length - 1]?.[3]?.endsWith('run\\cache')).toBe(true)
})
