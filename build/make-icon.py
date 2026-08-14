#!/usr/bin/env python3
"""Generate Nova's app icon (1024x1024 RGBA PNG) with no external libraries.

Draws the "Aurora Glass" identity: a midnight rounded-square tile with a glowing
cyan->violet->pink aurora orb. Output: build/icon.png
"""
import math, struct, zlib, os

N = 1024
CX, CY = 512.0, 496.0          # orb centre (slightly above middle)
R = 300.0                      # orb radius
MARGIN = 80.0                  # transparent margin around the tile
CR = 200.0                     # tile corner radius

CYAN   = (34, 211, 238)
VIOLET = (139, 92, 246)
PINK   = (244, 114, 182)
BG_TOP = (16, 21, 48)          # #101530
BG_BOT = (10, 14, 39)          # #0a0e27


def lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t)


def aurora(t):
    t = max(0.0, min(1.0, t))
    return lerp(CYAN, VIOLET, t * 2) if t < 0.5 else lerp(VIOLET, PINK, (t - 0.5) * 2)


def rrect_coverage(x, y):
    """Anti-aliased coverage (0..1) of the rounded-square tile."""
    half = (N - 2 * MARGIN) / 2.0
    qx = abs(x - N / 2.0) - (half - CR)
    qy = abs(y - N / 2.0) - (half - CR)
    d = math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - CR
    return max(0.0, min(1.0, 0.5 - d))


raw = bytearray()
for y in range(N):
    raw.append(0)  # PNG filter type 0 for this scanline
    fy = y + 0.5
    for x in range(N):
        fx = x + 0.5
        rc = rrect_coverage(fx, fy)
        if rc <= 0.0:
            raw += b'\x00\x00\x00\x00'
            continue

        # Base midnight vertical gradient.
        base = lerp(BG_TOP, BG_BOT, y / float(N))
        r, g, b = base

        dist = math.hypot(fx - CX, fy - CY)

        # Outer aurora glow.
        if dist > R:
            f = (R + 240.0 - dist) / 240.0
            if f > 0.0:
                f = f * f * 0.55
                gc = lerp(VIOLET, CYAN, 0.4)
                r += gc[0] * f
                g += gc[1] * f
                b += gc[2] * f

        # The orb itself (aurora gradient along the 115deg diagonal).
        orb = max(0.0, min(1.0, R + 0.5 - dist))
        if orb > 0.0:
            t = ((fx - (CX - R)) * 0.6 + (fy - (CY - R)) * 0.4) / (2.0 * R)
            oc = aurora(t)
            # Soft top-left highlight for a glassy sphere look.
            hl = max(0.0, 1.0 - math.hypot(fx - (CX - 90), fy - (CY - 110)) / 230.0) * 0.5
            oc = lerp(oc, (255, 255, 255), hl)
            r = r + (oc[0] - r) * orb
            g = g + (oc[1] - g) * orb
            b = b + (oc[2] - b) * orb

        a = int(round(255 * rc))
        raw.append(max(0, min(255, int(round(r)))))
        raw.append(max(0, min(255, int(round(g)))))
        raw.append(max(0, min(255, int(round(b)))))
        raw.append(a)


def chunk(tag, data):
    return (struct.pack('>I', len(data)) + tag + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))


png = b'\x89PNG\r\n\x1a\n'
png += chunk(b'IHDR', struct.pack('>IIBBBBB', N, N, 8, 6, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
png += chunk(b'IEND', b'')

out = os.path.join(os.path.dirname(__file__), 'icon.png')
with open(out, 'wb') as f:
    f.write(png)
print('wrote', out, os.path.getsize(out), 'bytes')
