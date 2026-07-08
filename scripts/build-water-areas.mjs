// build-water-areas (part 2, step 2) — turn each coastal-water sub-area into a
// real water area and wire the water-graph into adjacency, so the engine's naval
// logic (isCoastal / navalDestinations / embark) routes ships through coastal
// water. ADDITIVE: existing areas + edges are untouched, so a coastal land keeps
// any sea edge it already had AND gains its own coastal water — previously
// stranded coasts (Galatia, Scythia) become embarkable.
//
// Coastal-water areas are flagged `coastalWater:true` so the UI can fold them into
// their parent territory instead of drawing a separate clickable cell.
// Run AFTER build-coasts + build-water-graph. Regenerates areas.json + adjacency.json.
import fs from 'fs';

const areas = JSON.parse(fs.readFileSync('src/data/areas.json', 'utf8'));
// Seed from the pristine pre-water adjacency so re-runs are idempotent (never
// compound on our own previously-added water edges / stale dropped-area refs).
const adjacency = JSON.parse(fs.readFileSync('src/data/adjacency.prewater-backup.json', 'utf8'));
const coast = JSON.parse(fs.readFileSync('src/data/coastlines.json', 'utf8'));
const graph = JSON.parse(fs.readFileSync('src/data/water-graph.json', 'utf8'));
const areaById = new Map(areas.map((a) => [a.id, a]));

// strip previously-generated coastal-water areas so this is idempotent
const baseAreas = areas.filter((a) => !a.coastalWater);
const baseById = new Map(baseAreas.map((a) => [a.id, a]));

// map each SEA sub-area -> the area id ships occupy there
const subToArea = new Map();
const newAreas = [];
for (const t of coast.territories) {
  const area = t.name ? baseById.get(t.name) : undefined;
  for (const s of t.sub) { if (s.kind !== 'sea') continue;
    if (area && area.isWater) { subToArea.set(s.subId, area.id); continue; } // existing open/named sea
    if (!area) continue; // unnamed territory: no land area to embark from -> skip (would strand)
    // coastal water inside a land territory -> new water area (embarkable from its land)
    subToArea.set(s.subId, s.subId);
    newAreas.push({ id: s.subId, name: `${t.name ?? t.id} coastal water`, board: area.board, sustains: 0, isWater: true, isCitySite: false, isFloodplain: false, isOpenSea: false, isVolcanoSite: false, startRegion: null, coastalWater: true, parent: area.id, path: s.exterior.map(([x, y]) => [Math.round(x), Math.round(y)]), flags: {} });
  }
}

const outAreas = [...baseAreas, ...newAreas];
// rebuild adjacency: keep base edges, ensure every id present, then add water edges
const adj = {};
for (const a of outAreas) adj[a.id] = new Set(adjacency[a.id] ?? []);
const add = (a, b) => { if (a === b || !adj[a] || !adj[b]) return; adj[a].add(b); adj[b].add(a); };
let waterEdges = 0, embarkEdges = 0;
for (const [a, nbrs] of Object.entries(graph.adjacency)) for (const b of nbrs) { const aa = subToArea.get(a), bb = subToArea.get(b); if (aa && bb) { const before = adj[aa]?.size; add(aa, bb); if (adj[aa] && adj[aa].size !== before) waterEdges++; } }
for (const [land, subs] of Object.entries(graph.embark)) for (const s of subs) { const w = subToArea.get(s); if (baseById.has(land) && w) { const before = adj[land]?.size; add(land, w); if (adj[land] && adj[land].size !== before) embarkEdges++; } }

const adjOut = {};
for (const k of Object.keys(adj).sort()) adjOut[k] = [...adj[k]].sort();

fs.writeFileSync('src/data/areas.json', JSON.stringify(outAreas));
fs.writeFileSync('src/data/adjacency.json', JSON.stringify(adjOut, null, 1));
console.log(`areas: ${baseAreas.length} base + ${newAreas.length} coastal-water = ${outAreas.length}`);
console.log(`adjacency edges added: ~${waterEdges} water-water, ~${embarkEdges} land-embark`);
// sanity: Galatia / Scythia now have a water neighbour?
for (const id of ['galatia', 'scythia', 'phaestos']) console.log(`  ${id} water neighbours: ${(adjOut[id] || []).filter((n) => baseById.get(n)?.isWater || newAreas.find((x) => x.id === n)).join(', ') || 'NONE'}`);
