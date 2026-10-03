# Solution Explorer

A Claude Code mod that shows a Solution Explorer-style file tree in a side pane: your projects, what git says changed, and the files Claude wrote this session.

```
Explorer · MyApp
2 touched · 3 changed · MyApp.sln
refresh hidden changes collapse close
 ▾ Solution 'MyApp' (2 projects)
●    ▾ MyApp.Web
● M    ▸ Controllers
         Program.cs
   ▸ MyApp.Tests
   ▸ (root)
```

- **Solution aware.** A `.sln` or `.slnx` in the project root (or one folder down) turns the tree into the solution, its projects (each rooted at its project file's folder), then a `(root)` bucket for everything else. Solution folders are ignored. With no solution file it is the plain directory tree.
- **Marks.** `●` (magenta) is a file Claude wrote or edited this session (`Write`, `Edit`, `NotebookEdit`, subagents included). The letter next to it is git: `M` modified, `A` added, `?` untracked, `D` deleted (struck through), `R` renamed, `!` conflict. A folder shows `●` or a dim `•` when something under it changed.
- **Changes only (`t`).** Shows just the touched and git-changed paths, grouped by project. It needs no folder listing, so it is cheap.
- **Click** a folder to open or close it. Click a file to append `@path` to the prompt box; it never replaces your draft.
- **Hidden by default:** `.git`, `node_modules`, `bin`, `obj`, `.vs`, `dist`, `build`, `out`, `.claude-plugin/types`, plus the root `.gitignore` subset (names, `name/`, `/anchored`, `a/b` paths, `*.ext`; no `!` negations, other globs or nested `.gitignore`) and the `hide` setting. `h` shows them dim.
- Open folders and the two toggles are remembered per root across restarts.

## Commands

| Command | Does |
| --- | --- |
| `/explorer` | Opens the pane and refreshes it |
| `/explorer refresh` | Re-lists the open folders and reruns git |
| `/explorer root <path>` | Uses another folder as the root (`/explorer root` resets it) |
| `/explorer find <text>` | Filters to names containing the text (searches up to 60 folders); `find` alone clears it |
| `/explorer collapse` | Closes every folder |
| `/explorer show <path>` | Opens the folders down to a file and highlights it |

If `/explorer` is taken, the mod registers `/solution-explorer` instead.

## Hotkeys

`r` refresh, `h` hidden, `t` changes only, `c` collapse, `q` close. Inside the workbench both columns share one pane site, so when mod-menu and the explorer sit side by side `r`, `q` and `t` clash and the later one wins.

## Config

- `hide`: extra names, `*.ext` patterns or relative paths to hide.
- `gitStatus`: run `git status` (default on).
- `maxEntries`: entries shown per folder before `… +K more` (default 400).

## Limits

- No live watching: the tree refreshes when the pane opens, on `r`, after each finished main-loop turn and when Claude writes a file. Edits made elsewhere show up on the next turn end or refresh.
- It cannot open a file in an editor or Visual Studio, and shows no contents or diffs.
- Read-only: it never writes a file, and the only process it runs is `git`.
- Shows the disk under each project folder, not the MSBuild item list; no NuGet or dependency nodes.
- `MultiEdit` is not in this build, and shell or MCP writes are not seen as touches (git still catches them).

Hosted in the workbench: the workbench must load after this mod in `CLAUDE_CODE_PLUGIN_DIRS`.

## Check

```sh
claude plugin validate ./solution-explorer
claude plugin test ./solution-explorer
```
