// Stage 1: segment the board art into land / open-sea / coastal-water regions,
// calibrate to our known areas, and validate John's invariant (land is NEVER
// adjacent to an open sea). Produces a REVIEW report; writes nothing to game data.
import sharp from 'sharp';
import fs from 'fs';

const areas = JSON.parse(fs.readFileSync('src/data/areas.json', 'utf8'));
const cen = (p) => { const n = p.length; return [p.reduce((s, q) => s + q[0], 0) / n, p.reduce((s, q) => s + q[1], 0) / n]; };
const PANELS = [
  ['western', 'assets/vmod_extract/map-western.svg', 782.177],
  ['main', 'assets/vmod_extract/map-main.svg', 2323.12],
  ['eastern', 'assets/vmod_extract/map-eastern.svg', 1189.066],
];
const SEA_NAMES = new Set(areas.filter((a) => a.isWater).map((a) => a.name));
const DENS = 130;

function inpaintAndSegment(data, W, H, C) {
  const orange = (r, g, b) => r > 236 && g > 120 && g < 195 && b < 95;
  const yellow = (r, g, b) => r > 210 && g > 200 && b < 150;
  const red = (r, g, b) => r > 150 && g < 95 && b < 100;
  const md = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) { const r = data[i * C], g = data[i * C + 1], b = data[i * C + 2];
    if (orange(r, g, b) || yellow(r, g, b) || red(r, g, b)) { const y = (i / W) | 0, x = i % W;
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H) md[ny * W + nx] = 1; } } }
  // inpaint masked -> nearest unmasked colour
  const src = new Int32Array(W * H).fill(-1); let q = [];
  for (let i = 0; i < W * H; i++) if (!md[i]) { src[i] = i; q.push(i); }
  for (let h = 0; h < q.length; h++) { const p = q[h], y = (p / W) | 0, x = p % W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const ni = ny * W + nx; if (src[ni] === -1) { src[ni] = src[p]; q.push(ni); } } }
  const cl = Buffer.from(data);
  for (let i = 0; i < W * H; i++) if (md[i]) { const t = src[i]; cl[i * C] = data[t * C]; cl[i * C + 1] = data[t * C + 1]; cl[i * C + 2] = data[t * C + 2]; }
  const px = (x, y) => { const i = (y * W + x) * C; return [cl[i], cl[i + 1], cl[i + 2]]; };
  const border = (r, g, b) => (r > 200 && g > 200 && b > 200) || Math.max(r, g, b) < 70;
  const water = (r, g, b) => b >= g && b > 110 && b >= r - 10;
  const lab = new Int32Array(W * H).fill(-1); const regs = []; const st = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (lab[i] !== -1) continue; if (border(...px(x, y))) { lab[i] = -2; continue; }
    const id = regs.length; let Lp = 0, Wp = 0, sz = 0, sx = 0, sy = 0; st.length = 0; st.push(i); lab[i] = id;
    while (st.length) { const p = st.pop(); const y2 = (p / W) | 0, x2 = p % W; sz++; sx += x2; sy += y2; const c = px(x2, y2); if (water(...c)) Wp++; else Lp++;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x2 + dx, ny = y2 + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const ni = ny * W + nx; if (lab[ni] !== -1) continue; if (border(...px(nx, ny))) { lab[ni] = -2; continue; } lab[ni] = id; st.push(ni); } }
    regs.push({ id, sz, water: Wp > Lp, cx: sx / sz, cy: sy / sz }); }
  // adjacency: for each border pixel, the distinct regions in its neighbourhood are mutually adjacent
  const adj = regs.map(() => new Set());
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (lab[i] !== -2) continue; const near = new Set();
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const l = lab[ny * W + nx]; if (l >= 0) near.add(l); }
    for (const a of near) for (const b of near) if (a !== b) adj[a].add(b); }
  return { regs, adj, lab };
}

