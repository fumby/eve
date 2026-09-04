"""Draw EVE's dock icon — her glowing teal orb on the dark cosmic background,
in a macOS-style rounded square — as a 1024x1024 PNG, using only the stdlib
(zlib + struct). No PIL, no ImageMagick, fully deterministic."""

import math
import struct
import zlib
from pathlib import Path

SIZE = 1024
OUT = Path(__file__).parent / "icon_1024.png"

# palette (the face's own colors)
BG = (5, 7, 11)
TEAL = (45, 212, 168)
PALE = (159, 240, 218)

CORNER = SIZE * 0.2237  # Apple's rounded-square corner ratio
CX, CY = SIZE / 2, SIZE * 0.47
CORE_R = SIZE * 0.130
HALO_R = SIZE * 0.400


def rounded_rect_alpha(x: float, y: float) -> float:
    """1 inside the rounded square, 0 outside, soft 2px edge."""
    hx = SIZE / 2 - CORNER
    dx = max(abs(x - SIZE / 2) - hx, 0.0)
    dy = max(abs(y - SIZE / 2) - hx, 0.0)
    d = math.hypot(dx, dy) - CORNER
    if d < -1:
        return 1.0
    if d > 1:
        return 0.0
    return 0.5 - d / 2


def star_field(x: int, y: int) -> float:
    """A few deterministic faint stars."""
    h = (x * 73856093 ^ y * 19349663) & 0xFFFFFF
    return 0.55 if h < 900 else 0.0


def pixel(x: int, y: int) -> tuple[int, int, int, int]:
    a = rounded_rect_alpha(x + 0.5, y + 0.5)
    if a <= 0:
        return (0, 0, 0, 0)

    d = math.hypot(x - CX, y - CY)
    r, g, b = BG

    # faint nebula wash toward the lower left, like the scene
    wash = max(0.0, 1 - math.hypot(x - SIZE * 0.3, y - SIZE * 0.75) / (SIZE * 0.9)) * 0.10
    r += TEAL[0] * wash * 0.4
    g += TEAL[1] * wash * 0.4
    b += TEAL[2] * wash * 0.4

    s = star_field(x, y)
    if s and d > HALO_R * 0.9:
        r += 200 * s
        g += 215 * s
        b += 235 * s

    if d < HALO_R:
        t = d / HALO_R
        if t < 0.28:
            # white-hot core blending to pale teal
            k = t / 0.28
            r += (255 - r) * (1 - k) + (PALE[0] - r) * k * 0.9
            g += (255 - g) * (1 - k) + (PALE[1] - g) * k * 0.9
            b += (255 - b) * (1 - k) + (PALE[2] - b) * k * 0.9
        else:
            # halo: teal falling off exponentially
            k = math.exp(-((t - 0.28) / 0.30) ** 1.6)
            r += (TEAL[0] - r) * k
            g += (TEAL[1] - g) * k
            b += (TEAL[2] - b) * k

    return (min(255, int(r)), min(255, int(g)), min(255, int(b)), int(a * 255))


def write_png(path: Path) -> None:
    raw = bytearray()
    for y in range(SIZE):
        raw.append(0)  # filter: none
        for x in range(SIZE):
            raw.extend(pixel(x, y))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)  # RGBA8
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)
    print(f"wrote {path} ({len(png)} bytes)")


if __name__ == "__main__":
    write_png(OUT)
