# gb-pane

Play Game Boy and Game Boy Color games in a side pane of [Claude Code](https://claude.com/claude-code) while Claude works. Type `/gb <rom>`, play while Claude thinks, and the game pauses itself when Claude finishes or needs you: a permission prompt, a question, a plan to approve.

It is a sibling of [nes-pane](../nes-pane) and [doom-pane](https://github.com/tylergraydev/doom-pane): a small native helper runs the emulator ([binjgb](https://github.com/binji/binjgb) by Ben Smith) and streams terminal-cell frames into the pane.

> **Status:** Windows only (the helper is a Windows executable). Built against Claude Code 2.1.288's early-access mod (function hooks) API, which may change between releases.

## Install

```sh
claude --plugin-dir C:\code\cc-mods\gb-pane
```

Then type `/gb` in a terminal wide enough for a side pane (or press **show** for gb-pane in mod-menu, which runs `/gb`). If something else already owns `/gb`, the command is `/gb-pane`.

## Try it

The mod ships no games. To see it work, generate its own test ROM (stripes in four shades that scroll, a background that turns red while A is held and blue while B is):

```sh
python native/test/make_rom.py run/test.gbc --cgb
```

and type `/gb`: the picker lists it, since it sits in `run/`. Leave out `--cgb` (and name it `test.gb`) for a plain Game Boy ROM, where A turns the screen black and B white. For anything else, bring your own legally owned `.gb` / `.gbc` ROMs (or `.zip` files holding them).

## Play

### Picking a ROM

`/gb` with nothing running always opens the pane, on a picker: **Game Boy · pick a ROM**, then one row per ROM it found, each with a dim tag saying what it is and where it came from, such as `gbc · romDir`. The kind (`gb`, `gbc` or `zip`) tells `Tetris.gb` and `Tetris.gbc` apart.

| Source | Where |
|---|---|
| `recent` | ROMs you played before (still on disk), newest first |
| `romDir` | `.gb`, `.gbc` and `.zip` files in the ROM folder option (that folder only, not its subfolders) |
| `run` | `.gb`, `.gbc` and `.zip` files in the mod's `run/roms` and `run` folders (where unzipped ROMs land) |

Click a row, or press its digit (`1`-`9`, the first nine rows) while the pane has the keyboard. `f` refreshes the list and `x` closes the pane. With nothing found it says so: put `.gb`, `.gbc` or `.zip` files in a folder and set `romDir`, or type `/gb <path>`.

Whether a game runs as a Game Boy, a Game Boy Color or a Super Game Boy is read from its header, never from the file's extension.

### Zipped ROMs

A `.zip` (from the picker or `/gb <path>.zip`) is unzipped with Windows' own `C:\Windows\System32\tar.exe` into `run/roms/<zip name>/`. One `.gb` or `.gbc` inside plays at once (and is what the recent list remembers); several (a `x.gb` and a `x.gbc` too) are added to the picker; none says `No .gb or .gbc file inside <zip>.` `tar.exe` is the only process the mod runs besides its own helper.

### In the side pane

Picking a ROM gives the pane the keyboard. Press any control to start.

| Hotkey | Button | Hotkey | Button |
|---|---|---|---|
| W / A / S / D | D-pad | J | B |
| K | A | P | Start |
| O | Select | Q / E | hold ← / hold → (press again to let go) |
| R | hold B | | |

**Arrows, Enter and Backspace:** click the line under the picture once. That line then catches keys until Esc:

| Key | Button | Key | Button |
|---|---|---|---|
| ← ↑ → ↓ or W A S D | D-pad | Z or J | B |
| X or K | A | Enter | Start |
| Backspace or `` ` `` | Select | Shift+← / Shift+→ | hold ← / hold → |
| Shift+↑ / Shift+↓ | let go of a held direction | | |

Esc hands the keyboard back to the Claude prompt and pauses the game.

**Why the holds:** a terminal reports key presses but not releases, and repeats only the last key held. So a press holds its button for a moment (a little longer for the D-pad), and an auto-repeat keeps it held. To walk right and hold B while you press A, latch the direction (E) and B (R), then press K. A plain arrow, or the other direction's latch, lets a held direction go.

### In a window: `/gb window`

Opens the game in its own window, 640×576 (4× the 160×144 picture), with the real keyboard, presses and releases: arrows, Z/J for B, X/K for A, Enter for Start, Backspace or right Shift for Select. It still pauses with Claude; any key in the window resumes. Close it or type `/gb window off` to go back to the pane alone.

### With a controller

Any XInput (Xbox-style) controller works in the pane and the window, without either having the focus, with every button held at once.

| Controller | Game Boy | Controller | Game Boy |
|---|---|---|---|
| D-pad or left stick | D-pad | A or Y | A |
| B or X | B | Start | Start |
| Back | Select | | |

A button that resumes a paused game does not also act in the game.

## Commands

| Command | Does |
|---|---|
| `/gb <rom>` | open a ROM: a path to a `.gb`, `.gbc` or `.zip`, or a name found in the ROM folder (exact, then a unique prefix, then a unique part; a name that matches both a `.gb` and a `.gbc` asks for more) |
| `/gb` | reopen the running game; otherwise open the pane on the ROM picker |
| `/gb list` | the picker's ROMs as text (recent, ROM folder, `run`), and the picker opened when no game is running |
| `/gb save [1-9]` / `/gb load [1-9]` | save or load a state slot (slot 1 when left out) |
| `/gb window` / `/gb window off` | the game in its own window, or not |
| `/gb hd on` / `/gb hd off` | 2×2 or 1×2 pixels per terminal cell (remembered) |
| `/gb quit` | stop the game |

## Pausing

The game pauses when Claude's turn ends, when a tool call needs your permission, when Claude asks a question or presents a plan, when you leave the pane (Esc or closing it), and after a while without input (30 seconds by default). Any game key resumes; that key does not also act in the game.

## Options

Set them in `/config` under gb-pane.

| Option | Default | Does |
|---|---|---|
| ROM folder (`romDir`) | empty | the folder `/gb <name>` searches and the picker lists (`.gb`, `.gbc` and `.zip`) |
| Sharper picture (`hd`) | on | 2×2 pixels per cell (quadrant glyphs); off draws 1×2 half blocks |
| Idle pause (`idlePauseSeconds`) | 30 | pause after this long with no key or controller input; 0 never |

## Picture quality

The pane draws the game with block characters, box-filtered, and keeps the Game Boy's 10:9 shape. At 80 columns the picture is 80×36 cells: 160×72 pixels with quadrant glyphs (2 across and 2 down a cell), against the Game Boy's 160×144, so every second line is averaged in. Small text blurs. A smaller terminal font or a taller pane gives a sharper picture.

Colours: Game Boy Color games show their palettes uncorrected (each 5-bit channel scaled straight to 8 bits, so they look brighter and more saturated than on the real screen); Game Boy games show four grays; games flagged for the Super Game Boy get binjgb's SGB palettes. There is no Game Boy Color-style automatic colouring of plain Game Boy games.

Real pixels in the pane would need a terminal with the kitty graphics protocol (kitty, Ghostty), and the desktop app draws neither `Raster` nor `Image`: there the pane says the Game Boy plays in the terminal. `/gb window` is the full-resolution option.

## Saves

Battery saves and state slots live in `run/saves`, named after the ROM and its CRC (`<name>-<crc>.sav`, `<name>-<crc>.state1`...). The `.sav` holds the cartridge RAM alone, its size the cartridge's (2, 8, 32, 64 or 128 KiB; 512 bytes for MBC2), and is written when you quit and every few seconds while it changes. A `.sav` from another emulator with a 44- or 48-byte real-time-clock footer is read without the footer; a `.sav` of any other size is moved aside to `.sav.old` rather than overwritten.

Save states are tied to this build of the helper: a rebuilt `gb-cc.exe` may refuse an older state ("state is from another ROM or build"). States do keep the MBC3 clock.

## Supported games

Cartridges without a mapper, MBC1 (and MBC1 multicarts), MBC2, MBC3 (with or without its clock), MBC5 (rumble ignored), MMM01 and HuC1, which between them cover nearly the whole Game Boy and Game Boy Color library. No boot ROM is needed. Refused with a message: MBC6, MBC7, the Pocket Camera, TAMA5, HuC3, any unknown cartridge type, files that are not Game Boy ROMs (a `.gba` among them), and files over 8 MiB.

## What's rough

- No sound: binjgb emulates the audio unit, but there is no way to play it from the helper into Claude Code yet, so the samples are thrown away.
- No link cable, Game Boy Printer or Camera.
- The MBC3 real-time clock runs only while the game does and is not kept in the `.sav`: Pokémon Gold, Silver and Crystal lose the time between sessions (a save state keeps it).
- Plain Game Boy games are gray; no automatic colouring.
- Game Boy Color support is, in binjgb's own words, "hacky-but-passable": some games show glitches.
- Super Game Boy games can blank the screen briefly when they mask it (the SGB's `MASK_EN`); borders are not shown.
- No key releases from the terminal: holds are timed, and hold-plus-press needs the latches. The controller and `/gb window` have real holds.
- One click is needed before arrows, Enter and Backspace work in the pane.
- Input-to-picture latency is roughly 50–80 ms; the pane shows about 30 frames a second (the game runs at 59.7).
- Save states break across rebuilds of the helper.
- Windows only.

## How it works

```
Claude Code ─ hooks/register.tsx ── run/ctrl.txt ──► native: gb-cc.exe (binjgb)
   pane: Raster cells ◄── stdout: frames, status lines ──┘
```

- **`hooks/`** is the Claude Code mod. `register.tsx` registers `/gb`, draws the pane (the ROM picker, or a `Raster` of terminal cells, the key-catcher line and the controls), unzips `.zip` ROMs with `tar.exe` and pauses on `turn.complete`, `tool.check` asks, `AskUserQuestion`, `ExitPlanMode`, Esc and idle time. `gb.ts` holds the pure parts (commands, the control file's text, frames, key tables, ROM lookup, the picker's merged list). `pad.tsx` is the key catcher, a `Client` that posts the keys it gets.
- **`native/`** is the helper.
  - `gb-cc.c` checks the cartridge header, runs binjgb at 59.73 Hz, packs every second frame into terminal cells, reads the control file (size, play/pause, buttons, save slots) and keeps battery RAM and save states.
  - `cc_window.c` is the pop-out window; `cc_pad.c` reads the controller (both adapted from doom-pane).
  - `binjgb/` is the vendored emulator core, with one edit (see `binjgb/VENDORED.md`).

## Build

`bin/gb-cc.exe` is prebuilt. To build it yourself you need the Visual Studio 2022 Build Tools (C++). From Git Bash:

```sh
cmd //c 'native\build.cmd'   # writes bin/gb-cc.exe
sh native/test/protocol.sh   # generated ROMs: play, holds, pause, resize, save/load, quit, DMG, battery (MBC1, MBC3, MBC2), MBC5, errors
claude plugin validate .
claude plugin test .
```

## License

MIT; see [LICENSE](LICENSE). binjgb is MIT too ([native/binjgb/LICENSE](native/binjgb/LICENSE)), with the gb-pane edit listed in [native/binjgb/VENDORED.md](native/binjgb/VENDORED.md). `cc_pad.c` and `cc_window.c` are adapted from the author's doom-pane. Game Boy is a trademark of Nintendo; this project is not affiliated with Nintendo or Anthropic.
