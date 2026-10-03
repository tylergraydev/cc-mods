#!/bin/sh
# Drives gb-cc through its control file on generated test ROMs: frames, held
# buttons, pause, resize while paused, save and load states, quit, a Game Boy
# (DMG) ROM, battery RAM on MBC1, MBC3 and MBC2, an MBC5 Color ROM, and the
# errors for a bad cartridge type, a file that is no ROM, a ROM too big and a
# missing ROM. Exits 1 when any check failed.
cd "$(dirname "$0")" || exit 1
EXE=../../bin/gb-cc.exe
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

rm -rf saves frames.txt log.txt ctrl.txt preview.png ./*.gb ./*.gbc ./*.txt
python make_rom.py test.gbc --cgb || exit 1
python make_rom.py test.gb || exit 1
python make_rom.py batt.gb --cart 0x03 --ram 0x02 || exit 1
python make_rom.py rtc.gbc --cgb --cart 0x10 --ram 0x03 || exit 1
python make_rom.py mbc2.gb --cart 0x06 || exit 1
python make_rom.py mbc5.gbc --cgb --cart 0x1b --ram 0x02 || exit 1
python make_rom.py bad.gb --cart 0x22 || exit 1
python make_rom.py junk.gb --junk || exit 1
python make_rom.py big.gb --junk --size 9437184 || exit 1

# 1. Play: frames of the asked size and the ready line.
ctrl 'size 40 18' 'mode play' 'hd on'
$EXE -rom test.gbc -ctrl ctrl.txt -sav saves > frames.txt 2> log.txt &
pid=$!
sleep 2
n=$(grep -ac "^$F 40 18 " frames.txt)
check "frames while playing ($n in 2 s)" test "$n" -gt 20
check "ready cgb rom battery 0" has "${S} ready cgb rom battery 0"

# 2. A latched A turns the background red; let go and latch B, blue.
ctrl 'size 40 18' 'mode play' 'hd on' 'h 1 a 1'
sleep 0.5
check "A held turns the background red" python check_frame.py frames.txt red
ctrl 'size 40 18' 'mode play' 'hd on' 'h 1 a 1' 'h 2 a 0' 'h 3 b 1'
sleep 0.5
check "B held turns the background blue" python check_frame.py frames.txt blue

# 3. Pause: no more frames.
ctrl 'size 40 18' 'mode pause' 'hd on' 'h 3 b 1'
sleep 0.3
paused=$(frames)
sleep 1.5
later=$(frames)
check "no frames while paused ($paused, then $later)" test "$paused" -eq "$later"

# 4. Resize while paused: one frame of the new size.
ctrl 'size 50 22' 'mode pause' 'hd on' 'h 3 b 1'
sleep 0.5
check "a resize while paused sends a 50x22 frame" sh -c "tail -n 1 frames.txt | grep -aq '^$F 50 22 '"

# 5. Save and load a state.
ctrl 'size 50 22' 'mode pause' 'hd on' 'h 3 b 1' 'save 4 1'
sleep 0.5
check "state file written" sh -c 'ls saves/test-*.state1 > /dev/null 2>&1'
check "saved 1" has "${S} saved 1"
ctrl 'size 50 22' 'mode pause' 'hd on' 'h 3 b 1' 'save 4 1' 'load 5 1'
sleep 0.5
check "loaded 1" has "${S} loaded 1"
ctrl 'size 50 22' 'mode pause' 'hd on' 'h 3 b 1' 'save 4 1' 'load 5 1' 'load 6 9'
sleep 0.5
check "nostate 9" has "${S} nostate 9"

# 6. Quit.
ctrl 'size 50 22' 'mode pause' 'hd on' 'quit'
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

run_rom() { # run_rom <rom> <out> [control lines...] : plays 1 s, quits, sets $code
    rom=$1
    out=$2
    shift 2
    ctrl 'size 40 18' 'mode play' 'hd on' "$@"
    $EXE -rom "$rom" -ctrl ctrl.txt -sav saves > "$out" 2>> log.txt &
    p=$!
    sleep 1
    ctrl 'size 40 18' 'mode play' 'hd on' "$@" 'quit'
    sleep 1
    if kill -0 $p 2> /dev/null; then
        kill $p
        code=killed
    else
        wait $p
        code=$?
    fi
}

# 7. A Game Boy (DMG) ROM: four grays; A held is all black, B held all white.
run_rom test.gb dmg-a.txt 'h 1 a 1'
check "test.gb: ready dmg rom battery 0" has "${S} ready dmg rom battery 0" dmg-a.txt
check "test.gb: A held is black" python check_frame.py dmg-a.txt black
check "test.gb: exits 0 (got $code)" test "$code" = 0
run_rom test.gb dmg-b.txt 'h 1 b 1'
check "test.gb: B held is white" python check_frame.py dmg-b.txt white
check "test.gb: exits 0 again (got $code)" test "$code" = 0

# 8. Battery RAM is written on quit, its size the cartridge's, and read back.
sav_size() { # sav_size <prefix> : the size of saves/<prefix>-*.sav, or 0
    sav=$(ls saves/"$1"-*.sav 2> /dev/null | head -n 1)
    if [ -n "$sav" ]; then wc -c < "$sav" | tr -d ' '; else echo 0; fi
}
run_rom batt.gb batt.txt
check "batt.gb: exits 0 (got $code)" test "$code" = 0
check "batt.gb: ready dmg mbc1 battery 1" has "${S} ready dmg mbc1 battery 1" batt.txt
size=$(sav_size batt)
check "batt.gb: battery file of 8192 bytes (got $size)" test "$size" -eq 8192
: > log2.txt
ctrl 'size 40 18' 'mode play' 'hd on'
$EXE -rom batt.gb -ctrl ctrl.txt -sav saves > batt2.txt 2> log2.txt &
p=$!
sleep 1
ctrl 'size 40 18' 'mode play' 'hd on' 'quit'
sleep 1
kill $p 2> /dev/null
check "batt.gb: a second run loads the battery file" grep -q "gb-cc: loaded" log2.txt
cat log2.txt >> log.txt
rm -f log2.txt

run_rom rtc.gbc rtc.txt
check "rtc.gbc: ready cgb mbc3 battery 1" has "${S} ready cgb mbc3 battery 1" rtc.txt
size=$(sav_size rtc)
check "rtc.gbc: battery file of 32768 bytes (got $size)" test "$size" -eq 32768
check "rtc.gbc: exits 0 (got $code)" test "$code" = 0

run_rom mbc2.gb mbc2.txt
check "mbc2.gb: ready dmg mbc2 battery 1" has "${S} ready dmg mbc2 battery 1" mbc2.txt
size=$(sav_size mbc2)
check "mbc2.gb: battery file of 512 bytes (got $size)" test "$size" -eq 512
check "mbc2.gb: exits 0 (got $code)" test "$code" = 0

# 9. MBC5 on a Color ROM.
run_rom mbc5.gbc mbc5.txt
n=$(frames mbc5.txt)
check "mbc5.gbc: frames ($n in 1 s)" test "$n" -gt 10
check "mbc5.gbc: ready cgb mbc5 battery 1" has "${S} ready cgb mbc5 battery 1" mbc5.txt
check "mbc5.gbc: exits 0 (got $code)" test "$code" = 0

# 10. Bad inputs.
$EXE -rom bad.gb -ctrl ctrl.txt -sav saves > bad.txt 2>> log.txt
code=$?
check "cartridge type 0x22 refused with exit 4 (got $code)" test "$code" -eq 4
check "cartridge type 0x22 error line" has "${S} error unsupported cartridge type 0x22" bad.txt
$EXE -rom junk.gb -ctrl ctrl.txt -sav saves > junk.txt 2>> log.txt
code=$?
check "a file that is no ROM refused with exit 4 (got $code)" test "$code" -eq 4
check "no-ROM error line" has "${S} error not a Game Boy ROM" junk.txt
$EXE -rom big.gb -ctrl ctrl.txt -sav saves > big.txt 2>> log.txt
code=$?
check "a 9 MiB file refused with exit 4 (got $code)" test "$code" -eq 4
check "too-big error line" has "${S} error ROM is larger than 8 MiB" big.txt
$EXE -rom no-such.gb -ctrl ctrl.txt -sav saves > missing.txt 2>> log.txt
code=$?
check "missing ROM exits 3 (got $code)" test "$code" -eq 3
check "missing ROM error line" has "${S} error cannot read ROM" missing.txt

echo
echo "frames: $(frames) in frames.txt; last size: $(grep -a "^$F" frames.txt | tail -n 1 | cut -c2-8)"
grep "gb-cc:" log.txt | sed 's/, [^ ]*$//' | sort | uniq -c
if [ "$failures" -ne 0 ]; then
    echo "$failures check(s) failed"
    exit 1
fi
echo "all checks passed"
