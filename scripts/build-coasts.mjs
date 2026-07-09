// build-coasts — the coastline infrastructure. For every COASTAL territory, look
// inside its polygon on the board image and split it by the BLACK coastline into
// connected land sub-areas and sea (coastal-water) sub-areas. openSea territories
// become one sea sub-area, land territories one land sub-area. Emits
// src/data/coastlines.json: per territory a list of sub-areas {kind, exterior},
// plus a verification render _coasts.png. This is the DATA layer that later feeds
// coastal-water adjacency + ship routing (Scythia's two separate waters come out
// as two sea sub-areas).
import sharp from 'sharp';
import fs from 'fs';

const terr = JSON.parse(fs.readFileSync('src/data/territories.json', 'utf8'));
const areasById = Object.fromEntries(JSON.parse(fs.readFileSync('src/data/areas.json', 'utf8')).map((a) => [a.id, a]));
const { data, info } = await sharp('public/dev-assets/board.png').raw().toBuffer({ resolveWithObject: true });
const IW = info.width, IH = info.height, C = info.channels;
const px = (x, y) => { const i = (y * IW + x) * C; return [data[i], data[i + 1], data[i + 2]]; };
const isBlue = (r, g, b) => b >= g && b > 110 && b >= r - 10;
// White territory line (incl. its pale anti-alias halo) OR near-black coastline.
//  - White/halo: min channel > 150. The strict all-channels>200 test left the
//    border's pale-grey fringe (~rgb(180,200,180)) as "land", tracing a thin ring
//    just inside each territory's outline — a floating tan hexagon on island
//    territories (knossos/phaestos/thera). Real terrain is saturated (one channel
//    low), so min>150 catches only the near-white halo, not land/sea.
//  - Black coast: max channel < 50. Must stay BELOW the dark-teal floodplain land
//    (~rgb(14,62,56), max ch 62) or that land is misread as coastline (delta
//    city-sites port-dialx/karachi rendered as a tan blob / water).
const isBorder = (r, g, b) => Math.min(r, g, b) > 150 || Math.max(r, g, b) < 50;
const MIN_SEA = 60;   // coastal waters can be small strips — keep them
const MIN_LAND = 60;  // small islands (e.g. Ebusus ~166px) are signal, not noise

const pip = (x, y, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1]; if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) c = !c; } return c; };
const inRegion = (x, y, r) => pip(x, y, r.exterior) && !(r.holes || []).some((h) => pip(x, y, h));
const polyArea = (p) => { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1]; return Math.abs(a) / 2; };
const centroidOf = (p) => { let a = 0, cx = 0, cy = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { const cr = p[j][0] * p[i][1] - p[i][0] * p[j][1]; a += cr; cx += (p[j][0] + p[i][0]) * cr; cy += (p[j][1] + p[i][1]) * cr; } if (!a) { const m = p.reduce((s, q) => [s[0] + q[0], s[1] + q[1]], [0, 0]); return [m[0] / p.length, m[1] / p.length]; } a *= 0.5; return [cx / (6 * a), cy / (6 * a)]; };
function dp(points, eps) { if (points.length < 4) return points; const sq = eps * eps; const d2 = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1]; const L = dx * dx + dy * dy; if (!L) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2; let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L; t = Math.max(0, Math.min(1, t)); return (p[0] - (a[0] + t * dx)) ** 2 + (p[1] - (a[1] + t * dy)) ** 2; }; const sim = (s, e, arr) => { let idx = -1, mx = 0; for (let i = s + 1; i < e; i++) { const d = d2(arr[i], arr[s], arr[e]); if (d > mx) { mx = d; idx = i; } } return (mx > sq && idx !== -1) ? [...sim(s, idx, arr), ...sim(idx, e, arr).slice(1)] : [arr[s], arr[e]]; }; let a1 = 1, best = -1; for (let i = 1; i < points.length; i++) { const d = (points[i][0] - points[0][0]) ** 2 + (points[i][1] - points[0][1]) ** 2; if (d > best) { best = d; a1 = i; } } const h1 = sim(0, a1, points); const s2 = [...points.slice(a1), points[0]]; const h2 = sim(0, s2.length - 1, s2); return [...h1.slice(0, -1), ...h2.slice(0, -1)]; }
function traceLoop(edges) { const adj = new Map(); const pts = new Map(); const used = new Set(); const key = (x, y) => x * 100000 + y; const ek = (a, b) => (a < b ? a + '_' + b : b + '_' + a); for (const [ax, ay, bx, by] of edges) { const ka = key(ax, ay), kb = key(bx, by); pts.set(ka, [ax, ay]); pts.set(kb, [bx, by]); const e = ek(ka, kb); if (!adj.has(ka)) adj.set(ka, []); if (!adj.has(kb)) adj.set(kb, []); adj.get(ka).push({ to: kb, e }); adj.get(kb).push({ to: ka, e }); } let best = null; for (const s of adj.keys()) { let o; while ((o = adj.get(s).find((x) => !used.has(x.e)))) { const loop = [pts.get(s)]; let cur = s, step = o, g = 0; while (step && g++ < edges.length + 5) { used.add(step.e); loop.push(pts.get(step.to)); if (step.to === s) break; cur = step.to; step = adj.get(cur).find((x) => !used.has(x.e)); } if (loop.length >= 4 && (!best || loop.length > best.length)) best = loop; } } return best; }

