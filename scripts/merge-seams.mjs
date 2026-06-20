// Stitch the three map panels into one connected map by MERGING the overlap
// areas the panels share. Each boundary area is reprinted on the adjacent panel
// (same name, separate coordinate space) — e.g. Etruria on Western+Main, Susa on
// Main+Eastern (the Eastern copy is a sustains-0 sliver). We pick one canonical
// record per name (the fullest land version), drop the duplicates, remap every
// reference (adjacency, civ start areas) to the canonical id, and recompute
// adjacency across the now-unified area set. Supersedes build-adjacency.mjs for
// the full (multi-panel) map. Outputs: areas.json, adjacency.json, civilizations.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { adjacencyFromPolygons, toPolygon } from 'digital-boardgame-framework';

const areas = JSON.parse(readFileSync('src/data/areas.json', 'utf8'));
const civData = JSON.parse(readFileSync('src/data/civilizations.json', 'utf8'));

// Group by name; choose a canonical record per group.
const boardRank = { main: 0, western: 1, eastern: 2 };
const groups = {};
for (const a of areas) (groups[a.name] ??= []).push(a);

const alias = {};      // duplicate id -> canonical id
const canonicalIds = new Set();
const merged = [];
for (const [name, recs] of Object.entries(groups)) {
  // Canonical = highest sustains, then prefer main panel.
  const canon = [...recs].sort((a, b) => (b.sustains - a.sustains) || (boardRank[a.board] - boardRank[b.board]))[0];
  canonicalIds.add(canon.id);
  // Fold the twins' data into the canonical (so it's the full land area).
  const folded = { ...canon };
  folded.sustains = Math.max(...recs.map((r) => r.sustains));
  folded.isWater = folded.sustains === 0;
  folded.isCitySite = recs.some((r) => r.isCitySite);
  folded.isFloodplain = recs.some((r) => r.isFloodplain);
  folded.isOpenSea = recs.some((r) => r.isOpenSea);
  folded.isVolcanoSite = recs.some((r) => r.isVolcanoSite);
  folded.startRegion = recs.map((r) => r.startRegion).find(Boolean) ?? null;
  merged.push(folded);
  for (const r of recs) if (r.id !== canon.id) alias[r.id] = canon.id;
}
const canon = (id) => alias[id] ?? id;

// Recompute adjacency per board from polygons, remapping ids to canonical.
const byBoard = {};
for (const a of areas) { if (a.path?.length >= 3) (byBoard[a.board] ??= {})[a.id] = toPolygon(a.path); }
const edges = new Set();
for (const polys of Object.values(byBoard)) {
  for (const [a, b] of adjacencyFromPolygons(polys, 6)) {
    const [x, y] = [canon(a), canon(b)];
    if (x !== y) edges.add([x, y].sort().join('|'));
  }
}
const adjacency = {};
for (const a of merged) adjacency[a.id] = [];
for (const key of edges) { const [a, b] = key.split('|'); adjacency[a].push(b); adjacency[b].push(a); }
for (const k of Object.keys(adjacency)) adjacency[k] = [...new Set(adjacency[k])].sort();

// Remap civilization start areas through the alias.
for (const c of civData.civilizations) {
  c.start = canon(c.start);
  if (c.startAreas) c.startAreas = [...new Set(c.startAreas.map(canon))];
}

// Connectivity check.
const seen = new Set(); let comps = 0, biggest = 0;
for (const a of merged) {
  if (seen.has(a.id)) continue;
  comps++; let size = 0; const st = [a.id];
  while (st.length) { const x = st.pop(); if (seen.has(x)) continue; seen.add(x); size++; for (const n of adjacency[x]) if (!seen.has(n)) st.push(n); }
  biggest = Math.max(biggest, size);
}

merged.sort((a, b) => (boardRank[a.board] - boardRank[b.board]) || a.name.localeCompare(b.name));
writeFileSync('src/data/areas.json', JSON.stringify(merged, null, 1));
writeFileSync('src/data/adjacency.json', JSON.stringify(adjacency, null, 1));
writeFileSync('src/data/civilizations.json', JSON.stringify(civData, null, 1));
const deg = Object.values(adjacency).map((v) => v.length);
console.error(`merged ${areas.length} -> ${merged.length} areas (${Object.keys(alias).length} seam duplicates folded)`);
console.error(`  ${edges.size} edges; degree min/avg/max ${Math.min(...deg)}/${(deg.reduce((a, b) => a + b, 0) / deg.length).toFixed(1)}/${Math.max(...deg)}`);
console.error(`  connected components: ${comps} (largest ${biggest}/${merged.length})`);
