import type { WorkbenchLayout, WorkbenchMember, WorkbenchSide } from '../types'

export const EMPTY_LAYOUT: WorkbenchLayout = { left: [], right: [], shown: {}, split: 50, released: [], hosted: [] }

/** Columns the strip keeps for the empty side, so there is somewhere to drop a tab. */
export const DROP_ZONE = 12

const MIN_COLUMN = 16

export const other = (side: WorkbenchSide): WorkbenchSide => (side === 'left' ? 'right' : 'left')

export const sideOf = (layout: WorkbenchLayout, id: string): WorkbenchSide | undefined =>
  layout.left.includes(id) ? 'left' : layout.right.includes(id) ? 'right' : undefined

/** The members on each side, in the side's order, and the one each side shows. */
export function visible(layout: WorkbenchLayout, members: WorkbenchMember[]) {
  const pick = (side: WorkbenchSide) => {
    const list = layout[side].flatMap(id => members.filter(one => one.id === id))
    const shown = list.find(one => one.id === layout.shown[side]) ?? list[0]
    return { list, shown }
  }
  return { left: pick('left'), right: pick('right') }
}

/**
 * Seats a pane id that has just opened: where it sat before, else on the side
 * with fewer open members (left on a tie). The side shows it.
 */
export function seat(layout: WorkbenchLayout, id: string, members: WorkbenchMember[]): WorkbenchLayout {
  const known = sideOf(layout, id)
  if (known) return { ...layout, shown: { ...layout.shown, [known]: id } }
  const open = (side: WorkbenchSide) => layout[side].filter(one => members.some(m => m.id === one)).length
  const side: WorkbenchSide = open('right') < open('left') ? 'right' : 'left'
  return { ...layout, [side]: [...layout[side], id], shown: { ...layout.shown, [side]: id } }
}

/** Moves a pane to `side` at `index` (the end when absent); its new side shows it. */
export function move(layout: WorkbenchLayout, id: string, side: WorkbenchSide, index?: number): WorkbenchLayout {
  const from = sideOf(layout, id)
  const left = layout.left.filter(one => one !== id)
  const right = layout.right.filter(one => one !== id)
  const target = side === 'left' ? left : right
  const at = index === undefined ? target.length : Math.max(0, Math.min(target.length, index))
  target.splice(at, 0, id)
  const shown = { ...layout.shown, [side]: id }
  if (from && from !== side && shown[from] === id) shown[from] = (from === 'left' ? left : right)[0]
  return { ...layout, left, right, shown }
}

export function show(layout: WorkbenchLayout, id: string): WorkbenchLayout {
  const side = sideOf(layout, id)
  return side ? { ...layout, shown: { ...layout.shown, [side]: id } } : layout
}

/** How the pane's width divides: the two bodies, and the strip's divider column. */
export function widths(total: number, split: number, hasLeft: boolean, hasRight: boolean) {
  const all = Math.max(1, total)
  if (hasLeft && hasRight) {
    const wanted = Math.round(((all - 1) * split) / 100)
    const left = Math.max(Math.min(MIN_COLUMN, all - 1), Math.min(all - 1 - Math.min(MIN_COLUMN, all - 1), wanted))
    return { left, right: all - 1 - left, divider: left }
  }
  if (hasLeft) return { left: all, right: 0, divider: Math.max(0, all - DROP_ZONE - 1) }
  if (hasRight) return { left: 0, right: all, divider: Math.min(all - 1, DROP_ZONE) }
  return { left: 0, right: 0, divider: Math.floor(all / 2) }
}

export type WorkbenchCommand =
  | { kind: 'open' }
  | { kind: 'move'; id: string; side: WorkbenchSide }
  | { kind: 'split'; percent: number }
  | { kind: 'add'; id: string; title?: string }
  | { kind: 'release'; id: string }
  | { kind: 'host'; id: string }
  | { kind: 'error'; text: string }

export const USAGE =
  'Usage: /workbench [move <pane> left|right | split <20-80> | add <pane> [title] | release <pane> | host <pane>]'

export function parseCommand(args: string): WorkbenchCommand {
  const [verb = '', first = '', second = '', ...more] = args.trim().split(/\s+/)
  if (verb === '') return { kind: 'open' }
  if (verb === 'move') {
    if (first && (second === 'left' || second === 'right')) return { kind: 'move', id: first, side: second }
    return { kind: 'error', text: 'Usage: /workbench move <pane> left|right' }
  }
  if (verb === 'split') {
    const percent = Number(first)
    if (Number.isInteger(percent) && percent >= 20 && percent <= 80) return { kind: 'split', percent }
    return { kind: 'error', text: 'Usage: /workbench split <20-80> (the left column\'s share)' }
  }
  if (verb === 'add' && first) return second ? { kind: 'add', id: first, title: [second, ...more].join(' ') } : { kind: 'add', id: first }
  if ((verb === 'release' || verb === 'host') && first) return { kind: verb, id: first }
  return { kind: 'error', text: USAGE }
}