// Split a coastal region into sub-areas by the black coast. Returns [{kind, exterior}].
function splitRegion(r) {
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  for (const p of r.exterior) { minx = Math.min(minx, p[0]); miny = Math.min(miny, p[1]); maxx = Math.max(maxx, p[0]); maxy = Math.max(maxy, p[1]); }
  minx = Math.max(0, Math.floor(minx)); miny = Math.max(0, Math.floor(miny)); maxx = Math.min(IW - 1, Math.ceil(maxx)); maxy = Math.min(IH - 1, Math.ceil(maxy));
  const W = maxx - minx + 1, H = maxy - miny + 1;
  const kind = new Int8Array(W * H); // 0 outside/border, 1 sea, 2 land
  const inside = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const gx = minx + x, gy = miny + y;
    if (!inRegion(gx + 0.5, gy + 0.5, r)) continue; inside[y * W + x] = 1; const c = px(gx, gy); if (isBorder(...c)) continue; kind[y * W + x] = isBlue(...c) ? 1 : 2; }
  // Peel a 2px margin just inside the territory's OUTER boundary. The white
  // border's anti-alias halo there classifies as land and otherwise traces a thin
  // ring around the whole polygon — a floating tan outline on island territories
  // (knossos/phaestos/thera). Erode only against pixels OUTSIDE the polygon, so
  // the internal land/sea split (the black coastline) is left untouched.
  const ER = 2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (!kind[y * W + x]) continue;
    let edge = false;
    for (let dy = -ER; dy <= ER && !edge; dy++) for (let dx = -ER; dx <= ER; dx++) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H || !inside[ny * W + nx]) { edge = true; break; } }
    if (edge) kind[y * W + x] = -1; }
  for (let i = 0; i < W * H; i++) if (kind[i] === -1) kind[i] = 0;
  const lab = new Int32Array(W * H).fill(-1); const comps = []; const st = [];
  for (let i = 0; i < W * H; i++) { if (lab[i] !== -1 || kind[i] === 0) continue; const id = comps.length; const k = kind[i]; let sz = 0, bx0 = W, by0 = H, bx1 = 0, by1 = 0; st.length = 0; st.push(i); lab[i] = id;
    while (st.length) { const p = st.pop(); const y = (p / W) | 0, x = p % W; sz++; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const ni = ny * W + nx; if (lab[ni] === -1 && kind[ni] === k) { lab[ni] = id; st.push(ni); } } }
    comps.push({ id, k, sz, bw: bx1 - bx0 + 1, bh: by1 - by0 + 1 }); }
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? -1 : lab[y * W + x];
  const out = [];
  for (const comp of comps) { if (comp.sz < (comp.k === 1 ? MIN_SEA : MIN_LAND)) continue;
    // Drop a thin perimeter ring: a LAND component that spans almost the whole
    // territory bbox yet fills little of it is the white-border halo, not real
    // land (the real island is a separate, compact component).
    if (comp.k === 2 && comp.bw > 0.8 * W && comp.bh > 0.8 * H && comp.sz < 0.28 * comp.bw * comp.bh) continue;
    // Drop a small, very thin LAND sliver (fill < 0.15) — halo fringe along the
    // internal coastline, floating in the coastal water. Real small islands are
    // blobby (fill ≥ 0.2, e.g. Ebusus 0.29), so this leaves them intact.
    if (comp.k === 2 && comp.sz < 500 && comp.sz < 0.15 * comp.bw * comp.bh) continue;
    const edges = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (lab[y * W + x] !== comp.id) continue;
      if (at(x, y - 1) !== comp.id) edges.push([x, y, x + 1, y]); if (at(x, y + 1) !== comp.id) edges.push([x, y + 1, x + 1, y + 1]); if (at(x - 1, y) !== comp.id) edges.push([x, y, x, y + 1]); if (at(x + 1, y) !== comp.id) edges.push([x + 1, y, x + 1, y + 1]); }
    const loop = traceLoop(edges); if (!loop) continue; const ext = dp(loop.map(([x, y]) => [+(minx + x).toFixed(1), +(miny + y).toFixed(1)]), 2);
    if (ext.length >= 3) out.push({ kind: comp.k === 1 ? 'sea' : 'land', exterior: ext });
  }
  return out;
}

