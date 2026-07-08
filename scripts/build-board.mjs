// build:board — regenerate the game's area GEOMETRY from the owner-authored
// territory polygons (territories.json), keyed by the naming crosswalk (each game
// area's centroid falls inside exactly one territory). Replaces each area's `path`
// (and adds `holes`) with the new polygon, in the single combined 3800x1405 image
// space. Everything else — name/board/sustains/flags/isWater/isOpenSea/startRegion
// — is preserved, and adjacency.json is NOT touched (it's a tested logical graph).
//
// After this, src/ui/anchors.ts must treat area.path as combined-space (no per-board
// offset) with viewBox = territories image. Run: node scripts/build-board.mjs
import fs from 'fs';

const areas = JSON.parse(fs.readFileSync('src/data/areas.json', 'utf8'));
const terr = JSON.parse(fs.readFileSync('src/data/territories.json', 'utf8'));

const WEST_W = 782.177, MAIN_W = 2323.12, H = 1587.4;
const OFF = { western: 0, main: WEST_W, eastern: WEST_W + MAIN_W };
const COMB_W = WEST_W + MAIN_W + 1189.066;
const SX = terr.image.width / COMB_W, SY = terr.image.height / H;

const centroid = (pts) => { let a = 0, cx = 0, cy = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const cr = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]; a += cr; cx += (pts[j][0] + pts[i][0]) * cr; cy += (pts[j][1] + pts[i][1]) * cr; } if (!a) { const m = pts.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]); return [m[0] / pts.length, m[1] / pts.length]; } a *= 0.5; return [cx / (6 * a), cy / (6 * a)]; };
const pip = (p, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1]; if (((yi > p[1]) !== (yj > p[1])) && (p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi)) c = !c; } return c; };
const inTerr = (p, t) => pip(p, t.exterior) && !(t.holes || []).some((h) => pip(p, h));
const round1 = (pts) => pts.map(([x, y]) => [+x.toFixed(1), +y.toFixed(1)]);

let matched = 0; const unmatched = [];
for (const a of areas) {
  if (!a.path || a.path.length < 3) { unmatched.push(a.id); continue; }
  const [cx, cy] = centroid(a.path);
  const p = [(cx + (OFF[a.board] ?? 0)) * SX, cy * SY];
  const hit = terr.regions.find((r) => inTerr(p, r));
  if (!hit) { unmatched.push(a.id); continue; }
  a.path = round1(hit.exterior);
  if (hit.holes && hit.holes.length) a.holes = hit.holes.map(round1); else delete a.holes;
  matched++;
}

fs.writeFileSync('src/data/areas.json', JSON.stringify(areas));
console.log(`areas: ${areas.length}; geometry replaced from new polygons: ${matched}`);
console.log(`unmatched (kept old geometry): ${unmatched.length}${unmatched.length ? ' -> ' + unmatched.join(', ') : ''}`);
console.log(`coordinate space is now the combined ${terr.image.width}x${terr.image.height} image (update anchors.ts accordingly).`);
