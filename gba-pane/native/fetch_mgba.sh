#!/bin/sh
# Refreshes native/mgba/ from the pinned mGBA 0.10.5 tarball: the subset this
# mod builds, unmodified (LF, as upstream). Run from Git Bash:
#   sh native/fetch_mgba.sh [download folder]
# The tarball goes to the download folder (a fresh temporary one by default)
# and its sha256 is printed; compare it with native/mgba/VENDORED.md.
set -e
cd "$(dirname "$0")"
TAG=0.10.5
URL=https://github.com/mgba-emu/mgba/archive/refs/tags/$TAG.tar.gz
DL=${1:-$(mktemp -d)}
mkdir -p "$DL"
TARBALL=$DL/mgba-$TAG.tar.gz
[ -f "$TARBALL" ] || curl -sSL -o "$TARBALL" "$URL"
echo "sha256: $(sha256sum "$TARBALL" | cut -d' ' -f1)"

TMP=$DL/mgba-extract
rm -rf "$TMP"
mkdir -p "$TMP"
# (from inside the folder: Git Bash tar reads "C:..." as a remote host)
(cd "$DL" && tar -xzf "mgba-$TAG.tar.gz" -C mgba-extract)
UP=$TMP/mgba-$TAG

# Keep VENDORED.md and .gitattributes (ours); replace everything else.
OUT=mgba
mkdir -p "$OUT"
find "$OUT" -mindepth 1 -maxdepth 1 ! -name VENDORED.md ! -name .gitattributes -exec rm -rf {} +

keep() { # keep <path relative to the tarball's top folder>...
    for p in "$@"; do
        mkdir -p "$OUT/$(dirname "$p")"
        cp -R "$UP/$p" "$OUT/$p"
    done
}

keep LICENSE include
keep src/arm/CMakeLists.txt src/arm/arm.c src/arm/decoder.c src/arm/decoder-arm.c src/arm/decoder-thumb.c \
    src/arm/isa-arm.c src/arm/isa-thumb.c
for f in CMakeLists.txt version.c.in bitmap-cache.c cache-set.c cheats.c config.c core.c directories.c input.c \
    interface.c library.c lockstep.c log.c map-cache.c mem-search.c rewind.c serialize.c sync.c thread.c \
    tile-cache.c timing.c; do
    keep src/core/$f
done
keep src/gb/audio.c src/gba
for f in "$UP"/src/util/*.c; do keep "src/util/$(basename "$f")"; done
keep src/util/CMakeLists.txt src/util/vfs/vfs-mem.c src/util/vfs/vfs-fifo.c src/util/vfs/vfs-fd.c
keep src/platform/windows/memory.c src/platform/windows/vfs-w32.c
keep src/third-party/inih/ini.c src/third-party/inih/ini.h src/third-party/inih/LICENSE.txt

# Excluded: blip_buf is LGPL-2.1 (a silent MIT stub replaces it), getopt.h is
# unused, and the GBA debugger, extras, tests, Dolphin and lockstep SIO and the
# OpenGL renderer are not built.
rm -f "$OUT/include/mgba/core/blip_buf.h" "$OUT/include/mgba-util/platform/windows/getopt.h"
rm -rf "$OUT/src/gba/debugger" "$OUT/src/gba/extra" "$OUT/src/gba/test"
rm -f "$OUT/src/gba/sio/dolphin.c" "$OUT/src/gba/sio/lockstep.c" "$OUT/src/gba/renderers/gl.c"

rm -rf "$TMP"
echo "native/mgba: $(find "$OUT" -type f | wc -l | tr -d ' ') files"
