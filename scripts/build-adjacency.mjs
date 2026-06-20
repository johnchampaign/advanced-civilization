// Compute area adjacency from polygon shared edges, per board, using the
// framework's geo helper. Cross-board seams (western|main|eastern tile
// horizontally) are added as curated links afterward.
import { readFileSync, writeFileSync } from 'node:fs';
import { adjacencyFromPolygons, toPolygon } from 'digital-boardgame-framework';

const areas = JSON.parse(readFileSync('src/data/areas.json', 'utf8'));
const byId = new Map(areas.map((a) => [a.id, a]));

// Group polygons by board.
const boards = {};
for (const a of areas) {
  if (!a.path || a.path.length < 3) continue;
  (boards[a.board] ??= {})[a.id] = toPolygon(a.path);
}

const edges = new Set();
const addEdge = (a, b) => {
  if (a === b) return;
  edges.add([a, b].sort().join('|'));
};

for (const [board, polys] of Object.entries(boards)) {
  const result = adjacencyFromPolygons(polys, 6);
  for (const [a, b] of result) addEdge(a, b);
  console.error(`${board}: ${Object.keys(polys).length} polys -> ${result.length} edges`);
}

// Stitch the panels: areas that share a NAME across boards are the same physical
// area reprinted on the overlapping panel edges (the "dotted dividing line",
// rules §16). Link them and union their neighbourhoods so the three panels form
// one connected graph (rules §4.3: a boundary line between two areas makes them
// adjacent, and these seam areas border areas on both panels).
const byName = {};
for (const a of areas) (byName[a.name] ??= []).push(a.id);
let seamGroups = 0;
for (const [name, ids] of Object.entries(byName)) {
  if (ids.length < 2) continue;
  seamGroups++;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) addEdge(ids[i], ids[j]);
}

const adjacency = {};
for (const a of areas) adjacency[a.id] = [];
for (const key of edges) {
  const [a, b] = key.split('|');
  adjacency[a].push(b);
  adjacency[b].push(a);
}
// Union neighbourhoods within each seam group so each twin reaches both panels.
for (const ids of Object.values(byName)) {
  if (ids.length < 2) continue;
  const union = new Set();
  for (const id of ids) for (const n of adjacency[id]) union.add(n);
  for (const id of ids) { for (const n of union) if (n !== id) adjacency[id].push(n); for (const o of ids) if (o !== id) adjacency[id].push(o); }
}
for (const k of Object.keys(adjacency)) adjacency[k] = [...new Set(adjacency[k])].sort();

// Connectivity check: how many connected components, and are all panels joined?
function components() {
  const seen = new Set(); let comps = 0; let biggest = 0;
  for (const a of areas) {
    if (seen.has(a.id)) continue;
    comps++; let size = 0; const stack = [a.id];
    while (stack.length) { const x = stack.pop(); if (seen.has(x)) continue; seen.add(x); size++; for (const n of adjacency[x]) if (!seen.has(n)) stack.push(n); }
    biggest = Math.max(biggest, size);
  }
  return { comps, biggest };
}
const { comps, biggest } = components();
const counts = Object.values(adjacency).map((v) => v.length);
const isolated = Object.entries(adjacency).filter(([, v]) => v.length === 0).map(([k]) => byId.get(k)?.name);
writeFileSync('src/data/adjacency.json', JSON.stringify(adjacency, null, 1));
console.error(`wrote adjacency.json: ${edges.size} undirected edges; ${seamGroups} seam groups stitched`);
console.error(`  degree min/avg/max: ${Math.min(...counts)}/${(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1)}/${Math.max(...counts)}`);
console.error(`  connected components: ${comps} (largest covers ${biggest}/${areas.length} areas)`);
console.error(`  isolated areas (${isolated.length}):`, isolated.slice(0, 30));
