#!/bin/sh
# Drives nes-cc through its control file on generated test ROMs: frames, a held
# button, pause, resize while paused, save and load states, quit, battery RAM,
# mappers 3 and 7, and the errors for a bad mapper and a missing ROM.
# Exits 1 on the first failed check.
cd "$(dirname "$0")" || exit 1
EXE=../../bin/nes-cc.exe
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
ctrl() { printf '%s\n' "$@" end > ctrl.txt; }
frames() { grep -ac "^$F" "${1:-frames.txt}"; }
has() { grep -aq "$1" "${2:-frames.txt}"; }

rm -rf saves frames.txt log.txt ctrl.txt preview.png
python make_rom.py test.nes || exit 1
python make_rom.py batt.nes --mapper 1 --battery --prg32 || exit 1
python make_rom.py bad.nes --mapper 5 || exit 1
python make_rom.py m3.nes --mapper 3 || exit 1
python make_rom.py m7.nes --mapper 7 --prg32 || exit 1

# 1. Play: frames of the asked size and the ready line.
ctrl 'size 40 15' 'mode play' 'hd on'
$EXE -rom test.nes -ctrl ctrl.txt -sav saves > frames.txt 2> log.txt &
pid=$!
sleep 2
n=$(grep -ac "^$F 40 15 " frames.txt)
check "frames while playing ($n in 2 s)" test "$n" -gt 20
check "ready mapper 0 battery 0" has "${S} ready mapper 0 battery 0"

# 2. A latched A turns the backdrop red.
ctrl 'size 40 15' 'mode play' 'hd on' 'h 1 a 1'
sleep 0.5
check "A held turns the backdrop red" python check_frame.py frames.txt red

# 3. Pause: no more frames.
ctrl 'size 40 15' 'mode pause' 'hd on' 'h 1 a 1'
sleep 0.3
paused=$(frames)
sleep 1.5
later=$(frames)
check "no frames while paused ($paused, then $later)" test "$paused" -eq "$later"

# 4. Resize while paused: one frame of the new size.
ctrl 'size 50 19' 'mode pause' 'hd on' 'h 1 a 1'
sleep 0.5
check "a resize while paused sends a 50x19 frame" sh -c "tail -n 1 frames.txt | grep -aq '^$F 50 19 '"

# 5. Save and load a state.
ctrl 'size 50 19' 'mode pause' 'hd on' 'h 1 a 1' 'save 2 1'
sleep 0.5
check "state file written" sh -c 'ls saves/test-*.state1 > /dev/null 2>&1'
check "saved 1" has "${S} saved 1"
ctrl 'size 50 19' 'mode pause' 'hd on' 'h 1 a 1' 'save 2 1' 'load 3 1'
sleep 0.5
check "loaded 1" has "${S} loaded 1"
ctrl 'size 50 19' 'mode pause' 'hd on' 'h 1 a 1' 'save 2 1' 'load 3 1' 'load 4 9'
sleep 0.5
check "nostate 9" has "${S} nostate 9"

# 6. Quit.
ctrl 'size 50 19' 'mode pause' 'hd on' 'quit'
sleep 1
if kill -0 $pid 2> /dev/null; then
    check "exits on quit" false
    kill $pid
else
    wait $pid
    code=$?
    check "exits on quit with 0 (got $code)" test "$code" -eq 0
fi
echo "preview: $(python preview.py frames.txt)"

run_rom() { # run_rom <rom> <out> : plays 1 s, quits, sets $code
    ctrl 'size 40 15' 'mode play' 'hd on'
    $EXE -rom "$1" -ctrl ctrl.txt -sav saves > "$2" 2>> log.txt &
    p=$!
    sleep 1
    ctrl 'size 40 15' 'mode play' 'hd on' 'quit'
    sleep 1
    if kill -0 $p 2> /dev/null; then
        kill $p
        code=killed
    else
        wait $p
        code=$?
    fi
}

# 7. Battery RAM is written on quit.
run_rom batt.nes batt.txt
check "battery ROM exits 0 (got $code)" test "$code" = 0
check "ready mapper 1 battery 1" has "${S} ready mapper 1 battery 1" batt.txt
sav=$(ls saves/batt-*.sav 2> /dev/null | head -n 1)
size=$( [ -n "$sav" ] && wc -c < "$sav" | tr -d ' ')
check "battery file of 8192 bytes (${sav:-none}, ${size:-0})" test "${size:-0}" -eq 8192

# 8. Mappers 3 and 7.
for m in 3 7; do
    run_rom m$m.nes m$m.txt
    n=$(frames m$m.txt)
    check "mapper $m: frames ($n in 1 s)" test "$n" -gt 10
    check "mapper $m: ready" has "${S} ready mapper $m" m$m.txt
    check "mapper $m: exits 0 (got $code)" test "$code" = 0
done

# 9. Bad inputs.
$EXE -rom bad.nes -ctrl ctrl.txt -sav saves > bad.txt 2>> log.txt
code=$?
check "mapper 5 refused with exit 4 (got $code)" test "$code" -eq 4
check "mapper 5 error line" has "${S} error unsupported mapper 5" bad.txt
$EXE -rom no-such.nes -ctrl ctrl.txt -sav saves > missing.txt 2>> log.txt
code=$?
check "missing ROM exits 3 (got $code)" test "$code" -eq 3
check "missing ROM error line" has "${S} error cannot read ROM" missing.txt

echo
echo "frames: $(frames) in frames.txt; last size: $(grep -a "^$F" frames.txt | tail -n 1 | cut -c2-8)"
grep "nes-cc:" log.txt | sort | uniq -c
if [ "$failures" -ne 0 ]; then
    echo "$failures check(s) failed"
    exit 1
fi
echo "all checks passed"
