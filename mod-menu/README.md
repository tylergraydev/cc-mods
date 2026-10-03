# Mod Menu

A Claude Code mod that manages your whole loadout in one pane: mods, marketplace plugins, skills, hooks and MCP servers. Turn each on or off, tag them, switch between profiles (`work`, `personal`), and sync the loadout between machines through a secret GitHub gist with `gh`.

```
MOD MENU  9 on · 1 off · 1 pending restart                  [s Sync] [r Refresh]
GitHub: tylergraydev ✓ · synced 4m ago
Profile: [work] [personal] [all]  active: work
  → use personal: 2 on, 3 off, 2 need restart · 1 missing here   [y Apply] [n Cancel]
▾ Mods 9 on · 1 off · 1 pending restart
1 [ on ] ▸ guardrail 0.1.0   work            Blocks risky git…
▾ Plugins 3 · 3 on
  [ on ] ▸ warp@claude-code-warp 2.0.0   personal   off → on after /reload-plugins
▸ Skills 2
▸ Hooks 0
▾ MCP 1 · 0 on · 1 off
  [ off ] ▸ claude.ai Gmail   personal   blocked via deniedMcpServers · next session
      ▾ selected row detail: tags: work, personal  [t Edit tags]
```

## What "off" writes

Every switch edits one file or runs one command, and says when it takes effect.

| Section | Off writes | Takes effect |
|---|---|---|
| **Mods** | removes the folder from `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` (v0.1 behaviour: workbench last, itself never off) | next session |
| **Plugins** | `claude plugin disable --json --scope user <id>`; success is read from the JSON `outcome` / `alreadyInGoalState`, not the exit code. Only when `claude` cannot start does it edit `enabledPlugins` in settings.json instead | `/reload-plugins` |
| **Skills** | `skillOverrides.<name> = "off"` in settings.json; turning it on restores the earlier value (kept in `$.store` `skillPrev`) or removes the entry. No folders are moved | now |
| **Hooks** | takes the hook out of `hooks` in settings.json and keeps it in `$.store` `hookStash`; turning it on puts it back where it was | now |
| **MCP** | adds `{ "serverName": "<name>" }` to `deniedMcpServers` in settings.json. It never writes `~/.claude.json` | next session |

Every settings.json edit is a fresh read, a surgical replace of just the top-level key being changed (all other keys keep their bytes), a check by parsing the result, a backup at `settings.json.mod-menu-backup`, the write, and a read back that compares every edited path. A file that does not parse as plain JSON (comments, trailing commas) is refused, and nothing is written when nothing changes.

## Live vs restart

| Applies | Items |
|---|---|
| now | skills, hooks, a mod's own `/config` rows |
| after `/reload-plugins` | marketplace plugins |
| next session | mods, MCP servers |

A row that differs from what this session started with shows `on → off next session` (or `after /reload-plugins`) and the header counts it as pending. Whether a `skillOverrides` edit hides a skill mid-session is unverified; if it does not, set `SKILL_APPLY` in `hooks/loadout.ts` to `'restart'`.

## Tags and profiles

Tag any row: open it and press `t` (or `/mod-menu tag <id> work,personal`; `-` clears). `all` is reserved. Tags and each item's on/off live in the catalog, `~/.claude/loadout.json`. Items enter the catalog when they are tagged or touched by a profile; a toggle keeps the catalog in step only for an item that is already in it.

`/mod-menu use <tag>` brings the machine to that profile:

| item tags | `use work` |
|---|---|
| none, or not in the catalog | unchanged |
| includes `work` | on |
| only other tags (`personal`) | off |
| `work` and `personal` | on |
| any tag, with `use all` | on |

Locked items (project or managed settings, this menu itself) are never changed and are counted. Catalog entries with no local item (a mod folder or hook command this machine does not have) are listed as missing and never made up. `use work --dry-run` prints what would change and writes nothing and runs nothing but the plugin listing. `use` makes one settings write for everything that is not a plugin, runs plugins one at a time through the CLI, then records the catalog (`active` profile and what is on). `/mod-menu apply` brings the machine to the catalog's on/off the same way. In the pane, a profile button previews the plan and `y` applies it.

