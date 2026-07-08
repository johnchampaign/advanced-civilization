#!/usr/bin/env python3
"""Derive rules-16 play-area data from the VASSAL module's own overlays.

Regenerates src/data/playAreas.json. Everything is mechanical — no judgment
calls (see rules 16.6-16.11):

- The module's Greyout overlay SVGs (overlay-panel*.svg) each contain one
  visible cover polygon defining a board configuration's out-of-play region,
  in main-board coordinates (the same space as areas.json paths).
- A LAND area is out of play iff its printed population number sits inside the
  cover region (16.11's own criterion for areas straddling a panel boundary).
  The printed positions are the `#_x3N_pop` <use> symbols in map-main.svg's
  symbols-numbers layer — exactly one per main-board land area.
- A SEA area is out only if its whole polygon is inside the cover region
  (16.6-16.8: "open sea areas containing the dividing line may be used").
- 16.11 also voids a city site whose SITE SYMBOL is printed on an out-of-play
  panel even when the area itself stays in play: `#city` / `#city-floodplain`
  <use> symbols give the printed site positions.
- 16.8 (two players): city sites on islands are disregarded. The module's
  overlay-islandcities.svg `coverislandcities-2player` layer covers exactly
  those printed site symbols with small rects.

Extension boards (western/eastern) are whole-board toggles handled by the
engine, not listed here.
"""

import json
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VMOD = ROOT / 'assets' / 'civ.vmod'
AREAS = ROOT / 'src' / 'data' / 'areas.json'
OUT = ROOT / 'src' / 'data' / 'playAreas.json'

# Greyout overlay file -> (visible cover group, config key)
CONFIGS = {
    'overlay-panel1.svg': ('coverwestern', 'panel1'),
    'overlay-panel12.svg': ('coverwestern3player', 'panel12'),
    'overlay-panel4.svg': ('covereasternpanel', 'panel4'),
    'overlay-panel34.svg': ('cover2eastern', 'panel34'),
    'overlay-paneleastern-dotted.svg': ('covereastern-3player', 'eastOfDotted'),
    'overlay-panelwestern-dotted.svg': ('westernhalf-overlay', 'westOfDotted'),
}


def point_in_polygon(pt, poly):
    x, y = pt
    inside = False
    for i in range(len(poly)):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % len(poly)]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def group_body(svg, gid):
    """Extract a <g id=gid> group's inner markup (handles nested <g>)."""
    start = svg.index(f'<g id="{gid}"')
    depth = 0
    for m in re.finditer(r'<g\b|</g>', svg[start:]):
        depth += 1 if m.group(0) == '<g' else -1
        if depth == 0:
            return svg[start:start + m.end()]
    raise ValueError(f'unterminated group {gid}')


def polygon_points(el):
    nums = [float(v) for v in re.split(r'[ ,\t\n]+', re.search(r'points="([^"]+)"', el).group(1).strip()) if v]
    return list(zip(nums[0::2], nums[1::2]))


def use_positions(body, hrefs):
    """Positions of <use xlink:href="#<href>"> symbols (matrix tx/ty)."""
    out = []
    for m in re.finditer(r'<use\b[^>]*>', body):
        el = m.group(0)
        href = re.search(r'xlink:href="#([^"]+)"', el)
        if not href or href.group(1) not in hrefs:
            continue
        tf = re.search(r'matrix\(([^)]+)\)', el)
        nums = [float(v) for v in re.split(r'[ ,]+', tf.group(1).strip())]
        out.append((nums[4], nums[5]))
    return out


