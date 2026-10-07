# Inbox

A pane for the `inbox/` work queue that a repo's `AGENTS.md` describes: one markdown file per item, moved between folders as it progresses. The mod reads that layout wherever the session runs, so any repo with an `inbox/` folder gets the pane.

The folder is found from the session's project root (which a shell `cd` does not move), then the working directory, then the root's parent folders, and every path the mod touches is absolute from there. The pane re-reads the files every 3 seconds, so items added or moved by hand, by a worker or by another session appear on their own; the **Refresh** button (hotkey `f`) and `/inbox refresh` force it, find the folder again and say where they looked. When nothing is found the pane names the folder it expected instead of just "empty".

```
inbox/<item>.md        status: todo         waiting to be picked up
  processing/          status: processing   a worker is on it
  review/              status: review       the worker finished; waiting for a reviewer
  done/                status: done         reviewed and accepted (only a reviewer moves items here)
  blocked/             status: blocked      the worker couldn't finish; ## Result says why
```

- **Pane** (`/inbox`): every item with its status, worker and why it can't start yet (`waits on 70-engine (processing)`, `paths overlap with 71-overlay`). Click an item for its goal, owner-paths, dependencies, the worker's `## Result`, the reviewer's `## Review`, and the **Dispatch**, **Review**, **Accept** and **Reopen** buttons. While a worker runs, the row shows run time, tool count and the call it's making now.
- **Dispatch** claims a ready item (moves it to `processing/` with `started`, `claim-id`, `worker-kind: subagent`, `worker-agent`, `dispatched`) and starts one background subagent on it. The worker appends `## Result` and moves the item to `review/` or `blocked/` itself. A toast says where it landed.
- **Drain** (`/inbox drain 3`, or the pane's **Drain ×2** button) keeps N workers busy on ready items, in filename order, never two whose owner-paths overlap, until nothing ready is left.
- **Review** (`/inbox review <item>`, or the button on an item in `review/`) starts a reviewer that verifies the acceptance criteria, commits the worker's files with an `Inbox: <item>` trailer and moves the item to `done/`, or sends it back. **Accept** does the bookkeeping when you reviewed it yourself.
- Workers Claude starts from the `inbox` skill (an Agent whose description is `inbox <item>`) show in the pane too: the mod locks the item and tracks the run. A bare spawn on a todo item is claimed on the way.
- A watchdog flags workers that stop making progress, and per-item locks keep two Claude sessions in one repo off the same item (below).
- **Auto review** (the `autoReview` option, off by default; flip it in `/config` under inbox, or with the pane's **Auto-review** button, hotkey `o`): when a worker lands an item in `review/`, a reviewer starts on it at once, and while draining, items already waiting in `review/` get reviewers within the drain width. Each item is auto-reviewed once per session, so a reviewer that ends without moving its item is not respawned in a loop. The reviewer commits on accept, so turning this on means commits land without a per-item word from you.

| Command | |
|---|---|
| `/inbox` | open the pane |
| `/inbox new [--worker codex\|claude] [--paths a,b] [--after item,item] <title> [-- <goal>]` | add an item from the template, numbered after the highest |
| `/inbox run <item> [<item>…]` | claim each ready item and start its worker; `70` or `70-op-tutorial-step-engine` both name it |
| `/inbox drain [n\|off]` | work ready items n at a time (default 2, max 10) |
| `/inbox status` | one line: ready, waiting, processing, review, blocked, done, and what to run next |
| `/inbox refresh` | find the `inbox/` folder again and re-read every item (`reload` is an alias); says where it looked |
| `/inbox review <item> [<item>…]` | start a reviewer on an item in `review/` (`commit` is an alias) |
| `/inbox accept <item> [<sha>]` | mark an item in `review/` done and move it to `done/` |
| `/inbox reopen <item> [<item>…]` | send an item in `processing/` (no live worker), `review/` or `blocked/` back to todo; its claim fields become `prev-*` |
| `/inbox unlock <item> [--force]` | release a lock this session holds; `--force` releases anyone's |
| `/inbox show <item>` · `/inbox list` | print an item, or all of them with their readiness |

## Item files

`inbox/70-op-tutorial-step-engine.md`:

```markdown
---
status: todo
created: 2026-10-03
owner-paths: packages/game-onepiece/src/tutorial.ts, docs/one-piece-tutorial.md
depends-on: 67-browser-scripts-home-screen
worker: claude
---
# One Piece tutorial: step-scripted chapters

## Goal
...

## Acceptance criteria
- ...
```

The mod reads `status` (the folder decides when it is missing), `owner-paths`, `depends-on`, `worker` and the first `# ` heading, and preserves every other field as written. Files starting with `_` or `.` (`_TEMPLATE.md`, `_claim.lock`) are not items.

An item is **ready** when it is a todo item at the root, every `depends-on` item sits in `review/` or `done/`, no item in `processing/` (or with a live worker here) owns a path that is, contains or lies under one of its owner-paths, and no other session holds its lock.

**Routing.** `worker: codex` or `worker: claude` wins. Otherwise an item whose owner-paths are all front-end code (`apps/client/**`, `apps/landing/**`, `*.css`, `*.tsx`) goes to Codex; anything else, and an item with no owner-paths, goes to Claude.

- Claude items run on the `general-purpose` agent on Sonnet. The brief is the worker rules from the inbox skill with the absolute repo and item paths.
- Codex items run on the `codex-runner` agent (`~/.claude/agents/codex-runner.md`), with `Repo:`, `sandbox: workspace-write`, `slug: <item>`, `resume: <codex-thread>` when the item carries one, and `delay: 20 × position` for the second and later Codex items in a batch (two sandboxes starting in the same second have crashed each other). The runner's report gives `codex-thread` and `codex-run`, which the mod records in the item so a send-back resumes the same thread. The `codexModel` option adds a `model:` line; `CODEX_UI_MODEL` in the environment is the other knob.

Moving a file needs `node` (or `sh` with `mv`) on the PATH: the plugin file API has no rename.

## Watchdog

While a worker runs, the mod polls its conversation (`$.session.messages({ agentId })`, every 3 s) and keeps a heartbeat: the time at which the conversation last changed (a new row, a finished tool call, a result). Rows carry no timestamps, so activity is dated to the poll that saw the change, give or take 3 s. A tool call still in flight is shown as `in Bash 12m` rather than `idle 12m`. The pane row carries the note, the header counts `N idle` and `N timed out`, and each level toasts once (`inbox: 70-engine idle 10m`, `inbox: 70-engine timed out (idle 30m)`).

The timeout is based on idle time, not total run time, so a productive worker is never cut off. A wall-clock cap exists as a separate option and is off by default.

Settings (plugin options, set in `/config` or `pluginConfigs`):

| Option | Default | |
|---|---|---|
| `idleMinutes` | 10 | idle this long: toast once, row turns yellow |
| `timeoutMinutes` | 30 | idle this long: marked timed out (red `!`), toast once, then `onTimeout` runs |
| `maxRunMinutes` | 0 (off) | optional wall-clock cap, treated like a timeout |
| `onTimeout` | `mark` | `mark`, `nudge` or `redeploy` |
| `lockStaleMinutes` | 20 | a lock not refreshed for this long can be taken over |
| `commitTrailer` | `Inbox` | git trailer key for the commit check (`Inbox: <item>`) |
| `codexModel` | (empty) | `model:` line for the codex-runner; empty uses its default |

**The mod cannot stop a subagent.** The plugin API has no stop or kill for subagents, and aborting a turn only reaches the main conversation. So a timeout never kills anything:

- `mark` (default): the row and a toast. To actually stop the worker, use the engine's own background-task view, then **Reopen** or **Dispatch** the item.
- `nudge`: also appends a note to the worker. It reaches the agent only at the top of its next loop.
- `redeploy`: marks the old run `abandoned`, sends the item back to todo and dispatches a fresh worker, at most once per item per session. The old agent may still be running and editing files.

A worker that ends without moving its item (the session's subagents end with the session, too) leaves it in `processing/`: the row says `no agent here`, its last message is kept under `## Result` if it wrote none, and **Reopen** sends it back to todo.

## Locks

Two Claude sessions in one repo share `inbox/`. Before a work or review deployment takes an item, it takes `inbox/.locks/<item>.lock`, one line of JSON:

```json
{"task":"70-engine","phase":"review","session":"<session id>","host":"<COMPUTERNAME>","acquiredAt":"2026-10-03T10:00:00Z","refreshedAt":"2026-10-03T10:04:00Z","nonce":"<session>:<ms>:<rand>","released":false}
```

- A lock this session owns is re-entrant, and survives a plugin reload. Another session's lock that was refreshed within `lockStaleMinutes` blocks: `/inbox run` and `review` refuse, drains skip the item, a model-started `inbox <item>` agent is denied, and the pane shows `⊘ locked by other session`.
- A lock not refreshed for `lockStaleMinutes` is stale: the next deployment takes it over, with a toast.
- Running locks are refreshed every minute and released when the agent settles, a deploy is refused or no agent starts. Release rewrites the file with `"released":true`; the API has no delete.
- `$.fs` has no exclusive create, so taking a lock is write-then-read-back, trusting it only if the nonce is ours. This is a best-effort guard against the usual overlap, not a mutex. The inbox skill's `_claim.lock` is a separate, short-lived handle.
- A repo that gitignores `inbox/` (as tcg-sim does) covers the locks; otherwise add `inbox/.locks/`.

## Commit check

Review commits carry a git trailer, `Inbox: <item>` (the key is `commitTrailer`). Before deploying a reviewer, `/inbox review` runs `git log --all -n 1 --grep '^Inbox: <item>$'`: a hit refuses with `70-engine already committed in abc1234 "subject"`, records `commit: abc1234` in the item and releases the lock. If git fails, the review goes ahead and the answer says the check was skipped. The reviewer's brief repeats the check immediately before committing and ends its report with `COMMIT: <sha>` or `NO-COMMIT: <reason>`; when the item lands in `done/` without a `commit` field, the mod stores the sha.

## Check

```sh
claude plugin validate ./inbox
claude plugin test ./inbox
```
