"""Fonds d'écran originaux générés par programme (aucune image tierce) pour Transcripteur IA.

Usage : python3 assets/fonds/generer.py assets/fonds
"""
import math
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

W, H = 1920, 1200
OUT = sys.argv[1] if len(sys.argv) > 1 else '.'
rng = np.random.default_rng(7)


def fbm(w, h, octaves=6, base=4, seed=0, persistence=0.5):
    r = np.random.default_rng(seed)
    acc = np.zeros((h, w), np.float32)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        n = base * 2 ** o
        g = r.random((max(2, int(n * h / w)) + 1, n + 1)).astype(np.float32)
        im = Image.fromarray((g * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC)
        acc += amp * np.asarray(im, np.float32) / 255
        tot += amp
        amp *= persistence
    acc /= tot
    return (acc - acc.min()) / (acc.max() - acc.min() + 1e-6)


def grad(stops, t):
    """Dégradé multi-arrêts : stops = [(pos, (r,g,b)), ...], t dans [0,1]."""
    t = np.clip(t, 0, 1)
    out = np.zeros(t.shape + (3,), np.float32)
    for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
        m = (t >= p0) & (t <= p1)
        k = ((t - p0) / max(p1 - p0, 1e-6))[..., None]
        out[m] = (np.array(c0) * (1 - k) + np.array(c1) * k)[m]
    return out


def save(arr, name):
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    img.save(f'{OUT}/{name}.webp', quality=80, method=6)
    img.resize((480, 300), Image.LANCZOS).save(f'{OUT}/{name}-mini.webp', quality=78, method=6)


Y, X = np.mgrid[0:H, 0:W].astype(np.float32)
yn, xn = Y / H, X / W


def stars(arr, n=900, seed=1, top=1.0):
    r = np.random.default_rng(seed)
    for _ in range(n):
        x, y = r.integers(0, W), r.integers(0, int(H * top))
        b = r.random() ** 3 * 220
        arr[y, x] = np.minimum(255, arr[y, x] + b)
    return arr


# 1. Aurore boréale
def aurore():
    sky = grad([(0, (8, 10, 28)), (0.6, (12, 22, 48)), (1, (10, 30, 45))], yn)
    n = fbm(W, H, 5, 3, seed=11)
    for k, (col, off, amp) in enumerate([((60, 230, 160), 0.33, 0.10), ((120, 90, 255), 0.25, 0.08), ((40, 200, 220), 0.42, 0.07)]):
        centre = off + amp * np.sin(xn * (5 + k) + k * 1.7) + 0.05 * (n - 0.5)
        d = (yn - centre)
        streak = fbm(W, H, 4, 24, seed=90 + k)
        band = np.exp(-(d / 0.075) ** 2) * (0.45 + 0.55 * streak ** 1.5)
        tail = np.where(d > 0, np.exp(-d / 0.25), 0) * np.exp(-(d / 0.35) ** 2)
        sky += (band * 0.9 + tail * 0.35)[..., None] * np.array(col) * 0.9
    sky = stars(sky, 1100, 2, 0.6)
    ridge = 0.86 + 0.05 * fbm(W, 1, 6, 6, seed=3)[0] - 0.03 * np.sin(xn[0] * 7)
    sky[yn > ridge[None, :].repeat(H, 0)] = (6, 9, 16)
    save(sky, 'aurore-boreale')


# 2. Dunes au couchant
def dunes():
    img = grad([(0, (40, 24, 70)), (0.35, (200, 90, 90)), (0.55, (250, 170, 110)), (1, (250, 200, 150))], yn)
    sun = np.exp(-(((xn - 0.68) * 1.6) ** 2 + ((yn - 0.42) * 2.6) ** 2) / 0.004)
    img += sun[..., None] * np.array((255, 220, 170)) * 0.9
    layers = [(0.55, (180, 80, 70)), (0.66, (150, 60, 60)), (0.78, (110, 45, 55)), (0.9, (70, 30, 45))]
    for i, (base, col) in enumerate(layers):
        top = base + 0.06 * np.sin(xn[0] * (3 + i) + i * 2.1) + 0.03 * np.sin(xn[0] * (9 + i * 2) + i)
        mask = yn > top[None, :].repeat(H, 0)
        shade = np.clip((yn - top[None, :]) * 3, 0, 1)
        c = np.array(col)[None, None, :] * (1.15 - 0.35 * shade[..., None])
        img = np.where(mask[..., None], c, img)
    save(img, 'dunes')


# 3. Montagnes dans la brume
def montagnes():
    img = grad([(0, (30, 36, 80)), (0.5, (110, 100, 170)), (1, (200, 170, 200))], yn)
    for i in range(6):
        prof = fbm(W, 1, 5, 2, seed=40 + i, persistence=0.45)[0]
        top = 0.38 + i * 0.09 + 0.18 * (prof - 0.5) * (1.2 - i * 0.12)
        mask = yn > top[None, :].repeat(H, 0)
        k = i / 5
        col = np.array((150, 140, 200)) * (1 - k) + np.array((25, 22, 50)) * k
        fog = np.clip(1 - (yn - top[None, :]) * 4, 0, 1)[..., None] * 0.35
        c = col[None, None, :] * (1 - fog) + np.array((210, 190, 220)) * fog
        img = np.where(mask[..., None], c, img)
    save(img, 'montagnes-brume')


# 4. Océan profond (caustiques)
def ocean():
    img = grad([(0, (10, 60, 110)), (0.5, (6, 35, 80)), (1, (3, 12, 35))], yn)
    ridge = 1 - np.abs(fbm(W, H, 4, 10, seed=61) * 2 - 1)
    ridge2 = 1 - np.abs(fbm(W, H, 4, 14, seed=62) * 2 - 1)
    caust = (ridge ** 10 * 0.7 + ridge2 ** 12 * 0.5) * np.exp(-yn * 2.0)
    rays = np.clip(np.sin(xn * 40 + yn * 6) * 0.5 + 0.5, 0, 1) ** 6 * np.exp(-yn * 3) * 0.25
    img += (caust * 0.8 + rays)[..., None] * np.array((120, 220, 255))
    save(img, 'ocean-profond')


# 5. Nébuleuse
def nebuleuse():
    n1, n2 = fbm(W, H, 7, 3, seed=80), fbm(W, H, 7, 4, seed=81)
    img = np.zeros((H, W, 3), np.float32) + np.array((6, 5, 18))
    img += (n1 ** 3)[..., None] * np.array((190, 60, 200)) * 1.4
    img += (n2 ** 4)[..., None] * np.array((60, 110, 255)) * 1.6
    img += ((n1 * n2) ** 3)[..., None] * np.array((255, 150, 120)) * 1.5
    img = stars(img, 1600, 5)
    save(img, 'nebuleuse')


# 6. Bokeh
def bokeh():
    base = Image.fromarray(grad([(0, (18, 12, 40)), (1, (40, 15, 50))], yn).astype(np.uint8))
    lay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    r = np.random.default_rng(9)
    cols = [(255, 120, 160), (120, 140, 255), (255, 190, 110), (160, 110, 255), (90, 220, 230)]
    for _ in range(70):
        x, y, s = r.integers(0, W), r.integers(0, H), r.integers(30, 160)
        c = cols[r.integers(0, len(cols))]
        d.ellipse((x - s, y - s, x + s, y + s), fill=c + (int(r.integers(25, 90)),))
    lay = lay.filter(ImageFilter.GaussianBlur(14))
    base.paste(lay, (0, 0), lay)
    save(np.asarray(base, np.float32), 'bokeh')


# 7. Soie (vagues de verre)
def soie():
    img = grad([(0, (20, 16, 50)), (1, (35, 20, 70))], xn * 0.5 + yn * 0.5)
    for k in range(5):
        y0 = 0.25 + k * 0.13 + 0.12 * np.sin(xn * (2.2 + k * 0.4) + k)
        d = yn - y0
        sheen = np.exp(-(d / (0.05 + k * 0.01)) ** 2)
        col = np.array([(140, 110, 255), (230, 120, 200), (120, 170, 255), (255, 160, 140), (170, 130, 255)][k])
        img += sheen[..., None] * col * 0.55
    img = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(6))
    save(np.asarray(img, np.float32), 'soie')


