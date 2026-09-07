"""Draw EVE's dock icon — the new face's orb: a triangulated glowing globe
wrapped in a teal particle veil with segmented rings, on the near-black
background, in a macOS-style rounded square — as a 1024x1024 PNG, using only
the stdlib (zlib + struct). No PIL, no ImageMagick, fully deterministic.

The reference is the accepted handoff orb (face/orb/eve-orb.js): wireframe
icosphere core, three concentric segmented bands (recessed inner circuitry,
broad radial blue panels, narrow teal crown), and a dense particle membrane.
This is a 2D evocation of that 3D scene, not a screenshot of it."""

import math
import struct
import zlib
from pathlib import Path

SIZE = 1024
OUT = Path(__file__).parent / "icon_1024.png"

# palette (the new face's own tokens)
BG = (1, 3, 4)            # --eve-bg near-black
GLOBE = (161, 240, 214)   # the wireframe's pale teal
GLOBE_DIM = (34, 90, 78)
BAND = (17, 118, 151)     # the broad radial blue panels
BAND_EDGE = (90, 204, 204)
CROWN = (21, 172, 172)    # the narrow teal segmented crown
VEIL = (18, 176, 172)     # the particle membrane
DUST = (14, 140, 140)

CORNER = SIZE * 0.2237  # Apple's rounded-square corner ratio
CX, CY = SIZE / 2, SIZE / 2

# radii, proportioned like the handoff orb seen frontally
GLOBE_R = SIZE * 0.145
CORE_GLOW_R = SIZE * 0.19
BAND_IN, BAND_OUT = SIZE * 0.225, SIZE * 0.285
CROWN_IN, CROWN_OUT = SIZE * 0.305, SIZE * 0.318
VEIL_R = SIZE * 0.355
AURA_R = SIZE * 0.47


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


# ---- the globe: an icosphere's wireframe, frontally ----------------------
# Deterministic golden-ratio vertices on the sphere, edges drawn as great
# circles; brightness by facing (front-lit) so it reads as a 3D wire globe.
GOLDEN = (1 + math.sqrt(5)) / 2
_V = [
    (-1, GOLDEN, 0), (1, GOLDEN, 0), (-1, -GOLDEN, 0), (1, -GOLDEN, 0),
    (0, -1, GOLDEN), (0, 1, GOLDEN), (0, -1, -GOLDEN), (0, 1, -GOLDEN),
    (GOLDEN, 0, -1), (GOLDEN, 0, 1), (-GOLDEN, 0, -1), (-GOLDEN, 0, 1),
]
verts = []
for v in _V:
    n = math.sqrt(sum(c * c for c in v))
    verts.append(tuple(c / n for c in v))
faces = [
    (0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11),
    (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6), (7, 1, 8),
    (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9),
    (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1),
]


def subdivide(verts, faces):
    mids = {}
    def middle(a, b):
        key = (min(a, b), max(a, b))
        if key in mids:
            return mids[key]
        va, vb = verts[a], verts[b]
        m = tuple((va[i] + vb[i]) / 2 for i in range(3))
        n = math.sqrt(sum(c * c for c in m))
        m = tuple(c / n for c in m)
        verts.append(m)
        mid = len(verts) - 1
        mids[key] = mid
        return mid
    out = []
    for (a, b, c) in faces:
        ab, bc, ca = middle(a, b), middle(b, c), middle(c, a)
        out += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
    return verts, out


for _ in range(2):  # 2 subdivisions: dense enough to read as the handoff globe
    verts, faces = subdivide(verts, faces)

# Rotate the globe slightly (like the live orb, never dead-frontal)
ROT_Y = 0.35
ROT_X = 0.25
cy_, sy_ = math.cos(ROT_Y), math.sin(ROT_Y)
cx_, sx_ = math.cos(ROT_X), math.sin(ROT_X)
rv = []
for (x, y, z) in verts:
    x2 = x * cy_ + z * sy_
    z2 = -x * sy_ + z * cy_
    y2 = y * cx_ - z2 * sx_
    z3 = y * sx_ + z2 * cx_
    rv.append((x2, y2, z3))

edges = set()
for (a, b, c) in faces:
    for (p, q) in ((a, b), (b, c), (c, a)):
        edges.add((min(p, q), max(p, q)))
# screen positions + facing for every vertex
proj = [(CX + v[0] * GLOBE_R, CY - v[1] * GLOBE_R, v[2]) for v in rv]


def globe_glow(x: float, y: float) -> tuple[float, float, float]:
    """Wire globe: line segments + node points, additive."""
    acc = [0.0, 0.0, 0.0]
    for (ai, bi) in edges:
        x1, y1, z1 = proj[ai]
        x2, y2, z2 = proj[bi]
        # segment distance
        dx, dy = x2 - x1, y2 - y1
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / L2))
        px, py = x1 + t * dx, y1 + t * dy
        d = math.hypot(x - px, y - py)
        facing = 0.5 + 0.5 * (z1 * (1 - t) + z2 * t)  # front-lit
        if d < 2.2:
            k = (1 - d / 2.2) * (0.35 + 0.65 * facing)
            acc[0] += GLOBE[0] * k
            acc[1] += GLOBE[1] * k
            acc[2] += GLOBE[2] * k
    # node points (brighter, front-facing only)
    for (x1, y1, z1) in proj:
        if z1 <= 0:
            continue
        d = math.hypot(x - x1, y - y1)
        if d < 3.0:
            k = (1 - d / 3.0) ** 2 * z1
            acc[0] += GLOBE[0] * k * 1.2
            acc[1] += GLOBE[1] * k * 1.2
            acc[2] += GLOBE[2] * k * 1.2
    return (acc[0], acc[1], acc[2])


