// Extract per-civ AST epoch boundaries from the VASSAL ASTstrip-<civ>.svg overlays
// and write them into src/data/ast.json (tracksByCiv).
//
// Strip model (viewBox width 958): START arrow at x≈187.8, FINISH at x≈913.8 →
// 16 numbered spaces of width (913.8-187.8)/16≈45.375. Each strip marks two grey
// blocks (#BCBEC0) and the Late Iron Age number cells (fill="none", ~45.5 wide).
// Per the AST header the gated middle regions are Early Bronze | Late Bronze |
// Early Iron, laid out as grey1 | gap | grey2; Stone is before grey1; Late Iron
// is the numbered cells (its threshold values read separately); FINISH follows.
import { readFileSync, writeFileSync } from 'node:fs';

const X0 = 187.817, CW = (913.817 - 187.817) / 16;
const space = (x) => Math.round((x - X0) / CW);

// Late Iron Age thresholds read from the rendered strips (point value to enter
// each LIA space, §33.25).
const THRESHOLDS = {
  africa: [1300, 1600], asia: [1200, 1500, 1800], assyria: [1500, 1800], babylon: [1600, 1900],
  crete: [1300, 1600], egypt: [1300, 1600, 1900], iberia: [1200], illyria: [1200, 1500, 1800],
  indus: [1100, 1300], italy: [1400, 1700], persia: [1200, 1400], semites: [1100, 1300],
  sumeria: [1100, 1300], thrace: [1200, 1400, 1700],
};

const tracks = {};
for (const civ of Object.keys(THRESHOLDS)) {
  const s = readFileSync(`assets/aststrips/images/ASTstrip-${civ}.svg`, 'utf8');
  const rects = [...s.matchAll(/<rect\b[^>]*>/g)].map((m) => {
    const t = m[0];
    const num = (n) => { const r = new RegExp(n + '="([\\d.]+)"').exec(t); return r ? parseFloat(r[1]) : null; };
    const fill = (/fill="(#[0-9a-fA-F]+)"/.exec(t) || /fill:\s*(#[0-9a-fA-F]+)/.exec(t) || [])[1] || (/fill="none"/.test(t) ? 'none' : null);
    return { x: num('x'), w: num('width'), fill };
  }).filter((r) => r.x != null);
  const grey = rects.filter((r) => r.fill === '#BCBEC0').sort((a, b) => a.x - b.x);
  const lia = rects.filter((r) => r.fill === 'none' && r.w > 40 && r.w < 50).sort((a, b) => a.x - b.x);
  const [g1, g2] = grey;
  const liaCount = lia.length;
  if (liaCount !== THRESHOLDS[civ].length) throw new Error(`${civ}: ${liaCount} LIA cells but ${THRESHOLDS[civ].length} thresholds`);
  tracks[civ] = {
    spaces: 16, finishSpace: 16, pointsPerSpace: 100,
    epochStart: {
      stone: 1,
      earlyBronze: space(g1.x),
      lateBronze: space(g1.x) + Math.round(g1.w / CW),
      earlyIron: space(g2.x),
      lateIron: 16 - liaCount, // numbered cells run from here to space 15; finish = 16
    },
    lateIronThresholds: THRESHOLDS[civ],
  };
}

// Cross-check against the official 1995 computer version (its AST screen): Africa,
// Illyria and Thrace match the strips exactly, validating the extraction. Iberia
// is the one disagreement — the computer game gives Iberia Italy's track
// (1400/1700), consistent with Iberia replacing Italy on the West map, whereas the
// fan VASSAL `iberia` strip shows a lone 1200 (an outlier). We follow the official
// game and equate Iberia with Italy. (To use the VASSAL strip instead, delete this.)
tracks.iberia = JSON.parse(JSON.stringify(tracks.italy));

const ast = JSON.parse(readFileSync('src/data/ast.json', 'utf8'));
const doc = ast.tracksByCiv._doc;
ast.tracksByCiv = { _doc: doc, ...tracks };
writeFileSync('src/data/ast.json', JSON.stringify(ast, null, 2) + '\n');
console.log('wrote tracksByCiv for', Object.keys(tracks).length, 'nations');
for (const [c, t] of Object.entries(tracks)) console.log(' ', c, JSON.stringify(t.epochStart), t.lateIronThresholds);
