# Status Bar

A Claude Code mod that folds every plugin's status line into one line under the prompt, or into one wrapped row above it.

```
Before                                  After
⚠ agent-deck: agents 3 running · 2 done
⚠ arcade: 🎮
⚠ claim-check: claims: 1 unverified     ⚠ status-bar: agents 3 running · 2 done │ arcade: 🎮 │ claims: 1 unverified │ goal: ship the sta… │ guard: no dry-run yet │ +1
⚠ goal-anchor: goal: ship the sta…
⚠ guardrail: guard: no dry-run yet
⚠ usage-tracker: CC 5h 19% 7d 40% · Codex 7d 12%
```

Band mode, wrapped onto two rows at 80 columns:

```
agents 3 running · 2 done  arcade: 🎮  claims: 1 unverified  goal: ship the sta…
guard: no dry-run yet  usage: CC 5h 19% 7d 40% · Codex 7d 12%
```

- **Modes**: `status` (default) pins one status line under the prompt. `band` draws one wrapped row above the prompt in colour, and pins nothing.
- **Labels**: short names for long plugin names (`usage-tracker` shows as `usage`, `guardrail` as `guard`, `mod-menu` as `mods`, and so on). A text that already starts with its label keeps its own words.
- **Order and hide**: `order` lists plugins to show first, the rest follow alphabetically. `hide` drops plugins.
- **Clipping**: each text is cut to `maxSegment` cells with `…`. In status mode whole segments are dropped from the end and counted as `│ +N`; in band mode each segment is clipped to the width.
- **Debounce**: a mod that updates ten times a second causes one state write and one pin per 150 ms, and only when the line changed.

## Commands

`/statusbar` (or `/status-bar` where the engine refuses the first name):

- `/statusbar` lists the combined statuses, the mode and the hidden plugins.
- `/statusbar mode status|band` switches layout.
- `/statusbar on|off` turns folding on or off.
- `/statusbar hide <plugin>` and `/statusbar show <plugin>`.

Choices are kept across sessions.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `mode` | `status` | `status` or `band` |
| `maxSegment` | 40 | Cells per plugin text, 8 to 200 |
| `width` | 160 | Width to fit the status line to until a band draw reports the real one, 40 to 1000 |
| `order` | empty | Comma-separated plugin names shown first |
| `hide` | empty | Comma-separated plugin names to drop |

## Position

Put `status-bar` **first** in `CLAUDE_CODE_PLUGIN_DIRS`. Status folding works from any position (the hook sees every tier's `$.ui.status` calls, checked in the tests), but band mode needs it: guardrail, goal-anchor and handoff-watch answer the band without calling `next` while theirs is active, so a band under them is never asked. Outermost, status-bar calls `next` and stacks what comes back beneath its own row.

## Limits

- The engine's own pinned notices stay; only plugins' status lines are folded.
- In status mode the engine still draws its own prefix, so the line reads `⚠ status-bar: …`. The `ENGINE_PREFIX` of 16 cells is a guess at that prefix.
- Band mode is drawn on terminal and desktop only, and sits above the prompt, not under it.
- Turning folding `off` cannot bring the other lines back at once: a plugin cannot pin under another's name. Each mod's line returns the next time that mod updates; a mod that pins once (such as arcade's `🎮`) returns after a reload or restart.
- A status raised while the mod is not loaded reaches the engine and is cleared at that mod's next update.

## Check

```sh
claude plugin validate ./status-bar
claude plugin test ./status-bar
```
