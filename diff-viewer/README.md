# Diff Viewer

A Claude Code mod that shows what Claude changed, per turn and per file, in a side pane.

```
Diff · turn 4 (open)
turn 4 (open): 3 files +20 −5
j: next k: prev u: session g: git w: wrap
▾ +12 −3 src/api/client.ts
  @@ -10,7 +10,9 @@ …
▸ +8 −2  src/app.tsx sub
▸ +0 −0  README.md new
earlier turns
▸ turn 3 · 2 files +5 −1
```

- **What is recorded**: every `Write`, `Edit` and `NotebookEdit` Claude makes, from subagents too (tagged `sub`). The file is read just before and just after the tool runs, so the diff is of what really landed.
- **Turn vs session**: turn groups the edits by Claude's turn, newest first, with earlier turns folded below. Session shows one net diff per file over the whole session (`×k` marks a file changed more than once).
- **`git` mode**: `git diff HEAD` for the session folder, run only when you press `g` or type `/diff git`, never on a timer. It catches what the mod did not see.
- Click `▸` or the stats to open a file; one file is open at a time. Click the path to append `@path` to the prompt; your draft is never replaced.
- Tags: `new` (file did not exist), `bin`, `big` (kept as a patch only), `?` (unreadable), `sub` (a subagent), and `A` `D` `R` in git mode.

## Commands

| Command | What it does |
| --- | --- |
| `/diff` | Open the pane |
| `/diff turn [N]` | Show a turn (the latest with changes, or N) |
| `/diff session` | Net diff per file over the session |
| `/diff git` | Run `git diff HEAD` and show it |
| `/diff file <path>` | Open one file's diff |
| `/diff clear` | Forget the record |

If `/diff` is taken by Claude Code's built-in, use `/diff-viewer`; it is always registered.

## Hotkeys

`j` next file, `k` previous file, `u` turn/session, `g` git, `w` wrap, `b` close the open file. Inside the workbench, arcade's games use `j`, `k` and `u` while a game is drawn; the later pane wins.

## Config

- `contextLines`: unchanged lines around each change (0-10, default 3).
- `maxChanges`: recorded changes kept per session (5-500, default 60); older ones drop off.
- `wrap`: wrap long diff lines instead of cutting them (default off; `w` toggles it).

## Limits

- Edits made through Bash, PowerShell, MCP tools or your editor appear only in `git` mode, and untracked files are not in `git` mode. There is no `MultiEdit` in this build.
- A file over 4 MiB is "unreadable" (no diff). A change over 200 KiB is kept as a patch only, and a patch over 200 KiB as counts only.
- Binary files show no content diff. `.ipynb` edits diff the notebook JSON.
- Diffs are line-level; there is no revert or per-hunk accept.
- Session-only: nothing is kept across sessions, and `/clear` empties the record. Read-only: the mod never writes a file, and its only process is `git`.

Hosted in the workbench: the workbench must load after this mod.

## Check

```sh
claude plugin validate ./diff-viewer
claude plugin test ./diff-viewer
```
