# Guardrail

A Claude Code mod that stops Claude from skipping git hooks and from running live data operations that have no successful dry run first. You can let one blocked command through at a time.

```
status line   guard: dry-run ✓ sync-prod-to-stage.ps1, sqlpackage +1 · 2 blocked · allow armed
band          ⛔ guardrail blocked sqlpackage: no dry run yet     [Allow once] [Dismiss]
toast         guardrail blocked git push --no-verify: skipping hooks needs your OK · /guardrail allow no-verify
```

- **Hook skipping** is denied in Bash, PowerShell and Monitor commands: `--no-verify` (and abbreviations), `-n` on `git commit`, `-c core.hooksPath=`, `HUSKY=0`, `HUSKY_SKIP_HOOKS`, `SKIP=`. It looks inside `bash -c`, `pwsh -Command`, `cmd /c`, `wsl`, `eval`, `iex` and `Start-Process git`. `git push -n` is a dry run and passes.
- **Live data operations** are denied until a dry run of the same tool and target has succeeded in this session: `sqlpackage` publish/import, `dotnet ef database update`, `bcp ... in`, `sqlcmd` / `Invoke-Sqlcmd` that writes (SELECT-only passes), migration tools (prisma, flyway, liquibase, alembic, rails, knex, sequelize, Django), anything under `scripts/data/`, scripts named like `sync` or `migrate`, and any `--live` flag.
- **Dry runs** are the tool's own preview (`/a:DeployReport`, `migrations script`, `prisma migrate diff`, a `BEGIN TRAN ... ROLLBACK` query) or a `-WhatIf` / `--dry-run` flag. A dry run against Stage does not unlock Prod: the key is the tool plus a hash of its target options.
- **Allowing**: `/guardrail allow` (live) or `/guardrail allow no-verify` lets the next matching command through once, within `allowMinutes`. The band's **Allow once** button does the same. Claude cannot press it, and `/guardrail allow` only counts when you type it.
- Claude is told why it was blocked and what to ask you. A short policy note is added to the system prompt (`announce`).

## Commands

| Command | |
| --- | --- |
| `/guardrail` or `/guardrail status` | dry runs with times, blocked count, pending block, allowance, options |
| `/guardrail allow [no-verify]` | allow the next live data operation (or git hook skip) once |
| `/guardrail reset` | forget dry runs, the pending block and the allowance |

## Options

| Option | Default | |
| --- | --- | --- |
| `blockNoVerify` | `true` | deny git hook skipping |
| `blockLiveWithoutDryRun` | `true` | deny live data operations without a dry run |
| `dryRunScope` | `tool` | `tool`: same tool and target. `session`: any successful dry run unlocks all |
| `extraLivePattern` | | one case-insensitive regex tested on each command segment, e.g. `seed-prod\|reset-db` |
| `extraDryRunPattern` | | one case-insensitive regex for extra dry-run flags |
| `disabledRules` | | comma-separated rule ids: `sqlpackage`, `dotnet-ef`, `bcp`, `sqlcmd`, `migration-cli`, `data-script`, `sync-migrate-script`, `live-flag`, `custom` |
| `allowMinutes` | `10` | how long an allowance lasts |
| `requireTypedAllow` | `true` | only a command you typed may run `/guardrail allow` |
| `announce` | `true` | add the policy note to the system prompt |

An invalid regex is ignored, with a toast at session start.

## Limits

- A dry run only counts when it ran in the foreground and finished without error. Backgrounded and Monitor runs never count, and `dry | tee log` or `dry; echo done` can hide a failed dry run.
- Not caught: a new script written with the Write tool under a neutral name, PowerShell splatting (`git @args`), aliases or functions in a persistent shell, and tools other than Bash, PowerShell and Monitor (for example an MCP SQL server).
- Read-only commands that mention a data script (`cat`, `git add`, `rm`, an editor) are not treated as running it.
- State is per session and cleared on `/clear`. Dry runs are kept as hashed keys, and shown commands have passwords redacted.

## Check

```sh
claude plugin validate ./guardrail
claude plugin test ./guardrail
```
