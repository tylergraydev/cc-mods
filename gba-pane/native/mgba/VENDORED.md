# mGBA, vendored

- Upstream: https://github.com/mgba-emu/mgba
- Tag `0.10.5`, commit `26b7884bc25a5933960f3cdcd98bac1ae14d42e2` (released 2025-03-09; `git get-tar-commit-id` on the tarball agrees)
- Tarball: https://github.com/mgba-emu/mgba/archive/refs/tags/0.10.5.tar.gz
- sha256: `91d6fbd32abcbdf030d58d3f562de25ebbc9d56040d513ff8e5c19bee9dacf14` (14,358,730 bytes)
- Fetched 2026-10-03 with `native/fetch_mgba.sh`, which rebuilds this folder from the tarball.

**No mGBA source file is modified.** Every vendored file is byte-identical to the tarball, LF line endings kept
(`.gitattributes` here says `* -text`, so git leaves them alone), and `diff -r` against the tarball's subset is empty.
This file and `.gitattributes` are gba-pane's own.

## Licences

- mGBA is **MPL-2.0** (`LICENSE` here). Its files keep their headers. MPL is per file, so gba-pane's own files
  (`native/gba-cc.c`, `cc_pad.c`, `cc_window.c`, `blip_stub.c`, `mgba-shim/mgba/core/blip_buf.h`, `gen_build.py`,
  `fetch_mgba.sh`, the tests and the TypeScript) stay MIT. `bin/gba-cc.exe` contains mGBA; its source is this folder,
  as the README's licence section says.
- `src/gba/hle-bios.c` is generated upstream from `src/gba/hle-bios.s` by `src/gba/hle-bios.make`; both are kept as
  the preferred form of that file (MPL section 3.1).
- inih (`src/third-party/inih/`) is BSD-3 (`src/third-party/inih/LICENSE.txt`).
- One generated MPL-derived file lives outside this folder: `native/mgba-gen/version.c`, written by `gen_build.py`
  from `src/core/version.c.in` with its MPL header kept.

## What is kept

The subset a GBA-only, dependency-free build needs (`MINIMAL_CORE=1`, `DISABLE_THREADING`, no debugger, no scripting):

- `LICENSE`
- `include/`: all of `include/mgba` and `include/mgba-util`, less the exclusions below
- `src/arm/`: `arm.c decoder.c decoder-arm.c decoder-thumb.c isa-arm.c isa-thumb.c CMakeLists.txt` (not `debugger/`)
- `src/core/`: the `SOURCE_FILES` of its `CMakeLists.txt`, `CMakeLists.txt` and `version.c.in` (not `scripting.c`,
  `flags.h.in`, `test/`)
- `src/gb/audio.c` alone: the GBA's sound reuses the Game Boy channels (`src/gba/CMakeLists.txt` lists `../gb/audio.c`)
- `src/gba/`: everything less `debugger/`, `extra/`, `test/`, `sio/dolphin.c`, `sio/lockstep.c` and `renderers/gl.c`;
  `hle-bios.s` and `hle-bios.make` kept
- `src/util/`: every `*.c` at its top, `CMakeLists.txt`, and `vfs/vfs-mem.c vfs-fifo.c vfs-fd.c`
- `src/platform/windows/memory.c` and `vfs-w32.c` (CMake's `OS_SRC` and `CORE_VFS_SRC` on Windows)
- `src/third-party/inih/ini.c ini.h LICENSE.txt`

248 files in all, about 2.2 MB.

## What is left out, and why

- **`include/mgba/core/blip_buf.h` and `src/third-party/blip_buf/`**: blip_buf is LGPL-2.1. gba-pane has no audio path,
  so `native/blip_stub.c` (MIT, written fresh) answers mGBA's calls without producing sound, and
  `native/mgba-shim/mgba/core/blip_buf.h` (MIT, written fresh, first on the include path) declares them.
- `include/mgba-util/platform/windows/getopt.h`: public domain, unused.
- Every other `src/` folder (the frontends, the Game Boy and SM83 cores, the debugger, scripting, feature code, the
  other third-party libraries).

## How it is built

`native/gen_build.py` reads `set(SOURCE_FILES ...)` from `src/{arm,core,gba,util}/CMakeLists.txt`, drops
`gba/renderers/gl.c`, `util/png-io.c` and `util/elf-read.c`, adds what the root `CMakeLists.txt` adds on Windows
(`vfs-mem.c`, `vfs-fifo.c`, `vfs-fd.c`, `platform/windows/vfs-w32.c`, `platform/windows/memory.c`, `inih/ini.c`) plus
`blip_stub.c` and `mgba-gen/version.c`, and writes `native/build.cmd`: one `cl` per source folder (several base names
repeat across folders), then `lib` into `mgba.lib`, then the helper. 81 mGBA sources.

Changes from the plan's list found while building: none to the source list. The link needed two more Windows
libraries than mGBA's own `OS_LIB` (`ws2_32 shlwapi`): `ole32.lib` and `shell32.lib`, for `SHGetKnownFolderPath` and
`CoTaskMemFree` in `mCoreConfigDirectory` (`src/core/config.c`), which the helper never calls but which links in with
that file.
