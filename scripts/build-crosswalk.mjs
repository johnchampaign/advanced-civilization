// Naming crosswalk bootstrap: map each of the game's 222 named areas (areas.json)
// to the new territory polygon that contains it, so the new geometry can carry the
// game's identities (name/terrain/adjacency). Areas live in per-panel space; the
// new territories live in one 3800x1405 image. We transform area centroids into
// territory space (same West·Main·East layout as anchors.ts) and test containment.
//
// Emits scripts/crosswalk.json (territory id -> matched area id, where confident)
// and prints a quality report: clean 1:1, merges (territory holding >1 area),
// orphan areas (no territory / cosmetic), empty territories, category mismatches.
import fs from 'fs';

const areas = JSON.parse(fs.readFileSync('src/data/areas.json', 'utf8'));
const terr = JSON.parse(fs.readFileSync('src/data/territories.json', 'utf8'));

// --- layout constants (mirror src/ui/anchors.ts) ---
const WEST_W = 782.177, MAIN_W = 2323.12, H = 1587.4;
const OFF = { western: 0, main: WEST_W, eastern: WEST_W + MAIN_W };
const COMB_W = WEST_W + MAIN_W + 1189.066;   // 4294.363
const SX = terr.image.width / COMB_W, SY = terr.image.height / H;

const centroid = (pts) => { let a = 0, cx = 0, cy = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const cr = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]; a += cr; cx += (pts[j][0] + pts[i][0]) * cr; cy += (pts[j][1] + pts[i][1]) * cr; } if (!a) { const m = pts.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]); return [m[0] / pts.length, m[1] / pts.length]; } a *= 0.5; return [cx / (6 * a), cy / (6 * a)]; };
const pip = (p, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1]; if (((yi > p[1]) !== (yj > p[1])) && (p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi)) c = !c; } return c; };
const inTerr = (p, t) => pip(p, t.exterior) && !(t.holes || []).some((h) => pip(p, h));

// area centroid -> territory-image space
const areaPt = (a) => { const [cx, cy] = centroid(a.path); return [(cx + OFF[a.board]) * SX, cy * SY]; };

const regions = terr.regions;
const byTerr = new Map(regions.map((r) => [r.id, []]));   // territory id -> [area ids]
const areaToTerr = new Map();
let orphan = [];
for (const a of areas) {
  const p = areaPt(a);
  const hit = regions.find((r) => inTerr(p, r));
  if (!hit) { orphan.push(a.id); continue; }
  areaToTerr.set(a.id, hit.id);
  byTerr.get(hit.id).push(a.id);
}

const areaById = Object.fromEntries(areas.map((a) => [a.id, a]));
const catWater = (c) => c === 'openSea';
const clean = [], merged = [], mism = [];
for (const r of regions) {
  const list = byTerr.get(r.id);
  if (r.category === 'cosmetic') continue;
  if (list.length === 1) {
    const a = areaById[list[0]];
    if (catWater(r.category) !== a.isWater) mism.push(`#${r.id}[${r.category}] -> ${a.id}(${a.isWater ? 'water' : 'land'})`);
    else clean.push({ terr: r.id, area: a.id, name: a.name });
  } else if (list.length > 1) merged.push({ terr: r.id, cat: r.category, areas: list });
}
const emptyT = regions.filter((r) => r.category && r.category !== 'cosmetic' && byTerr.get(r.id).length === 0).map((r) => `#${r.id}[${r.category}]`);
const cosmeticHits = regions.filter((r) => r.category === 'cosmetic').flatMap((r) => byTerr.get(r.id).map((a) => `${a}->cosmetic#${r.id}`));

const crosswalk = {};
for (const c of clean) crosswalk[c.terr] = { areaId: c.area, name: c.name };
fs.writeFileSync('scripts/crosswalk.json', JSON.stringify(crosswalk, null, 0));

console.log(`areas: ${areas.length} (land ${areas.filter((a) => !a.isWater).length}, water ${areas.filter((a) => a.isWater).length})`);
console.log(`territories: ${regions.length} (cosmetic ${regions.filter((r) => r.category === 'cosmetic').length})`);
console.log(`\nCLEAN 1:1 matches: ${clean.length}`);
console.log(`MERGED (one territory holds >1 area — need splitting): ${merged.length}`);
for (const m of merged.slice(0, 40)) console.log(`  #${m.terr}[${m.cat}] <- ${m.areas.join(', ')}`);
console.log(`\nORPHAN areas (centroid in no territory / distorted): ${orphan.length}`);
console.log('  ' + orphan.slice(0, 40).join(', '));
console.log(`\nAreas landing in a COSMETIC territory: ${cosmeticHits.length}  ${cosmeticHits.join(', ')}`);
console.log(`EMPTY non-cosmetic territories (0 areas): ${emptyT.length}  ${emptyT.slice(0, 40).join(', ')}`);
console.log(`CATEGORY mismatches (water/land): ${mism.length}`);
for (const m of mism.slice(0, 30)) console.log('  ' + m);
console.log(`\nwrote scripts/crosswalk.json (${Object.keys(crosswalk).length} confident matches)`);