const result = [];
for (const r of terr.regions) {
  if (r.category === 'cosmetic') continue;
  let subs;
  // openSea / land are single-kind; coastal AND uncategorised get split by the
  // black coast into whatever land/sea components actually exist.
  if (r.category === 'openSea') subs = [{ kind: 'sea', exterior: r.exterior }];
  else if (r.category === 'land') subs = [{ kind: 'land', exterior: r.exterior }];
  else subs = splitRegion(r);
  // fallback: if splitting produced nothing, treat whole region as its category
  if (!subs.length) subs = [{ kind: r.category === 'openSea' ? 'sea' : 'land', exterior: r.exterior }];
  // The game's areas.json is authoritative on land vs water: a LAND area must
  // have land (don't let a tiny island render as pure water), and vice-versa.
  const area = r.name ? areasById[r.name] : undefined;
  if (area && !area.isWater && !subs.some((s) => s.kind === 'land')) subs = [{ kind: 'land', exterior: r.exterior }];
  else if (area && area.isWater && !subs.some((s) => s.kind === 'sea')) subs = [{ kind: 'sea', exterior: r.exterior }];
  result.push({ id: r.id, name: r.name, category: r.category,
    sub: subs.map((s, i) => ({ subId: `${r.name || r.id}#${s.kind}${i + 1}`, kind: s.kind, area_px: Math.round(polyArea(s.exterior)), centroid: centroidOf(s.exterior).map((v) => +v.toFixed(1)), exterior: s.exterior })) });
}

fs.writeFileSync('src/data/coastlines.json', JSON.stringify({ image: { width: IW, height: IH }, count: result.length, territories: result }, null, 0));

// verification render
const svg = result.flatMap((t) => t.sub.map((s) => `<polygon points="${s.exterior.map((p) => p.join(',')).join(' ')}" fill="${s.kind === 'sea' ? 'rgba(20,90,140,0.75)' : 'rgba(200,168,106,0.75)'}" stroke="#ff2d2d" stroke-width="1"/>`)).join('');
await sharp('public/dev-assets/board.png').composite([{ input: Buffer.from(`<svg width="${IW}" height="${IH}" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`), top: 0, left: 0 }]).png().toFile('_coasts.png');

const coastal = result.filter((t) => t.category === 'coastal');
const multiSea = coastal.filter((t) => t.sub.filter((s) => s.kind === 'sea').length > 1);
const noSea = coastal.filter((t) => !t.sub.some((s) => s.kind === 'sea'));
console.log(`territories processed: ${result.length}`);
console.log(`total sub-areas: ${result.reduce((n, t) => n + t.sub.length, 0)} (sea ${result.reduce((n, t) => n + t.sub.filter((s) => s.kind === 'sea').length, 0)}, land ${result.reduce((n, t) => n + t.sub.filter((s) => s.kind === 'land').length, 0)})`);
console.log(`coastal territories: ${coastal.length}`);
console.log(`  with >1 sea sub-area (like Scythia): ${multiSea.length}  ${multiSea.slice(0, 15).map((t) => (t.name || t.id) + '(' + t.sub.filter((s) => s.kind === 'sea').length + ')').join(', ')}`);
console.log(`  coastal but NO sea sub-area detected (needs review): ${noSea.length}  ${noSea.slice(0, 20).map((t) => t.name || t.id).join(', ')}`);
console.log('wrote src/data/coastlines.json and _coasts.png');
