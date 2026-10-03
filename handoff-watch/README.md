# Handoff Watch

A Claude Code mod that watches how full the context is against the auto-compact point and, at a quiet moment before it gets there, nudges you to have Claude write a session handoff doc. It never calls a model itself: the doc is written by your own session, from a request it puts in your prompt box.

```
◆ context 64% of 160k · 3 turns since last checkpoint
[Write handoff]  [Later]  [Done]

status line:  ctx 64% · handoff 41%
```

## What it shows

- **Status line**: `ctx 64%`, plus `· handoff 41%` once a handoff was made in this context (`handoff ✓` when you marked one with `Done`). Hidden below `showAt`.
- **Band** above the prompt, only while a nudge is open: the fill, its ceiling and how many turns ago the last checkpoint (commit or handoff) was. `Write handoff` fills the prompt, `Later` hides it until the next band, `Done` records a handoff you made yourself.
- **Toast** when a nudge fires, and when an auto-compaction starts with no recent handoff.

Fill is measured against the auto-compact point (read from `$.session.usage({ breakdown: 'summary' })`), not the raw window. If auto-compact is off or the point is unknown it falls back to the window.

## How it decides

Decisions happen only when a main-loop turn ends with an answer. A nudge becomes due at `warnAt` (or `remindEvery` past the last handoff, if later). It fires when the turn was **quiet** (no tool calls) or ended a **git commit**, or after `maxWaitTurns` busy turns. At `urgentAt` it fires at the next turn end regardless. One nudge per band of `remindEvery`; `Later` keeps it away until the next band or the urgent line.

## Commands

`/handoff` puts the request in the prompt (after any draft you have, never over it). `/handoff PROJ-123 [focus]` names the doc `HANDOFF-PROJ-123.md`; `/handoff <focus>` adds a focus line; `/handoff done` marks one; `/handoff status` prints the meter; `/handoff resume` submits the resume prompt for the project's last doc. If `handoff` is a built-in's name the mod registers `/handoff-watch` instead.

## After the doc: clear and resume

Once a handoff doc is written during a turn (by the request above, or any `HANDOFF*.md` write), the end of that turn runs `/clear` (`autoClear`). The `/clear` ends the conversation but keeps the process and the mod, so the mod then submits one prompt into the fresh conversation (`autoResume`): read the doc in full, treat its verified facts as facts and its UNVERIFIED items as open, continue its next steps in order, and say in a line where things stand. The same resume happens after a `/clear` you type yourself in a context where a handoff doc was written. Nothing is submitted after a `/clear` with no handoff behind it.

If `/clear` cannot be run from the mod, a toast says so and the resume stays armed for your own `/clear`. If the resume prompt cannot enter (a dialog is up, the box is busy), it is left in the prompt box for you to send.

## Handoff files

Default `.claude/handoffs/HANDOFF-<yyyy-mm-dd-hhmm>.md`. Any write of a `HANDOFF*.md` / `handoff*.md` anywhere, or any `.md` under the handoff folder, counts as the handoff. Add `.claude/handoffs/` to `.gitignore` if you do not want them committed.

## Compaction

Before a compaction of the main conversation (`auto`, `manual` and `precompute`) the mod appends a `[handoff-watch]` line to the summarizer's instructions, after your own: keep the goal, files, commits, verified vs assumed facts, open questions, next steps, resume commands, and name the latest handoff doc. It is added once. A toast shows on `auto` when no handoff was made near this fill.

**The honest limit:** a plugin cannot pause an auto-compaction while the model writes a doc, and skipping it would leave the conversation over the threshold. So the toast is advisory; the instruction injection and the earlier nudges are the real protection.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `showAt` | 0.3 | Fill below which the status line stays empty |
| `warnAt` | 0.6 | Fill from which a nudge is due |
| `urgentAt` | 0.85 | Fill at which it fires at the next turn end |
| `remindEvery` | 0.15 | Band step after a handoff or nudge |
| `maxWaitTurns` | 3 | Busy turns to wait for a quiet turn or commit; 0 nudges at once |
| `handoffDir` | `.claude/handoffs` | Folder for docs; empty = project root |
| `compactInstructions` | true | Steer compaction summaries |
| `autoClear` | true | Run `/clear` at the end of the turn that wrote a handoff doc |
| `autoResume` | true | After a `/clear` that follows a handoff doc, submit a prompt that reads it and continues |

## Check

```sh
claude plugin validate ./handoff-watch
claude plugin test ./handoff-watch
```
