# Workbench

One docked pane split into a left and a right column. Panes from agent-deck, usage-tracker, rail-runner, inbox, dev-doctor, mod-menu, sound-board and arcade open inside it instead of as separate tabs.

- **Drag** a tab in the top strip across the `│` divider to move that mod to the other column. Clicking a tab shows it. While you drag, the divider and the target side turn yellow.
- **Buttons**: each column has a `move … ⇢` / `⇠ move …` button. On desktop, which has no tab strip, the tabs are buttons too.
- The layout (which side each mod is on, and the split) is remembered across sessions.

| Command | |
|---|---|
| `/workbench` | open it |
| `/workbench move <pane> left\|right` | move a pane |
| `/workbench split <20-80>` | set the left column's share of the width |
| `/workbench release <pane>` | let a mod open as its own tab again |
| `/workbench host <pane>` | undo `release`, or host another mod's pane id |
| `/workbench add <pane> [title]` | pull in a pane id now |

## How mods draw in it

The engine won't let one plugin draw another plugin's pane, so the mods cooperate. The workbench draws the frame and leaves an empty `Box` keyed `slot-<pane id>` for each pane it shows. Each hosted mod has a second `ui.render` hook on the `workbench` pane that takes the frame from `next(e)` and fills its own slot (see `hooks/bench.ts` in each mod). That mod's buttons, inputs and live state stay its own.

That means **workbench must be listed after the hosted mods in `CLAUDE_CODE_PLUGIN_DIRS`**, so their hooks run above it. If a slot says "its mod has not drawn here", check that order.

To make another mod hostable: copy `hooks/bench.ts` into it, move its pane drawing into `drawPane($, e)`, add the `BENCH` hook (see agent-deck's `register.tsx`), and add its pane id to `SUPPORTED` (or run `/workbench host <id>`).

DOOM isn't hosted. It paints frames straight into its own pane with `$.ui.blit`.

## Limits

The engine owns where the dock goes, so both columns sit on the same side of the transcript. There's no way for a mod to add a panel on the far left.

## Check

```sh
claude plugin validate ./workbench
claude plugin test ./workbench
```
