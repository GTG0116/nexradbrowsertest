#!/usr/bin/env python3
"""Procedurally render the RadarNexus storm-cell icon and write the PNG sizes the
app needs (favicon + iOS web-app / PWA icons).

There is no SVG rasteriser in this environment, so the icon is drawn here as a
metaball reflectivity field — a cluster of Gaussian "cells" forming an irregular
storm mass with a curved hook echo, coloured with the familiar NWS reflectivity
palette (green -> yellow -> red -> magenta) over black, matching the supplied
logo mark. PNGs are encoded straight from RGBA with zlib (stdlib only).
"""
import math, struct, zlib

# NWS-style reflectivity palette as (stop 0..1, (r,g,b)). Warm/strong = high.
PALETTE = [
    (0.00, (10, 110, 25)),    # dark green (edge)
    (0.16, (24, 175, 35)),    # green
    (0.30, (90, 215, 45)),    # light green
    (0.42, (245, 245, 50)),   # yellow
    (0.52, (250, 175, 30)),   # orange
    (0.62, (240, 60, 30)),    # red
    (0.78, (205, 20, 25)),    # deep red (bulk of the cell)
    (0.90, (150, 0, 10)),     # darkest red
    (0.96, (210, 40, 225)),   # magenta core
    (1.00, (240, 150, 250)),  # bright magenta core
]


def ramp(t):
    t = max(0.0, min(1.0, t))
    for i in range(len(PALETTE) - 1):
        a, ca = PALETTE[i]
        b, cb = PALETTE[i + 1]
        if a <= t <= b:
            f = (t - a) / (b - a) if b > a else 0.0
            return tuple(ca[j] + (cb[j] - ca[j]) * f for j in range(3))
    return PALETTE[-1][1]


# Storm cells: (cx, cy, radius, weight) in a -1..1 normalised square. The main
# mass sits upper-right; a trailing arc of shrinking cells curls into a hook
# echo toward the lower-left, like the logo.
def build_cells():
    cells = [
        (0.18, -0.22, 0.52, 1.05),
        (0.36, -0.05, 0.42, 0.95),
        (0.00, -0.34, 0.40, 0.90),
        (0.42, -0.40, 0.34, 0.80),
        (-0.16, -0.10, 0.40, 0.92),
        (0.30, 0.18, 0.34, 0.78),
        (-0.04, 0.10, 0.36, 0.85),
        (0.50, -0.20, 0.30, 0.70),
        (-0.30, -0.36, 0.30, 0.72),
    ]
    # Hook echo: a curling tail of cells spiralling down-left then hooking up.
    n = 10
    for i in range(n):
        f = i / (n - 1)
        ang = math.pi * (0.55 + 1.55 * f)        # sweep around
        rad = 0.30 + 0.42 * f                     # spiral outward
        cx = -0.30 - rad * 0.55 * math.cos(ang)
        cy = 0.18 + rad * 0.62 * math.sin(ang)
        cells.append((cx, cy, 0.20 - 0.10 * f, 0.62 - 0.18 * f))
    return cells


CELLS = build_cells()

# A handful of intense "cores" that punch into magenta, like the logo's hot
# streaks low and left of centre.
CORES = [(-0.08, 0.06, 0.16), (0.06, 0.16, 0.14), (-0.20, -0.02, 0.13)]


def _hash(ix, iy):
    h = (ix * 374761393 + iy * 668265263) & 0xffffffff
    h = (h ^ (h >> 13)) * 1274126177 & 0xffffffff
    return ((h ^ (h >> 16)) & 0xffff) / 65535.0


def noise(x, y, cells=34):
    """Blocky value noise on a coarse grid -> the pixelated radar-gate texture."""
    gx, gy = x * cells, y * cells
    ix, iy = math.floor(gx), math.floor(gy)
    return _hash(int(ix), int(iy))


def field(x, y):
    s = 0.0
    for cx, cy, r, w in CELLS:
        dx, dy = (x - cx) / r, (y - cy) / r
        s += w * math.exp(-(dx * dx + dy * dy) * 1.55)
    core = 0.0
    for cx, cy, r in CORES:
        dx, dy = (x - cx) / r, (y - cy) / r
        core += math.exp(-(dx * dx + dy * dy))
    return s, core


def render(size, pad=0.10, corner=0.0):
    """Return RGBA bytes for an icon `size`x`size`. `corner` rounds the black
    tile (0 = square). 2x supersampled for clean edges."""
    ss = 2
    S = size * ss
    px = bytearray(4 * size * size)
    half = (size - 1) / 2.0
    rad_px = size * (0.5 - 0.0)
    for j in range(size):
        for i in range(size):
            acc = [0, 0, 0, 0]
            for sj in range(ss):
                for si in range(ss):
                    fx = (i + (si + 0.5) / ss)
                    fy = (j + (sj + 0.5) / ss)
                    # normalised -1..1 with padding margin
                    nx = (fx / size * 2 - 1) / (1 - pad)
                    ny = (fy / size * 2 - 1) / (1 - pad)
                    r, g, b, a = 0, 0, 0, 255
                    v, core = field(nx, ny)
                    # granular texture: jitter the field by blocky noise so the
                    # cell breaks into radar-gate speckle instead of smooth bands
                    nz = noise(nx * 0.5 + 0.5, ny * 0.5 + 0.5)
                    v *= 0.82 + 0.34 * nz
                    if v > 0.34:
                        # Map the bulk of the mass into greens->reds; only the
                        # intense cores (plus a noise kick) reach magenta.
                        base = (v - 0.34) / 0.62          # 0..~1 across the cell
                        t = 0.10 + 0.74 * min(1.0, base)
                        if core > 0.55:
                            t = max(t, 0.90 + 0.12 * (core - 0.55) + 0.05 * nz)
                        col = ramp(t)
                        # soft alpha at the faint fringe so the edge melts to black
                        edge = min(1.0, (v - 0.34) / 0.12)
                        r = int(col[0] * edge)
                        g = int(col[1] * edge)
                        b = int(col[2] * edge)
                    # rounded-corner / circular mask
                    if corner > 0:
                        cx = min(fx, size - fx)
                        cy = min(fy, size - fy)
                        cr = corner * size
                        if cx < cr and cy < cr:
                            d = math.hypot(cr - cx, cr - cy)
                            if d > cr:
                                a = 0
                    acc[0] += r; acc[1] += g; acc[2] += b; acc[3] += a
            o = 4 * (j * size + i)
            px[o] = acc[0] // (ss * ss)
            px[o + 1] = acc[1] // (ss * ss)
            px[o + 2] = acc[2] // (ss * ss)
            px[o + 3] = acc[3] // (ss * ss)
    return bytes(px)


def write_png(path, size, **kw):
    rgba = render(size, **kw)
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)
        raw.extend(rgba[y * stride:(y + 1) * stride])

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) +
           chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    print("wrote", path, size)


if __name__ == "__main__":
    import os
    here = os.path.dirname(os.path.abspath(__file__))
    # Maskable/full-bleed square icons (PWA + iOS use a black tile, no rounding —
    # iOS rounds it for us; the manifest declares them maskable).
    write_png(os.path.join(here, "icon-512.png"), 512)
    write_png(os.path.join(here, "icon-192.png"), 192)
    write_png(os.path.join(here, "apple-touch-icon.png"), 180)
    write_png(os.path.join(here, "favicon-32.png"), 32)
    write_png(os.path.join(here, "favicon-16.png"), 16)
