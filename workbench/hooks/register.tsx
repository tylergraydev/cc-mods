import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { WorkbenchLayout, WorkbenchMember, WorkbenchSide } from '../types'
import { EMPTY_LAYOUT, USAGE, move, other, parseCommand, seat, show, sideOf, visible, widths } from './layout'

// The workbench draws the frame: the tab strip, the two columns and an empty
// Box keyed `slot-<pane id>` for each pane shown. Each hosted mod hooks this
// pane's ui.render above it, takes the frame from next(e) and fills its own
// slot, so its buttons and live state stay its own. A slot no mod fills keeps
// its placeholder, which says so.

const PANE = 'workbench'
const TITLE = 'Workbench'
const STORE_KEY = 'layout'
// Mods that fill a workbench slot; `/workbench host <pane>` adds another.
const SUPPORTED = ['agent-deck', 'usage-tracker', 'rail-runner', 'inbox', 'dev-doctor', 'mod-menu', 'sound-board', 'arcade', 'solution-explorer', 'diff-viewer']

const layout = atom({ plugin: 'workbench', key: 'layout' } as const, EMPTY_LAYOUT)
const members = atom({ plugin: 'workbench', key: 'members' } as const, [] as WorkbenchMember[])

type Message = { kind: 'show'; id: string } | { kind: 'move'; id: string; side: WorkbenchSide; index?: number }

function isMessage(data: unknown): data is Message {
  if (typeof data !== 'object' || data === null) return false
  const m = data as Record<string, unknown>
  if (typeof m.id !== 'string') return false
  if (m.kind === 'show') return true
  return m.kind === 'move' && (m.side === 'left' || m.side === 'right') && (m.index === undefined || typeof m.index === 'number')
}

const isHosted = (held: WorkbenchLayout, id: string) =>
  id !== PANE && !held.released.includes(id) && (SUPPORTED.includes(id) || held.hosted.includes(id))

async function setLayout($: EngineInterface, fn: (held: WorkbenchLayout) => WorkbenchLayout) {
  const next = await update($, layout, fn)
  await $.store.set(STORE_KEY, next)
  return next
}