# ---- segmented bands (drawn as polar segments) ---------------------------
def band(x: float, y: float) -> tuple[float, float, float]:
    d = math.hypot(x - CX, y - CY)
    ang = math.atan2(y - CY, x - CX)
    acc = [0.0, 0.0, 0.0]
    # broad blue panels: segmented, with lit outward edges
    if BAND_IN - 1 < d < BAND_OUT + 1:
        seg = (ang / (2 * math.pi) * 68) % 1.0  # 68 segments, like the orb
        if 0.10 < seg < 0.90:
            t = (d - BAND_IN) / (BAND_OUT - BAND_IN)
            edge = max(0.0, 1 - abs(d - BAND_OUT) / 4)  # cyan outward edge
            k = 0.55 + 0.45 * (1 - t)
            acc[0] += BAND[0] * k + BAND_EDGE[0] * edge * 0.9
            acc[1] += BAND[1] * k + BAND_EDGE[1] * edge * 0.9
            acc[2] += BAND[2] * k + BAND_EDGE[2] * edge * 0.9
    # narrow teal crown
    if CROWN_IN - 1 < d < CROWN_OUT + 1:
        seg = (ang / (2 * math.pi) * 110) % 1.0  # 110 segments
        if 0.12 < seg < 0.88:
            k = 0.8
            acc[0] += CROWN[0] * k
            acc[1] += CROWN[1] * k
            acc[2] += CROWN[2] * k
    return (acc[0], acc[1], acc[2])


# ---- particle veil + dust -------------------------------------------------
def _rand01(n: int) -> float:
    """Deterministic hash-based noise in [0,1)."""
    h = (n * 2654435761) & 0xFFFFFFFF
    h ^= h >> 13
    h = (h * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFFFFFF) / 0xFFFFFFFF


VEIL_POINTS = []
for i in range(560):
    a = _rand01(i * 3 + 1) * 2 * math.pi
    # a wavy, breathing membrane: radius modulated like the toroidal veil
    wob = 0.030 * math.sin(3 * a + 1.2) + 0.018 * math.sin(5 * a + 0.4)
    r = VEIL_R * (1 + wob + (_rand01(i * 3 + 2) - 0.5) * 0.055)
    z = (_rand01(i * 3 + 3) - 0.5) * 0.35  # pseudo-depth for brightness
    VEIL_POINTS.append((CX + r * math.cos(a), CY + r * math.sin(a), 0.55 + 0.45 * (z + 0.35)))


def veil(x: float, y: float) -> tuple[float, float, float]:
    acc = [0.0, 0.0, 0.0]
    for (px, py, bright) in VEIL_POINTS:
        d = math.hypot(x - px, y - py)
        if d < 5.5:
            k = (1 - d / 5.5) ** 1.6 * bright * 1.05
            acc[0] += VEIL[0] * k
            acc[1] += VEIL[1] * k
            acc[2] += VEIL[2] * k
    return (acc[0], acc[1], acc[2])


DUST_POINTS = []
for i in range(240):
    a = _rand01(90000 + i * 2) * 2 * math.pi
    r = VEIL_R * (1.04 + _rand01(90000 + i * 2 + 1) * 0.22)
    DUST_POINTS.append((CX + r * math.cos(a), CY + r * math.sin(a), 0.3 + 0.7 * _rand01(95000 + i)))


def dust(x: float, y: float) -> tuple[float, float, float]:
    acc = [0.0, 0.0, 0.0]
    for (px, py, bright) in DUST_POINTS:
        d = math.hypot(x - px, y - py)
        if d < 2.6:
            k = (1 - d / 2.6) ** 2 * bright * 0.6
            acc[0] += DUST[0] * k
            acc[1] += DUST[1] * k
            acc[2] += DUST[2] * k
    return (acc[0], acc[1], acc[2])


def pixel(x: int, y: int) -> tuple[int, int, int, int]:
    a = rounded_rect_alpha(x + 0.5, y + 0.5)
    if a <= 0:
        return (0, 0, 0, 0)
    fx, fy = x + 0.5, y + 0.5
    r, g, b = float(BG[0]), float(BG[1]), float(BG[2])
    d = math.hypot(fx - CX, fy - CY)

    # soft core glow behind the globe
    if d < CORE_GLOW_R:
        t = d / CORE_GLOW_R
        k = math.exp(-(t ** 2) * 3.2) * 0.30
        r += (GLOBE_DIM[0] * 2) * k
        g += (GLOBE_DIM[1] * 2) * k
        b += (GLOBE_DIM[2] * 2) * k

    # the outer aura: faint teal bloom
    if d < AURA_R:
        t = d / AURA_R
        k = math.exp(-((t - 0.72) / 0.16) ** 2) * 0.22
        r += VEIL[0] * k * 0.55
        g += VEIL[1] * k * 0.55
        b += VEIL[2] * k * 0.55

    for (dr, dg, db) in (band(fx, fy), veil(fx, fy), dust(fx, fy), globe_glow(fx, fy)):
        r += dr
        g += dg
        b += db

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