# 8. Plan d'architecte (blueprint)
def plan():
    S = 2
    im = Image.new('RGB', (W * S, H * S), (16, 52, 112))
    d = ImageDraw.Draw(im)
    for x in range(0, W * S, 24 * S):
        d.line((x, 0, x, H * S), fill=(30, 72, 140), width=1)
    for y in range(0, H * S, 24 * S):
        d.line((0, y, W * S, y), fill=(30, 72, 140), width=1)
    for x in range(0, W * S, 120 * S):
        d.line((x, 0, x, H * S), fill=(44, 92, 165), width=2)
    for y in range(0, H * S, 120 * S):
        d.line((0, y, W * S, y), fill=(44, 92, 165), width=2)
    L = (205, 225, 255)
    def wall(x0, y0, x1, y1, w=10):
        d.rectangle((x0 * S, y0 * S, x1 * S, y1 * S), outline=L, width=w)
    # Plan d'un appartement
    ox, oy = 420, 220
    wall(ox, oy, ox + 1080, oy + 720, 12)
    for (x0, y0, x1, y1) in [(ox, oy, ox + 420, oy + 360), (ox + 420, oy, ox + 720, oy + 300), (ox, oy + 360, ox + 300, oy + 720), (ox + 720, oy + 420, ox + 1080, oy + 720)]:
        wall(x0, y0, x1, y1, 6)
    for (cx, cy, r, a0) in [(ox + 420, oy + 300, 90, 180), (ox + 300, oy + 460, 80, 270), (ox + 720, oy + 420, 90, 0)]:
        d.arc(((cx - r) * S, (cy - r) * S, (cx + r) * S, (cy + r) * S), a0, a0 + 90, fill=L, width=3)
    for y in (oy - 70, oy + 790):
        d.line((ox * S, y * S, (ox + 1080) * S, y * S), fill=L, width=2)
        for x in (ox, ox + 420, ox + 720, ox + 1080):
            d.line(((x - 8) * S, (y + 8) * S, (x + 8) * S, (y - 8) * S), fill=L, width=3)
    for x in range(ox + 760, ox + 1060, 26):
        d.line((x * S, (oy + 40) * S, x * S, (oy + 120) * S), fill=L, width=2)
    d.rectangle(((W - 420) * S, (H - 170) * S, (W - 60) * S, (H - 50) * S), outline=L, width=3)
    d.line(((W - 420) * S, (H - 110) * S, (W - 60) * S, (H - 110) * S), fill=L, width=2)
    im = im.resize((W, H), Image.LANCZOS)
    arr = np.asarray(im, np.float32)
    arr *= (1.1 - 0.35 * np.hypot(xn - 0.5, yn - 0.5))[..., None]
    save(arr, 'plan-architecte')


