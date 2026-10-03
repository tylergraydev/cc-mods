# Decodes the last frame line of a frames file and checks a background color:
#   python check_frame.py frames.txt red|blue|black|white
# Passes (exit 0) when more than half of the cells have that color as their
# foreground or background. Red and blue are the test ROM's Color palettes
# (0x001F and 0x7C00, each 5-bit channel shifted left 3 by binjgb); black and
# white are the Game Boy's darkest and lightest grays (BGP $FF and $00).
import base64
import struct
import sys

COLORS = {'red': 0xF80000, 'blue': 0x0000F8, 'black': 0x000000, 'white': 0xFFFFFF}

path, name = sys.argv[1], sys.argv[2]
want = COLORS[name]
lines = [l for l in open(path, 'rb').read().split(b'\n') if l.startswith(b'\x01F ')]
if not lines:
    print('check_frame: no frame lines')
    sys.exit(1)
_, c, r, data = lines[-1].strip().split(b' ')
c, r = int(c), int(r)
words = struct.unpack('<%dI' % (c * r * 3), base64.b64decode(data))
hits = sum(1 for i in range(c * r) if want in (words[i * 3 + 1], words[i * 3 + 2]))
share = hits / (c * r)
print(f'check_frame: {name} in {hits}/{c * r} cells ({share:.0%}) of a {c}x{r} frame')
sys.exit(0 if share > 0.5 else 1)
