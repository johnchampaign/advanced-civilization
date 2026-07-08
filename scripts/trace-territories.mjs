// Tracer v2 — WHITE-only borders on the JOINED west·center·east map.
//
// Model (owner-specified):
//  - The 3 panels tile horizontally into ONE continuous map (same height). A
//    territory may straddle a seam; the seam artifact line is healed so it does.
//  - WHITE lines are the ONLY territory borders. Black coastlines are INTERNAL to
//    coastal territories (land/sea divider), so they are NOT borders here.
//  - Every pixel is assigned to SOME polygon (full partition): white border pixels
//    and sub-threshold specks are absorbed into the nearest real territory, so the
//    polygons tile the map with no gaps.
//  - Classify pure-blue -> openSea, pure-land -> land, mixed -> coastal. Dead-space
//    (extension labels etc.) stays uncategorised for the owner to mark 'cosmetic'.
//
// Emits src/data/territories.json (editor schema) + public/dev-assets/board.png.
import sharp from 'sharp';
import fs from 'fs';

const PANELS = [
  ['western', 'assets/vmod_extract/map-western.svg'],
  ['main', 'assets/vmod_extract/map-main.svg'],
  ['eastern', 'assets/vmod_extract/map-eastern.svg'],
];
const DENS = 130;
const DISPLAY_W = 3800;

const isWhite = (r, g, b) => r > 200 && g > 200 && b > 200;   // WHITE ONLY = territory border
const isBlue = (r, g, b) => b >= g && b > 110 && b >= r - 10;
const isLand = (r, g, b) => !isBlue(r, g, b) && !(Math.max(r, g, b) < 70) && (g > 95 || (r > 170 && g > 130));

// ---- render + inpaint markers, collect panels (all same height) ----
const rendered = [];
for (const [pname, svg] of PANELS) {
  const buf = await sharp(svg, { density: DENS }).png().toBuffer();
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, C = info.channels;
  const orange = (r, g, b) => r > 236 && g > 120 && g < 195 && b < 95;
  const yellow = (r, g, b) => r > 210 && g > 200 && b < 150;
  const red = (r, g, b) => r > 150 && g < 95 && b < 100;
  const md = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) { const r = data[i * C], g = data[i * C + 1], b = data[i * C + 2];
    if (orange(r, g, b) || yellow(r, g, b) || red(r, g, b)) { const y = (i / W) | 0, x = i % W;
      for (let dy = -11; dy <= 11; dy++) for (let dx = -11; dx <= 11; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H) md[ny * W + nx] = 1; } } }
  const src = new Int32Array(W * H).fill(-1); let q = [];
  for (let i = 0; i < W * H; i++) if (!md[i]) { src[i] = i; q.push(i); }
  for (let h = 0; h < q.length; h++) { const p = q[h], y = (p / W) | 0, x = p % W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const ni = ny * W + nx; if (src[ni] === -1) { src[ni] = src[p]; q.push(ni); } } }
  const cl = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) { const t = md[i] ? src[i] : i; cl[i * 3] = data[t * C]; cl[i * 3 + 1] = data[t * C + 1]; cl[i * 3 + 2] = data[t * C + 2]; }
  rendered.push({ pname, W, H, cl });
  console.log(`${pname}: ${W}x${H}`);
}

// ---- join panels into one combined RGB buffer (top-aligned, uniform height) ----
const H = Math.max(...rendered.map((p) => p.H));
const seams = []; let totW = 0;
const panelSpan = [];
for (const p of rendered) { panelSpan.push([totW, totW + p.W, p.pname]); totW += p.W; if (totW < rendered.reduce((s, q) => s + q.W, 0)) seams.push(totW); }
const W = totW;
const comb = Buffer.alloc(W * H * 3).fill(255); // pad = white (its own region, ignorable)
let xoff = 0;
for (const p of rendered) { for (let y = 0; y < p.H; y++) for (let x = 0; x < p.W; x++) { const si = (y * p.W + x) * 3, di = (y * W + xoff + x) * 3; comb[di] = p.cl[si]; comb[di + 1] = p.cl[si + 1]; comb[di + 2] = p.cl[si + 2]; } xoff += p.W; }
seams.pop(); // last cumulative == W, not an interior seam
const gp = (x, y) => { const i = (y * W + x) * 3; return [comb[i], comb[i + 1], comb[i + 2]]; };

