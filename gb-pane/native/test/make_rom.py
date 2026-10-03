# Writes gb-pane's own test ROM (MIT, like the rest of the mod): vertical
# stripes of 8-pixel tiles in the four shades, a horizontal scroll that moves
# every frame, a frame counter in cartridge RAM ($A000), and a background that
# changes while A or B is held:
#
#   held   Game Boy (BGP)    Game Boy Color (BG palette 0)
#   A      $FF: all black    four times red   (0x001F -> 0xF80000)
#   B      $00: all white    four times blue  (0x7C00 -> 0x0000F8)
#   none   $E4: four grays   white, light, dark, black
#
#   python make_rom.py out.gb [--cgb] [--cart 0xNN] [--ram 0xNN] [--junk] [--size N]
#
# --cgb sets the Color flag (0x143 = 0x80). --cart and --ram set the cartridge
# type (0x147) and RAM size code (0x149). --junk writes --size zero bytes
# (default 32768) with no header at all. A ROM is always 32 KiB (code 0x00).
import argparse
import struct

ap = argparse.ArgumentParser()
ap.add_argument('out')
ap.add_argument('--cgb', action='store_true')
ap.add_argument('--cart', type=lambda s: int(s, 0), default=0)
ap.add_argument('--ram', type=lambda s: int(s, 0), default=0)
ap.add_argument('--junk', action='store_true')
ap.add_argument('--size', type=int, default=32768)
args = ap.parse_args()

if args.junk:
    open(args.out, 'wb').write(bytes(args.size))
    raise SystemExit(0)


class Asm:
    """A tiny label-resolving SM83 assembler: enough for this ROM."""

    def __init__(self, org):
        self.org = org
        self.b = bytearray()
        self.labels = {}
        self.fixups = []  # (offset, label, kind)

    def pc(self):
        return self.org + len(self.b)

    def label(self, name):
        self.labels[name] = self.pc()

    def op(self, *bs):
        self.b += bytes(bs)

    def n8(self, op, v):
        self.b += bytes([op, v & 0xFF])

    def n16(self, op, v):
        self.b.append(op)
        if isinstance(v, str):
            self.fixups.append((len(self.b), v, 'abs'))
            self.b += b'\0\0'
        else:
            self.b += struct.pack('<H', v)

    def jr(self, op, label):
        self.b.append(op)
        self.fixups.append((len(self.b), label, 'rel'))
        self.b.append(0)

    def data(self, bs):
        self.b += bytes(bs)

    def resolve(self):
        for off, name, kind in self.fixups:
            target = self.labels[name]
            if kind == 'abs':
                self.b[off:off + 2] = struct.pack('<H', target)
            else:
                rel = target - (self.org + off + 1)  # from the byte after the offset
                assert -128 <= rel <= 127, name
                self.b[off] = rel & 0xFF


NOP, JP, DI, LD_SP = 0x00, 0xC3, 0xF3, 0x31
LDH_A_N, LDH_N_A, CP_N = 0xF0, 0xE0, 0xFE
JR_NZ, JR_Z, JR_C, JR = 0x20, 0x28, 0x38, 0x18
XOR_A, LD_A_L, OR_C, LD_NN_A, INC_IHL, AND_N = 0xAF, 0x7D, 0xB1, 0xEA, 0x34, 0xE6
LD_A_N, LD_B_N, LD_BC, LD_DE, LD_HL = 0x3E, 0x06, 0x01, 0x11, 0x21
LD_A_IDE, LD_IHLI_A, LD_A_IHLI, INC_DE, DEC_B, DEC_BC = 0x1A, 0x22, 0x2A, 0x13, 0x05, 0x0B
LD_A_B, LD_B_A, INC_A, CPL = 0x78, 0x47, 0x3C, 0x2F

LY, LCDC, SCX, BGP, BCPS, BCPD, P1 = 0x44, 0x40, 0x43, 0x47, 0x68, 0x69, 0x00

a = Asm(0x150)
a.op(DI)
a.n16(LD_SP, 0xFFFE)
# The LCD may only be turned off in vertical blank.
a.label('vbl')
a.n8(LDH_A_N, LY)
a.n8(CP_N, 144)
a.jr(JR_C, 'vbl')
a.op(XOR_A)
a.n8(LDH_N_A, LCDC)
# Four tiles of one shade each, at $8000.
a.n16(LD_HL, 0x8000)
a.n16(LD_DE, 'tiles')
a.n8(LD_B_N, 64)
a.label('copy')
a.op(LD_A_IDE)
a.op(LD_IHLI_A)
a.op(INC_DE)
a.op(DEC_B)
a.jr(JR_NZ, 'copy')
# The tile map: tile (L & 3), so 8-pixel vertical stripes.
a.n16(LD_HL, 0x9800)
a.n16(LD_BC, 0x0400)
a.label('fill')
a.op(LD_A_L)
a.n8(AND_N, 3)
a.op(LD_IHLI_A)
a.op(DEC_BC)
a.op(LD_A_B)
a.op(OR_C)
a.jr(JR_NZ, 'fill')
# Cartridge RAM on (MBC1/2/3/5); a no-op without an MBC.
a.n8(LD_A_N, 0x0A)
a.n16(LD_NN_A, 0x0000)
a.n8(LD_A_N, 0xE4)
a.n8(LDH_N_A, BGP)
a.n16(LD_HL, 'pal_normal')
a.n8(LD_A_N, 0x80)
a.n8(LDH_N_A, BCPS)
a.n8(LD_B_N, 8)
a.label('pal0')
a.op(LD_A_IHLI)
a.n8(LDH_N_A, BCPD)
a.op(DEC_B)
a.jr(JR_NZ, 'pal0')
a.n8(LD_A_N, 0x91)  # LCD on, BG on, tiles at $8000, map at $9800
a.n8(LDH_N_A, LCDC)

