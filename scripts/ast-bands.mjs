import sharp from 'sharp';

const { data, info } = await sharp('assets/ast.png').raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H, channels: C } = info;
const y = Math.round((180 / 1582) * H); // colored band row
const px = (x) => { const i = (y * W + x) * C; return [data[i], data[i + 1], data[i + 2]]; };

// Epoch palette (approx) -> name
const palette = [
  { name: 'stone', rgb: [102, 45, 145] },     // purple #662D91
  { name: 'stone', rgb: [161, 83, 152] },     // purple variant #A15398
  { name: 'earlyBronze', rgb: [39, 170, 225] },// blue #27AAE1
  { name: 'lateBronze', rgb: [57, 181, 74] },  // green #39B54A
  { name: 'earlyIron', rgb: [244, 235, 77] },  // yellow #F4EB4D
  { name: 'earlyIron', rgb: [251, 176, 64] },  // orange #FBB040 (treat below)
  { name: 'lateIron', rgb: [250, 165, 63] },   // orange #FAA53F
  { name: 'lateIron', rgb: [241, 90, 41] },    // #F15A29
  { name: 'lateIron', rgb: [239, 65, 54] },    // red #EF4136
];
const dist = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
function classify(rgb) {
  // ignore background tan ~ (215,186,145) and white
  let best = null, bd = 1e9;
  for (const p of palette) { const d = dist(rgb, p.rgb); if (d < bd) { bd = d; best = p; } }
  return bd < 4000 ? best.name : null;
}

// segment the row by classified epoch
const segs = [];
let cur = null, start = 0;
for (let x = 0; x < W; x++) {
  const c = classify(px(x));
  if (c !== cur) { if (cur) segs.push({ name: cur, x0: start, x1: x }); cur = c; start = x; }
}
if (cur) segs.push({ name: cur, x0: start, x1: W });
const big = segs.filter((s) => s.x1 - s.x0 > 25);
console.log('epoch color spans (merged):');
// merge adjacent same-name
const merged = [];
for (const s of big) { const last = merged[merged.length - 1]; if (last && last.name === s.name && s.x0 - last.x1 < 30) last.x1 = s.x1; else merged.push({ ...s }); }
for (const s of merged) console.log(`  ${s.name}: x ${s.x0}..${s.x1} (w ${s.x1 - s.x0})`);

// VP spaces: the bottom row 100..1600 is evenly spaced; infer 16 spaces across the
// same x extent as the whole colored track (first span start .. last span end).
const trackX0 = merged[0].x0, trackX1 = merged[merged.length - 1].x1;
const n = 17; // START arrow (index 0) + 16 VP spaces
console.log(`\ntrack x ${trackX0}..${trackX1}; per-space epoch (skip START):`);
const out = [];
for (let i = 1; i <= n - 1; i++) {
  const cx = trackX0 + ((i + 0.5) / n) * (trackX1 - trackX0);
  const seg = merged.find((s) => cx >= s.x0 && cx < s.x1) || merged.reduce((a, b) => (Math.abs((a.x0 + a.x1) / 2 - cx) < Math.abs((b.x0 + b.x1) / 2 - cx) ? a : b));
  out.push(seg.name);
}
console.log(JSON.stringify(out));
// epoch start spaces
const starts = {};
out.forEach((e, idx) => { if (!(e in starts)) starts[e] = idx + 1; });
console.log('epochStarts:', JSON.stringify(starts));
