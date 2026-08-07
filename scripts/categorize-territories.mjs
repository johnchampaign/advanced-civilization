// Categorize each WHITE-LINE territory into: open sea | coastal | land | unknown.
// Borders = WHITE lines only (black coastlines are INTERIOR to a coastal cell).
//   land    = cell contains no water (all land colour)
//   openSea = one of the 13 owner-identified seas (by known centroid)
//   coastal = cell contains water but is not an open sea
//   unknown = ambiguous / invariant-violating (land cell touching open sea) -> owner decides
import sharp from 'sharp';
import fs from 'fs';

const areas = JSON.parse(fs.readFileSync('src/data/areas.json', 'utf8'));
const cen = (p) => { const n = p.length; return [p.reduce((s, q) => s + q[0], 0) / n, p.reduce((s, q) => s + q[1], 0) / n]; };
const PANELS = [
  ['western', 'assets/vmod_extract/map-western.svg', 782.177],
  ['main', 'assets/vmod_extract/map-main.svg', 2323.12],
  ['eastern', 'assets/vmod_extract/map-eastern.svg', 1189.066],
];
const DENS = 130;

// Territory borders = white lines AND black coastlines (owner-confirmed this set is correct).
const isBorder = (r, g, b) => (r > 200 && g > 200 && b > 200) || Math.max(r, g, b) < 70;
const isBlue = (r, g, b) => b >= g && b > 110 && b >= r - 10;
const isLandCol = (r, g, b) => !isBlue(r, g, b) && !isBorder(r, g, b) && (g > 95 || (r > 170 && g > 130));

