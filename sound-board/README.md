# Sound Board

A Claude Code mod that plays a distinct sound when a subagent starts, finishes or fails, when Claude asks for permission, when auto mode declines a call, when a long answer is done, and a few more moments. Pick, preview and mute each one from a pane.

```
SOUND BOARD   [ mute ] [ rescan ] [ close ]
on · quiet 22:00-08:00 · player auto · 2 user sounds
Agent starts        rise (agent-spawn)        1: ▶ test
Agent finishes      fall (agent-done)         2: ▶ test
Agent fails         drop (agent-failed)       3: ▶ test
Permission asked    blips (permission-ask)    4: ▶ test
Auto mode denied    buzz (permission-denied)  5: ▶ test
Answer finished     chime (turn-done)         6: ▶ test
...
Drop .wav/.mp3 into ~/.claude/sounds, then r to rescan
```

## Cues

| Cue | When | Default |
| --- | --- | --- |
| `agent.spawn` | a subagent starts | rising two-tone |
| `agent.done` | a subagent this session started answers | falling two-tone |
| `agent.failed` | such a subagent ends in an error or a refusal | low drop |
| `permission.ask` | a permission dialog is put to you | triple blip |
| `permission.autoDenied` | auto mode declined a call | low buzz |
| `turn.done` | a main answer took at least `minTurnSeconds` | chime |
| `turn.failed` | a main turn ended in an error or a refusal | sink |
| `session.compactAuto` | an automatic compaction ran | downward sweep |
| `session.end` | you leave the session (not `/clear`) | three descending notes |
| `tool.longBash` | a foreground Bash or PowerShell call ran at least `longToolSeconds` | two pings |

Interrupted turns are silent. One sound per cue within `cooldownMs`, so five spawns at once play once; when two cues land in the same instant the higher-priority one is heard (a denial over a spawn).

Also built in, for you to assign: `pop`, `bell`, `tick`. The status line shows `🔇 muted`, `🔇 until 10:30`, `🔇 quiet until 08:00` or `🔇 off` while sounds are held back.

## Your own sounds

Put `.wav` or `.mp3` files (up to 4 MiB) in `~/.claude/sounds`, then press `r` in the pane or run `/sounds rescan`. They appear in every picker marked with a star. A cue whose file was deleted plays its default and the pane marks it `(missing)`.

## Commands

`/sounds [list | test <cue> | set <cue> <sound> | mute [on|off|30m|2h|1h30m] | rescan]`

- no arguments opens the pane.
- `test spawn` plays a cue now, through mute and quiet hours.
- `set agent.done my ding` picks a file by name (case and extension optional), `set done bell` a built-in, `set done off` silences it, `set done default` resets it.
- `mute` toggles, `mute on` mutes until you unmute, `mute 30m` for a while.

Cue names are the full id or the part after the dot (`spawn`, `done`, `failed`, `ask`, `denied`, `compact`, `end`, `long`). If another command already owns `sounds`, the mod registers `/sound-board` instead. Inside the workbench the pane takes its own slot.

## Options

Set in `/config` or in mod-menu: `enabled`, `volume` (0-200), `quietHours` (`22:00-08:00`, local time), `minTurnSeconds`, `speak` (say "agent done: <description>"), `cooldownMs`, `player`, `subagentScope` (`all` or `top`), `askVia` (`dialog` or `check`), `longToolSeconds`.

## Players

The engine's `$.audio.play` makes no sound in a Windows or Linux terminal. So on Windows (`player: auto`) the mod runs a fixed PowerShell script: `System.Media.SoundPlayer` for `.wav`, `MediaPlayer` for `.mp3`. The file path and volume go in through environment variables, never into the script. Elsewhere it uses the engine's player. `volume` does not apply to `.wav` files under PowerShell (SoundPlayer has no volume); it does for `.mp3` and for the engine player. Regenerate the built-in sounds with `python scripts/make-sounds.py` (`--check` verifies them).

## Honest limits

- `permission.autoDenied` relies on the `PermissionDenied` event and, as a fallback, on the classifier's wording in a refused tool result.
- `permission.ask` is the dialog being shown to you, not the classifier's verdict. `askVia: check` fires on every engine verdict of "ask", which is noisy in auto mode.
- The engine's player cannot tell a played clip from a skipped one, so a silent surface looks like success; only a rejection raises the single "audio unavailable" toast.
- The session-end sound is played inline for at most about 0.6 s and may be cut short when the process exits.
- Remote surfaces (a phone) do not hear sound played on the host.
- Quiet hours use the machine's local time.

## Check

```sh
claude plugin validate ./sound-board
claude plugin test ./sound-board
python sound-board/scripts/make-sounds.py --check
```