# 9. Maquette filaire isométrique
def maquette():
    S = 2
    im = Image.new('RGB', (W * S, H * S), (10, 12, 30))
    d = ImageDraw.Draw(im)
    cx, cy, u = W * S * 0.5, H * S * 0.62, 34 * S
    def iso(x, y, z):
        return (cx + (x - y) * u * 0.866, cy + (x + y) * u * 0.5 - z * u)
    for i in range(-14, 15):
        d.line((*iso(i, -14, 0), *iso(i, 14, 0)), fill=(32, 40, 90), width=2)
        d.line((*iso(-14, i, 0), *iso(14, i, 0)), fill=(32, 40, 90), width=2)
    r = np.random.default_rng(4)
    blocks = []
    for gx in range(-9, 10, 3):
        for gy in range(-9, 10, 3):
            if r.random() < 0.75:
                blocks.append((gx, gy, 2, 2, int(r.integers(2, 12))))
    blocks.sort(key=lambda b: b[0] + b[1])
    for (x, y, w, dpt, h) in blocks:
        top = [iso(x, y, h), iso(x + w, y, h), iso(x + w, y + dpt, h), iso(x, y + dpt, h)]
        col = (110, 140, 255) if (x + y) % 2 else (180, 120, 255)
        d.polygon([iso(x + w, y, 0), iso(x + w, y + dpt, 0), iso(x + w, y + dpt, h), iso(x + w, y, h)], fill=(18, 20, 52))
        d.polygon([iso(x, y + dpt, 0), iso(x + w, y + dpt, 0), iso(x + w, y + dpt, h), iso(x, y + dpt, h)], fill=(24, 26, 64))
        d.polygon(top, fill=(30, 32, 80))
        for a, b in [(iso(x + w, y, 0), iso(x + w, y, h)), (iso(x + w, y + dpt, 0), iso(x + w, y + dpt, h)), (iso(x, y + dpt, 0), iso(x, y + dpt, h))]:
            d.line((*a, *b), fill=col, width=3)
        d.line([*top, top[0]], fill=col, width=3)
        for z in range(1, h):
            d.line((*iso(x + w, y, z), *iso(x + w, y + dpt, z)), fill=tuple(int(c * 0.45) for c in col), width=2)
    im = im.resize((W, H), Image.LANCZOS)
    glow = im.filter(ImageFilter.GaussianBlur(10))
    arr = np.asarray(im, np.float32) + np.asarray(glow, np.float32) * 0.9
    save(arr, 'maquette-filaire')