// ---- heal the seam artifact: replace WHITE pixels in a thin band at each seam
// with the nearest non-white colour horizontally, so straddling territories join.
for (const sx of seams) for (let x = sx - 3; x <= sx + 2; x++) { if (x < 0 || x >= W) continue;
  for (let y = 0; y < H; y++) { if (!isWhite(...gp(x, y))) continue;
    let rep = null;
    for (let d = 1; d <= 12 && !rep; d++) { for (const nx of [x - d, x + d]) { if (nx < 0 || nx >= W) continue; const c = gp(nx, y); if (!isWhite(...c)) { rep = c; break; } } }
    if (rep) { const i = (y * W + x) * 3; comb[i] = rep[0]; comb[i + 1] = rep[1]; comb[i + 2] = rep[2]; }
  }
}

// ---- segment WHITE-only ----
const lab = new Int32Array(W * H).fill(-1); const regs = []; const st = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (lab[i] !== -1) continue; if (isWhite(...gp(x, y))) { lab[i] = -2; continue; }
  const id = regs.length; let sz = 0, blue = 0, land = 0, sx = 0, sy = 0; st.length = 0; st.push(i); lab[i] = id;
  while (st.length) { const p = st.pop(); const y2 = (p / W) | 0, x2 = p % W; sz++; sx += x2; sy += y2; const c = gp(x2, y2); if (isBlue(...c)) blue++; else if (isLand(...c)) land++;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x2 + dx, ny = y2 + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const ni = ny * W + nx; if (lab[ni] !== -1) continue; if (isWhite(...gp(nx, ny))) { lab[ni] = -2; continue; } lab[ni] = id; st.push(ni); } }
  regs.push({ id, sz, blue, land, cx: sx / sz, cy: sy / sz }); }

const scale = DISPLAY_W / W;
const BIG = Math.round(280 * (DENS / 96) ** 2);
const big = regs.filter((r) => r.sz >= BIG);
const bigIds = new Set(big.map((r) => r.id));
console.log(`\nsegmented: ${regs.length} raw regions, ${big.length} >= ${BIG}px`);

// ---- full partition: assign EVERY pixel (borders + specks) to nearest BIG region ----
const near = new Int32Array(W * H).fill(-1); let q = [];
for (let i = 0; i < W * H; i++) { const l = lab[i]; if (l >= 0 && bigIds.has(l)) { near[i] = l; q.push(i); } }
for (let h = 0; h < q.length; h++) { const p = q[h], y = (p / W) | 0, x = p % W; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const ni = ny * W + nx; if (near[ni] === -1) { near[ni] = near[p]; q.push(ni); } } }

