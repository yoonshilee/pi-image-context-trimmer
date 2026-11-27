"""Generate deterministic synthetic images for the paid vision benchmark."""

import hashlib
import json
from pathlib import Path
import random
import struct
import zlib

DIGITS = {
    "0": ("11111", "10001", "10001", "10001", "10001", "10001", "11111"),
    "1": ("00100", "01100", "00100", "00100", "00100", "00100", "01110"),
    "2": ("11111", "00001", "00001", "11111", "10000", "10000", "11111"),
    "3": ("11111", "00001", "00001", "11111", "00001", "00001", "11111"),
    "4": ("10001", "10001", "10001", "11111", "00001", "00001", "00001"),
    "5": ("11111", "10000", "10000", "11111", "00001", "00001", "11111"),
    "6": ("11111", "10000", "10000", "11111", "10001", "10001", "11111"),
    "7": ("11111", "00001", "00010", "00100", "01000", "01000", "01000"),
    "8": ("11111", "10001", "10001", "11111", "10001", "10001", "11111"),
    "9": ("11111", "10001", "10001", "11111", "00001", "00001", "11111"),
}

CASES = (
    ("small", 480, 290, 41, "4817", "7256"),
    ("large", 960, 600, 73, "6093", "3842"),
)


def chunk(kind, data):
    """Encode a PNG chunk.

    Args:
        kind: Four-byte chunk identifier.
        data: Chunk payload.

    Returns:
        Bytes containing the length, payload, and checksum.
    """
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def make_image(width, height, seed, top, bottom):
    """Render two visually separate, four-digit codes on a noise background.

    Args:
        width: Image width in pixels.
        height: Image height in pixels.
        seed: Deterministic noise seed.
        top: Upper panel's expected code.
        bottom: Lower panel's expected code.

    Returns:
        Encoded RGB PNG bytes.
    """
    pixels = bytearray(random.Random(seed).randbytes(width * height * 3))
    scale = max(8, height // 28)
    panel_width = min(width - 32, 28 * scale)
    panel_height = 11 * scale
    panel_x = (width - panel_width) // 2
    for center_y, code in ((height // 4, top), (3 * height // 4, bottom)):
        panel_y = center_y - panel_height // 2
        for y in range(panel_y, panel_y + panel_height):
            start = (y * width + panel_x) * 3
            pixels[start : start + panel_width * 3] = b"\xff" * (panel_width * 3)
        x0 = (width - (len(code) * 6 - 1) * scale) // 2
        y0 = center_y - 7 * scale // 2
        for index, digit in enumerate(code):
            for row, pattern in enumerate(DIGITS[digit]):
                for col, cell in enumerate(pattern):
                    if cell == "0":
                        continue
                    x = x0 + (index * 6 + col) * scale
                    for y in range(y0 + row * scale, y0 + (row + 1) * scale):
                        start = (y * width + x) * 3
                        pixels[start : start + scale * 3] = b"\x00" * (scale * 3)
    scanlines = b"".join(b"\x00" + pixels[y * width * 3 : (y + 1) * width * 3] for y in range(height))
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(scanlines)) + chunk(b"IEND", b"")


def main():
    """Write fixtures and the frozen expected-answer manifest."""
    destination = Path(__file__).parent / "fixtures"
    destination.mkdir(exist_ok=True)
    manifest = []
    for name, width, height, seed, top, bottom in CASES:
        data = make_image(width, height, seed, top, bottom)
        filename = f"{name}.png"
        (destination / filename).write_bytes(data)
        manifest.append({"name": name, "file": filename, "width": width, "height": height, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "top": top, "bottom": bottom})
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
