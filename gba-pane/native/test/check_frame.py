# Decodes the last frame line of a frames file and checks a band color:
#   python check_frame.py frames.txt green|red|blue|white|yellow|black
# Passes (exit 0) when more than 10% of the cells have that color as their
# foreground or background. The colors are what make_rom.py's bands turn with
# no key held (green), A (red), B (blue), L (white) and R (yellow), as mGBA
# expands the GBA's 15-bit colors (31 becomes 0xFF).
import base64
import struct
import sys

COLORS = {'green': 0x00FF00, 'red': 0xFF0000, 'blue': 0x0000FF, 'white': 0xFFFFFF, 'yellow': 0xFFFF00, 'black': 0x000000}

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
sys.exit(0 if share > 0.10 else 1)
