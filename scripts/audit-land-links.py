#!/usr/bin/env python3
"""Audit every land link in adjacency.json against the real board art.

Finds the three kinds of bad link that hand-traced map data produces:

- WATER: two land areas linked overland whose shared border runs only through
  water (an island, a strait, a lake). It should be a ship crossing instead
  (23.3/23.52). Examples fixed this way: Lemnos, Ithaka, Britain, Gibraltar.
- CORNER: two areas that meet only at a point where four borders cross, or don't
  touch at all. No boundary line divides them, so they are not neighbours
  (4.31) -- the Gulashkird|Pasagardes precedent.
- BOGUS HOP: a land-to-land ship crossing (ship-edges.json) with no water along
  its border -- a thin traced sliver -- or one that passes through a single
  point out at sea. Barbarians use these hops too (30.5233).

How each land link is measured (calibrated 2026-09-28 on known cases: Lemnos,
Kerch, Crete, Messina, Euboea are water; Troy|Sardes, Crimea's isthmus and the
Mesopotamian rivers are land):

1. Walk the shared stretch of the two owner-traced polygons (territories.json)
   and read the art a short step off to BOTH sides -- past the white border line
   and the thick coloured start-area borders, which would otherwise read as
   land. A stretch counts as land only where both sides are land. Every known
   water border scores <= 11.5 px of land; every real land border >= 16.
2. Rivers are drawn blue too, so the owner-traced coast (coastlines.json sea
   pieces, split off by the black coastline) is the second opinion: a border the
   art calls water but the coast calls mostly land is reported as RIVER? -- most
   are rivers, but the coast pieces don't always reach the border (Mana|Tilmun
   is really sea), so these are listed, never silently dropped. Dark teal is
   delta/floodplain and counts as land.
3. A traced border can stop at the coast while the real white line carries on
   overland (Corinth|Delphi across the Isthmus), so each flagged border's ENDS
   are checked for land of both areas. A borderline flag with land at an end is
   dropped as a real land border; a clear WATER flag is only annotated (land
   near a narrow strait can fool this check -- Lemnos|Troy).
4. Links whose traced borders share < 20 px are corner candidates.

Nothing here is decisive on its own: every flag needs a look by eye, and the
contact sheets are for exactly that. Links already reviewed and deliberately
kept are in REVIEWED with the reason, so a rerun only reports what is new; add
to it when you confirm a flag is fine. To apply a fix, edit adjacency.json /
ship-edges.json and mirror it in build-adjacency.mjs REMOVE_EDGES or
build-ship-edges.mjs DROP_SHIP_EDGES.

Needs inkscape, numpy and Pillow, plus the bring-your-own VASSAL art in
assets/vmod_extract/ (gitignored). Rendered panels are cached.

Run:     python3 scripts/audit-land-links.py [--all] [--no-sheets]
Output:  _land-link-audit/report.txt, report.json, sheet-*.png
"""

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / '_land-link-audit'
DATA = ROOT / 'src' / 'data'

# Board panels: SVG width in board units; the combined canvas lays them side by
# side. territories.json / coastlines.json / areas.json use that combined space.
PANEL_W = {'western': 782.177, 'main': 2323.12, 'eastern': 1189.066}
PANEL_OFF = {'western': 0.0, 'main': 782.177, 'eastern': 782.177 + 2323.12}
BOARD_H = 1587.4
PX = 2  # art pixels per board unit when rendering the panels

# Thresholds (see the calibration note above).
WATER_MAX_LAND = 12.0        # px of land along the border: below this reads as water
REVIEW_MAX_LAND = 24.0       # 12-24 px of land, on under 60% of the border: borderline
REVIEW_SHORT_RATIO = 0.6     #   (a short border that is mostly land is just short)
REVIEW_MAX_RATIO = 0.35      # or land on < 35% of any border (coast-hugging lines)
RIVER_MIN_COAST_LAND = 0.5   # traced coast calls >= 50% land: a river, not the sea
CORNER_MAX_SHARED = 20.0     # traced borders sharing < 20 px: corner candidate
TOUCH_TOL = 4.0              # combined px: how close two outlines must run to "share"
SIDE_OFFSET = 7.0            # combined px off the border to read the art (both sides)

