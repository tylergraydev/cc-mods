/** `on` and `off` are what this process loaded; `turning-*` differ from it and apply next session. */
export type ModState = 'on' | 'off' | 'turning-off' | 'turning-on'
export type ModNote = 'missing' | 'no-manifest' | 'bad-manifest'

export type ModEntry = {
  /** Stable slug: manifest name (or folder basename), de-duplicated with -2, -3. */
  id: string
  /** The spelling written in settings (or as remembered). */
  dir: string
  /** The normalized dir. */
  key: string
  name: string
  version?: string
  description?: string
  state: ModState
  isSelf: boolean
  isWorkbench: boolean
  /** Occurrences on disk (duplicates). */
  listed: number
  note?: ModNote
}

/** One /config row of a mod's userConfig, as the pane shows it. */
export type ModConfigRow = {
  key: string
  plugin: string
  field: string
  label: string
  description?: string
  kind: 'boolean' | 'choice' | 'text' | 'number'
  value: boolean | string | number | string[]
  options?: string[]
  isLocked: boolean
}

/** `notes` says why a section could not be listed (one failure never kills the pane). */
export type ModMenuSnapshot = { mods: ModEntry[]; settingsPath: string; readAt: number; error?: string; notes?: Partial<Record<ItemType, string>> }

/** $.store key 'disabled' (not declared: $.store is untyped). */
export type DisabledDir = { dir: string; name?: string; after?: string; at: number }

export type ItemType = 'mod' | 'plugin' | 'skill' | 'hook' | 'mcp'
/** When a toggle takes effect: now, after /reload-plugins, or next session. */
export type ApplyWhen = 'live' | 'reload' | 'restart'
export type Tier = 'user' | 'project' | 'local' | 'synced' | 'managed'

/** One thing the menu can switch: a mod, plugin, skill, hook or MCP server. */
export type LoadoutItem = {
  /** `type:name`, e.g. `mod:guardrail`, `plugin:warp@claude-code-warp`, `hook:PreToolUse:Bash:1a2b3c4d`. */
  id: string
  type: ItemType
  name: string
  /** Unique within its type; the pane's keys are `<type>-<slug>`. */
  slug: string
  label: string
  description?: string
  /** What this session has now. */
  state: 'on' | 'off'
  /** What is configured, when it differs from `state` and waits for a restart or reload. */
  pending?: 'on' | 'off'
  apply: ApplyWhen
  tier: Tier
  isLocked: boolean
  lockReason?: string
  tags: string[]
  inCatalog: boolean
  /** The catalog says on/off and this machine disagrees. */
  drift: boolean
  note?: string
}

export type CatalogItem = { tags: string[]; on: boolean; note?: string; updatedAt: number; deleted?: true }
export type CatalogProfile = { updatedAt: number; note?: string; deleted?: true }
export type CatalogMachine = { name: string; seenAt: number; missing: string[] }
/** `~/.claude/loadout.json`: names and tags only, no paths and no hook commands. */
export type Catalog = {
  version: 1
  updatedAt: number
  items: Record<string, CatalogItem>
  profiles: Record<string, CatalogProfile>
  active?: { tag: string; at: number }
  machines: Record<string, CatalogMachine>
}

export type GhStatus = { kind: 'unknown' | 'checking' | 'ok' | 'logged-out' | 'missing' | 'error'; login?: string; message?: string; checkedAt: number }
export type SyncState = { kind: 'idle' | 'busy' | 'ok' | 'error'; op?: 'sync' | 'pull' | 'push'; message?: string; at?: number }
export type ProfilePlan = { tag: string; on: string[]; off: string[]; restart: string[]; missing: string[]; locked: string[]; text: string; isDryRun: boolean }

/** $.store keys (untyped): 'disabled' (v0.1), 'skillPrev': Record<string,string>, 'hookStash': HookStash[], 'sync': { gistId?, owner?, remoteUpdatedAt?, lastSyncAt? }, 'machine': { id, name }. */
export type HookStash = { id: string; event: string; matcher?: string; groupIndex: number; hookIndex: number; def: Record<string, unknown>; at: number }

declare module 'claude-code' {
  interface PluginState {
    'mod-menu': {
      /** Normalized dirs at process start; written once. */
      boot: string[] | null
      snapshot: ModMenuSnapshot
      config: ModConfigRow[]
      /** LoadoutItem.id whose detail is open. */
      selected: string | null
      isWriting: boolean
      /** enabledPlugins and denied MCP names as first read: what this session started with. */
      bootSettings: { enabledPlugins: Record<string, boolean>; denied: string[] } | null
      items: LoadoutItem[]
      catalog: Catalog | null
      catalogError: string | null
      gh: GhStatus
      sync: SyncState
      collapsed: ItemType[]
      /** LoadoutItem.id whose tags are being typed. */
      editing: string | null
      plan: ProfilePlan | null
    }
  }
}
