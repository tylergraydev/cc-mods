export type WorkbenchSide = 'left' | 'right'

/** A mod pane the workbench hosts: the id it opened under and its title. */
export type WorkbenchMember = { id: string; title: string }

/**
 * Which side each pane id sits on (remembered for ids not open now), which
 * one each side shows, the left column's share of the width, the ids left
 * to open as their own tabs, and ids hosted beyond the mods that support it.
 */
export type WorkbenchLayout = {
  left: string[]
  right: string[]
  shown: { left?: string; right?: string }
  split: number
  released: string[]
  hosted: string[]
}

declare module 'claude-code' {
  interface PluginState {
    workbench: { layout: WorkbenchLayout; members: WorkbenchMember[] }
  }
}
