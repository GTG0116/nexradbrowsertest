#!/usr/bin/env python3
"""Generate the favicon + iOS web-app / PWA icon PNGs from the RadarNexus mark.

The square brand mark lives in `Logo2.png`; this script decodes it and box-
downscales it to every size the app and manifest reference. (The wide wordmark,
`Logo1.png`, is shown on screen directly and isn't rasterised here.)

Everything is stdlib only — a minimal PNG decoder (zlib inflate + per-scanline
unfilter), an area-average downscaler, and a zlib PNG encoder — so it runs with
no Pillow/ImageMagick in the environment.
"""
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "Logo2.png")

# (filename, size) for each icon the app + manifest declare.
TARGETS = [
    ("icon-512.png", 512),
    ("icon-192.png", 192),
    ("apple-touch-icon.png", 180),
    ("favicon-32.png", 32),
    ("favicon-16.png", 16),
]


def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def decode_png(path):
    """Decode an 8-bit non-interlaced PNG (RGB or RGBA) to (w, h, channels, bytes)."""
    with open(path, "rb") as f:
        data = f.read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    pos = 8
    width = height = bit_depth = color_type = None
    idat = bytearray()
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        tag = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length  # length + tag + data + CRC
        if tag == b"IHDR":
            width, height, bit_depth, color_type = struct.unpack(">IIBB", chunk[:10])
        elif tag == b"IDAT":
            idat.extend(chunk)
        elif tag == b"IEND":
            break
    assert bit_depth == 8, "only 8-bit PNGs supported"
    channels = {0: 1, 2: 3, 6: 4}[color_type]
    raw = zlib.decompress(bytes(idat))
    stride = width * channels
    out = bytearray(stride * height)
    prev = bytearray(stride)
    p = 0
    for y in range(height):
        ftype = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        for i in range(stride):
            a = line[i - channels] if i >= channels else 0
            b = prev[i]
            c = prev[i - channels] if i >= channels else 0
            if ftype == 1:
                line[i] = (line[i] + a) & 0xff
            elif ftype == 2:
                line[i] = (line[i] + b) & 0xff
            elif ftype == 3:
                line[i] = (line[i] + ((a + b) >> 1)) & 0xff
            elif ftype == 4:
                line[i] = (line[i] + _paeth(a, b, c)) & 0xff
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return width, height, channels, bytes(out)


def downscale(src_w, src_h, ch, pixels, size):
    """Area-average downscale `pixels` to size×size, returning RGBA bytes."""
    out = bytearray(4 * size * size)
    for dy in range(size):
        y0 = dy * src_h // size
        y1 = max(y0 + 1, (dy + 1) * src_h // size)
        for dx in range(size):
            x0 = dx * src_w // size
            x1 = max(x0 + 1, (dx + 1) * src_w // size)
            r = g = b = a = n = 0
            for sy in range(y0, y1):
                row = sy * src_w * ch
                for sx in range(x0, x1):
                    o = row + sx * ch
                    r += pixels[o]
                    g += pixels[o + 1]
                    b += pixels[o + 2]
                    a += pixels[o + 3] if ch == 4 else 255
                    n += 1
            d = 4 * (dy * size + dx)
            out[d] = r // n
            out[d + 1] = g // n
            out[d + 2] = b // n
            out[d + 3] = a // n
    return bytes(out)


def write_png(path, size, rgba):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)  # filter type 0 (none)
        raw.extend(rgba[y * stride:(y + 1) * stride])

    def chunk(tag, payload):
        return (struct.pack(">I", len(payload)) + tag + payload +
                struct.pack(">I", zlib.crc32(tag + payload) & 0xffffffff))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) +
           chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    print("wrote", path, size)


if __name__ == "__main__":
    w, h, ch, px = decode_png(SOURCE)
    for name, size in TARGETS:
        write_png(os.path.join(HERE, name), size, downscale(w, h, ch, px, size))
