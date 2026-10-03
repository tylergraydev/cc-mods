# Writes nes-pane's own test ROM (MIT, like the rest of the mod): vertical
# stripes of eight tiles, a backdrop that turns red while A is held and blue
# while B is, a horizontal scroll that moves every frame, and a frame counter
# written to $6000 (battery RAM on mappers 1 and 4).
#
#   python make_rom.py out.nes [--mapper N] [--battery] [--prg32]
#
# --mapper 5 writes the unsupported-mapper fixture. Mapper 7 has CHR RAM, so
# its tiles are blank and only the backdrop shows.
import argparse
import struct

ap = argparse.ArgumentParser()
ap.add_argument('out')
ap.add_argument('--mapper', type=int, default=0)
ap.add_argument('--battery', action='store_true')
ap.add_argument('--prg32', action='store_true')
args = ap.parse_args()


class Asm:
    """A tiny label-resolving 6502 assembler: enough for this ROM."""

    def __init__(self, org):
        self.org = org
        self.b = bytearray()
        self.labels = {}
        self.fixups = []  # (offset, label, kind)

    def pc(self):
        return self.org + len(self.b)

    def label(self, name):
        self.labels[name] = self.pc()

    def imp(self, op):
        self.b.append(op)

    def imm(self, op, v):
        self.b += bytes([op, v & 0xFF])

    def zp(self, op, a):
        self.b += bytes([op, a & 0xFF])

    def abs(self, op, a):
        self.b.append(op)
        if isinstance(a, str):
            self.fixups.append((len(self.b), a, 'abs'))
            self.b += b'\0\0'
        else:
            self.b += struct.pack('<H', a)

    def br(self, op, label):
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
                rel = target - (self.org + off + 1)  # pc + 2 of the branch
                assert -128 <= rel <= 127, name
                self.b[off] = rel & 0xFF


SEI, CLD, TXS, INX, INY, DEX, TYA, PHA, PLA, TXA, TAX, LSR, RTI = 0x78, 0xD8, 0x9A, 0xE8, 0xC8, 0xCA, 0x98, 0x48, 0x68, 0x8A, 0xAA, 0x4A, 0x40
LDX_I, LDY_I, LDA_I, AND_I, CPX_I = 0xA2, 0xA0, 0xA9, 0x29, 0xE0
STX, STA, LDA, LDA_X, BIT, JMP = 0x8E, 0x8D, 0xAD, 0xBD, 0x2C, 0x4C
INC_Z, LDA_Z, STA_Z, ROL_Z = 0xE6, 0xA5, 0x85, 0x26
BPL, BNE, BEQ = 0x10, 0xD0, 0xF0

a = Asm(0xC000)

# RESET
a.label('reset')
a.imp(SEI)
a.imp(CLD)
a.imm(LDX_I, 0x40)
a.abs(STX, 0x4017)
a.imm(LDX_I, 0xFF)
a.imp(TXS)
a.imp(INX)
a.abs(STX, 0x2000)
a.abs(STX, 0x2001)
a.label('vb1')
a.abs(BIT, 0x2002)
a.br(BPL, 'vb1')
a.label('vb2')
a.abs(BIT, 0x2002)
a.br(BPL, 'vb2')
a.abs(LDA, 0x2002)
a.imm(LDA_I, 0x3F)
a.abs(STA, 0x2006)
a.imm(LDA_I, 0x00)
a.abs(STA, 0x2006)
a.imm(LDX_I, 0)
a.label('pal')
a.abs(LDA_X, 'palette')
a.abs(STA, 0x2007)
a.imp(INX)
a.imm(CPX_I, 32)
a.br(BNE, 'pal')
a.abs(LDA, 0x2002)
a.imm(LDA_I, 0x20)
a.abs(STA, 0x2006)
a.imm(LDA_I, 0x00)
a.abs(STA, 0x2006)
a.imm(LDX_I, 4)
a.imm(LDY_I, 0)
a.label('fill')
a.imp(TYA)
a.imm(AND_I, 7)
a.abs(STA, 0x2007)
a.imp(INY)
a.br(BNE, 'fill')
a.imp(DEX)
a.br(BNE, 'fill')
a.imm(LDA_I, 0)
a.abs(STA, 0x2005)
a.abs(STA, 0x2005)
a.imm(LDA_I, 0x80)
a.abs(STA, 0x2000)
a.imm(LDA_I, 0x1E)
a.abs(STA, 0x2001)
a.label('loop')
a.abs(JMP, 'loop')

