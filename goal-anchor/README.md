# Goal Anchor

A Claude Code mod that remembers what the session is for, notices when Claude has spent several turns somewhere else, and nudges it back.

```
status line   goal: fix video-generation… · 6 turns away · 1 open Q

◆ goal: Fix the video-generation select/button bug in GenerationForm
  6 turns on environment work since it was last touched
  ? "should this be in a worktree?" · unanswered for 3 turns
  [ Back to goal ]  [ Make latest prompt the goal ]  [ Snooze ]  [ Answered ]
```

- **Anchor**: the first substantive prompt (a real ask, not `hi`, `continue` or a slash command, typed by you rather than a notification or schedule) becomes the session goal. `/goal-anchor <text>` sets it by hand.
- **Drift**: every finished turn is classed as on the goal, prerequisite (ports, installs, SDK versions, file locks) or other. Edits to files that match the goal's words, or tool calls that mention them, count as on goal. A turn of environment tools stays off goal even if the reply talks about the goal. Aborted turns and subagent turns do not count.
- **Confirm**: at 5 turns away one Haiku call confirms the label (GOAL, PREREQUISITE or OTHER). GOAL resets the count and teaches the anchor the file names edited during the streak. If the model is unavailable the heuristic alone raises the alarm.
- **Questions**: direct questions in your prompts are tracked until a reply covers their keywords. One still open after 2 more turns gets one Haiku check, then shows in the band.
- **Status line**: goal label, turns away, open questions.
- **Toast** once per drift streak.
- **System prompt**: one static 4-line section while a goal exists. It changes only when the goal does, so the prompt cache holds.
- **Next prompt**: the drift nudge and any unanswered questions ride along as hidden per-prompt context, not in the system prompt.

## How it decides

Pure logic lives in `hooks/anchor.ts`, wiring in `hooks/register.tsx`.

- Words: lowercase, camelCase and path splits, a stopword list plus coding filler (`fix`, `bug`, `file`), naive stemming.
- A turn is on goal when it edits a file whose name hits the goal's words or learned vocabulary, when its tool calls hit at least 2 goal words (1 if the goal has at most 2), or when it used no tools and the reply hits at least 2. It is a prerequisite when at least half its tool calls look like environment work.
- Cost: the heuristic is free and counts every turn. Haiku (`effort: low`, 16 tokens) runs at most once per drift crossing and once per stale question, scheduled off `turn.complete` with `$.clock.after(0, ...)` and never awaited inside the hook.
- Known miss: a question phrased as a statement, such as "the port is 3001?".
- Turns that finish while a model check is in flight are not counted, to keep the check from feeding itself.

## Commands

`/goal` is a built-in name, so Claude Code refuses it and the mod registers **`/goal-anchor`** instead (the handler answers both names, should `/goal` ever be free).

- `/goal-anchor` shows the goal, drift and open questions
- `/goal-anchor <text>` sets the goal and resets drift
- `/goal-anchor off` stops tracking for this session
- `/goal-anchor answered <n|all>` marks questions answered

Band buttons: `g` back to goal (fills the prompt, never submits), `m` make the latest prompt the goal, `s` snooze for 5 more turns, `a` dismiss the questions shown.

## Check

```
claude plugin validate C:\code\cc-mods\goal-anchor
claude plugin test C:\code\cc-mods\goal-anchor
npx -y -p typescript tsc -p C:\code\cc-mods\goal-anchor
```

Add the folder to `CLAUDE_CODE_PLUGIN_DIRS` to load it. State is per session and is reset by `/clear`.
