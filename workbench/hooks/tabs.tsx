import type { ClientModule, ClientPointerEvent } from 'claude-code'

// The tab strip across the top of the workbench: a click shows a tab, a drag
// across the divider moves that pane to the other column. Runs on the drawing
// thread; it reaches the hooks module by `post` alone.

type Tab = { id: string; title: string; shown: boolean }
type Side = 'left' | 'right'
export type StripProps = { width: number; divider: number; left: Tab[]; right: Tab[] }
type Drag = { id: string; from: Side; startX: number; x: number; isMoving: boolean }
type StripState = { drag?: Drag }
type Placed = Tab & { side: Side; x: number; w: number; label: string }

const fit = (title: string, room: number) =>
  title.length <= room ? title : room <= 1 ? title.slice(0, Math.max(0, room)) : `${title.slice(0, room - 1)}…`

function place(tabs: Tab[], side: Side, start: number, room: number): Placed[] {
  const each = Math.max(3, Math.floor(room / Math.max(1, tabs.length)) - 2)
  let x = start
  return tabs.map(tab => {
    const label = ` ${fit(tab.title, each)} `
    const placed = { ...tab, side, x, w: label.length, label }
    x += label.length
    return placed
  })
}

export function placeAll(p: StripProps): Placed[] {
  return [...place(p.left, 'left', 0, p.divider), ...place(p.right, 'right', p.divider + 1, p.width - p.divider - 1)]
}

const sideAt = (p: StripProps, x: number): Side => (x <= p.divider ? 'left' : 'right')

/** Where a tab dropped at `x` lands: its side and the index among that side's other tabs. */
export function dropAt(p: StripProps, id: string, x: number) {
  const side = sideAt(p, x)
  const others = placeAll(p).filter(one => one.side === side && one.id !== id)
  return { side, index: others.filter(one => one.x + one.w / 2 <= x).length }
}

const TabStrip: ClientModule<StripProps, StripState> = (p, surface) => {
  const { Box, Text } = surface.elements
  const placed = placeAll(p)
  const drag = surface.state?.drag

  surface.onPointer((ev: ClientPointerEvent) => {
    const held = surface.state?.drag
    if (ev.type === 'down' && ev.button === 'left') {
      const hit = placed.find(one => ev.y === 0 && ev.x >= one.x && ev.x < one.x + one.w)
      if (hit) surface.setState({ drag: { id: hit.id, from: hit.side, startX: ev.x, x: ev.x, isMoving: false } })
      return
    }
    if (!held) return
    if (ev.type === 'move' && ev.button === 'left' && ev.x !== held.x) {
      surface.setState({ drag: { ...held, x: ev.x, isMoving: held.isMoving || Math.abs(ev.x - held.startX) >= 2 } })
      return
    }
    if (ev.type === 'up') {
      surface.setState({})
      if (!held.isMoving) return surface.post({ kind: 'show', id: held.id })
      const to = dropAt(p, held.id, ev.x)
      surface.post({ kind: 'move', id: held.id, side: to.side, index: to.index })
    }
  })

  const target = drag?.isMoving ? sideAt(p, drag.x) : undefined
  const region = (side: Side, start: number, end: number) => {
    const tabs = placed.filter(one => one.side === side)
    const used = tabs.reduce((sum, one) => sum + one.w, 0)
    const room = Math.max(0, end - start - used)
    const isTarget = target === side && drag?.from !== side
    const filler = isTarget ? fit(tabs.length === 0 ? ' drop here' : ' ⇢ drop', room).padEnd(room) : ' '.repeat(room)
    return [
      ...tabs.map(one => (
        <Text
          key={`t-${one.id}`}
          wrap="truncate"
          inverse={one.shown || drag?.id === one.id}
          bold={one.shown}
          dimColor={drag?.isMoving === true && drag.id === one.id}
          color={drag?.id === one.id ? 'yellow' : undefined}
        >
          {one.label}
        </Text>
      )),
      <Text key={`f-${side}`} color={isTarget ? 'yellow' : undefined} dimColor={!isTarget} wrap="truncate">
        {tabs.length === 0 && !isTarget ? fit(' drop here', room).padEnd(room) : filler}
      </Text>,
    ]
  }

  return (
    <Box flexDirection="row" width={p.width}>
      {region('left', 0, p.divider)}
      <Text key="divider" color={target ? 'yellow' : undefined} dimColor={!target}>
        │
      </Text>
      {region('right', p.divider + 1, p.width)}
    </Box>
  )
}

export default TabStrip
