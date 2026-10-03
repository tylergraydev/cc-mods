# Inbox

A task inbox for subagents, kept as markdown files in `.inbox/` in each project: one file per task. You, Claude or any agent can read, add or edit them.

- **Pane** (`/inbox`): every task with its status, plus a box to add a new one (`title -- details`). Click a task for its details, the agent's report and the **Deploy**, **Mark done** and **Reopen** buttons. While an agent works a task, its row shows run time, tool count and the call it's making now.
- **Deploy** starts one background subagent on a task. The task goes `open` → `running` → `done` (or `failed`), and the agent's final report is written into the file under `## Result`.
- **Drain** (`/inbox drain 3`, or the pane's **Drain ×2** button) keeps N subagents busy on open tasks, oldest first, until none are left.
- **Review** (`/inbox review <id>`, or the pane's **Review** button on a done task) deploys a reviewer that checks the work and commits it, once (see Commit check).
- A toast fires as each task finishes. The pane sits in the workbench when that's loaded.
- A watchdog flags workers that stop making progress, and per-task locks keep two Claude sessions in one repo off the same task (below).

| Command | |
|---|---|
| `/inbox` | open the pane |
| `/inbox new [--agent t] [--model m] <title> [-- <details>]` | add a task |
| `/inbox run <id> [<id>…]` | deploy a subagent on each |
| `/inbox review <id> [<id>…]` | deploy a reviewer on each done task; it commits with an `Inbox-Task:` trailer unless one exists (`commit` is an alias) |
| `/inbox status` | one line: open, running, idle or timed out, locked elsewhere, and what to run next |
| `/inbox unlock <id> [--force]` | release a lock this session holds; `--force` releases anyone's |
| `/inbox drain [n\|off]` | work the open tasks n at a time (default 2) |
| `/inbox done <id>` · `/inbox reopen <id>` | set the status |
| `/inbox show <id>` · `/inbox list` | print a task, or all of them |

## Task files

`.inbox/007-fix-login-redirect.md`:

```markdown
---
id: 7
title: Fix the login redirect
status: open
agent: general-purpose
model: sonnet
created: 2026-10-03T10:00:00Z
updated: 2026-10-03T10:00:00Z
---

It loops back to /login after SSO. Check auth.ts.

## Result

(the agent's report, written when it finishes)
```

Only `status` matters to the inbox; `agent` and `model` are optional. A file with no front matter is an open task titled by its first line, so `echo "# Bump deps" > .inbox/012-deps.md` works. New files show up within 3 seconds. If you'd rather not commit the inbox, add `.inbox/` to `.gitignore`.

An agent Claude starts with a description beginning `inbox #<id>:` (or `inbox #<id> review:`) is tracked and locked against that task too.

## Watchdog

While a worker runs, the mod polls its conversation (`$.session.messages({ agentId })`, every 3 s) and keeps a heartbeat: the time at which the conversation last changed (a new row, a finished tool call, a result). Rows carry no timestamps, so activity is dated to the poll that saw the change, give or take 3 s. A tool call still in flight is shown as `in Bash 12m` rather than `idle 12m`. The pane row carries the note, the header counts `N idle` and `N timed out`, and each level toasts once (`inbox: task 64 idle 10m`, `inbox: task 64 timed out (idle 30m)`).

The timeout is based on idle time, not total run time, so a productive worker is never cut off. A wall-clock cap exists as a separate option and is off by default. The worker's tool count and last call come from the same poll.

Settings (plugin options, set in `/config` or `pluginConfigs`):

| Option | Default | |
|---|---|---|
| `idleMinutes` | 10 | idle this long: toast once, row turns yellow |
| `timeoutMinutes` | 30 | idle this long: marked timed out (red `!`), toast once, then `onTimeout` runs |
| `maxRunMinutes` | 0 (off) | optional wall-clock cap, treated like a timeout |
| `onTimeout` | `mark` | `mark`, `nudge` or `redeploy` |
| `lockStaleMinutes` | 20 | a lock not refreshed for this long can be taken over |
| `commitTrailer` | `Inbox-Task` | git trailer key for the commit check |

**The mod cannot stop a subagent.** The plugin API has no stop or kill for subagents, and aborting a turn only reaches the main conversation. So a timeout never kills anything:

- `mark` (default): the row and a toast. To actually stop the worker, use the engine's own background-task view, then **Reopen** or **Deploy** the task.
- `nudge`: also appends a note to the worker (`[inbox watchdog] No progress on inbox #64 for 30m. Finish and report now, or say what is blocking you.`). It reaches the agent only at the top of its next loop, so a worker stuck inside one tool call will not see it until that call returns.
- `redeploy`: marks the old run `abandoned`, then deploys a fresh agent, at most once per task per session. The old agent may still be running and editing files; stop it from the engine's task view.

`tool.call` hooks do not see the tool calls of agents a hook spawned itself, so the mod does not rely on them for the heartbeat; the poll covers agents however they were started.

## Locks

Two Claude sessions in one repo share `.inbox/`. Before a work or review deployment takes a task, it takes `.inbox/.locks/<id padded to 3>.lock`, one line of JSON:

```json
{"task":64,"phase":"review","session":"<session id>","host":"<COMPUTERNAME>","acquiredAt":"2026-10-03T10:00:00Z","refreshedAt":"2026-10-03T10:04:00Z","nonce":"<session>:<ms>:<rand>","released":false}
```

- A lock this session owns is re-entrant, and survives a plugin reload. Another session's lock that was refreshed within `lockStaleMinutes` blocks: `/inbox run` and `review` refuse, drains skip the task, a model-started `inbox #N:` agent is denied, and the pane shows `⊘ locked by other session`.
- A lock not refreshed for `lockStaleMinutes` is stale: the next deployment takes it over, with a toast.
- Running locks are refreshed every minute and released when the agent settles, a deploy is refused or no agent starts. Release rewrites the file with `"released":true`; the API has no delete.
- `$.fs` has no exclusive create, so taking a lock is write-then-read-back, trusting it only if the nonce is ours. Two sessions acting in the same few milliseconds can still both win; this is a best-effort guard against the usual overlap, not a mutex.
- Add `.inbox/.locks/` to `.gitignore`.

## Commit check

Review commits carry a git trailer, `Inbox-Task: <id>` (the key is `commitTrailer`; `<id>` is the number, so task `022-dbs-tutorial` is `Inbox-Task: 22`). Before deploying a reviewer, `/inbox review` runs `git log --all -n 1 --grep '^Inbox-Task: <id>$'`: a hit refuses with `#64 already committed in abc1234 "subject"`, records `commit: abc1234` in the task file and releases the lock. If git fails, the review goes ahead and the answer says the check was skipped. The reviewer's brief repeats the check immediately before committing, adds the trailer, and ends its report with `COMMIT: <sha>` or `NO-COMMIT: <reason>`; the mod stores the sha as `commit:` and appends the report to the task's result under `### Review (<time>)`. The task's status is left as it was.

## Not covered here

These belong in the `/inbox-dispatch` and `/inbox-review` skills on the other machine, not in this mod:

1. Submitting to the pane: after pasting, send Enter, read the pane back to confirm, retry once, alert if still there.
2. Codex launch timeouts: explicit generous timeout on every background `codex exec`.
3. Non-interactive workers: `CI=1`, `--yes`, `NO_UPDATE_NOTIFIER=1`.
4. "Never answer with nothing" for the model-driven `/inbox` skill: always end with a state summary.
5. Honouring this mod's lock and commit conventions: read/write `.inbox/.locks/<id>.lock` in the format above; check and write the `Inbox-Task:` trailer. Recommend adding `.inbox/.locks/` to `.gitignore`.

## Check

```sh
claude plugin validate ./inbox
claude plugin test ./inbox
```
