"""Extract map areas (zones) from the VASSAL buildFile into clean JSON.

Each game-map Zone becomes an area record:
  { id, name, board, sustains, isWater, isCitySite, path:[[x,y],...], flags:{...} }

`sustains` = population the area supports (0 for water / non-supporting).
`isCitySite` heuristic: sustains >= 2 (a city can be built where >=2 pop is
supported). We refine city sites against the rules later if needed.
"""
import json, re, xml.etree.ElementTree as ET

SRC = "assets/vmod_extract/buildFile"
OUT = "src/data/areas.json"
GAME_BOARDS = {
    "map-western.svg": "western",
    "map-main.svg": "main",
    "map-eastern.svg": "eastern",
}

t = ET.parse(SRC); root = t.getroot()
parents = {c: p for p in root.iter() for c in p}
def tag(e): return e.tag.split('.')[-1]

def board_of(zone):
    e = zone
    while e is not None:
        e = parents.get(e)
        if e is not None and tag(e) == 'Board':
            return e.get('image') or e.get('name')
    return None

def parse_path(s):
    pts = []
    if not s: return pts
    for pair in s.split(';'):
        pair = pair.strip()
        if not pair: continue
        x, y = pair.split(',')
        pts.append([int(x), int(y)])
    return pts

def slug(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')

areas = []
seen = set()
for z in root.iter():
    if tag(z) != 'Zone': continue
    img = board_of(z)
    if img not in GAME_BOARDS: continue
    name = z.get('name') or ''
    if not name: continue
    props = {}
    for p in z:
        if tag(p) == 'ZoneProperty':
            props[p.get('name')] = p.get('initialValue')
    sustains = props.get('Sustains')
    sustains = int(sustains) if (sustains is not None and sustains.lstrip('-').isdigit()) else 0
    is_water = sustains == 0
    path = parse_path(z.get('path'))
    sid = slug(name)
    base = sid; n = 2
    while sid in seen:
        sid = f"{base}-{n}"; n += 1
    seen.add(sid)
    flags = {k: v for k, v in props.items() if k != 'Sustains'}
    # The VASSAL module flags EVERY sea zone as OpenSea, but per rules §23.52
    # only genuine open (oceanic) seas require Astronomy to cross — enclosed and
    # coastal seas are sailed freely (otherwise island/coastal nations like Crete
    # could never leave without Astronomy). Restrict the Astronomy gate to the
    # truly-open waters; treat the enclosed seas below as navigable.
    ENCLOSED_SEAS = {
        'Aegean Sea', 'Adriatic Sea', 'Black Sea', 'Red Sea', 'Caspian Sea',
        'Gulf of Persia', 'Gulf of Oman',
    }
    if name in ENCLOSED_SEAS:
        flags.pop('OpenSea', None)
    # Authoritative designations from VASSAL ZoneProperties (rules-accurate):
    #   CitySite  -> a printed city site (6 tokens build a city here; 12 elsewhere, §25.2)
    #   Floodplain-> Flood calamity applies (§30.51)
    #   OpenSea   -> open sea, crossable only with Astronomy (§32.411)
    #   VolcanoSite-> can be struck by Volcanic Eruption/Earthquake (§30.21)
    #   StartRegion-> a legal opening area (value = which nation)
    areas.append({
        "id": sid,
        "name": name,
        "board": GAME_BOARDS[img],
        "sustains": sustains,
        "isWater": is_water,
        "isCitySite": 'CitySite' in flags,
        "isFloodplain": 'Floodplain' in flags,
        "isOpenSea": 'OpenSea' in flags,
        "isVolcanoSite": 'VolcanoSite' in flags,
        "startRegion": flags.get('StartRegion'),
        "path": path,
        "flags": flags,
    })

areas.sort(key=lambda a: (a["board"], a["name"]))
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(areas, f, indent=1)

land = [a for a in areas if not a["isWater"]]
water = [a for a in areas if a["isWater"]]
sites = [a for a in areas if a["isCitySite"]]
print(f"wrote {len(areas)} areas -> {OUT}")
print(f"  land={len(land)} water={len(water)} citySites={len(sites)}")
print(f"  floodplains={sum(1 for a in areas if a['isFloodplain'])} openSeas={sum(1 for a in areas if a['isOpenSea'])} volcanoSites={sum(1 for a in areas if a['isVolcanoSite'])} startRegions={sum(1 for a in areas if a['startRegion'])}")
print("  sustains histogram:", {s: sum(1 for a in areas if a['sustains']==s) for s in sorted({a['sustains'] for a in areas})})
print("  sample land:", [(a['name'], a['sustains']) for a in land[:8]])
