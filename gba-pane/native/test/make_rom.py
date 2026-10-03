# Writes a tiny GBA test ROM (ARM, hand-assembled) for protocol.sh:
#   python make_rom.py out.gba [--bad] [--size N]
# Mode 4: horizontal bands 16 lines tall in palette colour 1 over a black
# backdrop, scrolling up. Colour 1 is green with no key held, red while A is,
# blue for B, white for L and yellow for R. Each frame also writes a byte to
# cartridge SRAM, so mGBA detects a 32 KiB SRAM save.
# The header carries no Nintendo logo (it is copyrighted); mGBA's built-in
# BIOS never checks it. 512 KiB, so mGBA does not take it for multiboot.
# --bad writes text that is not a ROM; --size N pads the output to N bytes.
import struct
import sys

COND = {'al': 0xE, 'eq': 0x0, 'ne': 0x1}
OPS = {'and': 0, 'sub': 2, 'add': 4, 'tst': 8, 'cmp': 10, 'orr': 12, 'mov': 13, 'mvn': 15}


def rotated(value):
    """value as ARM's 8-bit immediate rotated right by an even amount: (rot, imm8)."""
    for rot in range(16):
        imm = ((value << (2 * rot)) | (value >> (32 - 2 * rot))) & 0xFFFFFFFF if rot else value
        if imm < 256:
            return rot, imm
    raise ValueError(f'{value:#x} is not an ARM immediate')


class Asm:
    def __init__(self, origin):
        self.origin = origin
        self.words = []
        self.labels = {}
        self.fixups = []

    @property
    def pc(self):
        return self.origin + 4 * len(self.words)

    def label(self, name):
        self.labels[name] = self.pc

    def emit(self, word):
        self.words.append(word & 0xFFFFFFFF)

    def dpi(self, op, rd, rn, value, cond='al', s=None):
        """Data processing with an immediate: mov/mvn ignore rn; tst/cmp set flags and have no rd."""
        s = OPS[op] in (8, 10) if s is None else s
        rot, imm = rotated(value)
        self.emit(COND[cond] << 28 | 1 << 25 | OPS[op] << 21 | int(s) << 20 | rn << 16 | rd << 12 | rot << 8 | imm)

    def dpr(self, op, rd, rn, rm, lsl=0, cond='al', s=False):
        """Data processing with a register shifted left by an immediate."""
        self.emit(COND[cond] << 28 | OPS[op] << 21 | int(s) << 20 | rn << 16 | rd << 12 | lsl << 7 | rm)

    def str_post(self, rd, rn, offset):  # str rd, [rn], #offset
        self.emit(0xE4800000 | rn << 16 | rd << 12 | offset)

    def str_(self, rd, rn, offset=0):  # str rd, [rn, #offset]
        self.emit(0xE5800000 | rn << 16 | rd << 12 | offset)

    def strb(self, rd, rn, offset=0):  # strb rd, [rn, #offset]
        self.emit(0xE5C00000 | rn << 16 | rd << 12 | offset)

    def half(self, load, rd, rn, offset=0):  # ldrh / strh rd, [rn, #offset]
        assert offset < 256
        self.emit(0xE1C000B0 | int(load) << 20 | rn << 16 | rd << 12 | (offset >> 4) << 8 | (offset & 15))

    def b(self, name, cond='al'):
        self.fixups.append((len(self.words), name))
        self.emit(COND[cond] << 28 | 0xA << 24)

    def link(self):
        for index, name in self.fixups:
            offset = (self.labels[name] - (self.origin + 4 * index + 8)) >> 2
            self.words[index] |= offset & 0xFFFFFF
        return b''.join(struct.pack('<I', w) for w in self.words)


