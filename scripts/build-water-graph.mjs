// build-water-graph (part 2, step 1) — the coastal-water movement graph. Nodes are
// every SEA sub-area from coastlines.json (open seas + coastal waters); edges join
// two sea sub-areas whose polygons come within tolerance across a territory border.
// Each node is tagged open (needs Astronomy — from areas.json isOpenSea) or free.
// Also records, per land area, the sea sub-areas of ITS OWN territory (embark points).
// Emits src/data/water-graph.json and reports connectivity (does Galatia reach a sea?).
import fs from 'fs';
import { adjacencyFromPolygons, toPolygon } from 'digital-boardgame-framework';

const coast = JSON.parse(fs.readFileSync('src/data/coastlines.json', 'utf8'));
const areas = JSON.parse(fs.readFileSync('src/data/areas.json', 'utf8'));
const areaById = Object.fromEntries(areas.map((a) => [a.id, a]));
const TOL = 10; // px gap across a white territory border that still counts as touching

// nodes: every sea sub-area. openSea (Astronomy) iff its territory's area isOpenSea.
const nodes = [];
const embark = {}; // land areaId -> [seaSubId] of its own territory
for (const t of coast.territories) {
  const area = t.name ? areaById[t.name] : undefined;
  const seas = t.sub.filter((s) => s.kind === 'sea');
  for (const s of seas) nodes.push({ subId: s.subId, territory: t.name ?? String(t.id), open: !!(area && area.isOpenSea), centroid: s.centroid });
  // embark: a land area reaches its own territory's sea sub-areas
  if (area && !area.isWater && seas.length) embark[area.id] = seas.map((s) => s.subId);
}
const polys = {};
for (const t of coast.territories) for (const s of t.sub) if (s.kind === 'sea') polys[s.subId] = toPolygon(s.exterior);

const rawEdges = adjacencyFromPolygons(polys, TOL);
const adj = {}; for (const n of nodes) adj[n.subId] = [];
for (const [a, b] of rawEdges) { if (adj[a] && !adj[a].includes(b)) adj[a].push(b); if (adj[b] && !adj[b].includes(a)) adj[b].push(a); }
for (const k of Object.keys(adj)) adj[k].sort();

fs.writeFileSync('src/data/water-graph.json', JSON.stringify({
  _meta: { note: 'Coastal-water + open-sea movement graph (scripts/build-water-graph.mjs). node.open => needs Astronomy. embark[landAreaId] = sea sub-areas of its own territory.', tol: TOL },
  nodes, adjacency: adj, embark,
}, null, 0));

// ---- report + connectivity checks ----
const byId = Object.fromEntries(nodes.map((n) => [n.subId, n]));
const comp = new Map(); let nc = 0;
for (const n of nodes) { if (comp.has(n.subId)) continue; const id = nc++; const st = [n.subId]; comp.set(n.subId, id);
  while (st.length) { const x = st.pop(); for (const y of adj[x] || []) if (!comp.has(y)) { comp.set(y, id); st.push(y); } } }
const sizes = {}; for (const [, id] of comp) sizes[id] = (sizes[id] || 0) + 1;
const big = Object.entries(sizes).sort((a, b) => b[1] - a[1]);
const isolated = nodes.filter((n) => (adj[n.subId] || []).length === 0);
// does each coastal land reach an open sea?
const reachesOpen = (start) => { const seen = new Set(start); const st = [...start]; while (st.length) { const x = st.pop(); if (byId[x]?.open) return true; for (const y of adj[x] || []) if (!seen.has(y)) { seen.add(y); st.push(y); } } return false; };
let landCanEmbark = 0, landCantReachOpen = [];
for (const [aid, subs] of Object.entries(embark)) { landCanEmbark++; if (!reachesOpen(subs)) landCantReachOpen.push(aid); }
const galatia = embark['galatia'], scythia = embark['scythia'];

console.log(`water nodes (sea sub-areas): ${nodes.length}  (open ${nodes.filter((n) => n.open).length}, free ${nodes.filter((n) => !n.open).length})`);
console.log(`edges: ${rawEdges.length};  connected components: ${nc}  (largest ${big[0]?.[1]}, next ${big.slice(1, 4).map((x) => x[1]).join(',')})`);
console.log(`isolated water nodes (touch nothing): ${isolated.length}  ${isolated.slice(0, 12).map((n) => n.subId).join(', ')}`);
console.log(`land areas with an embark point (own water): ${landCanEmbark}`);
console.log(`  ...that CANNOT reach any open sea via water: ${landCantReachOpen.length}  ${landCantReachOpen.slice(0, 20).join(', ')}`);
console.log(`galatia embark subs: ${galatia?.join(', ') || 'NONE'}  reaches open sea: ${galatia ? reachesOpen(galatia) : 'n/a'}`);
console.log(`scythia embark subs: ${scythia?.join(', ') || 'NONE'}  reaches open sea: ${scythia ? reachesOpen(scythia) : 'n/a'}`);
console.log('wrote src/data/water-graph.json');