const report = { panels: [], totals: { land: 0, coastal: 0, openSea: 0, unmatchedLand: 0, invariantViolations: 0 } };
const panelImgs = [];
for (const [pname, svg, vw] of PANELS) {
  const knownLand = areas.filter((a) => a.board === pname && !a.isWater).map((a) => ({ a, c: cen(a.path) }));
  const knownSea = areas.filter((a) => a.board === pname && a.isWater).map((a) => ({ a, c: cen(a.path) }));
  const buf = await sharp(svg, { density: DENS }).png().toBuffer();
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, C = info.channels, scale = W / vw;
  const { regs, adj, lab } = inpaintAndSegment(data, W, H, C);
  const BIG = Math.round(300 * scale * scale);
  const big = regs.filter((r) => r.sz >= BIG);
  // viewBox centroid
  for (const r of big) { r.vx = r.cx / scale; r.vy = r.cy / scale; }
  // match land regions -> known land (nearest, greedy)
  const usedLand = new Set(); let landDist = [];
  for (const r of big.filter((r) => !r.water)) { let best = null;
    for (const k of knownLand) { if (usedLand.has(k.a.id)) continue; const d = Math.hypot(r.vx - k.c[0], r.vy - k.c[1]); if (!best || d < best.d) best = { k, d }; }
    if (best && best.d < 120) { r.match = best.k.a.id; usedLand.add(best.k.a.id); landDist.push(best.d); } }
  const landRegs = big.filter((r) => !r.water);
  // Open sea = the 13 GIVEN, owner-identified named seas. The water region CONTAINING
  // each known sea's centroid IS that open sea — we never re-derive or discard them.
  for (const k of knownSea) {
    const sx = Math.round(k.c[0] * scale), sy = Math.round(k.c[1] * scale);
    if (sx >= 0 && sy >= 0 && sx < W && sy < H) { const rid = lab[sy * W + sx]; if (rid >= 0 && regs[rid].water) regs[rid].openSea = k.a.id; }
  }
  // Everything else that is water = coastal (the layer we're actually extracting).
  for (const r of big.filter((r) => r.water)) if (!r.openSea) r.coastal = true;
  const openRegs = big.filter((r) => r.water && r.openSea);
  const coastalRegs = big.filter((r) => r.water && r.coastal);
  const unmatchedLand = landRegs.filter((r) => !r.match);
  // invariant: land region adjacent to an open-sea region
  const openIds = new Set(openRegs.map((r) => r.id));
  const viol = [];
  for (const r of landRegs) for (const n of adj[r.id]) if (openIds.has(n)) viol.push([r.match || `land#${r.id}`, openRegs.find((o) => o.id === n)?.openSea]);
  // ---- visualization: land tan, coastal cyan, open sea dark-blue, UNMATCHED land magenta ----
  const cls = new Map();
  for (const r of big) cls.set(r.id, r.water ? (r.coastal ? 'coastal' : 'open') : (r.match ? 'land' : 'unmatchedland'));
  const bigset = new Set(big.map((r) => r.id));
  const near = new Int32Array(W * H).fill(-1); const qq = [];
  for (let i = 0; i < W * H; i++) if (lab[i] >= 0 && bigset.has(lab[i])) { near[i] = lab[i]; qq.push(i); }
  for (let h = 0; h < qq.length; h++) { const p = qq[h], y = (p / W) | 0, x = p % W; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const ni = ny * W + nx; if (near[ni] === -1) { near[ni] = near[p]; qq.push(ni); } } }
  const COL = { land: [201, 164, 92], coastal: [90, 205, 225], open: [24, 42, 110], unmatchedland: [120, 120, 120] };
  const out = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; const rg = near[i]; let c = rg < 0 ? [40, 40, 40] : (COL[cls.get(rg)] || [40, 40, 40]);
    for (const [dx, dy] of [[1, 0], [0, 1]]) { const nx = x + dx, ny = y + dy; if (nx < W && ny < H) { const nn = near[ny * W + nx]; if (nn >= 0 && rg >= 0 && nn !== rg) c = [12, 12, 12]; } }
    out[i * 3] = c[0]; out[i * 3 + 1] = c[1]; out[i * 3 + 2] = c[2]; }
  panelImgs.push({ out, W, H });
  const unmatchedInfo = unmatchedLand.map((r) => ({ at: [Math.round(r.vx), Math.round(r.vy)], sz: r.sz }));
  const openNames = [...new Set(openRegs.map((r) => r.openSea))];
  landDist.sort((a, b) => a - b);
  report.panels.push({ panel: pname, regions: big.length, land: landRegs.length, matchedLand: landRegs.length - unmatchedLand.length,
    unmatchedLand: unmatchedLand.length, coastal: coastalRegs.length, openSea: openRegs.length,
    medMatchDist: landDist.length ? +landDist[landDist.length >> 1].toFixed(1) : null, maxMatchDist: landDist.length ? +landDist[landDist.length - 1].toFixed(1) : null,
    invariantViolations: viol.length, openSeaNames: openNames, unmatchedLandRegions: unmatchedInfo });
  report.totals.land += landRegs.length; report.totals.coastal += coastalRegs.length; report.totals.openSea += openRegs.length;
  report.totals.unmatchedLand += unmatchedLand.length; report.totals.invariantViolations += viol.length;
}
// composite panels side by side (West · Main · East) into one verification image
const maxH = Math.max(...panelImgs.map((p) => p.H));
const totW = panelImgs.reduce((s, p) => s + p.W, 0);
const comb = Buffer.alloc(totW * maxH * 3).fill(30);
let xoff = 0;
for (const p of panelImgs) {
  for (let y = 0; y < p.H; y++) for (let x = 0; x < p.W; x++) {
    const si = (y * p.W + x) * 3, di = (y * totW + (xoff + x)) * 3;
    comb[di] = p.out[si]; comb[di + 1] = p.out[si + 1]; comb[di + 2] = p.out[si + 2];
  }
  xoff += p.W;
}
await sharp(comb, { raw: { width: totW, height: maxH, channels: 3 } }).resize({ width: 1600 }).png().toFile('_layer_full.png');
console.log(JSON.stringify(report, null, 2).split('\n').filter((l)=>/panel|open|coastal|violation|land|TOTAL/i.test(l)).join('\n'));
console.log('wrote _layer_full.png');
