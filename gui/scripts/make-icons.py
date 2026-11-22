#!/usr/bin/env python3
"""Generates the app and tray icons (pure Python, no dependencies)."""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')


def png(path, w, h, pixels):
    raw = b''.join(b'\x00' + bytes(pixels[y * w * 4:(y + 1) * w * 4]) for y in range(h))

    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    data += chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(data)


def shield(x, y):
    """Shield in unit square [0,1]; returns True if inside."""
    cx = 0.5
    if y < 0.08 or y > 0.94:
        return False
    top = 0.08 + 0.07 * (abs(x - cx) / 0.36) if abs(x - cx) <= 0.36 else 1
    if y < top:
        return False
    if y < 0.5:
        return abs(x - cx) <= 0.36
    # lower part narrows to a point (quadratic curve)
    t = (y - 0.5) / 0.44
    half = 0.36 * math.sqrt(max(0.0, 1 - t * t))
    return abs(x - cx) <= half


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def check(x, y, w=0.075):
    return seg_dist(x, y, 0.33, 0.50, 0.45, 0.63) < w or seg_dist(x, y, 0.45, 0.63, 0.68, 0.38) < w


def render(size, fn, ss=4):
    px = []
    for j in range(size):
        for i in range(size):
            acc = [0, 0, 0, 0]
            for sj in range(ss):
                for si in range(ss):
                    x = (i + (si + 0.5) / ss) / size
                    y = (j + (sj + 0.5) / ss) / size
                    r, g, b, a = fn(x, y)
                    acc[0] += r * a
                    acc[1] += g * a
                    acc[2] += b * a
                    acc[3] += a
            n = ss * ss
            a = acc[3] / n
            if a > 0:
                px += [int(acc[0] / acc[3]), int(acc[1] / acc[3]), int(acc[2] / acc[3]), int(a * 255)]
            else:
                px += [0, 0, 0, 0]
    return px


def app_icon(x, y):
    # rounded square with red gradient, white shield and check
    m, r = 0.06, 0.2
    qx = max(abs(x - 0.5) - (0.5 - m - r), 0)
    qy = max(abs(y - 0.5) - (0.5 - m - r), 0)
    if math.hypot(qx, qy) > r:
        return (0, 0, 0, 0)
    t = (x + y) / 2
    bg = (int(232 - 90 * t), int(58 - 38 * t), int(52 - 32 * t))
    sx, sy = (x - 0.5) / 0.62 + 0.5, (y - 0.5) / 0.62 + 0.5
    if shield(sx, sy):
        if check(sx, sy):
            return (*bg, 1)
        return (255, 255, 255, 1)
    return (*bg, 1)


def tray(kind):
    def f(x, y):
        sx, sy = (x - 0.5) / 0.92 + 0.5, (y - 0.5) / 0.92 + 0.5
        inside = shield(sx, sy)
        if not inside:
            return (0, 0, 0, 0)
        # outline: inside but not inside a shrunken shield
        ix, iy = (sx - 0.5) / 0.72 + 0.5, (sy - 0.52) / 0.72 + 0.5
        inner = shield(ix, iy)
        if kind == 'off':
            return (0, 0, 0, 0) if inner else (0, 0, 0, 1)
        if kind == 'busy':
            if inner and sx > 0.5:
                return (0, 0, 0, 1)
            return (0, 0, 0, 0) if inner else (0, 0, 0, 1)
        # on: filled with knocked-out check
        return (0, 0, 0, 0) if check(sx, sy, 0.085) else (0, 0, 0, 1)
    return f


def colorize(px, rgb):
    out = list(px)
    for k in range(0, len(out), 4):
        out[k:k + 3] = rgb
    return out


os.makedirs(OUT, exist_ok=True)
png(os.path.join(OUT, 'icon.png'), 512, 512, render(512, app_icon, 2))
for kind in ('off', 'busy', 'on'):
    for scale, suffix in ((1, ''), (2, '@2x')):
        size = 18 * scale
        px = render(size, tray(kind))
        png(os.path.join(OUT, f'tray-{kind}Template{suffix}.png'), size, size, px)
        color = {'off': (200, 205, 214), 'busy': (227, 162, 59), 'on': (52, 200, 138)}[kind]
        png(os.path.join(OUT, f'tray-{kind}{suffix}.png'), size * 1, size * 1, colorize(px, color))
print('icons written to', os.path.abspath(OUT))
