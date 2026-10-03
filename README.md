# cc-mods

Mods for Claude Code: plugins of function hooks that add side panes, status lines, toasts and tool-call guards to a session. Each folder is one mod and loads on its own.

| Mod | What it does |
| --- | --- |
| [agent-deck](agent-deck/) | Live pane of the session's subagents: status, tool calls, answers, launch and nudge, spawn caps and model rules |
| [arcade](arcade/) | Tic-tac-toe, sudoku and tetris in a side pane, playable by keyboard, mouse or an Xbox controller |
| [claim-check](claim-check/) | Flags confident claims about prod, data, deployments and tickets that no query backed up in the same turn |
| [dev-doctor](dev-doctor/) | Read-only environment checks on session start: bash, .NET, ports, git locks, Docker, Node and more |
| [doom-pane](doom-pane/) | Play DOOM (Freedoom) in a side pane with `/doom`; it pauses when Claude finishes or needs you |
| [goal-anchor](goal-anchor/) | Anchors the session's goal, counts turns spent away from it and nudges Claude back |
| [guardrail](guardrail/) | Blocks hook-skipping git commands and live data operations that have no successful dry run first |
| [handoff-watch](handoff-watch/) | Watches context fill and nudges for a handoff doc before auto-compact; can clear and resume on its own |
| [inbox](inbox/) | A task inbox kept as markdown files; deploy subagents on tasks one by one or as a drain |
| [mod-menu](mod-menu/) | Manage mods, plugins, skills, hooks and MCP servers: tag them, switch profiles, sync your loadout via `gh` |
| [rail-runner](rail-runner/) | An ASCII endless runner that plays in a side pane while Claude is working |
| [sound-board](sound-board/) | Plays a distinct sound for subagent events, permission asks, denials and finished turns |
| [usage-tracker](usage-tracker/) | Live 5-hour and 7-day usage with pace markers, burn-rate projections and sparklines |
| [workbench](workbench/) | Hosts other mods' panes in one docked pane split into two columns |

`doom-pane` and `rail-runner` are git submodules of their own repos. Clone with `git clone --recurse-submodules`.

## Loading

Point `CLAUDE_CODE_PLUGIN_DIRS` at the mod folders you want, separated by `;` on Windows. Keep `workbench` last so it can host the others. Mods load at process start and hot-reload at the end of a turn while the session runs.

Each mod has its own README with its commands, options and tests. Run a mod's tests with `claude plugin test ./<mod>` and check it with `claude plugin validate ./<mod>`.
