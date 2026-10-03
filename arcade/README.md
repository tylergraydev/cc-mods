# Arcade

A Claude Code mod with tic-tac-toe, sudoku and tetris in a side pane. Play with the keyboard, the mouse or an Xbox controller.

```
 TIC-TAC-TOE  hard   W 3 · L 0 · D 5
 [ X ][ 8 ][ 9 ]
 [ 4 ][ O ][ 6 ]
 [ 1 ][ 2 ][ X ]
 Your move (1-9 or click).   n: new  q: games  i: help
```

```
 TETRIS  L3  ★ 4,120  best 9,880
 │        ▓▓          │ NEXT  ▓▓▓▓
 │      ▓▓▓▓▓▓        │ HOLD  ▓▓
 │      ░░░░░░        │ LINES 23
 │██  ████████  ██████│
 └────────────────────┘
```

## Play

`/arcade` opens the game picker. `/arcade ttt`, `/arcade sudoku [easy|medium|hard]`, `/arcade tetris [zen]` start a game directly, and `/arcade scores` shows your records. (If `/arcade` is taken the command is `/arcade-games`.)

**Click the board once for arrow keys.** The pane only receives arrows, Space and Enter after a click on the board; until then use the letter and digit keys (hotkeys) or a controller. Esc hands the keyboard back.

## Controls

Shell keys in every game: `n` new game, `q` game picker, `i` help (`?` on a clicked board). Controller `start` opens the pause menu: `a` resume, `b` games, `x`/`back` new game.

| Game | Keyboard (board clicked) | Hotkey (pane focused) | Controller |
| --- | --- | --- | --- |
| Tic-tac-toe | arrows move, Enter places, click a cell | keypad layout `7 8 9 / 4 5 6 / 1 2 3` | d-pad moves, `a` places |
| Sudoku | arrows or `hjkl` move, click a cell, `1-9` enter, `0`/`x`/Backspace clear, `c` check, `s` solve, `p` pencil marks | digits `1-9`, `0` clear, `c`, `s`, `p`, `h j k l` | d-pad moves, `a` cycles the digit up, `b` clears, `x`/`back` pencil marks |
| Tetris | left/right move, down soft drop, up or `x` rotate, `z` rotate back, Space hard drop, `c` hold, `p` pause | `h` left, `l` right, `j` soft, `k` rotate, `u` rotate back, `d` hard drop, `c` hold, `p` pause | d-pad/stick left, right, down (auto-repeat), up hard drop, `a` rotate, `b` rotate back, `x`/`back` hold, `start` pause |
| Picker | | `1` `2` `3`, `s` scores | d-pad + `a` |

Inside the workbench the hotkeys are off (they would clash with other mods in it): click the board and use the keys above, or a controller.

## Controller (Windows)

An Xbox-style (XInput) controller works without focusing the pane. The helper is built once with MSVC Build Tools:

```sh
native\build.cmd
bin\pad.exe --version     # arcade-pad 1
```

`/arcade` starts the helper when `bin\pad.exe` exists. A 🎮 shows in the status line while a controller is connected. The helper does the button auto-repeat (170 ms, then every 50 ms). Only the first controller is used. Unplugging pauses tetris. With no helper built, no Windows or `controller` off, nothing happens.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `tttLevel` | `hard` | `easy` plays random moves; `hard` never loses |
| `sudokuDifficulty` | `medium` | clues kept: easy 40, medium 32, hard about 26 |
| `tetrisSpeed` | `normal` | `zen` keeps gravity at one row a second |
| `pauseOnTurnEnd` | `true` | pause a running game when Claude finishes a turn |
| `controller` | `true` | start the controller helper |

## Scores

Kept across sessions: tic-tac-toe wins, losses and draws per level; sudoku best times per difficulty; tetris best score, lines and level. The sudoku in progress is saved too. Tetris comes back paused after a reload.

## Limits

- Keys reach the board only after a click; hotkeys are letters and digits only.
- Terminal and desktop only for the board; VS Code gets text and hotkeys; mobile is not playable.
- Tetris gravity is capped at 80 ms a row; rotation is SRS-lite (no wall-kick tables, only side offsets).
- Sudoku difficulty is by clue count alone.
- The pane needs at least 16 (tic-tac-toe), 25 (sudoku) or 22 (tetris) columns.

## Check

```sh
claude plugin validate ./arcade
claude plugin test ./arcade
```
