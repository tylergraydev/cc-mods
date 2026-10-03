# agnes, vendored

- Upstream: https://github.com/kgabis/agnes
- Commit: `0e4220b084c467e39c04805d955e78c463feadd0` (2025-12-25), agnes 0.2.0
- Files: `agnes.c`, `agnes.h`, `LICENSE` (MIT, Copyright (c) 2019-2022 Krzysztof Gabis), fetched from
  `https://raw.githubusercontent.com/kgabis/agnes/<commit>/<file>`
- Line endings converted to CRLF, as every text file in this mod; nothing else changed in `agnes.h` or `LICENSE`.

## nes-pane edits to agnes.c

Every edit sits in a `/* nes-pane: */ ... /* nes-pane: end */` block (`grep -n "nes-pane:" agnes.c`):

1. **Mapper 3 (CNROM)**: `mapper3_t { agnes; chr_bank_offset }`. Reads below $2000 come from the selected 8 KiB CHR ROM bank;
   reads from $8000 come from PRG ROM, 16 KiB mirrored. A write at $8000+ selects the CHR bank (`val % chr banks`).
2. **Mapper 7 (AxROM)**: `mapper7_t { agnes; prg_bank_offset; chr_ram[8 KiB] }`. Starts with one-screen (lower) mirroring;
   CHR is RAM; a write at $8000+ selects a 32 KiB PRG bank (`(val & 7) % max(1, prg banks / 2)`) and the
   one-screen nametable (bit 4: upper or lower).
3. `m3` and `m7` added to the `agnes_t` mapper union, and `case 3` / `case 7` added to all five switches:
   `mapper_init`, `mapper_read`, `mapper_write`, `agnes_dump_state`, `agnes_restore_state`.

The mapper functions are `static` and placed just before `//FILE_START:mapper.c`, since the amalgamated file has no
headers for them. `native/test/protocol.sh` runs generated mapper-3 and mapper-7 ROMs to check them.

## Not changed

agnes has no APU (no sound) and supports mappers 0, 1, 2 and 4 upstream. Battery RAM is handled outside agnes, by
`nes-cc.c`, which reads `mapper.m1.prg_ram` / `mapper.m4.prg_ram` directly (it includes `agnes.c`).
