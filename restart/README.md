# Restart

A Claude Code mod that adds `/restart`: it runs `/exit`, and once your shell prompt is back it types `claude -c` into the same terminal and presses Enter, so the conversation continues in a fresh process. Use it after adding a mod to `CLAUDE_CODE_PLUGIN_DIRS`, after a Claude Code update, or whenever a mod needs a full reload.

```
> /restart
restart: helper started; exiting now, then "claude -c".
… Claude exits, the shell prompt appears, "claude -c" is typed …
restart: back via "claude -c"
```

## How it works

A process cannot relaunch itself after it has exited, so the mod starts a small helper first:

1. `/restart` spawns `restart.py` through `cmd /c start /b`, which puts it outside Claude's process tree (so Claude's exit does not take it down) while keeping it attached to the same console.
2. The mod runs `/exit` (falling back to typing `/exit` into the prompt when the command is not runnable).
3. The helper polls the console's process list until no `claude.exe` is attached, waits `settleMs` (400 ms) for the shell to draw its prompt, then writes the relaunch command and an Enter into the console input buffer with `WriteConsoleInputW`. To the shell that is indistinguishable from typing.
4. The new session's `session.start` sees the note the old one left in the store and toasts that it is back.

The helper writes a short log to `%TEMP%\claude-restart.log` (start, what it saw on the console, whether the write succeeded).

## Commands

- `/restart` exits and relaunches with the configured command, `claude -c` by default.
- `/restart fresh` relaunches with plain `claude`, a new conversation.
- `/restart <args>` relaunches as `claude <args>`, for example `/restart -r` or `/restart --model opus`.
- `/restart help`.

`/restart-claude` stands in where the engine refuses the first name.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `python` | `python.exe` | What runs the helper; a name on PATH or a full path |
| `command` | `claude -c` | What is typed after the exit |
| `settleMs` | 400 | Pause between Claude's exit and the typing |

## Limits

- Windows only: the helper uses the Win32 console API. On another OS the command reports that the helper could not start and exits nothing.
- The typing goes to whatever reads the console once Claude is gone. In an ordinary shell (PowerShell, cmd, Git Bash, under Windows Terminal or Warp) that is the shell's prompt. If Claude was started by a wrapper script that exits with it, the typing lands wherever that wrapper returned to.
- If the shell has not drawn its prompt within `settleMs`, the keystrokes still queue in the console input buffer and are read when it does; the pause only keeps the echo tidy.
- The helper gives up after two minutes if Claude never exits (a dialog held it open, say). Nothing is typed then.
- `claude -c` continues the most recent conversation in the current directory, so run `/restart` from the session you want to continue.
