#!/usr/bin/env python3
"""Generate clean PNG icons (no external deps): a rounded blue square with a
white paperclip drawn as two nested rounded-rectangle outlines (open at top),
the universal "attachment" symbol."""
import struct, zlib, os

TARGET_DIR = "/home/user/gmail-drive-always-file/icons"
BG = (26, 115, 232, 255)   # Google blue
FG = (255, 255, 255, 255)  # white
TRANSPARENT = (0, 0, 0, 0)


def rounded_square_mask(size, radius):
    inside = set()
    r = radius
    for y in range(size):
        for x in range(size):
            cx = min(max(x, r), size - 1 - r)
            cy = min(max(y, r), size - 1 - r)
            dx, dy = x - cx, y - cy
            if dx * dx + dy * dy <= r * r:
                inside.add((x, y))
    return inside


def rounded_rect_outline(cx, cy, half_w, half_h, radius, stroke, open_top=False):
    """Return set of float-space points near the perimeter of a rounded rect
    centered at (cx,cy). Sampled densely; caller scales to pixels."""
    pts = []
    # distance-field: a point is on the outline if |sdf(p)| <= stroke/2
    x0, x1 = cx - half_w, cx + half_w
    y0, y1 = cy - half_h, cy + half_h
    r = radius
    step = 0.35
    y = y0 - stroke
    while y <= y1 + stroke:
        x = x0 - stroke
        while x <= x1 + stroke:
            # signed distance to rounded rect
            qx = abs(x - cx) - (half_w - r)
            qy = abs(y - cy) - (half_h - r)
            qx = max(qx, 0.0)
            qy = max(qy, 0.0)
            d = (qx * qx + qy * qy) ** 0.5 - r
            if abs(d) <= stroke / 2.0:
                if not (open_top and y < y0 + stroke and abs(x - cx) < half_w - r):
                    pts.append((x, y))
            x += step
        y += step
    return pts


def draw_paperclip(size):
    s = size / 24.0
    pts = set()
    stroke = 2.1
    # Outer clip body
    outer = rounded_rect_outline(12, 12.5, 4.6, 6.8, 4.2, stroke, open_top=True)
    # Inner clip body (shorter, nested)
    inner = rounded_rect_outline(12, 11.0, 2.2, 4.6, 2.1, stroke, open_top=True)
    for (x, y) in outer + inner:
        px = int(round(x * s))
        py = int(round(y * s))
        if 0 <= px < size and 0 <= py < size:
            pts.add((px, py))
    return pts


def make_png(size):
    radius = max(2, round(size * 0.22))
    mask = rounded_square_mask(size, radius)
    glyph = draw_paperclip(size)

    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            if (x, y) not in mask:
                px = TRANSPARENT
            elif (x, y) in glyph:
                px = FG
            else:
                px = BG
            rows.extend(px)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(rows), 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


os.makedirs(TARGET_DIR, exist_ok=True)
for size in (16, 48, 128):
    with open(os.path.join(TARGET_DIR, f"icon{size}.png"), "wb") as f:
        f.write(make_png(size))
    print(f"wrote icon{size}.png")