def main():
    z = zipfile.ZipFile(VMOD)
    areas = json.loads(AREAS.read_text())
    main_areas = [a for a in areas if a['board'] == 'main' and a.get('path')]
    land = [a for a in main_areas if not a['isWater']]
    sea = [a for a in main_areas if a['isWater']]

    def area_at(pt, pool):
        hits = [a['id'] for a in pool if point_in_polygon(pt, a['path'])]
        if len(hits) != 1:
            raise ValueError(f'symbol at {pt} matches {hits}')
        return hits[0]

    # Printed markings on the main map.
    sym = group_body(z.read('images/map-main.svg').decode(), 'symbols-numbers')
    pop_by_area = {}
    for pt in use_positions(sym, {'_x31_pop', '_x32_pop', '_x33_pop', '_x34_pop', '_x35_pop'}):
        aid = area_at(pt, land)
        assert aid not in pop_by_area, f'two pop numbers in {aid}'
        pop_by_area[aid] = pt
    missing = {a['id'] for a in land} - set(pop_by_area)
    assert not missing, f'land areas without a printed population number: {missing}'

    site_by_area = {}
    for pt in use_positions(sym, {'city', 'city-floodplain'}):
        site_by_area[area_at(pt, land)] = pt
    flagged = {a['id'] for a in land if a['isCitySite']}
    # Parthia straddles the main|eastern seam (merged in areas.json); its site
    # symbol is printed on the eastern-extension sheet, not the main map. Every
    # crop key here cuts from the west or the dotted line, so its site can never
    # be suppressed by 16.11 — safe to leave unclassified.
    assert set(site_by_area) <= flagged, f'site symbols outside CitySite zones: {set(site_by_area) - flagged}'
    assert flagged - set(site_by_area) <= {'parthia'}, (
        f'CitySite zones without a printed symbol: {flagged - set(site_by_area)}')

    out_of_play = {}
    suppressed = {}
    covers = {}
    for fn, (gid, key) in CONFIGS.items():
        svg = z.read('images/' + fn).decode()
        cover = polygon_points(re.search(r'<polygon\b[^>]*>', group_body(svg, gid)).group(0))
        out = {aid for aid, pt in pop_by_area.items() if point_in_polygon(pt, cover)}
        out |= {a['id'] for a in sea if all(point_in_polygon(p, cover) for p in a['path'])}
        out_of_play[key] = sorted(out)
        suppressed[key] = sorted(
            aid for aid, pt in site_by_area.items()
            if aid not in out and point_in_polygon(pt, cover))
        covers[key] = [[round(x, 1), round(y, 1)] for x, y in cover]

    # 16.8: island city sites (2-player games) — the module covers their symbols.
    isl = group_body(z.read('images/overlay-islandcities.svg').decode(), 'coverislandcities-2player')
    islands = set()
    for m in re.finditer(r'<rect width="([\d.]+)" x="([\d.-]+)"[^>]*height="([\d.]+)" y="([\d.-]+)"', isl):
        w, x, h, y = map(float, m.groups())
        islands.add(area_at((x + w / 2, y + h / 2), land))
    assert islands <= flagged, f'island rects over non-site areas: {islands - flagged}'

    result = {
        '_doc': ('Rules-16 play-area data, derived from the VASSAL module by '
                 'scripts/derive_play_areas.py (see its docstring for the method). '
                 'outOfPlay: per board-configuration key, the main-board area ids '
                 'not in play (panel1|panel12|panel4|panel34 = those panels out; '
                 'eastOfDotted/westOfDotted = everything that side of the dotted '
                 'divider out). suppressedCitySites (16.11): areas that stay in '
                 'play but lose their printed city site to an out-of-play panel. '
                 'islandCitySites (16.8): city sites disregarded in 2-player games. '
                 'coverPolygons: each crop\'s greyout cover outline (main-board '
                 'coordinates), for drawing the out-of-play veil in the UI. '
                 'Extension boards are whole-board toggles, not listed here.'),
        'outOfPlay': out_of_play,
        'suppressedCitySites': suppressed,
        'islandCitySites': sorted(islands),
        'coverPolygons': covers,
    }
    OUT.write_text(json.dumps(result, indent=1) + '\n')
    for key in out_of_play:
        print(f'{key}: {len(out_of_play[key])} out, sites suppressed: {suppressed[key]}')
    print('islandCitySites:', sorted(islands))


if __name__ == '__main__':
    main()
