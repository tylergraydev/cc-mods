# Decodes the last frame line of a frames file and checks a backdrop color:
#   python check_frame.py frames.txt red|blue|black
# Passes (exit 0) when more than 10% of the cells have that color as their
# foreground or background. The colors are agnes's g_colors[0x16], [0x12] and
# [0x0F] (agnes.c), the ones the test ROM writes for A held, B held and neither.
import base64
import struct
import sys

COLORS = {'red': 0xF83800, 'blue': 0x0058F8, 'black': 0x000000}

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