# Flags reviewed by eye and deliberately kept (pair -> why). Keys are sorted pairs.
REVIEWED = {
    # Real land borders the heuristics flag (short, coast-hugging, or along rivers).
    ('athens', 'corinth'): 'short real border across the Isthmus (two junctions joined by a stub)',
    ('argos', 'athens'): 'real land stretch at the Isthmus before the Saronic Gulf',
    ('corinth', 'delphi'): 'water along the Gulf, but the line continues overland across the Isthmus',
    ('aracosta', 'basri'): 'short real border between two junctions',
    ('aria', 'herat'): 'river border (land)',
    ('herat', 'prophtasia'): 'river border (land)',
    ('herat', 'pura'): 'river border (land)',
    ('herat', 'seistan-inferior'): 'river border (land)',
    ('herat', 'seistan-superior'): 'river/lake border with a land stretch',
    ('artacona', 'herat'): 'river border (land)',
    ('chaldaea', 'sumeria'): 'three-line junction; they share a full border',
    ('illyricum', 'pannonia-2'): 'real border; a traced Germania sliver hides it',
    ('kurangan', 'lyan'): 'real border',
    ('lycia', 'miletus'): 'land border (traced outlines diverge mid-way)',
    ('arabia', 'fav'): 'Fav is nested inside Arabia',
    ('sabrata', 'thapsus'): 'land stretch at the west end',
    ('phrygia', 'sinope'): 'land stretch at the south end',
    ('onitas', 'shahi-tumo'): 'land border (traced outlines diverge)',
    ('antiochia', 'cilicia'): 'not clearly all-water',
    ('banda-abbas', 'harmoza'): 'land stretch above the coast',
    ('moesia', 'thyras'): 'crosses the Danube delta floodplain (land)',
    ('danube', 'thyras'): 'Danube delta floodplain (land)',
    ('alexandria', 'tanis'): 'Nile delta floodplain (land)',
    ('crimea', 'scythia'): 'the Perekop isthmus is land',
    ('cyprus', 'salamis'): 'internal border of Cyprus (land)',
    ('chalkis', 'eretria'): 'internal border of Euboea (land)',
    # Owner ruling 2026-09-28: the Mesopotamian delta channels are rivers.
    ('chaldaea', 'susa'): 'owner ruling: delta channels are rivers',
    ('susa', 'ur'): 'owner ruling: delta channels are rivers',
    ('chaldaea', 'ur'): 'owner ruling: delta channels are rivers',
}


# ---------------------------------------------------------------- geometry

def load():
    areas = {a['id']: a for a in json.loads((DATA / 'areas.json').read_text())}
    adjacency = json.loads((DATA / 'adjacency.json').read_text())
    terr = json.loads((DATA / 'territories.json').read_text())
    polys = {r['name']: np.array(r['exterior'], float) for r in terr['regions'] if r.get('name')}
    coast = json.loads((DATA / 'coastlines.json').read_text())
    edges = json.loads((DATA / 'ship-edges.json').read_text())['edges']
    total_w = sum(PANEL_W.values())
    sx, sy = terr['image']['width'] / total_w, terr['image']['height'] / BOARD_H
    return areas, adjacency, polys, coast, edges, sx, sy


def boundary_samples(poly, step=0.5):
    """Points along a polygon outline, each with its segment's unit normal."""
    pts, nrm = [], []
    for i in range(len(poly)):
        p, q = poly[i], poly[(i + 1) % len(poly)]
        d = math.dist(p, q)
        if d == 0:
            continue
        t = (q - p) / d
        n = max(1, int(d / step))
        for k in range(n):
            pts.append(p + (q - p) * k / n)
            nrm.append((-t[1], t[0]))
    return np.array(pts), np.array(nrm)