## Catalog file

`~/.claude/loadout.json` (or `$CLAUDE_CONFIG_DIR/loadout.json`): `version`, `updatedAt`, `items` (`id -> { tags, on, note?, updatedAt, deleted? }`), `profiles`, `active`, `machines` (name, last seen, ids missing there). Ids are `mod:<name>`, `plugin:<name@marketplace>`, `skill:<name>`, `hook:<Event>:<matcher>:<hash>`, `mcp:<name>`. It holds names and tags only: no absolute paths, no hook commands (a hook is identified by a hash of its command), no tokens. It is written sorted, 2-space, with `loadout.json.bak` before each overwrite, and never overwritten while it does not parse.

## Sync setup

1. Install `gh` (https://cli.github.com).
2. `gh auth login --web`, once.
3. `/mod-menu sync` finds your loadout gist (description `claude-loadout (mod-menu)`) or creates it as a secret gist, merges it with the local catalog item by item (newest `updatedAt` wins) and writes both sides. `pull` only updates the local file; `push` sends the local file as is and refuses if the remote moved since your last sync unless you add `--force`.
4. On the second machine, log in to the same account, `/mod-menu sync`, then `/mod-menu apply` (hooks only sync their tags and on/off; their commands stay on the machine that has them).

Sync never changes settings by itself: it only reports `N items differ here`. A secret gist is unlisted, not private: anyone with the URL can read it, which is why the catalog holds names and tags only. The merge uses each machine's clock, so a machine with a badly wrong clock can win or lose entries. If `gh` is logged in as a different account than the one the gist was made with, sync refuses; `gh auth switch`, or `/mod-menu sync --relink`. The mod never reads `~/.config/gh`, never sets or passes a token, and every `gh` error it shows is the first line of stderr with token-shaped text masked.

## Commands

- `/mod-menu` (alias `/mods`, if the name is free) opens the pane.
- `/mod-menu list` prints every item and its state.
- `/mod-menu on <id>` and `off <id>` work for every type. `<id>` is `type:name`, or a bare name when it is unique across types; quote names with spaces.
- `/mod-menu tag <id> <tags>`, `use <tag> [--dry-run]`, `apply`.
- `/mod-menu sync`, `pull`, `push [--force]`, `gh` (re-check login), `forget <id>` (a tombstone that syncs the removal).

Hotkeys: `1`...`9`, `0` toggle the first ten mods; `s` sync, `r` refresh, `q` close, `t` edit tags of the open row, `o` show the open row's pane, `y` / `n` apply or cancel a previewed profile.

Every loaded mod that has a pane carries a `show` button on its row (hotkey `o` on the open row). It opens the workbench dock first, then runs the mod's own command (`/deck`, `/arcade`, `/sounds`, ...), so the pane lands in the dock at any terminal width. Which command shows which mod is the `PANE_COMMANDS` table in `hooks/mods.ts`; a mod that is not loaded yet shows no button.

## Limits

- It cannot unload a mod in the running session; `$.plugin` has no such call.
- It never touches `~/.claude.json`, `pluginConfigs`, or `statusLine`, and never changes a key other than the one being edited.
- Not toggleable here: skills, hooks and MCP servers that plugins provide; anything set in project or managed settings (shown locked); project-level skills; and hooks with no local stash on a second machine.
- A plugin shows `pending` until the next restart even after `/reload-plugins`, because "what this session started with" is recorded once.
- If the `claude` command times out the plugin switch falls back to the settings.json edit, same as when it cannot start.
- `claude plugin list --json` runs on every refresh (20 s limit); there is no cache.
- Host commands: `process.run` needs the CLI. Without it plugins fall back to settings.json and sync is unavailable.
- Item-level last-writer-wins depends on the machines' clocks.
- A skill with the same name in `~/.claude/skills` and the synced folder is two rows; only the user one toggles, and turning it off also hides the synced copy.
- `mod-menu` must come before `workbench` in the plugin list for the workbench to host it.

## Check

```sh
claude plugin validate ./mod-menu
claude plugin test ./mod-menu
```
