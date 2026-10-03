# Copied from doom-pane. Draws the last frame of frames.txt as the terminal would: each cell's glyph
# (half or quadrant block) split into its fg and bg quarters. Writes preview.png.
import base64
import struct
import sys
import zlib

# Which quarters (TL, TR, BL, BR) a glyph fills with the foreground color.
MASKS = {0x20: 0, 0x2598: 1, 0x259D: 2, 0x2580: 3, 0x2596: 4, 0x258C: 5, 0x259E: 6, 0x259B: 7,
         0x2597: 8, 0x259A: 9, 0x2590: 10, 0x259C: 11, 0x2584: 12, 0x2599: 13, 0x259F: 14, 0x2588: 15}

# nes-pane: status lines follow frames, so only frame lines are taken.
lines = [l for l in open(sys.argv[1] if len(sys.argv) > 1 else 'frames.txt', 'rb').read().split(b'\n') if l.startswith(b'\x01F ')]
_, c, r, data = lines[-1].strip().split(b' ')
c, r = int(c), int(r)
words = struct.unpack('<%dI' % (c * r * 3), base64.b64decode(data))

S = 4  # screen pixels per quarter-cell edge (a cell is 2S wide, 4S tall)
W, H = c * 2 * S, r * 4 * S
rows = []
for y in range(r * 2):
    row = b''
    for x in range(c * 2):
        cp, fg, bg = words[(y // 2 * c + x // 2) * 3:(y // 2 * c + x // 2) * 3 + 3]
        bit = (y % 2) * 2 + (x % 2)
        col = fg if MASKS.get(cp, 3) >> bit & 1 else bg
        row += bytes([(col >> 16) & 255, (col >> 8) & 255, col & 255]) * S
    rows += [b'\0' + row] * (2 * S)


def chunk(t, b):
    return struct.pack('>I', len(b)) + t + b + struct.pack('>I', zlib.crc32(t + b))


open('preview.png', 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0))
                                + chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b''))
print(c, r, W, H)