def near(pts, poly, tol=TOUCH_TOL):
    """Mask of the points lying within `tol` of the polygon's outline."""
    best = np.full(len(pts), np.inf)
    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        ab = b - a
        L = ab @ ab
        t = np.clip(((pts - a) @ ab) / L, 0, 1) if L else np.zeros(len(pts))
        best = np.minimum(best, np.linalg.norm(pts - (a + np.outer(t, ab)), axis=1))
    return best <= tol


def pip(x, y, poly):
    inside = False
    for j in range(len(poly)):
        x1, y1 = poly[j]
        x2, y2 = poly[j - 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


# ---------------------------------------------------------------- the art

def render_panels(cache):
    cache.mkdir(parents=True, exist_ok=True)
    for name, w in PANEL_W.items():
        png = cache / f'panel-{name}.png'
        svg = ROOT / 'assets' / 'vmod_extract' / f'map-{name}.svg'
        if png.exists():
            continue
        if not svg.exists():
            sys.exit(f'missing {svg} -- extract the VASSAL module art first (see README)')
        print(f'rendering {name} panel...', flush=True)
        subprocess.run(['inkscape', str(svg), '--export-type=png', f'--export-width={round(w * PX)}',
                        '--export-background=white', '--export-background-opacity=1',
                        f'--export-filename={png}'], check=True, capture_output=True)


class Art:
    """The rendered panels, classified per pixel: 1 = water, 2 = land, 0 = line/other."""

    def __init__(self, cache, sx, sy):
        self.sx, self.sy = sx, sy
        self.rgb, self.cls = {}, {}
        for name in PANEL_W:
            im = np.asarray(Image.open(cache / f'panel-{name}.png').convert('RGB')).astype(int)
            r, g, b = im[..., 0], im[..., 1], im[..., 2]
            white = (r > 200) & (g > 200) & (b > 200)
            dark = np.maximum(np.maximum(r, g), b) < 70
            blue = (b >= g) & (b > 110) & (b >= r - 10) & ~white
            teal = (r < 40) & (g >= 45) & (g <= 80) & (b >= 40) & (b <= 75)  # delta / floodplain
            land = (~blue & ~white & ~dark & ((g > 95) | ((r > 170) & (g > 130)))) | teal
            c = np.zeros(r.shape, np.uint8)
            c[blue] = 1
            c[land] = 2
            self.rgb[name], self.cls[name] = im, c

    def panel_of(self, x):
        u = x / self.sx
        for name in ('western', 'main', 'eastern'):
            if PANEL_OFF[name] <= u < PANEL_OFF[name] + PANEL_W[name]:
                return name
        return 'eastern'

    def to_px(self, x, y, panel=None):
        panel = panel or self.panel_of(x)
        return panel, (x / self.sx - PANEL_OFF[panel]) * PX, y / self.sy * PX

    def land_fraction(self, x, y, rad=4):
        panel, px, py = self.to_px(x, y)
        c = self.cls[panel]
        px, py = int(round(px)), int(round(py))
        win = c[max(0, py - rad):py + rad + 1, max(0, px - rad):px + rad + 1]
        n_w, n_l = int((win == 1).sum()), int((win == 2).sum())
        return n_l / (n_w + n_l) if n_w + n_l else None


def shared_border(polys, a, b, step=0.5):
    pts, nrm = boundary_samples(polys[a], step)
    keep = near(pts, polys[b])
    return pts[keep], nrm[keep]


def art_land_along(art, polys, a, b, step=0.5):
    """(shared length, length with land on BOTH sides), taken over both outlines."""
    best = (0.0, 0.0)
    for p, q in ((a, b), (b, a)):
        pts, nrm = shared_border(polys, p, q, step)
        land = 0
        for (x, y), (nx, ny) in zip(pts, nrm):
            f1 = art.land_fraction(x + nx * SIDE_OFFSET, y + ny * SIDE_OFFSET)
            f2 = art.land_fraction(x - nx * SIDE_OFFSET, y - ny * SIDE_OFFSET)
            if f1 is not None and f2 is not None and f1 >= 0.5 and f2 >= 0.5:
                land += 1
        best = (max(best[0], len(pts) * step), max(best[1], land * step))
    return best


class SeaMask:
    """The owner-traced sea pieces (coastlines.json), rasterised: rivers are not sea."""

    def __init__(self, coast, scale=2):
        w, h = coast['image']['width'], coast['image']['height']
        img = Image.new('L', (w * scale, h * scale), 0)
        d = ImageDraw.Draw(img)
        for t in coast['territories']:
            for s in t['sub']:
                if s['kind'] == 'sea' and len(s['exterior']) >= 3:
                    d.polygon([(x * scale, y * scale) for x, y in s['exterior']], fill=1)
        self.mask, self.scale = np.asarray(img), scale

    def is_sea(self, x, y):
        px, py = int(x * self.scale), int(y * self.scale)
        if not (0 <= py < self.mask.shape[0] and 0 <= px < self.mask.shape[1]):
            return True
        return self.mask[py, px] == 1

    def land_ratio(self, polys, a, b, step=0.5, off=2.5):
        best = 0.0
        for p, q in ((a, b), (b, a)):
            pts, nrm = shared_border(polys, p, q, step)
            if not len(pts):
                continue
            land = sum(1 for (x, y), (nx, ny) in zip(pts, nrm)
                       if not self.is_sea(x + nx * off, y + ny * off) and not self.is_sea(x - nx * off, y - ny * off))
            best = max(best, land / len(pts))
        return best


def land_at_ends(art, polys, a, b, rad=14):
    """Does land of BOTH areas sit right at either end of their traced border?"""
    pts, _ = shared_border(polys, a, b)
    if len(pts) < 2:
        return False
    c = pts.mean(axis=0)
    v = np.linalg.svd(pts - c)[2][0]
    proj = (pts - c) @ v
    for ex, ey in (pts[proj.argmin()], pts[proj.argmax()]):
        panel, cx, cy = art.to_px(ex, ey)
        own = {a: 0, b: 0}
        for dy in range(-rad, rad + 1, 2):
            for dx in range(-rad, rad + 1, 2):
                px, py = int(cx) + dx, int(cy) + dy
                cls = art.cls[panel]
                if not (0 <= py < cls.shape[0] and 0 <= px < cls.shape[1]) or cls[py, px] != 2:
                    continue
                X = (px / PX + PANEL_OFF[panel]) * art.sx
                Y = py / PX * art.sy
                for n in (a, b):
                    if pip(X, Y, polys[n]):
                        own[n] += 1
        if own[a] and own[b]:
            return True
    return False


# ---------------------------------------------------------------- sheets

def owner_at(polys, x, y):
    hits = [n for n, p in polys.items() if pip(x, y, p)]
    if not hits:
        return None
    area = lambda n: abs(np.sum(polys[n][:, 0] * np.roll(polys[n][:, 1], 1) - np.roll(polys[n][:, 0], 1) * polys[n][:, 1]))
    return min(hits, key=area)  # innermost, for nested areas


def tile(art, polys, a, b, label, corner, size=400):
    """A zoom on the pair's border (red dots) or, for corners, their junction with
    owner initials around it (red = first area, yellow = second)."""
    pts, _ = shared_border(polys, a, b)
    if corner or not len(pts):
        pa, _ = boundary_samples(polys[a], 1.0)
        pb, _ = boundary_samples(polys[b], 1.0)
        dists = [np.hypot(*(pb - p).T).min() for p in pa]
        i = int(np.argmin(dists))
        j = int(np.hypot(*(pb - pa[i]).T).argmin())
        cx, cy = (pa[i] + pb[j]) / 2
        half = 34
    else:
        cx, cy = pts.mean(axis=0)
        span = (pts.max(axis=0) - pts.min(axis=0)) / art.sx * PX
        half = max(60, span.max() / 2 + 40)
    panel, X, Y = art.to_px(cx, cy)
    box = (int(X - half), int(Y - half), int(X + half), int(Y + half))
    im = Image.fromarray(art.rgb[panel].astype('uint8')).crop(box).resize((size, size), Image.LANCZOS)
    d = ImageDraw.Draw(im)
    k = size / (box[2] - box[0])
    if corner:
        for t in range(0, 360, 30):
            x, y = cx + 12 * math.cos(math.radians(t)), cy + 12 * math.sin(math.radians(t))
            o = owner_at(polys, x, y)
            if o:
                _, px, py = art.to_px(x, y, panel)
                px, py = (px - box[0]) * k, (py - box[1]) * k
                col = (255, 60, 60) if o == a else (255, 230, 0) if o == b else (255, 255, 255)
                d.rectangle([px - 13, py - 8, px + 13, py + 8], fill=(0, 0, 0))
                d.text((px - 10, py - 6), ''.join(w[0] for w in o.replace('-2', '').split('-')).upper()[:3], fill=col)
    else:
        for x, y in pts[::4]:
            _, px, py = art.to_px(x, y, panel)
            px, py = (px - box[0]) * k, (py - box[1]) * k
            d.ellipse([px - 2, py - 2, px + 2, py + 2], fill=(255, 0, 0))
    d.rectangle([0, 0, size, 20], fill=(0, 0, 0))
    d.text((5, 4), f'{label}: {a} | {b}', fill=(255, 255, 255))
    return im


def write_sheets(art, polys, flagged, cols=3, per_sheet=9):
    for f in OUT.glob('sheet-*.png'):
        f.unlink()
    for s in range(0, len(flagged), per_sheet):
        chunk = flagged[s:s + per_sheet]
        rows = (len(chunk) + cols - 1) // cols
        sheet = Image.new('RGB', (cols * 404, rows * 404), (30, 30, 30))
        for i, f in enumerate(chunk):
            sheet.paste(tile(art, polys, f['a'], f['b'], f['kind'], f['kind'] in ('CORNER', 'SEA CORNER')),
                        ((i % cols) * 404, (i // cols) * 404))
        sheet.save(OUT / f'sheet-{s // per_sheet + 1}.png')


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--all', action='store_true', help='also list and sheet the REVIEWED pairs')
    ap.add_argument('--no-sheets', action='store_true', help='skip the contact sheets')
    args = ap.parse_args()

    areas, adjacency, polys, coast, edges, sx, sy = load()
    render_panels(OUT / 'panels')
    art = Art(OUT / 'panels', sx, sy)
    sea = SeaMask(coast)
    is_land = lambda x: x in areas and not areas[x]['isWater']

    pairs = sorted({tuple(sorted((a, b))) for a, ns in adjacency.items() if is_land(a) for b in ns if is_land(b)})
    missing = [p for p in pairs if p[0] not in polys or p[1] not in polys]
    flags = []
    print(f'measuring {len(pairs)} land links...', flush=True)
    for n, (a, b) in enumerate(pairs, 1):
        if n % 50 == 0:
            print(f'  {n}/{len(pairs)}', flush=True)
        if a not in polys or b not in polys:
            continue
        shared, land = art_land_along(art, polys, a, b)
        if shared < CORNER_MAX_SHARED:
            flags.append({'kind': 'CORNER', 'a': a, 'b': b, 'shared': shared, 'land': land})
            continue
        ratio = land / shared
        if land >= WATER_MAX_LAND and ratio >= REVIEW_MAX_RATIO and not (land < REVIEW_MAX_LAND and ratio < REVIEW_SHORT_RATIO):
            continue
        coast_land = sea.land_ratio(polys, a, b)
        ends = land_at_ends(art, polys, a, b)
        if land < WATER_MAX_LAND:
            # The art says water. If the traced coast calls it mostly land it is
            # usually a river -- but the coast pieces don't always reach the border
            # (Mana|Tilmun is really sea), so report it rather than drop it.
            kind = 'RIVER?' if coast_land >= RIVER_MIN_COAST_LAND else 'WATER'
        else:
            kind = 'POSSIBLE'
        if kind == 'POSSIBLE' and ends:
            continue  # borderline, and both areas' land meets at an end: a real land border
        flags.append({'kind': kind, 'a': a, 'b': b, 'shared': shared, 'land': land,
                      'coast_land': round(coast_land, 2), 'land_at_ends': ends})

    print('checking land-to-land ship crossings...', flush=True)
    hops = sorted({tuple(sorted((e['a'], e['b']))) for e in edges if is_land(e['a']) and is_land(e['b'])})
    for a, b in hops:
        if a not in polys or b not in polys:
            continue
        shared, land = art_land_along(art, polys, a, b)
        overland = b in adjacency.get(a, [])
        if shared < 10:
            flags.append({'kind': 'SEA CORNER', 'a': a, 'b': b, 'shared': shared, 'land': land})
        elif not overland and land / shared > 0.5:
            flags.append({'kind': 'BOGUS HOP', 'a': a, 'b': b, 'shared': shared, 'land': land})

    for f in flags:
        f['reviewed'] = REVIEWED.get((f['a'], f['b']))
    new = [f for f in flags if not f['reviewed']]
    shown = flags if args.all else new

    OUT.mkdir(exist_ok=True)
    lines = [f'Land-link audit: {len(pairs)} land links, {len(hops)} land-to-land ship crossings checked.',
             f'{len(new)} new flag(s); {len(flags) - len(new)} already reviewed (see REVIEWED; --all lists them).', '']
    if missing:
        lines += [f'Links with no traced polygon (not checked): {missing}', '']
    order = {'WATER': 0, 'BOGUS HOP': 1, 'SEA CORNER': 2, 'CORNER': 3, 'POSSIBLE': 4, 'RIVER?': 5}
    for f in sorted(shown, key=lambda f: (order[f['kind']], f['a'], f['b'])):
        extra = ''
        if 'coast_land' in f:
            extra = f"  coast-land {f['coast_land']:.0%}" + ('  LAND AT AN END - check it continues overland' if f['land_at_ends'] else '')
        note = f"  [reviewed: {f['reviewed']}]" if f['reviewed'] else ''
        lines.append(f"{f['kind']:10} {f['a']:18} {f['b']:18} shared {f['shared']:6.1f}  land-along {f['land']:6.1f}{extra}{note}")
    if not shown:
        lines.append('Nothing to review.')
    lines += ['', 'WATER = land link whose border is all water (make it ship-only); CORNER = meets at a point',
              '(drop the link); BOGUS HOP / SEA CORNER = ship crossing that is not one (drop the edge);',
              'POSSIBLE = borderline, look before acting; RIVER? = the art shows water but the traced coast',
              'calls it land -- usually a river (a land border), occasionally real sea. Every flag needs a',
              'look by eye (sheet-*.png).']
    (OUT / 'report.txt').write_text('\n'.join(lines) + '\n')
    (OUT / 'report.json').write_text(json.dumps(flags, indent=1))
    if not args.no_sheets:
        write_sheets(art, polys, shown)
    print('\n'.join(lines))
    print(f'\nwrote {OUT.relative_to(ROOT)}/report.txt, report.json' + ('' if args.no_sheets else ', sheet-*.png'))


if __name__ == '__main__':
    main()
