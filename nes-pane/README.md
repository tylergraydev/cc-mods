# nes-pane

Play NES games in a side pane of [Claude Code](https://claude.com/claude-code) while Claude works. Type `/nes <rom>`, play while Claude thinks, and the game pauses itself when Claude finishes or needs you: a permission prompt, a question, a plan to approve.

It is a sibling of [doom-pane](https://github.com/tylergraydev/doom-pane): a small native helper runs the emulator ([agnes](https://github.com/kgabis/agnes)) and streams terminal-cell frames into the pane.

> **Status:** Windows only (the helper is a Windows executable). Built against Claude Code 2.1.288's early-access mod (function hooks) API, which may change between releases.

## Install

```sh
claude --plugin-dir C:\code\cc-mods\nes-pane
```

Then type `/nes` in a terminal wide enough for a side pane (or press **show** for nes-pane in mod-menu, which runs `/nes`). If something else already owns `/nes`, the command is `/nes-pane`.

## Try it

The mod ships no games. To see it work, generate its own test ROM (stripes, a backdrop that turns red while A is held and blue while B is):

```sh
python native/test/make_rom.py run/test.nes
```

and type `/nes`: the picker lists it, since it sits in `run/`. For anything else, bring your own legally owned `.nes` ROMs (or `.zip` files holding them).

## Play

### Picking a ROM

`/nes` with nothing running always opens the pane, on a picker: **NES · pick a ROM**, then one row per ROM it found, each with a dim tag saying where it came from.

| Tag | Where |
|---|---|
| `recent` | ROMs you played before (still on disk), newest first |
| `romDir` | `.nes` and `.zip` files in the ROM folder option (that folder only, not its subfolders) |
| `run` | `.nes` and `.zip` files in the mod's `run/roms` and `run` folders (where unzipped ROMs land) |

Click a row, or press its digit (`1`-`9`, the first nine rows) while the pane has the keyboard. `f` refreshes the list and `x` closes the pane. With nothing found it says so: put `.nes` or `.zip` files in a folder and set `romDir`, or type `/nes <path>`.

### Zipped ROMs

A `.zip` (from the picker or `/nes <path>.zip`) is unzipped with Windows' own `C:\Windows\System32\tar.exe` into `run/roms/<zip name>/`. One `.nes` inside plays at once (and is what the recent list remembers); several are added to the picker; none says `No .nes file inside <zip>.` `tar.exe` is the only process the mod runs besides its own helper.

### In the side pane

Picking a ROM gives the pane the keyboard. Press any control to start.

| Hotkey | Button | Hotkey | Button |
|---|---|---|---|
| W / A / S / D | D-pad | J | B |
| K | A | P | Start |
| O | Select | Q / E | hold ← / hold → (press again to let go) |
| R | hold B (run) | | |

**Arrows, Enter and Backspace:** click the line under the picture once. That line then catches keys until Esc:

| Key | Button | Key | Button |
|---|---|---|---|
| ← ↑ → ↓ or W A S D | D-pad | Z or J | B |
| X or K | A | Enter | Start |
| Backspace or `` ` `` | Select | Shift+← / Shift+→ | hold ← / hold → |
| Shift+↑ / Shift+↓ | let go of a held direction | | |

Esc hands the keyboard back to the Claude prompt and pauses the game.

**Why the holds:** a terminal reports key presses but not releases, and repeats only the last key held. So a press holds its button for a moment (a little longer for the D-pad), and an auto-repeat keeps it held. To walk right and run while you jump, latch the direction (E) and B (R), then jump with K. A plain arrow, or the other direction's latch, lets a held direction go.

### In a window: `/nes window`

Opens the game in its own window at full resolution with the real keyboard, presses and releases: arrows, Z/J for B, X/K for A, Enter for Start, Backspace or right Shift for Select. It still pauses with Claude; any key in the window resumes. Close it or type `/nes window off` to go back to the pane alone.

### With a controller

Any XInput (Xbox-style) controller works in the pane and the window, without either having the focus, with every button held at once.

| Controller | NES | Controller | NES |
|---|---|---|---|
| D-pad or left stick | D-pad | A or Y | A |
| B or X | B | Start | Start |
| Back | Select | | |

A button that resumes a paused game does not also act in the game.

## Commands

| Command | Does |
|---|---|
| `/nes <rom>` | open a ROM: a path to a `.nes` or `.zip`, or a name found in the ROM folder (exact, then a unique prefix, then a unique part) |
| `/nes` | reopen the running game; otherwise open the pane on the ROM picker |
| `/nes list` | the picker's ROMs as text (recent, ROM folder, `run`), and the picker opened when no game is running |
| `/nes save [1-9]` / `/nes load [1-9]` | save or load a state slot (slot 1 when left out) |
| `/nes window` / `/nes window off` | the game in its own window, or not |
| `/nes hd on` / `/nes hd off` | 2×2 or 1×2 pixels per terminal cell (remembered) |
| `/nes quit` | stop the game |

## Pausing

The game pauses when Claude's turn ends, when a tool call needs your permission, when Claude asks a question or presents a plan, when you leave the pane (Esc or closing it), and after a while without input (30 seconds by default). Any game key resumes; that key does not also act in the game.

## Options

Set them in `/config` under nes-pane.

| Option | Default | Does |
|---|---|---|
| ROM folder (`romDir`) | empty | the folder `/nes <name>` searches and the picker lists (`.nes` and `.zip`) |
| Sharper picture (`hd`) | on | 2×2 pixels per cell (quadrant glyphs); off draws 1×2 half blocks |
| Idle pause (`idlePauseSeconds`) | 30 | pause after this long with no key or controller input; 0 never |

## Picture quality

The pane draws the game with block characters, 2×2 pixels per terminal cell, box-filtered, so detail depends on the pane's size: about 160×60 pixels at 80 columns, against the NES's 256×224 (the 8-line overscan is cropped at top and bottom). Small HUD text blurs. A smaller terminal font or a wider pane gives a sharper picture.

Real pixels in the pane would need a terminal with the kitty graphics protocol (kitty, Ghostty), and the desktop app draws neither `Raster` nor `Image`: there the pane says the NES plays in the terminal. `/nes window` is the full-resolution option.

## Saves

Battery saves (games with battery RAM on mappers 1 and 4) and state slots live in `run/saves`, named after the ROM and its CRC. Battery RAM is written when you quit and every few seconds while it changes. Save states are tied to this build of the helper: a rebuilt `nes-cc.exe` may refuse an older state ("state is from another ROM or build").

## Supported games

Mappers 0 (NROM), 1 (MMC1), 2 (UxROM), 3 (CNROM), 4 (MMC3) and 7 (AxROM). Together these cover most of the US library (a common estimate is around 80%; unverified). Other mappers are refused with a message. PAL games run at NTSC speed. A `.zip` is unzipped into `run/roms` first (see Zipped ROMs).

## What's rough

- No sound: agnes has no audio unit yet.
- No key releases from the terminal: holds are timed, and run-plus-jump needs the latches. The controller and `/nes window` have real holds.
- One click is needed before arrows, Enter and Backspace work in the pane.
- Input-to-picture latency is roughly 50–80 ms; the pane shows about 30 frames a second.
- agnes is a small core: some games show PPU timing glitches or MMC3 IRQ edge cases, and some may not run at all.
- Save states break across rebuilds of the helper.
- Windows only.

## How it works

```
Claude Code ─ hooks/register.tsx ── run/ctrl.txt ──► native: nes-cc.exe (agnes)
   pane: Raster cells ◄── stdout: frames, status lines ──┘
```

- **`hooks/`** is the Claude Code mod. `register.tsx` registers `/nes`, draws the pane (the ROM picker, or a `Raster` of terminal cells, the key-catcher line and the controls), unzips `.zip` ROMs with `tar.exe` and pauses on `turn.complete`, `tool.check` asks, `AskUserQuestion`, `ExitPlanMode`, Esc and idle time. `nes.ts` holds the pure parts (commands, the control file's text, frames, key tables, ROM lookup, the picker's merged list). `pad.tsx` is the key catcher, a `Client` that posts the keys it gets.
- **`native/`** is the helper.
  - `nes-cc.c` runs agnes at 60.1 Hz, packs every second frame into terminal cells, reads the control file (size, play/pause, buttons, save slots) and keeps battery RAM and save states.
  - `cc_window.c` is the pop-out window; `cc_pad.c` reads the controller (both adapted from doom-pane).
  - `agnes/` is the vendored emulator core, with mappers 3 and 7 added (see `agnes/VENDORED.md`).

## Build

`bin/nes-cc.exe` is prebuilt. To build it yourself you need the Visual Studio 2022 Build Tools (C++). From Git Bash:

```sh
cmd //c native\build.cmd     # writes bin/nes-cc.exe
sh native/test/protocol.sh   # generated ROMs: play, hold, pause, resize, save/load, quit, battery, mappers 3 and 7, errors
claude plugin validate .
claude plugin test .
```

## License

MIT; see [LICENSE](LICENSE). agnes is MIT too ([native/agnes/LICENSE](native/agnes/LICENSE)), with the nes-pane edits listed in [native/agnes/VENDORED.md](native/agnes/VENDORED.md). `cc_pad.c` and `cc_window.c` are adapted from the author's doom-pane. NES is a trademark of Nintendo; this project is not affiliated with Nintendo or Anthropic.
