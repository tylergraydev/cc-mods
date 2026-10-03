# Arcade

A Claude Code mod with six games in a side pane: tic-tac-toe, sudoku, tetris, video poker, blackjack and UNO. Play with the keyboard, the mouse or an Xbox controller.

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

```
 VIDEO POKER  Jacks or Better 9/6
 Credits 499  Bet 1

 [A♠]  [K♥]  [10♦] [10♣] [3♠]
       HELD        HELD

 Choose the cards to keep
```

```
 BLACKJACK
 Dealer
 [10♠][??]

 You  soft 17  bet 20 ◀
 [A♠][6♥]

 Chips 480  Bet 20
```

## Play

`/arcade` opens the game picker. `/arcade ttt`, `/arcade sudoku [easy|medium|hard]`, `/arcade tetris [zen]` start a game directly, and `/arcade scores` shows your records. `/arcade poker`, `/arcade blackjack` and `/arcade uno [2|3]` start the card games. (If `/arcade` is taken the command is `/arcade-games`.)

**Click the board once for arrow keys.** The pane only receives arrows, Space and Enter after a click on the board; until then use the letter and digit keys (hotkeys) or a controller. Esc hands the keyboard back.

## Controls

Shell keys in every game: `n` new game, `q` game picker, `i` help (`?` on a clicked board). Controller `start` opens the pause menu: `a` resume, `b` games, `x`/`back` new game.

| Game | Keyboard (board clicked) | Hotkey (pane focused) | Controller |
| --- | --- | --- | --- |
| Tic-tac-toe | arrows move, Enter places, click a cell | keypad layout `7 8 9 / 4 5 6 / 1 2 3` | d-pad moves, `a` places |
| Sudoku | arrows or `hjkl` move, click a cell, `1-9` enter, `0`/`x`/Backspace clear, `c` check, `s` solve, `p` pencil marks | digits `1-9`, `0` clear, `c`, `s`, `p`, `h j k l` | d-pad moves, `a` cycles the digit up, `b` clears, `x`/`back` pencil marks |
| Tetris | left/right move, down soft drop, up or `x` rotate, `z` rotate back, Space hard drop, `c` hold, `p` pause | `h` left, `l` right, `j` soft, `k` rotate, `u` rotate back, `d` hard drop, `c` hold, `p` pause | d-pad/stick left, right, down (auto-repeat), up hard drop, `a` rotate, `b` rotate back, `x`/`back` hold, `start` pause |
| Video poker | `1-5` hold, click a card to hold, ←/→ cursor, Enter hold at cursor (deals between hands), Space or `d` deal/draw, ↑/↓ bet, `b` bet one, `m` max bet and deal, `r` rebuy at 0 | `1-5`, `d`, `b`, `m`, `r` | d-pad ←/→ cursor, ↑/↓ bet, `a` hold (deal between hands), `x`/`back` deal/draw |
| Blackjack | Enter/Space/`d` deal, `h` hit, `s` stand, `x` double, `p` split, ↑/↓ or `b` bet, `r` rebuy | `d h s x p b r` | `a` deal/hit, `b` stand, `x`/`back` double, → split, ↑/↓ bet |
| UNO | ←/→ or `h`/`l` choose, Enter/Space/`p` play, `d` draw (again: pass), click a card, the deck or a colour; `r g b y` colour | `h l p d r g b y` | d-pad ←/→, `a` play/choose colour, `x`/`back` draw/pass |
| Picker | | `1`-`6`, `s` scores | d-pad + `a` |

Inside the workbench the hotkeys are off (they would clash with other mods in it): click the board and use the keys above, or a controller.

## Video poker

Jacks or Better on the 9/6 paytable. Bet 1 to 5 coins, get five cards, keep the ones you like and draw once. A pair of jacks or better pays. Credits returned for one coin (the columns scale with the bet; five coins on a royal flush pay 4000):

| Hand | Pays for 1 coin |
| --- | --- |
| Royal flush | 250 |
| Straight flush | 50 |
| Four of a kind | 25 |
| Full house | 9 |
| Flush | 6 |
| Straight | 4 |
| Three of a kind | 3 |
| Two pair | 2 |
| Jacks or better | 1 |

Texas Hold'em is not included.

## Blackjack

Six decks, reshuffled when a quarter of the shoe is left. The dealer stands on soft 17 and peeks for a natural, so a dealer blackjack ends the round before you play. Naturals pay 3:2, a win 1:1. Double on any two cards, split a pair of the same rank once (split aces get one card each; a 21 after a split pays 1:1). No insurance, surrender or re-split. Bets are 10, 20, 50, 100 or 200.

## UNO

The 108-card deck against two or three computer players (three by default; `/arcade uno 2` or the `unoOpponents` option). You always start. The first card turned up is always a number. Reverse with two players acts as a skip. There is no stacking, no Wild Draw Four challenge, no points, and UNO is called for you. The computer plays a draw two first, then skip, reverse, its highest number, a wild and a wild four last, and names the colour it holds most of. An empty draw pile is refilled from the discard. The pane keeps a win/loss tally per table size.

## Bankroll

Poker and blackjack share one bankroll of play chips. It starts at 500, is kept across sessions and is shown with its peak on the scores screen. `r` rebuys 500 when you cannot cover the minimum bet (1 in poker, 10 in blackjack), never in the middle of a hand. There is no real money anywhere.

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
| `unoOpponents` | `3` | computer players at the UNO table: `2` or `3` |
| `pauseOnTurnEnd` | `true` | pause a running game when Claude finishes a turn |
| `controller` | `true` | start the controller helper |

## Scores

Kept across sessions: tic-tac-toe wins, losses and draws per level; sudoku best times per difficulty; tetris best score, lines and level. Video poker hand counts and your biggest win; blackjack wins, losses, pushes and naturals with your best chip count; UNO wins and losses per table size; the bankroll and its peak. The sudoku in progress is saved too. Tetris comes back paused after a reload.

## Limits

- Keys reach the board only after a click; hotkeys are letters and digits only.
- Terminal and desktop only for the board; VS Code gets text and hotkeys; mobile is not playable.
- Tetris gravity is capped at 80 ms a row; rotation is SRS-lite (no wall-kick tables, only side offsets).
- Sudoku difficulty is by clue count alone.
- The pane needs at least 16 (tic-tac-toe), 25 (sudoku), 22 (tetris), 32 (video poker), 30 (blackjack) or 38 (UNO) columns.
- Suit glyphs may draw double-width in some CJK terminals.
- No Hold'em, multiplayer or real money; the computer is the only opponent.

## Version

0.2.0 adds video poker, blackjack and UNO, the shared bankroll and the `unoOpponents` option.

## Check

```sh
claude plugin validate ./arcade
claude plugin test ./arcade
```
