# binjgb, vendored

- Upstream: https://github.com/binji/binjgb
- Commit: `16621111ed0ee73bcc45c912a823bcebedcffc0f` (2026-09-25)
- Files: `src/emulator.c`, `src/emulator.h`, `src/common.c`, `src/common.h`, `src/memory.c`, `src/memory.h`,
  `src/builtin-palettes.def` and `LICENSE` (MIT, Copyright (c) 2016 Ben Smith), fetched from
  `https://raw.githubusercontent.com/binji/binjgb/<commit>/<file>` and kept flat in this folder.
- Line endings converted to CRLF, as every text file in this mod; nothing else changed except the one edit below.

## gb-pane edit to emulator.c

One edit, in a `/* gb-pane: */ ... /* gb-pane: end */` block (`grep -n "gb-pane:" emulator.c`):

1. `log_cart_info` printed its seven lines (title, CGB and SGB flags, cart type, ROM and RAM size, header checksum)
   with `printf`, to stdout. They now go to stderr with `fprintf(stderr, ...)`, since the helper's stdout carries
   only its protocol (frames and status lines).

`emulator.c`, `common.c` and `memory.c` are compiled as translation units of their own (see `native/build.cmd`);
`gb-cc.c` includes only `emulator.h`.

## Not changed

- The APU runs, but `gb-cc.c` turns every channel off (`EmulatorConfig.disable_sound`) and discards the samples:
  there is no audio path from the helper into Claude Code.
- The MBC3 real-time clock runs on emulated time and lives only in `EmulatorState`; the battery file (`.sav`)
  holds the cartridge RAM alone. A `.sav` from another emulator with a 44- or 48-byte RTC footer is read
  without its footer.
- binjgb has no TAMA5, HuC3, MBC6, MBC7 or Pocket Camera; `gb-cc.c` refuses those cartridge types before the
  core sees them.