# NMI
a.label('nmi')
a.imp(PHA)
a.imp(TXA)
a.imp(PHA)
a.zp(INC_Z, 0x00)
a.zp(LDA_Z, 0x00)
a.abs(STA, 0x6000)
a.imm(LDA_I, 1)
a.abs(STA, 0x4016)
a.imm(LDA_I, 0)
a.abs(STA, 0x4016)
a.imm(LDX_I, 8)
a.label('pad')
a.abs(LDA, 0x4016)
a.imp(LSR)
a.zp(ROL_Z, 0x01)
a.imp(DEX)
a.br(BNE, 'pad')
a.abs(LDA, 0x2002)
a.imm(LDA_I, 0x3F)
a.abs(STA, 0x2006)
a.imm(LDA_I, 0x00)
a.abs(STA, 0x2006)
a.zp(LDA_Z, 0x01)
a.br(BPL, 'notA')
a.imm(LDA_I, 0x16)  # red: A held
a.abs(JMP, 'setc')
a.label('notA')
a.imm(AND_I, 0x40)
a.br(BEQ, 'notB')
a.imm(LDA_I, 0x12)  # blue: B held
a.abs(JMP, 'setc')
a.label('notB')
a.imm(LDA_I, 0x0F)
a.label('setc')
a.abs(STA, 0x2007)
a.abs(LDA, 0x2002)
a.zp(LDA_Z, 0x00)
a.abs(STA, 0x2005)
a.imm(LDA_I, 0)
a.abs(STA, 0x2005)
a.imm(LDA_I, 0x80)
a.abs(STA, 0x2000)
a.imp(PLA)
a.imp(TAX)
a.imp(PLA)
a.label('irq')
a.imp(RTI)

a.label('palette')
a.data([0x0F, 0x01, 0x11, 0x21, 0x0F, 0x06, 0x16, 0x26, 0x0F, 0x09, 0x19, 0x29, 0x0F, 0x02, 0x12, 0x22] * 2)
a.resolve()

prg = bytearray(b'\xFF' * 0x4000)
assert len(a.b) < 0x3FFA
prg[:len(a.b)] = a.b
prg[0x3FFA:0x4000] = struct.pack('<HHH', a.labels['nmi'], a.labels['reset'], a.labels['irq'])


def tile(p0, p1):
    return bytes(p0) + bytes(p1)


chr_ = b''.join([
    tile([0] * 8, [0] * 8),                                  # 0 blank
    tile([0xFF] * 8, [0] * 8),                               # 1 solid 1
    tile([0] * 8, [0xFF] * 8),                               # 2 solid 2
    tile([0xFF] * 8, [0xFF] * 8),                            # 3 solid 3
    tile([0xAA, 0x55] * 4, [0x55, 0xAA] * 4),                # 4 checker 1/2
    tile([0xFF, 0x00] * 4, [0xFF, 0x00] * 4),                # 5 horizontal stripes
    tile([0xAA] * 8, [0xAA] * 8),                            # 6 vertical stripes
    tile([0xFF] + [0x81] * 6 + [0xFF], [0] * 8),             # 7 hollow box
]).ljust(0x2000, b'\0')

n = args.mapper
prg_banks = 2 if (args.prg32 or n in (1, 7)) else 1
chr_banks = 0 if n == 7 else 1
flags6 = ((n & 15) << 4) | (2 if args.battery else 0)  # bit 0 clear: horizontal mirroring
flags7 = n & 0xF0
header = b'NES\x1a' + bytes([prg_banks, chr_banks, flags6, flags7]) + b'\0' * 8

with open(args.out, 'wb') as f:
    f.write(header + bytes(prg) * prg_banks + (chr_ if chr_banks else b''))
print(f'{args.out}: mapper {n}, {prg_banks * 16} KiB PRG, {chr_banks * 8} KiB CHR{", battery" if args.battery else ""}')