def program():
    a = Asm(0x080000C0)
    r0, r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12 = range(13)
    a.dpi('mov', r0, 0, 0x06000000)        # VRAM, mode-4 page 0
    a.dpi('mov', r2, 0, 1)
    a.dpr('orr', r2, r2, r2, lsl=8)
    a.dpr('orr', r2, r2, r2, lsl=16)       # 0x01010101: four pixels of colour 1
    a.dpi('mov', r3, 0, 0)                 # y
    a.label('row')
    a.dpi('tst', 0, r3, 16)                # 16-line bands
    a.dpr('mov', r4, 0, r2, cond='eq')
    a.dpi('mov', r4, 0, 0, cond='ne')
    a.dpi('mov', r1, 0, 60)                # 60 words = 240 pixels
    a.label('col')
    a.str_post(r4, r0, 4)
    a.dpi('sub', r1, r1, 1, s=True)
    a.b('col', 'ne')
    a.dpi('add', r3, r3, 1)
    a.dpi('cmp', 0, r3, 160)
    a.b('row', 'ne')
    a.dpi('mov', r6, 0, 0x04000000)        # I/O
    a.dpi('mov', r7, 0, 0x100)
    a.str_(r7, r6, 0x20)                   # BG2PA = 1.0, BG2PB = 0
    a.dpi('mov', r7, 0, 0x01000000)
    a.str_(r7, r6, 0x24)                   # BG2PC = 0, BG2PD = 1.0
    a.dpi('mov', r7, 0, 0x400)
    a.dpi('orr', r7, r7, 4)
    a.str_(r7, r6, 0)                      # DISPCNT = 0x0404: mode 4, BG2 on
    a.dpi('mov', r5, 0, 0)                 # frame counter
    a.dpi('add', r9, r6, 0x130)            # KEYINPUT
    a.dpi('mov', r11, 0, 0x05000000)       # palette RAM
    a.dpi('mov', r12, 0, 0x0E000000)       # cartridge SRAM
    a.label('frame')
    a.half(True, r7, r6, 6)                # VCOUNT
    a.dpi('cmp', 0, r7, 160)
    a.b('frame', 'ne')                     # wait for VBlank
    a.dpi('add', r5, r5, 1)
    a.dpi('and', r8, r5, 31)
    a.dpr('mov', r8, 0, r8, lsl=8)
    a.str_(r8, r6, 0x2C)                   # BG2Y = (frame & 31) << 8: the bands scroll up
    a.half(True, r7, r9)                   # keys, 0 = held
    a.dpi('mov', r10, 0, 0x3E0)            # green: nothing held
    a.dpi('tst', 0, r7, 1)                 # A
    a.dpi('mov', r10, 0, 0x1F, cond='eq')  # red
    a.b('setc', 'eq')
    a.dpi('tst', 0, r7, 2)                 # B
    a.dpi('mov', r10, 0, 0x7C00, cond='eq')  # blue
    a.b('setc', 'eq')
    a.dpi('tst', 0, r7, 0x200)             # L
    a.dpi('mvn', r10, 0, 0x8000, cond='eq')  # white (low half 0x7FFF)
    a.b('setc', 'eq')
    a.dpi('tst', 0, r7, 0x100)             # R
    a.dpi('mov', r10, 0, 0x400, cond='eq')
    a.dpi('sub', r10, r10, 1, cond='eq')   # yellow 0x03FF
    a.label('setc')
    a.half(False, r10, r11, 2)             # palette[1]
    a.strb(r5, r12)                        # SRAM byte 0: mGBA detects SRAM
    a.label('leave')
    a.half(True, r7, r6, 6)
    a.dpi('cmp', 0, r7, 160)
    a.b('leave', 'eq')
    a.b('frame')
    return a.link()


# The plan's words, checked against the encoder.
EXPECTED = [
    0xE3A00406, 0xE3A02001, 0xE1822402, 0xE1822802, 0xE3A03000, 0xE3130010, 0x01A04002, 0x13A04000,
    0xE3A0103C, 0xE4804004, 0xE2511001, 0x1AFFFFFC, 0xE2833001, 0xE35300A0, 0x1AFFFFF5, 0xE3A06301,
    0xE3A07C01, 0xE5867020, 0xE3A07401, 0xE5867024, 0xE3A07B01, 0xE3877004, 0xE5867000, 0xE3A05000,
    0xE2869E13, 0xE3A0B405, 0xE3A0C40E, 0xE1D670B6, 0xE35700A0, 0x1AFFFFFC, 0xE2855001, 0xE205801F,
    0xE1A08408, 0xE586802C, 0xE1D970B0, 0xE3A0AE3E, 0xE3170001, 0x03A0A01F, 0x0A000008, 0xE3170002,
    0x03A0AB1F, 0x0A000005, 0xE3170C02, 0x03E0A902, 0x0A000002, 0xE3170C01, 0x03A0AB01, 0x024AA001,
    0xE1CBA0B2, 0xE5CC5000, 0xE1D670B6, 0xE35700A0, 0x0AFFFFFC, 0xEAFFFFE4,
]


def rom():
    code = program()
    words = list(struct.unpack('<%dI' % (len(code) // 4), code))
    if words != EXPECTED:
        bad = [f'{0xC0 + 4 * i:#05x}: {w:08X} != {e:08X}' for i, (w, e) in enumerate(zip(words, EXPECTED)) if w != e]
        sys.exit('make_rom: encoder mismatch: ' + '; '.join(bad or ['length']))
    out = bytearray(0x80000)
    out[0:4] = struct.pack('<I', 0xEA00002E)  # b 0xC0
    out[0xA0:0xAC] = b'GBAPANETEST\0'
    out[0xAC:0xB0] = b'CCGT'
    # 0xB0, the maker code, stays 0.
    out[0xB2] = 0x96  # the fixed byte mGBA's GBAIsROM checks
    out[0xBD] = (-sum(out[0xA0:0xBD]) - 0x19) & 0xFF
    out[0xC0:0xC0 + len(code)] = code
    return out


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit('usage: make_rom.py out.gba [--bad] [--size N]')
    path = args[0]
    if '--bad' in args:
        text = b'not a gba rom\n'
        data = bytearray((text * (0x80000 // len(text) + 1))[:0x80000])
    else:
        data = rom()
    if '--size' in args:
        n = int(args[args.index('--size') + 1])
        data = data[:n] + bytes(max(0, n - len(data)))
    open(path, 'wb').write(data)
    print(f'make_rom: {path}, {len(data)} bytes')


main()
