# gba-pane

Play Game Boy Advance games in a side pane of [Claude Code](https://claude.com/claude-code) while Claude works. Type `/gba <rom>`, play while Claude thinks, and the game pauses itself when Claude finishes or needs you: a permission prompt, a question, a plan to approve.

It is a sibling of [nes-pane](../nes-pane) and [doom-pane](https://github.com/tylergraydev/doom-pane): a small native helper runs the emulator ([mGBA](https://mgba.io)'s core) and streams terminal-cell frames into the pane.

> **Status:** Windows only (the helper is a Windows executable). Built against Claude Code 2.1.288's early-access mod (function hooks) API, which may change between releases.

## Install

```sh
claude --plugin-dir C:\code\cc-mods\gba-pane
```

Then type `/gba` in a terminal wide enough for a side pane (or press **show** for gba-pane in mod-menu, which runs `/gba`). If something else already owns `/gba`, the command is `/gba-pane`.

## Try it

The mod ships no games. To see it work, generate its own test ROM (green bands scrolling up, which turn red while A is held, blue for B, white for L and yellow for R):

```sh
python native/test/make_rom.py run/test.gba
```

and type `/gba`: the picker lists it, since it sits in `run/`. For anything else, bring your own legally owned `.gba` ROMs (or `.zip` files holding them).

**No BIOS needed.** mGBA's built-in replacement BIOS runs instead of Nintendo's, so there is no boot logo: games start straight away.

## Play

### Picking a ROM

`/gba` with nothing running always opens the pane, on a picker: **GBA · pick a ROM**, then one row per ROM it found, each with a dim tag saying where it came from.

| Tag | Where |
|---|---|
| `recent` | ROMs you played before (still on disk), newest first |
| `romDir` | `.gba` and `.zip` files in the ROM folder option (that folder only, not its subfolders) |
| `run` | `.gba` and `.zip` files in the mod's `run/roms` and `run` folders (where unzipped ROMs land) |

Click a row, or press its digit (`1`-`9`, the first nine rows) while the pane has the keyboard. `f` refreshes the list and `x` closes the pane. With nothing found it says so: put `.gba` or `.zip` files in a folder and set `romDir`, or type `/gba <path>`.

### Zipped ROMs

A `.zip` (from the picker or `/gba <path>.zip`) is unzipped with Windows' own `C:\Windows\System32\tar.exe` into `run/roms/<zip name>/`. One `.gba` inside plays at once (and is what the recent list remembers); several are added to the picker; none says `No .gba file inside <zip>.` `tar.exe` is the only process the mod runs besides its own helper.

### In the side pane

Picking a ROM gives the pane the keyboard. Press any control to start.

| Hotkey | Button | Hotkey | Button |
|---|---|---|---|
| W / A / S / D | D-pad | J | B |
| K | A | U | L |
| I | R | P | Start |
| O | Select | Q / E | hold ← / hold → (press again to let go) |
| R | hold B | | |

U and I sit above J and K, as the shoulder buttons sit above the face buttons.

**Arrows, Enter and Backspace:** click the line under the picture once. That line then catches keys until Esc:

| Key | Button | Key | Button |
|---|---|---|---|
| ← ↑ → ↓ or W A S D | D-pad | Z or J | B |
| X or K | A | U | L |
| I | R | Enter | Start |
| Backspace or `` ` `` | Select | Shift+← / Shift+→ | hold ← / hold → |
| Shift+↑ / Shift+↓ | let go of a held direction | | |

Esc hands the keyboard back to the Claude prompt and pauses the game.

**Why the holds:** a terminal reports key presses but not releases, and repeats only the last key held. So a press holds its button for a moment (a little longer for the D-pad), and an auto-repeat keeps it held. To walk right and run while you jump, latch the direction (E) and B (R), then jump with K. A plain arrow, or the other direction's latch, lets a held direction go.

### In a window: `/gba window`

Opens the game in its own 720×480 window (3× the GBA's 240×160) with the real keyboard, presses and releases:

| Key | Button | Key | Button |
|---|---|---|---|
| arrows | D-pad | Z or J | B |
| X or K | A | A or Q | L |
| S or E | R | Enter | Start |
| Backspace or right Shift | Select | | |

It still pauses with Claude; any key in the window resumes. Close it or type `/gba window off` to go back to the pane alone.

### With a controller

Any XInput (Xbox-style) controller works in the pane and the window, without either having the focus, with every button held at once.

| Controller | GBA | Controller | GBA |
|---|---|---|---|
| D-pad or left stick | D-pad | A or Y | A |
| B or X | B | LB or LT | L |
| RB or RT | R | Start | Start |
| Back | Select | | |

A button that resumes a paused game does not also act in the game.

## Commands

| Command | Does |
|---|---|
| `/gba <rom>` | open a ROM: a path to a `.gba` or `.zip`, or a name found in the ROM folder (exact, then a unique prefix, then a unique part) |
| `/gba` | reopen the running game; otherwise open the pane on the ROM picker |
| `/gba list` | the picker's ROMs as text (recent, ROM folder, `run`), and the picker opened when no game is running |
| `/gba save [1-9]` / `/gba load [1-9]` | save or load a state slot (slot 1 when left out) |
| `/gba window` / `/gba window off` | the game in its own window, or not |
| `/gba hd on` / `/gba hd off` | 2×2 or 1×2 pixels per terminal cell (remembered) |
| `/gba quit` | stop the game |

## Pausing

The game pauses when Claude's turn ends, when a tool call needs your permission, when Claude asks a question or presents a plan, when you leave the pane (Esc or closing it), and after a while without input (30 seconds by default). Any game key resumes; that key does not also act in the game.

## Options

Set them in `/config` under gba-pane.

| Option | Default | Does |
|---|---|---|
| ROM folder (`romDir`) | empty | the folder `/gba <name>` searches and the picker lists (`.gba` and `.zip`) |
| Sharper picture (`hd`) | on | 2×2 pixels per cell (quadrant glyphs); off draws 1×2 half blocks |
| Idle pause (`idlePauseSeconds`) | 30 | pause after this long with no key or controller input; 0 never |

## Picture quality

The pane draws the game at 3:2 with block characters, 2×2 pixels per terminal cell, box-filtered: about 160×54 sample points at 80 columns, against the GBA's 240×160. Small text (dialogue, menus) is unreadable below about 240×80 cells. A smaller terminal font and a wider pane help; `/gba window` shows every pixel. The pane stops growing at 240 columns, where the vertical detail is complete and more columns would only cost bytes.

The desktop app draws no `Raster`: there the pane says the GBA plays in the terminal.

## Saves

- **Cartridge saves** (SRAM, Flash or EEPROM, detected by mGBA and its built-in table of games) are kept in `run/saves/<rom>-<crc>.sav`, raw, the format mGBA and VBA write. An existing mGBA `.sav` can be dropped in under that name. The file is written every 5 seconds while it changes, and when you quit; a game that never saves leaves none.
- **Real-time clock** games (the Pokémon Ruby, Sapphire and Emerald family, per mGBA's table) read the PC's clock.
- **Save states** (slots 1-9) sit beside them. They are tied to this build of the helper: a rebuilt `gba-cc.exe` may refuse an older state ("state is from another ROM or build").

## Supported games

Whatever mGBA 0.10.5 runs with its built-in BIOS, which is nearly the whole library. A few titles behave differently without the official BIOS (which ones is unverified). ROMs up to 32 MiB. A `.zip` is unzipped into `run/roms` first (see Zipped ROMs).

## What's rough

- **No sound.** There is no audio path from the helper into Claude Code, and mGBA's resampler (blip_buf, LGPL) is replaced by a silent stub.
- **CPU:** GBA emulation costs more than nes-pane. The helper used about 3% of one core at 80 columns and 10% at 240×80 on the generated test ROM (a 16-thread desktop); real games cost more, since the test ROM does almost nothing each frame. It pauses whenever Claude needs you, or after 30 s idle.
- Small text is unreadable in the pane (see Picture quality).
- No key releases from the terminal: holds are timed, and run-plus-jump needs the latches. The controller and `/gba window` have real holds.
- One click is needed before arrows, Enter and Backspace work in the pane.
- Input-to-picture latency is roughly 50–80 ms; the pane shows about 30 frames a second.
- No peripherals: solar sensor (Boktai), tilt and gyro (Yoshi Topsy-Turvy, WarioWare Twisted), rumble, e-Reader, link cable and the GB Player are not wired up.
- Stripped from mGBA: audio output, the debugger and GDB stub, scripting, the cheats UI, rewind, video logging and recording, screenshots and PNG, zip and 7z reading inside mGBA (zips go through `tar.exe` instead), ELF, link cable, lockstep and Dolphin serial, e-Reader, sensors, GB Player, the OpenGL renderers and threading.
- Save states break across rebuilds of the helper.
- A ROM under a path with characters outside the system code page cannot be opened ("cannot read ROM").
- Game Boy and Game Boy Color games are not played here.
- Windows only.

## How it works

```
Claude Code ─ hooks/register.tsx ── run/ctrl.txt ──► native: gba-cc.exe (mGBA)
   pane: Raster cells ◄── stdout: frames, status lines ──┘
```

- **`hooks/`** is the Claude Code mod. `register.tsx` registers `/gba`, draws the pane (the ROM picker, or a `Raster` of terminal cells, the key-catcher line and the controls), unzips `.zip` ROMs with `tar.exe` and pauses on `turn.complete`, `tool.check` asks, `AskUserQuestion`, `ExitPlanMode`, Esc and idle time. `gba.ts` holds the pure parts (commands, the control file's text, frames, key tables, ROM lookup, the picker's merged list). `pad.tsx` is the key catcher, a `Client` that posts the keys it gets.
- **`native/`** is the helper.
  - `gba-cc.c` runs mGBA's GBA core at 59.73 Hz with its built-in BIOS, packs every second frame into terminal cells, reads the control file (size, play/pause, buttons, save slots) and keeps the cartridge save and save states.
  - `cc_window.c` is the pop-out window; `cc_pad.c` reads the controller (both adapted from doom-pane).
  - `mgba/` is the vendored subset of mGBA 0.10.5, unmodified (see `mgba/VENDORED.md`); `blip_stub.c` and `mgba-shim/` stand in for its LGPL resampler.
  - `gen_build.py` writes `build.cmd` (and `mgba-gen/version.c`) from mGBA's own CMake source lists, so the build needs only `cl.exe`.

## Build

`bin/gba-cc.exe` is prebuilt. To build it yourself you need the Visual Studio 2022 Build Tools (C++). From Git Bash:

```sh
sh native/fetch_mgba.sh        # only to refresh the vendored copy of mGBA
python native/gen_build.py     # only after changing the source list
cmd //c native\build.cmd       # writes bin/gba-cc.exe
sh native/test/protocol.sh     # generated ROMs: play, A/B/L/R, pause, resize, save/load, quit, .sav, errors
claude plugin validate .
claude plugin test .
```

## License

MIT for this mod's own files; see [LICENSE](LICENSE).

- mGBA is MPL-2.0 ([native/mgba/LICENSE](native/mgba/LICENSE)). Its source is in `native/mgba/`, unmodified, and `bin/gba-cc.exe` contains it: that folder is where the executable's MPL source is.
- inih is BSD-3 ([native/mgba/src/third-party/inih/LICENSE.txt](native/mgba/src/third-party/inih/LICENSE.txt)).
- blip_buf (LGPL-2.1) is not included; a silent stub of our own replaces it.
- `cc_pad.c` and `cc_window.c` are adapted from the author's doom-pane.

Game Boy Advance is a trademark of Nintendo. This project is not affiliated with Nintendo, Anthropic or the mGBA project.
