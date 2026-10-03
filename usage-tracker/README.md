# Usage Tracker

A Claude Code mod that shows your 5-hour and 7-day usage for **Claude Code** and **Codex** in a side pane.

```
● CLAUDE CODE  live
5h  ██████████┃░░░░░░░░░░░░░░   42%
    resets in 2h 13m
    ▁▁▂▃▃▄▅▆ ⚠ hits 100% in 1h 40m

● CODEX  prolite · read 3h ago
7d  ███████████████░░┃░░░░░░░   52%
    resets in 2d 4h
    ▂▂▃▃▄▅▅ pace → ~71% at reset
```

- **Bars** turn green, yellow when you are ahead of even pace, and red at 90%. `┃` marks even pace, where usage would be if you spread the window evenly.
- **Sparklines** show the window's history. History is kept across sessions.
- **Forecast**: projects the recent burn rate to the reset and warns when it will hit 100% first.
- **Status line**: `CC 5h 42% 7d 61% · Codex 7d 52%`.
- **Toast** when a window crosses 90%.

## Data sources

- **Claude Code**: the rate-limit windows from the API responses (`$.session.usage()` and `session.measure`). These appear after the session's first response; the last reading is kept until then.
- **Codex**: the last `rate_limits` record in the newest rollout files under `~/.codex/sessions` (or `$CODEX_HOME/sessions`). It is only as fresh as your last Codex turn. Windows are labelled from `window_minutes`, so an account with only a weekly limit shows only `7d`.

`/usage-tracker` opens the pane. It refreshes every minute.

## Check

```sh
claude plugin validate ./usage-tracker
claude plugin test ./usage-tracker
```