# 10. Ville la nuit
def ville():
    img = grad([(0, (14, 12, 40)), (0.55, (70, 40, 110)), (0.75, (210, 110, 120)), (1, (240, 160, 120))], yn)
    img = stars(img, 600, 8, 0.4)
    r = np.random.default_rng(12)
    for layer, (base, col, win) in enumerate([(0.58, (40, 30, 70), 0.05), (0.66, (24, 18, 46), 0.12), (0.74, (12, 10, 26), 0.22)]):
        x = 0
        while x < W:
            bw = int(r.integers(50, 150))
            top = base - r.random() * (0.35 - layer * 0.06)
            ytop = int(top * H)
            img[ytop:, x:x + bw] = col
            for wy in range(ytop + 14, H - 10, 22):
                for wx in range(x + 8, x + bw - 10, 16):
                    if r.random() < win:
                        img[wy:wy + 8, wx:wx + 6] = (255, 210, 140) if r.random() < 0.8 else (150, 200, 255)
            x += bw + int(r.integers(0, 12))
    save(img, 'ville-nuit')


# 11. Béton et lumière
def beton():
    n = fbm(W, H, 4, 3, seed=21, persistence=0.5) * 0.4 + fbm(W, H, 4, 64, seed=22, persistence=0.6) * 0.6
    grain = np.random.default_rng(5).normal(0, 6, (H, W)).astype(np.float32)
    img = (112 + (n[..., None] - 0.5) * 38 + grain[..., None]) * np.array((1.0, 0.98, 0.95))
    pores = np.random.default_rng(3).random((H, W)) < 0.004
    img[pores] *= 0.55
    beam = np.exp(-((xn * 0.8 - yn * 0.6 - 0.05) / 0.09) ** 2) * 0.55 + np.exp(-((xn * 0.8 - yn * 0.6 - 0.32) / 0.05) ** 2) * 0.35
    img = img * (0.55 + 0.25 * yn[..., None]) + beam[..., None] * np.array((255, 210, 160)) * 0.6
    for x in range(0, W, 320):
        img[:, x:x + 3] *= 0.8
    for y in range(0, H, 240):
        img[y:y + 3, :] *= 0.8
    save(img, 'beton-lumiere')


# 12. Topographie (courbes de niveau)
def topo():
    n = fbm(W, H, 6, 2, seed=31)
    img = grad([(0, (12, 30, 40)), (1, (20, 60, 70))], n)
    lines = np.abs(((n * 28) % 1) - 0.5) < 0.045
    major = np.abs(((n * 7) % 1) - 0.5) < 0.012
    img[lines] = img[lines] * 0.4 + np.array((90, 220, 190)) * 0.6
    img[major] = (170, 255, 230)
    img *= (1.1 - 0.4 * np.hypot(xn - 0.5, yn - 0.5))[..., None]
    img = np.asarray(Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8)), np.float32)
    save(img, 'topographie')


for f in [aurore, dunes, montagnes, ocean, nebuleuse, bokeh, soie, plan, maquette, ville, beton, topo]:
    f()
    print('ok', f.__name__, flush=True)