# Once a frame, at the start of vertical blank.
a.label('frame')
a.label('w1')
a.n8(LDH_A_N, LY)
a.n8(CP_N, 144)
a.jr(JR_Z, 'w1')
a.label('w2')
a.n8(LDH_A_N, LY)
a.n8(CP_N, 144)
a.jr(JR_NZ, 'w2')
a.n8(LDH_A_N, SCX)
a.op(INC_A)
a.n8(LDH_N_A, SCX)
a.n16(LD_HL, 0xA000)
a.op(INC_IHL)
# The buttons: select them, read twice to let the lines settle.
a.n8(LD_A_N, 0x10)
a.n8(LDH_N_A, P1)
a.n8(LDH_A_N, P1)
a.n8(LDH_A_N, P1)
a.op(CPL)
a.n8(AND_N, 0x0F)
a.op(LD_B_A)
a.n8(AND_N, 1)
a.jr(JR_Z, 'notA')
a.n8(LD_A_N, 0xFF)
a.n8(LDH_N_A, BGP)
a.n16(LD_HL, 'pal_red')
a.jr(JR, 'setpal')
a.label('notA')
a.op(LD_A_B)
a.n8(AND_N, 2)
a.jr(JR_Z, 'notB')
a.n8(LD_A_N, 0x00)
a.n8(LDH_N_A, BGP)
a.n16(LD_HL, 'pal_blue')
a.jr(JR, 'setpal')
a.label('notB')
a.n8(LD_A_N, 0xE4)
a.n8(LDH_N_A, BGP)
a.n16(LD_HL, 'pal_normal')
a.label('setpal')
a.n8(LD_A_N, 0x80)
a.n8(LDH_N_A, BCPS)
a.n8(LD_B_N, 8)
a.label('pal')
a.op(LD_A_IHLI)
a.n8(LDH_N_A, BCPD)
a.op(DEC_B)
a.jr(JR_NZ, 'pal')
a.jr(JR, 'frame')

# Tile n is solid shade n: low and high bit planes, eight rows each.
a.label('tiles')
for lo, hi in ((0x00, 0x00), (0xFF, 0x00), (0x00, 0xFF), (0xFF, 0xFF)):
    a.data([lo, hi] * 8)
a.label('pal_normal')
a.data(struct.pack('<4H', 0x7FFF, 0x56B5, 0x294A, 0x0000))
a.label('pal_red')
a.data(struct.pack('<4H', *[0x001F] * 4))
a.label('pal_blue')
a.data(struct.pack('<4H', *[0x7C00] * 4))
a.resolve()

LOGO = bytes.fromhex(
    'CEED6666CC0D000B03730083000C000D0008111F8889000EDCCC6EE6DDDDD999'
    'BBBB67636E0EECCCDDDC999FBBB9333E')
assert len(LOGO) == 48

rom = bytearray(b'\xFF' * 0x8000)
rom[0x100:0x104] = bytes([NOP, JP, 0x50, 0x01])
rom[0x104:0x134] = LOGO
title = b'GBPANE TEST'
rom[0x134:0x143] = title + bytes(15 - len(title))
rom[0x143] = 0x80 if args.cgb else 0x00
rom[0x144:0x146] = b'\0\0'
rom[0x146] = 0x00
rom[0x147] = args.cart & 0xFF
rom[0x148] = 0x00
rom[0x149] = args.ram & 0xFF
rom[0x14A] = 0x01
rom[0x14B] = 0x00
rom[0x14C] = 0x00
x = 0
for i in range(0x134, 0x14D):
    x = (x - rom[i] - 1) & 0xFF
rom[0x14D] = x
assert len(a.b) < 0x8000 - 0x150
rom[0x150:0x150 + len(a.b)] = a.b
rom[0x14E:0x150] = b'\0\0'
total = (sum(rom) - rom[0x14E] - rom[0x14F]) & 0xFFFF
rom[0x14E:0x150] = struct.pack('>H', total)
open(args.out, 'wb').write(rom)
