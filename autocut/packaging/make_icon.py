"""Draw the Autocut icon (three offset 'camera' blocks) into an .iconset folder.

Pure numpy + zlib PNG writer: no image library needed at build time.
"""
import struct
import sys
import zlib
from pathlib import Path

import numpy as np


def png(path: Path, rgba: np.ndarray) -> None:
    h, w, _ = rgba.shape
    raw = b"".join(b"\0" + rgba[y].tobytes() for y in range(h))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def draw(size: int) -> np.ndarray:
    s = size
    y, x = np.mgrid[0:s, 0:s].astype(np.float32) + 0.5
    img = np.zeros((s, s, 4), np.float32)
    # rounded-square background
    m, r = 0.09 * s, 0.2 * s
    dx = np.maximum(np.maximum(m + r - x, x - (s - m - r)), 0)
    dy = np.maximum(np.maximum(m + r - y, y - (s - m - r)), 0)
    inside = np.clip(r - np.hypot(dx, dy) + 0.5, 0, 1)
    img[..., :3] = np.array([0.12, 0.12, 0.13]) * (1 - 0.25 * y[..., None] / s)
    img[..., 3] = inside
    # three shots, like cuts on a timeline
    for i, (col, off) in enumerate([((0.31, 0.55, 1.0), 0.0), ((0.24, 0.81, 0.56), 0.17), ((0.96, 0.65, 0.14), 0.34)]):
        x0, x1 = (0.2 + off) * s, (0.2 + off + 0.28) * s
        y0 = (0.27 + i * 0.17) * s
        y1 = y0 + 0.12 * s
        a = np.clip(np.minimum.reduce([x - x0, x1 - x, y - y0, y1 - y]) + 0.5, 0, 1) * inside
        img[..., :3] = img[..., :3] * (1 - a[..., None]) + np.array(col) * a[..., None]
    return (np.clip(img, 0, 1) * 255).astype(np.uint8)


def main(out: str) -> None:
    d = Path(out)
    d.mkdir(parents=True, exist_ok=True)
    for base in (16, 32, 128, 256, 512):
        png(d / f"icon_{base}x{base}.png", draw(base))
        png(d / f"icon_{base}x{base}@2x.png", draw(base * 2))


if __name__ == "__main__":
    main(sys.argv[1])
