#!/bin/sh
# Drives gba-cc through its control file on a generated test ROM: frames, the
# ready line, a clean stdout, A, B, L and R reaching the game, pause, resize
# while paused, save and load states, quit, the cartridge save written and read
# back, and the errors for a non-ROM, an oversized file and a missing ROM.
# Exits 1 when any check failed.
cd "$(dirname "$0")" || exit 1
EXE=../../bin/gba-cc.exe
F=$(printf '\001F')
S=$(printf '\001S')
failures=0

check() { # check <description> <command...>
    what=$1
    shift
    if "$@"; then
        echo "ok   $what"
    else
        echo "FAIL $what"
        failures=$((failures + 1))
    fi
}
EV=''
ctrl() { printf '%s\n' "$@" end > ctrl.txt; }
play() { # play <mode> [new events...]: the settings, every event so far, end
    mode=$1
    shift
    for e in "$@"; do EV="$EV|$e"; done
    old_ifs=$IFS
    IFS='|'
    # shellcheck disable=SC2086
    ctrl "size $SIZE" "mode $mode" 'hd on' ${EV#|}
    IFS=$old_ifs
}
frames() { grep -ac "^$F" "${1:-frames.txt}"; }
has() { grep -aq "$1" "${2:-frames.txt}"; }
color() { python check_frame.py frames.txt "$1"; }

rm -rf saves frames.txt log.txt ctrl.txt preview.png again.txt bad.txt big.txt missing.txt
python make_rom.py test.gba > /dev/null || exit 1
python make_rom.py bad.gba --bad > /dev/null || exit 1
python make_rom.py big.gba --size 33554433 > /dev/null || exit 1

# 1. Play: frames of the asked size, the ready line, nothing else on stdout.
SIZE='42 14'
play play
$EXE -rom test.gba -ctrl ctrl.txt -sav saves > frames.txt 2> log.txt &
pid=$!
sleep 2
n=$(grep -ac "^$F 42 14 " frames.txt)
check "frames while playing ($n in 2 s)" test "$n" -gt 20
check "ready code AGB-CCGT" has "^${S} ready code AGB-CCGT\$"
other=$(grep -avc "^$F \|^$S " frames.txt)
check "every stdout line is a frame or a status line ($other others)" test "$other" -eq 0

# 2. No key held: green bands.
check "no key: green" color green

# 3. A, B, L and R reach the game.
play play 'h 1 a 1'
sleep 0.5
check "A held: red" color red
play play 'h 2 a 0' 'h 3 b 1'
sleep 0.5
check "B held: blue" color blue
play play 'h 4 b 0' 'h 5 l 1'
sleep 0.5
check "L held: white (L reached the game)" color white
play play 'h 6 l 0' 'h 7 r 1'
sleep 0.5
check "R held: yellow (R reached the game)" color yellow
play play 'h 8 r 0'
sleep 0.5
play play 'k 9 l'
sleep 0.1
check "a tapped l presses L: white" color white

# 4. Pause: no more frames.
sleep 0.5
play pause
sleep 0.3
paused=$(frames)
sleep 1.5
later=$(frames)
check "no frames while paused ($paused, then $later)" test "$paused" -eq "$later"

# 5. Resize while paused: one frame of the new size.
SIZE='60 20'
play pause
sleep 0.5
check "a resize while paused sends a 60x20 frame" sh -c "tail -n 1 frames.txt | grep -aq '^$F 60 20 '"

# 6. Save and load a state.
play pause 'save 10 1'
sleep 0.5
check "state file written" sh -c 'ls saves/test-*.state1 > /dev/null 2>&1'
check "saved 1" has "${S} saved 1"
play pause 'load 11 1'
sleep 0.5
check "loaded 1" has "${S} loaded 1"
play pause 'load 12 9'
sleep 0.5
check "nostate 9" has "${S} nostate 9"

# 7. Quit: exit 0 and the cartridge's 32 KiB SRAM written.
ctrl "size $SIZE" 'mode pause' 'hd on' 'quit'
sleep 1
if kill -0 $pid 2> /dev/null; then
    check "exits on quit" false
    kill $pid
else
    wait $pid
    code=$?
    check "exits on quit with 0 (got $code)" test "$code" -eq 0
fi
sav=$(ls saves/test-*.sav 2> /dev/null | head -n 1)
size=$( [ -n "$sav" ] && wc -c < "$sav" | tr -d ' ')
check "SRAM save of 32768 bytes (${sav:-none}, ${size:-0})" test "${size:-0}" -eq 32768
echo "preview: $(python preview.py frames.txt)"

# 8. A second run reads the save back.
ctrl 'size 42 14' 'mode play' 'hd on'
$EXE -rom test.gba -ctrl ctrl.txt -sav saves > again.txt 2>> log.txt &
p=$!
sleep 1
ctrl 'size 42 14' 'mode play' 'hd on' 'quit'
sleep 1
if kill -0 $p 2> /dev/null; then
    kill $p
    code=killed
else
    wait $p
    code=$?
fi
check "second run exits 0 (got $code)" test "$code" = 0
check "second run loads the .sav" sh -c "grep -a 'gba-cc: loaded' log.txt | grep -aq '\.sav'"

# 9. Bad inputs.
$EXE -rom bad.gba -ctrl ctrl.txt -sav saves > bad.txt 2>> log.txt
code=$?
check "not a ROM: exit 4 (got $code)" test "$code" -eq 4
check "not a ROM: error line" has "${S} error not a GBA ROM" bad.txt
$EXE -rom big.gba -ctrl ctrl.txt -sav saves > big.txt 2>> log.txt
code=$?
check "over 32 MiB: exit 4 (got $code)" test "$code" -eq 4
check "over 32 MiB: error line" has "${S} error ROM is larger than 32 MiB" big.txt
$EXE -rom no-such.gba -ctrl ctrl.txt -sav saves > missing.txt 2>> log.txt
code=$?
check "missing ROM: exit 3 (got $code)" test "$code" -eq 3
check "missing ROM: error line" has "${S} error cannot read ROM" missing.txt

echo
echo "frames: $(frames) in frames.txt; last size: $(grep -a "^$F" frames.txt | tail -n 1 | cut -c2-8)"
grep "gba-cc:" log.txt | sort | uniq -c
if [ "$failures" -ne 0 ]; then
    echo "$failures check(s) failed"
    exit 1
fi
echo "all checks passed"