const panelImgs = [];
const totals = { land: 0, coastal: 0, openSea: 0, unknown: 0 };
for (const [pname, svg, vw] of PANELS) {
  const knownSea = areas.filter((a) => a.board === pname && a.isWater).map((a) => ({ a, c: cen(a.path) }));
  const buf = await sharp(svg, { density: DENS }).png().toBuffer();
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, C = info.channels, scale = W / vw;
  const gp = (x, y) => { const i = (y * W + x) * C; return [data[i], data[i + 1], data[i + 2]]; };

  // inpaint colour markers (orange/yellow/red discs + their white numbers) so they
  // don't inject white "borders" mid-cell or blank out coastal water.
  const orange = (r, g, b) => r > 236 && g > 120 && g < 195 && b < 95;
  const yellow = (r, g, b) => r > 210 && g > 200 && b < 150;
  const red = (r, g, b) => r > 150 && g < 95 && b < 100;
  const md = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) { const [r, g, b] = [data[i * C], data[i * C + 1], data[i * C + 2]];
    if (orange(r, g, b) || yellow(r, g, b) || red(r, g, b)) { const y = (i / W) | 0, x = i % W;
      for (let dy = -11; dy <= 11; dy++) for (let dx = -11; dx <= 11; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H) md[ny * W + nx] = 1; } } }
  const src = new Int32Array(W * H).fill(-1); let q = [];
  for (let i = 0; i < W * H; i++) if (!md[i]) { src[i] = i; q.push(i); }
  for (let h = 0; h < q.length; h++) { const p = q[h], y = (p / W) | 0, x = p % W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const ni = ny * W + nx; if (src[ni] === -1) { src[ni] = src[p]; q.push(ni); } } }
  const cl = Buffer.from(data);
  for (let i = 0; i < W * H; i++) if (md[i]) { const t = src[i]; cl[i * C] = data[t * C]; cl[i * C + 1] = data[t * C + 1]; cl[i * C + 2] = data[t * C + 2]; }
  const px = (x, y) => { const i = (y * W + x) * C; return [cl[i], cl[i + 1], cl[i + 2]]; };

  // segment: borders = WHITE only
  const lab = new Int32Array(W * H).fill(-1); const regs = []; const st = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (lab[i] !== -1) continue; if (isBorder(...px(x, y))) { lab[i] = -2; continue; }
    const id = regs.length; let blue = 0, land = 0, sz = 0, sx = 0, sy = 0; st.length = 0; st.push(i); lab[i] = id;
    while (st.length) { const p = st.pop(); const y2 = (p / W) | 0, x2 = p % W; sz++; sx += x2; sy += y2; const c = px(x2, y2); if (isBlue(...c)) blue++; else if (isLandCol(...c)) land++;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x2 + dx, ny = y2 + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const ni = ny * W + nx; if (lab[ni] !== -1) continue; if (isBorder(...px(nx, ny))) { lab[ni] = -2; continue; } lab[ni] = id; st.push(ni); } }
    regs.push({ id, sz, blue, land, cx: sx / sz, cy: sy / sz }); }

  // adjacency over white borders
  const adj = regs.map(() => new Set());
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (lab[i] !== -2) continue; const near = new Set();
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const l = lab[ny * W + nx]; if (l >= 0) near.add(l); }
    for (const a of near) for (const b of near) if (a !== b) adj[a].add(b); }

  const BIG = Math.round(280 * scale * scale);
  const big = regs.filter((r) => r.sz >= BIG);
  // classify
  for (const r of big) { const cls = r.blue + r.land; r.blueFrac = cls ? r.blue / cls : 0; r.cat = r.blueFrac < 0.04 ? 'land' : 'coastal'; }
  // Open sea = the WATER cell best overlapping each known sea polygon. A single
  // centroid can land on a coastal LAND cell (e.g. Tarentum) and wrongly bridge two
  // seas — sampling the whole polygon and requiring a water cell prevents that. We
  // never re-derive which seas exist; the 13 are given, we only locate their cell.
  const isWaterReg = (r) => { const t = r.blue + r.land; return t ? r.blue / t > 0.5 : false; };
  const waterCells = big.filter(isWaterReg);
  for (const k of knownSea) {
    let best = null;
    for (const r of waterCells) { const d = Math.hypot(r.cx / scale - k.c[0], r.cy / scale - k.c[1]); if (!best || d < best.d) best = { r, d }; }
    if (best && best.d < 500) best.r.cat = 'openSea';
  }
  const openIds = new Set(big.filter((r) => r.cat === 'openSea').map((r) => r.id));
  // invariant: a LAND cell adjacent to an OPEN SEA cell is impossible -> mark unknown for owner review
  for (const r of big) if (r.cat === 'land') for (const n of adj[r.id]) if (openIds.has(n)) { r.cat = 'unknown'; break; }

  for (const r of big) totals[r.cat] = (totals[r.cat] || 0) + 1;

  // render: openSea navy, coastal cyan, land tan, unknown magenta
  const COL = { land: [201, 164, 92], coastal: [90, 205, 225], openSea: [24, 42, 110], unknown: [210, 60, 180] };
  const catOf = new Map(big.map((r) => [r.id, r.cat]));
  const bigset = new Set(big.map((r) => r.id));
  const near = new Int32Array(W * H).fill(-1); q = [];
  for (let i = 0; i < W * H; i++) if (lab[i] >= 0 && bigset.has(lab[i])) { near[i] = lab[i]; q.push(i); }
  for (let h = 0; h < q.length; h++) { const p = q[h], y = (p / W) | 0, x = p % W; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const ni = ny * W + nx; if (near[ni] === -1) { near[ni] = near[p]; q.push(ni); } } }
  const out = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; const rg = near[i]; let c = rg < 0 ? [235, 235, 235] : (COL[catOf.get(rg)] || [235, 235, 235]);
    for (const [dx, dy] of [[1, 0], [0, 1]]) { const nx = x + dx, ny = y + dy; if (nx < W && ny < H) { const nn = near[ny * W + nx]; if (nn >= 0 && rg >= 0 && nn !== rg) c = [15, 15, 15]; } }
    out[i * 3] = c[0]; out[i * 3 + 1] = c[1]; out[i * 3 + 2] = c[2]; }
  panelImgs.push({ out, W, H });
  console.log(`${pname}: territories=${big.length}  land=${big.filter((r)=>r.cat==='land').length} coastal=${big.filter((r)=>r.cat==='coastal').length} openSea=${big.filter((r)=>r.cat==='openSea').length} unknown=${big.filter((r)=>r.cat==='unknown').length}`);
}
const maxH = Math.max(...panelImgs.map((p) => p.H)), totW = panelImgs.reduce((s, p) => s + p.W, 0);
const comb = Buffer.alloc(totW * maxH * 3).fill(30); let xoff = 0;
for (const p of panelImgs) { for (let y = 0; y < p.H; y++) for (let x = 0; x < p.W; x++) { const si = (y * p.W + x) * 3, di = (y * totW + xoff + x) * 3; comb[di] = p.out[si]; comb[di + 1] = p.out[si + 1]; comb[di + 2] = p.out[si + 2]; } xoff += p.W; }
await sharp(comb, { raw: { width: totW, height: maxH, channels: 3 } }).resize({ width: 1600 }).png().toFile('_categorized.png');
console.log('TOTALS:', totals);
console.log('wrote _categorized.png  (navy=open sea, cyan=coastal, tan=land, magenta=unknown)');