/** Takes a pane into the workbench and opens the workbench in its place. */
async function host($: EngineInterface, id: string, title: string, focus: boolean) {
  const list = await update($, members, all =>
    all.some(one => one.id === id) ? all.map(one => (one.id === id ? { ...one, title } : one)) : [...all, { id, title }],
  )
  const after = await setLayout($, current => seat(current, id, list))
  const both = visible(after, list)
  return $.ui.open({
    id: PANE,
    title: TITLE,
    ...(focus ? { focus: true as const } : {}),
    ...(both.left.list.length > 0 && both.right.list.length > 0 ? { columns: 97 } : {}),
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'workbench',
      description: 'Split pane hosting other mods: drag a tab across the divider to move it',
      argumentHint: '[move <pane> left|right | split <20-80> | add <pane> | release <pane> | host <pane>]',
    })
    const stored = (await $.store.get(STORE_KEY)) as Partial<WorkbenchLayout> | undefined
    if (stored && typeof stored === 'object') {
      await update($, layout, () => ({ ...EMPTY_LAYOUT, ...stored, shown: { ...stored.shown } }))
    }
    return next(e)
  })

  // A hosted mod opening its pane lands here instead of as a tab of its own.
  on('ui.open', async ($, e, next) => {
    if (!isHosted(await read($, layout), e.id)) return next(e)
    return { value: await host($, e.id, e.title ?? e.id, e.focus === true) }
  })

  // A hosted mod closing its pane leaves the workbench; the last one out closes it.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE || !(await read($, members)).some(one => one.id === e.id)) return next(e)
    const rest = await update($, members, all => all.filter(one => one.id !== e.id))
    if (rest.length === 0) await $.ui.close({ id: PANE })
    return next(e)
  })

  on('command.run', { command: 'workbench' }, async ($, e) => {
    const cmd = parseCommand(e.args ?? '')
    const list = await read($, members)
    const names = () => list.map(one => one.id).join(', ') || 'none'
    switch (cmd.kind) {
      case 'error':
        return { text: cmd.text }
      case 'open': {
        await $.ui.open({ id: PANE, title: TITLE, focus: true })
        const held = await read($, layout)
        const where = list.map(one => `${one.id} (${sideOf(held, one.id) ?? '?'})`)
        return { text: where.length > 0 ? `Workbench: ${where.join(', ')}.` : `Workbench opened; mod panes land here as they open. ${USAGE}` }
      }
      case 'add':
        await host($, cmd.id, cmd.title ?? cmd.id, true)
        return { text: `${cmd.id} is in the workbench.` }
      case 'move':
        if (!list.some(one => one.id === cmd.id)) return { text: `No pane "${cmd.id}" in the workbench. In it: ${names()}.` }
        await setLayout($, held => move(held, cmd.id, cmd.side))
        return { text: `Moved ${cmd.id} to the ${cmd.side}.` }
      case 'split':
        await setLayout($, held => ({ ...held, split: cmd.percent }))
        return { text: `The left column takes ${cmd.percent}%.` }
      case 'release':
        await setLayout($, held => ({
          ...held,
          released: [...held.released.filter(id => id !== cmd.id), cmd.id],
          hosted: held.hosted.filter(id => id !== cmd.id),
        }))
        if ((await update($, members, all => all.filter(one => one.id !== cmd.id))).length === 0) await $.ui.close({ id: PANE })
        return { text: `${cmd.id} opens as its own tab from now on; run its command to reopen it.` }
      case 'host':
        await setLayout($, held => ({
          ...held,
          released: held.released.filter(id => id !== cmd.id),
          hosted: [...held.hosted.filter(id => id !== cmd.id), ...(SUPPORTED.includes(cmd.id) ? [] : [cmd.id])],
        }))
        return { text: `${cmd.id} goes in the workbench the next time it opens.` }
    }
  })

  on('ui.message', { requestId: PANE }, async ($, e) => {
    if (!isMessage(e.data)) return {}
    const msg = e.data
    if (msg.kind === 'show') await setLayout($, held => show(held, msg.id))
    else await setLayout($, held => move(held, msg.id, msg.side, msg.index))
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const held = await read($, layout)
    const list = await read($, members)
    const both = visible(held, list)
    const total = e.props.bodyColumns || e.viewport?.columns || 80
    const w = widths(total, held.split, both.left.list.length > 0, both.right.list.length > 0)
    const rows = Math.max(3, e.props.scroll.bodyRows - 2)

    if (list.length === 0) {
      return <Text dimColor>No mod panes here yet. Open one (/deck, /usage-tracker, /rail-runner, /dev-doctor, /mod-menu, /sounds) and it lands here.</Text>
    }

    const tabs = (side: WorkbenchSide) =>
      both[side].list.map(one => ({ id: one.id, title: one.title, shown: one.id === both[side].shown?.id }))

    // The strip: a pointer-driven Client on the terminal, buttons elsewhere.
    const strip = (() => {
      if (e.surface === 'terminal') {
        const { Client } = $.ui.resolve(e)
        return (
          <Client
            key="tabs"
            module="./tabs.tsx"
            width={total}
            height={1}
            props={{ width: total, divider: w.divider, left: tabs('left'), right: tabs('right') }}
          />
        )
      }
      return (
        <Box key="tabs" flexDirection="row">
          {(['left', 'right'] as const).flatMap(side =>
            tabs(side).map(tab => (
              <Button key={`tab-${tab.id}`} variant={tab.shown ? 'primary' : 'secondary'} onPress={() => void setLayout($, h => show(h, tab.id))}>
                {`${side === 'left' ? '◧' : '◨'} ${tab.title}`}
              </Button>
            )),
          )}
        </Box>
      )
    })()

    const column = (side: WorkbenchSide, columns: number) => {
      const shown = both[side].shown
      if (!shown || columns <= 0) return null
      const to = other(side)
      return (
        <Box key={`col-${side}`} flexDirection="column" width={columns}>
          <Button key={`move-${shown.id}`} plain dimColor onPress={() => void setLayout($, h => move(h, shown.id, to))}>
            {side === 'left' ? `move ${shown.title} ⇢` : `⇠ move ${shown.title}`}
          </Button>
          <Box key={`slot-${shown.id}`} flexDirection="column" width={columns}>
            <Text dimColor>
              {shown.title}: its mod has not drawn here. Is it loaded, and listed before workbench in CLAUDE_CODE_PLUGIN_DIRS?
            </Text>
          </Box>
        </Box>
      )
    }

    const left = column('left', w.left)
    const right = column('right', w.right)

    return (
      <Box flexDirection="column">
        {strip}
        <Box key="columns" flexDirection="row">
          {left}
          {left && right && (
            <Box key="rule" width={1} flexDirection="column">
              {Array.from({ length: rows }, (_, i) => (
                <Text key={`r${i}`} dimColor>
                  │
                </Text>
              ))}
            </Box>
          )}
          {right}
        </Box>
      </Box>
    )
  })
}
