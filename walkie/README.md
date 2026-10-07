# Walkie

Push-to-talk to Claude Code from any app. Hold a key while you game, talk, let go: the words arrive in your Claude Code session as a prompt, and the answer is read aloud. Claude Code never needs focus.

```
you (holding F13)  ──mic──▶  walkie.py  ──whisper──▶  ~/.claude/walkie/drops/<ms>.txt
                                                                 │
                                                         walkie mod polls
                                                                 ▼
                                                     $.prompt.submit(transcript)
                                                                 │
                                                          Claude answers
                                                                 ▼
walkie.py ◀──reads aloud──  ~/.claude/walkie/replies/<ms>.txt  ◀──  turn.complete
```

Two parts:

- **`walkie.py`** runs outside Claude Code. It hooks a global key, records the microphone while the key is held, transcribes with a local faster-whisper model on your GPU, and drops the text as a file. It also watches the replies folder and speaks each one with the Windows speech synthesizer.
- **The mod** polls the drop folder every half second, submits each new transcript as a turn of its own (in your own words, with a short hint that the answer will be read aloud), and writes the answer of that turn to the replies folder.

Claude Code's built-in `/voice` dictation is a terminal keypress, so it only works while the terminal has focus. Walkie exists for when it does not.

## Setup

Needs Python 3.12 with `faster-whisper`, `sounddevice`, `keyboard` and `numpy`, plus CUDA for the GPU (CPU works with `recorderArgs` set to `--device cpu --compute int8 --model small`).

1. In your mouse software, bind the spare button to **F13** (any key works; set `recorderArgs` to `--key f14` or the like).
2. The mod loads with the rest of `C:\code\cc-mods` through `CLAUDE_CODE_PLUGIN_DIRS`. On session start it starts `walkie.py` itself, as a child that lives as long as the session, and toasts `walkie: ready: hold F13 to talk` once the model is loaded. The status line shows `🎙 walkie` while a recorder is alive.

Hold the button, talk, let go. Beeps: high on record start, two-tone when the drop is written, low when nothing was heard. Press the button again while a reply is being read to cut it off.

You can also run the recorder by hand in its own window, `C:\code\cc-mods\walkie\walkie.cmd`; the mod sees its heartbeat and does not start a second one. A second recorder on the same folder exits at once with code 3.

If the game runs elevated (most anti-cheat does), the recorder must be elevated too, or the keyboard hook never sees the key: run Claude Code elevated, or run `walkie.cmd` from an elevated window.

## Several sessions

Only one session answers the drops: the first one up writes `owner.txt` and refreshes it while it lives. The others leave the folder alone, show no walkie status, and take over within 15 seconds of the owner closing. `/walkie take` moves ownership to the session you are in. The owner is also the session that starts the recorder.

## Commands

```
/walkie             status: recorder, owner, folder, drops handled
/walkie pause       ignore drops until resumed (mute)
/walkie resume      listen again; drops made while paused are skipped
/walkie say <text>  have the recorder read <text> aloud (tests the speaker)
/walkie drop <text> write a drop by hand, as if spoken (tests the loop without a mic)
/walkie start       start the recorder from this session
/walkie stop        stop the recorder this session started; no auto-start until /walkie start
/walkie log         the recorder's last lines
/walkie take        make this session the one that answers the drops
```

## Options

`walkie.py --help` lists the recorder's flags: `--key`, `--model` (`large-v3` default; `small` is far lighter when the game wants the GPU), `--mic`, `--language`, `--no-speak`, `--rate`, `--suppress`. Pass them through the mod's `recorderArgs`.

The mod's `userConfig`:

| key | default | what |
| --- | --- | --- |
| `folder` | `~/.claude/walkie` | the exchange folder, shared with the recorder's `--folder` |
| `pollMs` | 500 | how often the drop folder is listed |
| `asUser` | true | submit the words as your own, without the plugin frame |
| `speakReplies` | true | write each answer to `replies/` for the recorder to speak |
| `hint` | "Spoken over push-to-talk…" | appended in parentheses to each voice prompt; empty for none |
| `autoStart` | true | the owning session starts `walkie.py` when no recorder is alive |
| `python` | `python.exe` | what runs `walkie.py` |
| `recorderArgs` | empty | extra flags for `walkie.py` |

## How a reply finds its turn

The mod remembers each transcript it submitted. When a turn starts whose prompt contains those words, the turn is the drop's; when that turn completes with an answer, the answer is written as `replies/<same stem>.txt`. Turns you type get no reply file. Drops older than the session's start, and drops made while paused, are never replayed.

## Check

```sh
claude plugin validate ./walkie
claude plugin test ./walkie
python walkie/walkie.py --list-devices
```
