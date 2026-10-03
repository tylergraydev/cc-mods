#!/usr/bin/env python3
"""Turns a Pokemon card image into terminal cells for the booster-pane Raster.

    card_cells.py <image-url> <cols> <rows> [--mode card|art] --png <png-path> <out-json>
    card_cells.py --clear-cache <dir>

The packing is a port of boxAverage / quadrantCell / base64 in nes-pane/native/nes-cc.c:
each cell holds a 2x2 block of pixels as one quadrant glyph and two colours.
Exit codes: 0 ok, 2 bad arguments, 3 download failed, 4 decode failed, 5 Pillow missing.
"""
import base64
import json
import os
import shutil
import struct
import sys
import urllib.request

USER_AGENT = "booster-pane/0.1 (personal card viewer)"
ALLOWED_PREFIXES = ("https://images.pokemontcg.io/", "https://assets.tcgdex.net/")
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
# The illustration window of a card, as fractions of its width and height (approximate).
ART_CROP = (0.08, 0.105, 0.92, 0.50)

QUADRANT = [
    0x20, 0x2598, 0x259D, 0x2580, 0x2596, 0x258C, 0x259E, 0x259B,
    0x2597, 0x259A, 0x2590, 0x259C, 0x2584, 0x2599, 0x259F, 0x2588,
]


def quadrant_cell(quad):
    """quad = [TL, TR, BL, BR] as (r, g, b); returns [codepoint, fg, bg] as 0x00RRGGBB.

    Of the 7 splits of the four pixels into two groups, keeps the first one with the
    strictly smallest squared error against its group means (integer division, zero for an empty group).
    """
    best_error = -1
    cell = None
    for mask in range(1, 8):
        sums = [[0, 0, 0], [0, 0, 0]]
        counts = [0, 0]
        for i in range(4):
            g = (mask >> i) & 1
            for k in range(3):
                sums[g][k] += quad[i][k]
            counts[g] += 1
        mean = [[(sums[g][k] // counts[g]) if counts[g] else 0 for k in range(3)] for g in range(2)]
        error = 0
        for i in range(4):
            g = (mask >> i) & 1
            for k in range(3):
                d = quad[i][k] - mean[g][k]
                error += d * d
        if best_error < 0 or error < best_error:
            best_error = error
            fg = (mean[1][0] << 16) | (mean[1][1] << 8) | mean[1][2]
            bg = (mean[0][0] << 16) | (mean[0][1] << 8) | mean[0][2]
            cell = [QUADRANT[mask], fg, bg]
    return cell


def pack_rgb(pixels, cols, rows):
    """pixels: a (cols*2) x (rows*2) grid as a flat row-major list of (r, g, b); returns the u32 words."""
    width = cols * 2
    words = []
    for cy in range(rows):
        for cx in range(cols):
            x = cx * 2
            y = cy * 2
            quad = [
                pixels[y * width + x], pixels[y * width + x + 1],
                pixels[(y + 1) * width + x], pixels[(y + 1) * width + x + 1],
            ]
            words.extend(quadrant_cell(quad))
    return words


def encode_words(words):
    """Standard padded base64 of little-endian u32 words."""
    return base64.b64encode(struct.pack("<%dI" % len(words), *words)).decode("ascii")


def crop_box(width, height, mode):
    """The crop rectangle for a mode, or None for the whole card."""
    if mode != "art":
        return None
    left, top, right, bottom = ART_CROP
    return (round(width * left), round(height * top), round(width * right), round(height * bottom))


def to_cells(image, cols, rows, mode):
    """A decoded PIL image to the cells' base64: RGBA over (16,16,16), crop, BOX resize, pack."""
    from PIL import Image

    rgba = image.convert("RGBA")
    flat = Image.new("RGBA", rgba.size, (16, 16, 16, 255))
    flat.alpha_composite(rgba)
    rgb = flat.convert("RGB")
    box = crop_box(rgb.width, rgb.height, mode)
    if box:
        rgb = rgb.crop(box)
    small = rgb.resize((cols * 2, rows * 2), Image.Resampling.BOX)
    return encode_words(pack_rgb(list(small.getdata()), cols, rows))


def download(url, png_path, opener=None):
    """Fetches the PNG unless it is already there; True when the file is good."""
    if os.path.isfile(png_path) and os.path.getsize(png_path) > 0:
        return True
    os.makedirs(os.path.dirname(png_path) or ".", exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    tmp = png_path + ".tmp"
    try:
        with (opener or urllib.request.urlopen)(request, timeout=10) as reply:
            data = reply.read()
        if not data.startswith(PNG_MAGIC):
            return False
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, png_path)
        return True
    except Exception as error:  # noqa: BLE001 - any failure is a failed download
        print("download failed: %s" % type(error).__name__, file=sys.stderr)
        try:
            os.remove(tmp)
        except OSError:
            pass
        return False


def write_json(path, payload):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    os.replace(tmp, path)


def is_cache_dir(path):
    norm = os.path.normpath(path).replace("\\", "/").rstrip("/")
    return norm.endswith("run/cache")


def clear_cache(path):
    """Removes the cache folder; refuses (False) anything not named run/cache."""
    if not is_cache_dir(path):
        return False
    shutil.rmtree(path, ignore_errors=True)
    return True


def run(url, cols, rows, mode, png_path, out_path, fetch=download):
    if not url.startswith(ALLOWED_PREFIXES) or not (1 <= cols <= 512) or not (1 <= rows <= 256) or mode not in ("card", "art"):
        print("bad arguments", file=sys.stderr)
        return 2
    if not fetch(url, png_path):
        return 3
    try:
        from PIL import Image
    except ImportError:
        print("Pillow is missing: python -m pip install pillow", file=sys.stderr)
        return 5
    try:
        with Image.open(png_path) as image:
            image.load()
            cells = to_cells(image, cols, rows, mode)
    except Exception as error:  # noqa: BLE001
        print("decode failed: %s" % type(error).__name__, file=sys.stderr)
        return 4
    write_json(out_path, {"v": 1, "cols": cols, "rows": rows, "mode": mode, "cells": cells})
    print(json.dumps({"ok": True, "cols": cols, "rows": rows}))
    return 0


def main(argv):
    if len(argv) == 3 and argv[1] == "--clear-cache":
        return 0 if clear_cache(argv[2]) else 2
    args = argv[1:]
    mode, png, positional = "card", None, []
    i = 0
    while i < len(args):
        if args[i] == "--mode" and i + 1 < len(args):
            mode = args[i + 1]
            i += 2
        elif args[i] == "--png" and i + 1 < len(args):
            png = args[i + 1]
            i += 2
        else:
            positional.append(args[i])
            i += 1
    if len(positional) != 4 or png is None:
        print(__doc__, file=sys.stderr)
        return 2
    url, cols, rows, out = positional
    try:
        cols_n, rows_n = int(cols), int(rows)
    except ValueError:
        print("bad arguments", file=sys.stderr)
        return 2
    return run(url, cols_n, rows_n, mode, png, out)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