// ---- trace each BIG region from the partition (near[]) via boundary-edge stitching ----
function traceRegion(edgeList) {
  const adj = new Map(); const used = new Set(); const pts = new Map();
  const key = (x, y) => x * 100000 + y; const ek = (a, b) => (a < b ? a + '_' + b : b + '_' + a);
  for (const [ax, ay, bx, by] of edgeList) { const ka = key(ax, ay), kb = key(bx, by); pts.set(ka, [ax, ay]); pts.set(kb, [bx, by]);
    if (!adj.has(ka)) adj.set(ka, []); if (!adj.has(kb)) adj.set(kb, []); adj.get(ka).push([kb, ek(ka, kb)]); adj.get(kb).push([ka, ek(ka, kb)]); }
  const loops = [];
  for (const startK of adj.keys()) { let cur = startK; const loop = []; let steps = 0, started = false;
    while (steps++ < edgeList.length * 2 + 5) { const opts = adj.get(cur).filter(([, e]) => !used.has(e)); if (!opts.length) break; const [nextK, e] = opts[0]; used.add(e); loop.push(pts.get(cur)); cur = nextK; started = true; if (cur === startK) break; }
    if (started && loop.length >= 4) loops.push(loop); }
  if (!loops.length) return null; loops.sort((a, b) => b.length - a.length); return loops[0];
}
function dp(points, eps) {
  if (points.length < 4) return points; const sq = eps * eps;
  const d2 = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1]; const L = dx * dx + dy * dy; if (!L) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2; let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L; t = Math.max(0, Math.min(1, t)); return (p[0] - (a[0] + t * dx)) ** 2 + (p[1] - (a[1] + t * dy)) ** 2; };
  const sim = (s, e, arr) => { let idx = -1, mx = 0; for (let i = s + 1; i < e; i++) { const d = d2(arr[i], arr[s], arr[e]); if (d > mx) { mx = d; idx = i; } } return (mx > sq && idx !== -1) ? [...sim(s, idx, arr), ...sim(idx, e, arr).slice(1)] : [arr[s], arr[e]]; };
  let a1 = 1, best = -1; for (let i = 1; i < points.length; i++) { const d = (points[i][0] - points[0][0]) ** 2 + (points[i][1] - points[0][1]) ** 2; if (d > best) { best = d; a1 = i; } }
  const h1 = sim(0, a1, points); const s2 = [...points.slice(a1), points[0]]; const h2 = sim(0, s2.length - 1, s2);
  return [...h1.slice(0, -1), ...h2.slice(0, -1)];
}
const shoelace = (p) => { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1]; return Math.abs(a) / 2; };
const centroidOf = (p) => { let a = 0, cx = 0, cy = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { const cr = p[j][0] * p[i][1] - p[i][0] * p[j][1]; a += cr; cx += (p[j][0] + p[i][0]) * cr; cy += (p[j][1] + p[i][1]) * cr; } if (!a) { const m = p.reduce((s, q) => [s[0] + q[0], s[1] + q[1]], [0, 0]); return [m[0] / p.length, m[1] / p.length]; } a *= 0.5; return [cx / (6 * a), cy / (6 * a)]; };

// Boolean union of adjacent polygons (display coords): rasterise, OR, re-trace.
function mergePolys(exts) {
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  for (const e of exts) for (const p of e) { minx = Math.min(minx, p[0]); miny = Math.min(miny, p[1]); maxx = Math.max(maxx, p[0]); maxy = Math.max(maxy, p[1]); }
  minx = Math.floor(minx) - 2; miny = Math.floor(miny) - 2; maxx = Math.ceil(maxx) + 2; maxy = Math.ceil(maxy) + 2;
  const w = maxx - minx, h = maxy - miny; if (w * h > 6e6) return null;
  const mask = new Uint8Array(w * h);
  const pip = (x, y, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1]; if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) c = !c; } return c; };
  for (const e of exts) { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const p of e) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) { if (pip(x + 0.5, y + 0.5, e)) { const mx = x - minx, my = y - miny; if (mx >= 0 && my >= 0 && mx < w && my < h) mask[my * w + mx] = 1; } } }
  const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x];
  const edges = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (!inside(x, y)) continue; if (!inside(x, y - 1)) edges.push([x, y, x + 1, y]); if (!inside(x, y + 1)) edges.push([x, y + 1, x + 1, y + 1]); if (!inside(x - 1, y)) edges.push([x, y, x, y + 1]); if (!inside(x + 1, y)) edges.push([x + 1, y, x + 1, y + 1]); }
  const loop = traceRegion(edges); if (!loop) return null;
  return dp(loop.map(([x, y]) => [minx + x, miny + y]), 1.8);
}

const edges = new Map(); for (const r of big) edges.set(r.id, []);
const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? -1 : near[y * W + x];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const l = near[y * W + x]; if (l < 0) continue; const E = edges.get(l); if (!E) continue;
  if (at(x, y - 1) !== l) E.push([x, y, x + 1, y]);
  if (at(x, y + 1) !== l) E.push([x, y + 1, x + 1, y + 1]);
  if (at(x - 1, y) !== l) E.push([x, y, x, y + 1]);
  if (at(x + 1, y) !== l) E.push([x + 1, y, x + 1, y + 1]); }

const panelOf = (cx) => { for (const [a, b, name] of panelSpan) if (cx >= a && cx < b) return name; return 'main'; };

// carry over sea NAMES from the previous file (same coord space) by nearest centroid
let oldSeas = [];
try { const old = JSON.parse(fs.readFileSync('src/data/territories.json', 'utf8')); oldSeas = (old.regions || []).filter((r) => r.name).map((r) => ({ name: r.name, c: r.centroid })); } catch { /* first run */ }

