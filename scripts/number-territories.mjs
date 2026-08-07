// STEP 1 of the rebuild: derive territories from the WHITE/BLACK border lines only,
// give each a STABLE number, and draw those numbers on the real board.
// NOTHING is classified here. No VASSAL polygon data is read anywhere.
// Output: _numbered.png (for the owner to point out the 13 open seas) and
//         territories.json (the stable id table that future categorisation attaches to).
import sharp from 'sharp';
import fs from 'fs';

const PANELS = [
  ['western', 'assets/vmod_extract/map-western.svg'],
  ['main', 'assets/vmod_extract/map-main.svg'],
  ['eastern', 'assets/vmod_extract/map-eastern.svg'],
];
const DENS = 130;

// Confirmed-correct border set: white territory lines AND black coastlines.
const isBorder = (r, g, b) => (r > 200 && g > 200 && b > 200) || Math.max(r, g, b) < 70;

const panels = [];
for (const [pname, svg] of PANELS) {
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(fs.readFileSync(svg, 'utf8'));
  const vw = parseFloat(vb[1]);
  const buf = await sharp(svg, { density: DENS }).png().toBuffer();
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, C = info.channels, scale = W / vw;

  // Inpaint the coloured population discs (orange/yellow/red) + their white numerals,
  // so a numeral's white pixels don't get read as a border and split a cell.
  const orange = (r, g, b) => r > 236 && g > 120 && g < 195 && b < 95;
  const yellow = (r, g, b) => r > 210 && g > 200 && b < 150;
  const red = (r, g, b) => r > 150 && g < 95 && b < 100;
  const md = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) { const r = data[i * C], g = data[i * C + 1], b = data[i * C + 2];
    if (orange(r, g, b) || yellow(r, g, b) || red(r, g, b)) { const y = (i / W) | 0, x = i % W;
      for (let dy = -11; dy <= 11; dy++) for (let dx = -11; dx <= 11; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H) md[ny * W + nx] = 1; } } }
  const srcMap = new Int32Array(W * H).fill(-1); let q = [];
  for (let i = 0; i < W * H; i++) if (!md[i]) { srcMap[i] = i; q.push(i); }
  for (let h = 0; h < q.length; h++) { const p = q[h], y = (p / W) | 0, x = p % W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const ni = ny * W + nx; if (srcMap[ni] === -1) { srcMap[ni] = srcMap[p]; q.push(ni); } } }
  const cl = Buffer.from(data);
  for (let i = 0; i < W * H; i++) if (md[i]) { const t = srcMap[i]; cl[i * C] = data[t * C]; cl[i * C + 1] = data[t * C + 1]; cl[i * C + 2] = data[t * C + 2]; }
  const px = (x, y) => { const i = (y * W + x) * C; return [cl[i], cl[i + 1], cl[i + 2]]; };

  // Segment: flood-fill non-border pixels into regions bounded by white/black lines.
  const lab = new Int32Array(W * H).fill(-1); const regs = []; const st = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (lab[i] !== -1) continue; if (isBorder(...px(x, y))) { lab[i] = -2; continue; }
    const id = regs.length; let sz = 0, sx = 0, sy = 0; st.length = 0; st.push(i); lab[i] = id;
    while (st.length) { const p = st.pop(); const y2 = (p / W) | 0, x2 = p % W; sz++; sx += x2; sy += y2;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x2 + dx, ny = y2 + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const ni = ny * W + nx; if (lab[ni] !== -1) continue; if (isBorder(...px(nx, ny))) { lab[ni] = -2; continue; } lab[ni] = id; st.push(ni); } }
    regs.push({ id, sz, cx: sx / sz, cy: sy / sz }); }

  const BIG = Math.round(280 * scale * scale);
  const big = regs.filter((r) => r.sz >= BIG);
  panels.push({ pname, W, H, scale, vw, px, lab, big });
  console.log(`${pname}: ${big.length} territories (>= ${BIG}px)`);
}

// Stable global numbering: reading order across the stitched strip (row band, then x).
let xoff = 0; const items = [];
for (const p of panels) { for (const r of p.big) items.push({ p, r, gx: xoff + r.cx, gy: r.cy }); xoff += p.W; }
items.sort((a, b) => (Math.round(a.gy / 60) - Math.round(b.gy / 60)) || (a.gx - b.gx));
items.forEach((it, i) => { it.n = i + 1; });

// Render: dimmed real board as background, detected border lines faint red, big regions kept.
const totW = panels.reduce((s, p) => s + p.W, 0), maxH = Math.max(...panels.map((p) => p.H));
const comb = Buffer.alloc(totW * maxH * 3).fill(20);
xoff = 0;
for (const p of panels) {
  const bigset = new Set(p.big.map((r) => r.id));
  for (let y = 0; y < p.H; y++) for (let x = 0; x < p.W; x++) {
    const i = y * p.W + x, di = (y * totW + xoff + x) * 3; const l = p.lab[i];
    let c;
    if (l === -2) c = [235, 120, 120];                     // detected border line -> red
    else if (l >= 0 && bigset.has(l)) { const [r, g, b] = p.px(x, y); c = [(r + 255) >> 1, (g + 255) >> 1, (b + 255) >> 1]; } // real board, lightened
    else c = [70, 70, 70];                                  // sub-threshold speck
    comb[di] = c[0]; comb[di + 1] = c[1]; comb[di + 2] = c[2];
  }
  xoff += p.W;
}
let png = await sharp(comb, { raw: { width: totW, height: maxH, channels: 3 } }).png().toBuffer();

// Overlay the numbers via an SVG text layer.
const texts = items.map((it) => {
  const x = Math.round(it.gx), y = Math.round(it.gy);
  return `<text x="${x}" y="${y}" font-size="26" font-family="Arial" font-weight="bold" text-anchor="middle" fill="#000" stroke="#fff" stroke-width="4" paint-order="stroke">${it.n}</text>`;
}).join('');
const overlay = Buffer.from(`<svg width="${totW}" height="${maxH}" xmlns="http://www.w3.org/2000/svg">${texts}</svg>`);
await sharp(png).composite([{ input: overlay, top: 0, left: 0 }]).png().toFile('_numbered.png');

// Persist the stable id table (viewBox coords per panel).
const table = items.map((it) => ({ n: it.n, panel: it.p.pname, cx: +(it.r.cx / it.p.scale).toFixed(1), cy: +(it.r.cy / it.p.scale).toFixed(1), sizePx: it.r.sz }));
fs.writeFileSync('territories.json', JSON.stringify(table, null, 0));
console.log(`\nTOTAL territories: ${items.length}`);
console.log('wrote _numbered.png (real board, numbered, NOTHING classified) and territories.json');
