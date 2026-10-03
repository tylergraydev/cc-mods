import base64
import json
import os
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import card_cells as cc  # noqa: E402

RED = (255, 0, 0)
BLUE = (0, 0, 255)


class QuadrantTests(unittest.TestCase):
    def test_top_left_red_rest_blue(self):
        cell = cc.quadrant_cell([RED, BLUE, BLUE, BLUE])
        self.assertEqual(cell, [0x2598, 0xFF0000, 0x0000FF])

    def test_uniform_quad_is_mask_one(self):
        grey = (10, 20, 30)
        cell = cc.quadrant_cell([grey] * 4)
        # mask 1 keeps TL in the foreground group; the first of equal errors wins
        self.assertEqual(cell[0], 0x2598)
        self.assertEqual(cell[1], (10 << 16) | (20 << 8) | 30)
        self.assertEqual(cell[2], (10 << 16) | (20 << 8) | 30)

    def test_top_half_and_bottom_half(self):
        cell = cc.quadrant_cell([RED, RED, BLUE, BLUE])
        self.assertEqual(cell, [0x2580, 0xFF0000, 0x0000FF])

    def test_integer_means(self):
        # three pixels in the background group: (1 + 1 + 2) // 3 == 1
        cell = cc.quadrant_cell([(9, 9, 9), (1, 1, 1), (1, 1, 1), (2, 2, 2)])
        self.assertEqual(cell[0], 0x2598)
        self.assertEqual(cell[2], (1 << 16) | (1 << 8) | 1)


class PackingTests(unittest.TestCase):
    def test_one_cell_bytes_and_base64(self):
        words = cc.pack_rgb([RED, BLUE, BLUE, BLUE], 1, 1)
        self.assertEqual(words, [0x2598, 0xFF0000, 0x0000FF])
        raw = struct.pack("<3I", 0x2598, 0xFF0000, 0x0000FF)
        self.assertEqual(raw, bytes([0x98, 0x25, 0, 0, 0, 0, 0xFF, 0, 0xFF, 0, 0, 0]))
        text = cc.encode_words(words)
        self.assertEqual(text, base64.b64encode(raw).decode("ascii"))
        self.assertEqual(text, "mCUAAAAA/wD/AAAA")
        self.assertEqual(len(text), 16)

    def test_grid_order_is_row_major(self):
        # 2x1 cells = a 4x2 pixel grid: left cell all red, right cell all blue
        pixels = [RED, RED, BLUE, BLUE, RED, RED, BLUE, BLUE]
        words = cc.pack_rgb(pixels, 2, 1)
        self.assertEqual(len(words), 6)
        self.assertEqual(words[1], 0xFF0000)
        self.assertEqual(words[4], 0x0000FF)


class ImageTests(unittest.TestCase):
    def test_resize_dimensions_and_cell_count(self):
        from PIL import Image

        image = Image.new("RGBA", (245, 342), (200, 0, 0, 255))
        text = cc.to_cells(image, 36, 25, "card")
        self.assertEqual(len(base64.b64decode(text)), 36 * 25 * 12)
        words = struct.unpack("<%dI" % (36 * 25 * 3), base64.b64decode(text))
        self.assertEqual(words[1], 0xC80000)

    def test_transparent_pixels_sit_on_dark_grey(self):
        from PIL import Image

        image = Image.new("RGBA", (10, 10), (255, 255, 255, 0))
        words = struct.unpack("<3I", base64.b64decode(cc.to_cells(image, 1, 1, "card")))
        self.assertEqual(words[1], 0x101010)

    def test_crop_fractions(self):
        self.assertIsNone(cc.crop_box(245, 342, "card"))
        self.assertEqual(cc.crop_box(1000, 1000, "art"), (80, 105, 920, 500))

    def test_art_mode_crops_before_resizing(self):
        from PIL import Image

        image = Image.new("RGBA", (100, 100), (0, 0, 255, 255))
        for x in range(100):
            for y in range(50):
                image.putpixel((x, y), (255, 0, 0, 255))
        # the art window (y 10..50) is entirely red
        words = struct.unpack("<3I", base64.b64decode(cc.to_cells(image, 1, 1, "art")))
        self.assertEqual(words[1], 0xFF0000)
        self.assertEqual(words[2], 0xFF0000)