// classify + build regions
let traced = [];
for (const r of big) {
  const ring = traceRegion(edges.get(r.id)); if (!ring) continue;
  const ext = dp(ring.map(([x, y]) => [+(x * scale).toFixed(1), +(y * scale).toFixed(1)]), 2.2);
  if (ext.length < 3) continue;
  const terr = r.blue + r.land; const bf = terr ? r.blue / terr : 0;
  const otherFrac = 1 - terr / r.sz;        // mostly non-land/non-sea colour = likely cosmetic
  let category = '';
  if (otherFrac < 0.55) category = bf > 0.9 ? 'openSea' : bf < 0.06 ? 'land' : 'coastal';
  traced.push({ id: 0, panel: panelOf(r.cx), category, area_px: Math.round(shoelace(ext)), centroid: centroidOf(ext).map((v) => +v.toFixed(1)), exterior: ext, _cx: r.cx * scale, _cy: r.cy * scale });
}
// name carry-over for open seas (nearest old named-sea centroid)
let named = 0;
for (const t of traced) { if (t.category !== 'openSea') continue; let best = null; for (const s of oldSeas) { const d = Math.hypot(s.c[0] - t.centroid[0], s.c[1] - t.centroid[1]); if (!best || d < best.d) best = { s, d }; } if (best && best.d < 220) { t.name = best.s.name; named++; } }
// merge same-named open-sea cells (a sea split by a line into >1 piece)
let merges = 0;
const byName = new Map();
for (const t of traced) if (t.category === 'openSea' && t.name) { if (!byName.has(t.name)) byName.set(t.name, []); byName.get(t.name).push(t); }
for (const [, grp] of byName) { if (grp.length < 2) continue; const ext = mergePolys(grp.map((g) => g.exterior)); if (!ext || ext.length < 3) continue;
  const keep = grp[0]; keep.exterior = ext; keep.area_px = Math.round(shoelace(ext)); const c = centroidOf(ext); keep.centroid = c.map((v) => +v.toFixed(1)); keep._cx = c[0]; keep._cy = c[1];
  const drop = new Set(grp.slice(1)); traced = traced.filter((t) => !drop.has(t)); merges += grp.length - 1; }
// stable numbering: reading order (row band, then x)
traced.sort((a, b) => (Math.round(a._cy / 60) - Math.round(b._cy / 60)) || (a._cx - b._cx));
traced.forEach((t, i) => { t.id = i + 1; });

const openCount = traced.filter((t) => t.category === 'openSea').length;
const regionsOut = traced.map(({ _cx, _cy, ...r }) => (r.name ? r : r));
fs.writeFileSync('src/data/territories.json', JSON.stringify({
  _meta: { schema: 'territory-polygons-v2', provenance: 'traced from WHITE-only border lines of the JOINED west·center·east board (scripts/trace-territories.mjs); black coastlines are internal to coastal territories; NO VASSAL polygon geometry', source: 'assets/vmod_extract/map-*.svg', notes: ['coords in board.png space', 'full partition: every pixel assigned to a territory', 'category: openSea|coastal|land|cosmetic|"" ; openSea pre-tagged from pure-blue cells (verify vs the 13)'] },
  image: { width: DISPLAY_W, height: Math.round(H * scale) }, count: traced.length, regions: traced.map(({ _cx, _cy, ...r }) => r),
}, null, 0));

// combined board.png for the editor
await sharp(comb, { raw: { width: W, height: H, channels: 3 } }).resize({ width: DISPLAY_W }).png().toFile('public/dev-assets/board.png');

console.log(`\nwrote src/data/territories.json: ${traced.length} territories`);
console.log(`  openSea(pure-blue)=${openCount}  coastal=${traced.filter((t) => t.category === 'coastal').length}  land=${traced.filter((t) => t.category === 'land').length}  uncategorised=${traced.filter((t) => !t.category).length}`);
console.log(`  sea names carried over: ${named}; same-name split-sea merges: ${merges}`);
console.log(`  board.png: ${DISPLAY_W}x${Math.round(H * scale)}`);
