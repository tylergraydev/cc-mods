# Dev Doctor

A Claude Code mod that checks your Windows dev environment when a session starts and tells you (and the model) what is wrong before something half-works: the wrong `bash` on PATH, a missing .NET SDK, a port held by a stale server, a stuck git lock, a missing `AUTH_SECRET`. It never changes anything.

```
DEV DOCTOR  C:\code\Shop   7/9 ok · 2 fail · 1 skip   checked 14:02 (timer)
[ Re-run ]
▸ ✗ FAIL  Port holders    3000: node.exe PID 18232, up 3d, cmd outside repo (C:\code\old-shop)
         fix  Get-Process -Id 18232 | Select Id,ProcessName,StartTime,Path   # confirm it is stale, then: ...  [ copy ]
▸ ! WARN  Port holders    3001: node.exe PID 2210 (this repo, up 12m). Running: do not restart
▸ ✗ FAIL  .NET SDK        global.json wants 9.0.100 (latestFeature); have 8.0.404
         fix  winget install --id Microsoft.DotNet.SDK.9 -e   # or edit rollForward in global.json  [ copy ]
▸ ✓ PASS  Bash on PATH    C:\Program Files\Git\bin\bash.exe (1st of 2)
▸ ✓ PASS  Node            v22.11.0 (wants 22 from .nvmrc)
▸ · SKIP  Docker          Docker Desktop not running
```

- **Status line**: `doctor: 7/9 ✓` (or `✗` with any FAIL). Skipped checks are not counted and a WARN counts as ok. In a folder with no project marker (no `global.json`, solution, AppHost or `package.json`) the line stays hidden unless something fails.
- **Toast** when a check newly fails: `dev-doctor FAIL: ports, node — /dev-doctor`. The same fails do not toast again.
- **Pane** (`/dev-doctor`): failures first, then warnings, passes and skips. `▸` expands a row to show why it ran and the whole fix; `copy` puts the fix on the clipboard. Fixes are text for you to read and run, never run by the mod.
- **Re-runs**: at session start, every 5 minutes, on the pane's Re-run button (or `r`), on `/dev-doctor run`, and a few seconds after a Bash or PowerShell command that starts or stops apps, containers or worktrees (`npm run dev`, `docker compose up`, `Stop-Process`, `git worktree`, ...). Those re-run only the volatile checks.
- **Prompt section**: while there are FAILs or this repo's own app holds a watched port, a section of at most four lines tells the model which checks fail and that a running app must not be killed or restarted. Its text only changes when the fail set or the port holders change, so it does not churn the prompt cache.

A WARN is deliberate: a port held by this repo's own running app is not a failure, because a FAIL invites the model to "fix" it by killing the server.

## Checks

| id | What it checks | Runs when |
| --- | --- | --- |
| `bash` | `bash` resolves to Git for Windows, not WSL (`System32`) or the WindowsApps alias | any Windows repo |
| `dotnet-sdk` | an installed SDK satisfies `global.json` (all `rollForward` policies, prereleases) | `global.json` |
| `dotnet-runtime` | a .NET 8 `Microsoft.NETCore.App` runtime is installed | `global.json`, a solution or an AppHost |
| `ports` | who holds the watched ports; own app is WARN, someone else's process FAIL, unreadable owner WARN; spots Next moving to 3001 because 3000 is taken | Windows, `package.json` or an AppHost |
| `git-locks` | `*.lock` files in the git dir and linked worktrees; older than `lockStaleSeconds` fails | git repo |
| `git-worktrees` | worktrees `git` marks `prunable` | git repo |
| `docker` | exited containers older than `dockerExitedHours` | AppHost or a compose file |
| `auth-secret` | `AUTH_SECRET` is defined (user-secrets, environment, `.env`, `.env.local`) and an AppHost `.cs` file forwards it | AppHost |
| `node` | `node --version` matches `.nvmrc`, `.node-version`, `engines.node` or the `nodeMajor` option | `package.json` |
| `worker` | the worker process runs; skipped while the AppHost itself is not running | AppHost |

An "AppHost" is a folder named `*AppHost` with a `.csproj`, at the repo root, one level down, or under `src/`.

## Read-only

The mod never writes a file and never starts anything but these, all with fixed arguments:

- `where.exe bash`
- `dotnet.exe --version`, `--list-sdks`, `--list-runtimes`
- `netstat.exe -ano -p tcp` and `-p tcpv6`
- `tasklist.exe /FO CSV /NH`
- `powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process ..."`, only for the PIDs holding watched ports and for `dotnet.exe` (the filter goes through an environment variable)
- `git.exe rev-parse --git-dir --git-common-dir`, `git.exe worktree list --porcelain`
- `docker.exe ps -a --filter status=exited`
- `node.exe --version`

Secrets are found by key name only. `.env` files and the user-secrets `secrets.json` are read to see which keys exist and whether they are empty; values are dropped inside the parser and never stored, drawn, logged or put in evidence. `dotnet user-secrets list` is deliberately not used because it prints values.

## Limits on Windows without elevation

- If `System32\bash.exe` comes first, putting Git first on the machine Path needs an admin shell. Alternatives: turn off the app execution alias, `npm config set script-shell 'C:\Program Files\Git\bin\bash.exe'`, or set `CLAUDE_CODE_GIT_BASH_PATH`.
- `Get-CimInstance Win32_Process` returns no command line for elevated or other users' processes. Such a holder is reported as "unknown owner" (WARN), not FAIL. `netstat -b` needs elevation and is not used. PID 4 (System, HTTP.sys or IIS Express) is reported as it is.
- `winget` installs raise a UAC prompt; they are only suggested.
- The Docker CLI needs `docker-users` membership; without it the check is skipped with that reason.
- The AUTH_SECRET check is static: where it is defined and whether AppHost code mentions it. It cannot see what a running process actually received.

## Options

Set under `pluginConfigs` in settings, or in the config menu:

```json
{
  "pluginConfigs": {
    "dev-doctor": {
      "options": {
        "ports": "3000,3001,5173",
        "intervalMinutes": 10,
        "nodeMajor": 22,
        "workerProcess": "Worker",
        "appHostProcess": "",
        "dockerExitedHours": 24,
        "lockStaleSeconds": 120,
        "disabledChecks": "docker,worker",
        "rerunAfterTools": true,
        "composeSection": true
      }
    }
  }
}
```

`ports` also picks up the ports in the AppHost's `Properties/launchSettings.json` `applicationUrl`. `intervalMinutes: 0` turns the timer off. `appHostProcess` blank uses the AppHost folder name (`Shop.AppHost` matches `Shop.AppHost.exe`, or a `dotnet.exe` whose command line names it).

## Workbench

`dev-doctor` is hosted by the [workbench](../workbench) mod: once it is loaded, the Doctor pane opens inside the workbench's columns. Add `dev-doctor` to the workbench's `SUPPORTED` list (done in this repo) and keep the workbench last in `CLAUDE_CODE_PLUGIN_DIRS`.

## A standing rule for CLAUDE.md

The mod only reports. The rule that stops the model killing a running server belongs in your own `~/.claude/CLAUDE.md`; paste this (the mod does not edit it):

```
Do not kill, restart or stop an app, server or container that is already running; ask first, even if it holds a port you need.
```

## Check

```sh
claude plugin validate ./dev-doctor
claude plugin test ./dev-doctor
```