class RunTests(unittest.TestCase):
    def test_bad_arguments_exit_two(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "o.json")
            png = os.path.join(d, "a.png")
            self.assertEqual(cc.run("https://evil.example/x.png", 4, 4, "card", png, out, fetch=lambda *a: True), 2)
            self.assertEqual(cc.run("https://assets.tcgdex.net/x/low.png", 0, 4, "card", png, out, fetch=lambda *a: True), 2)
            self.assertEqual(cc.run("https://assets.tcgdex.net/x/low.png", 4, 257, "card", png, out, fetch=lambda *a: True), 2)
            self.assertEqual(cc.run("https://assets.tcgdex.net/x/low.png", 4, 4, "wide", png, out, fetch=lambda *a: True), 2)

    def test_failed_download_exits_three(self):
        with tempfile.TemporaryDirectory() as d:
            code = cc.run("https://assets.tcgdex.net/x/low.png", 4, 4, "card", os.path.join(d, "a.png"), os.path.join(d, "o.json"), fetch=lambda *a: False)
            self.assertEqual(code, 3)

    def test_undecodable_file_exits_four(self):
        with tempfile.TemporaryDirectory() as d:
            png = os.path.join(d, "a.png")
            with open(png, "wb") as f:
                f.write(cc.PNG_MAGIC + b"not really")
            code = cc.run("https://assets.tcgdex.net/x/low.png", 4, 4, "card", png, os.path.join(d, "o.json"), fetch=lambda *a: True)
            self.assertEqual(code, 4)

    def test_good_run_writes_the_file(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as d:
            png = os.path.join(d, "a.png")
            Image.new("RGB", (24, 33), (0, 128, 0)).save(png)
            out = os.path.join(d, "sub", "o.json")
            self.assertEqual(cc.run("https://images.pokemontcg.io/x/1.png", 6, 4, "card", png, out, fetch=lambda *a: True), 0)
            with open(out, encoding="utf-8") as f:
                data = json.load(f)
            self.assertEqual((data["v"], data["cols"], data["rows"], data["mode"]), (1, 6, 4, "card"))
            self.assertEqual(len(base64.b64decode(data["cells"])), 6 * 4 * 12)

    def test_download_uses_the_user_agent_and_checks_the_magic(self):
        seen = {}

        class Reply:
            def __init__(self, data):
                self.data = data

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return self.data

        def opener(request, timeout):
            seen["ua"] = request.get_header("User-agent")
            seen["timeout"] = timeout
            return Reply(seen["body"])

        with tempfile.TemporaryDirectory() as d:
            png = os.path.join(d, "img", "a.png")
            seen["body"] = b"<html>403</html>"
            self.assertFalse(cc.download("https://assets.tcgdex.net/x", png, opener=opener))
            self.assertFalse(os.path.exists(png))
            seen["body"] = cc.PNG_MAGIC + b"data"
            self.assertTrue(cc.download("https://assets.tcgdex.net/x", png, opener=opener))
            self.assertEqual(seen["ua"], cc.USER_AGENT)
            self.assertEqual(seen["timeout"], 10)
            seen["body"] = None  # a second call must not touch the network
            self.assertTrue(cc.download("https://assets.tcgdex.net/x", png, opener=None))


class ClearCacheTests(unittest.TestCase):
    def test_refuses_other_paths(self):
        self.assertFalse(cc.clear_cache("C:/"))
        self.assertFalse(cc.clear_cache("C:\\Users"))
        self.assertFalse(cc.clear_cache("/tmp/cache"))
        self.assertFalse(cc.clear_cache("run"))

    def test_removes_run_cache(self):
        with tempfile.TemporaryDirectory() as d:
            cache = os.path.join(d, "run", "cache")
            os.makedirs(os.path.join(cache, "img"))
            with open(os.path.join(cache, "img", "a.png"), "wb") as f:
                f.write(b"x")
            keep = os.path.join(d, "run", "collection.json")
            with open(keep, "w") as f:
                f.write("{}")
            self.assertTrue(cc.clear_cache(cache))
            self.assertFalse(os.path.exists(cache))
            self.assertTrue(os.path.exists(keep))
            self.assertEqual(cc.main(["x", "--clear-cache", "C:/"]), 2)


if __name__ == "__main__":
    unittest.main()
