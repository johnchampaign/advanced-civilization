// build-ship-edges (ship-model phase 1) — the RAW §23.52 ship-move graph.
// A ship hops AREA to AREA; each hop must cross a water boundary. So an edge
// exists between two base-adjacent areas iff the shared border includes water:
//   - water ↔ water: always (the boundary is wet by definition).
//   - land ↔ water / land ↔ land: some sea sub-area of one side comes within
//     tolerance of a sea sub-area (or the water polygon) of the other, ACROSS
//     the border — exactly what water-graph.json's sub-adjacency already
//     computed from the traced coastline polygons.
// Each edge records WHICH coastline sub the crossing uses on each side — a
// ship in a two-coastline area (§23.57) must leave by the side it entered.
//
// Sides: null = the area's single/whole waterfront (water areas; coasts with no
// extracted sea sub, e.g. Thyras whose entire shore faces the Black Sea).
// PLUS: the printed board draws some borders entirely THROUGH water (straits,
// island chains — carthago|palermo, milazzo|campania, knossos|rhodes...). The
// base adjacency deliberately omits those so land tokens can't walk across
// water; for ships they are exactly the crossable water boundaries, so they are
// detected here from polygon contact (territories are a full partition) and
// added as ship edges.
// Run AFTER build-coasts + build-water-graph. Emits src/data/ship-edges.json.
import fs from 'fs';
import { adjacencyFromPolygons, toPolygon } from 'digital-boardgame-framework';

const areas = JSON.parse(fs.readFileSync('src/data/areas.json', 'utf8')).filter((a) => !a.coastalWater);
const adjacency = JSON.parse(fs.readFileSync('src/data/adjacency.prewater-backup.json', 'utf8'));
const coast = JSON.parse(fs.readFileSync('src/data/coastlines.json', 'utf8'));
const graph = JSON.parse(fs.readFileSync('src/data/water-graph.json', 'utf8'));
const byId = new Map(areas.map((a) => [a.id, a]));

// sea subs per area id (from the traced coastlines; openSea/water areas have one)
const seaSubs = new Map(); // areaId -> [subId]
for (const t of coast.territories) {
  if (!t.name || !byId.has(t.name)) continue;
  const subs = t.sub.filter((s) => s.kind === 'sea').map((s) => s.subId);
  if (subs.length) seaSubs.set(t.name, subs);
}
const subArea = (subId) => subId.split('#')[0]; // subId prefix is the territory/area name

// sub-level water adjacency from the water graph: subId -> Set(subId)
const subAdj = new Map();
for (const [a, nbrs] of Object.entries(graph.adjacency)) subAdj.set(a, new Set(nbrs));
const subsTouch = (sa, sb) => subAdj.get(sa)?.has(sb) ?? false;

// Owner corrections (see ur-thyras-shiraz memory): coasts whose shore water was
// traced into a NEIGHBOUR's polygon. Same list as build-water-areas MANUAL_EMBARK:
// the crossing uses the neighbour's sub on the neighbour side, none on ours.
const MANUAL = { ur: ['charax#sea1', 'susa#sea2', 'chaldaea#sea1'] };

const edges = [];
const seen = new Set();
const addEdge = (a, b, aSide, bSide) => {
  const k = a < b ? `${a}|${b}` : `${b}|${a}`;
  if (seen.has(k)) return; seen.add(k);
  edges.push(a < b ? { a, b, aSide, bSide } : { a: b, b: a, aSide: bSide, bSide: aSide });
};

for (const [a, nbrs] of Object.entries(adjacency)) {
  const A = byId.get(a); if (!A) continue;
  for (const b of nbrs) {
    const B = byId.get(b); if (!B || a >= b) continue; // each pair once
    if (A.isWater && B.isWater) { addEdge(a, b, null, null); continue; }
    // find a touching (seaSubOfA, seaSubOfB) pair across the border
    const subsA = seaSubs.get(a) ?? [];
    const subsB = seaSubs.get(b) ?? [];
    let hit = null;
    for (const sa of subsA) { for (const sb of subsB) if (subsTouch(sa, sb)) { hit = [sa, sb]; break; } if (hit) break; }
    if (hit) { addEdge(a, b, sideOf(a, hit[0]), sideOf(b, hit[1])); continue; }
    // land↔water: bordering a sea IS a water boundary — always crossable, even
    // when coast extraction found no touching sub (tolerance gaps caused the
    // original Phaestos embark-lock; the printed adjacency is authoritative).
    if (A.isWater !== B.isWater) addEdge(a, b, null, null);
    // land↔land with no touching sea subs: an all-land border. Not a ship edge.
  }
}
// Printed borders drawn entirely through water: polygon-touching pairs ABSENT
// from base adjacency (which omits them so land tokens can't cross). These are
// ship crossings (§23.52). Sides from touching subs where the coast data has them.
const terr = JSON.parse(fs.readFileSync('src/data/territories.json', 'utf8'));
const polys = {};
for (const r of terr.regions) { if (r.name && byId.has(r.name)) polys[r.name] = toPolygon(r.exterior); }
let waterBorders = 0;
for (const [a, b] of adjacencyFromPolygons(polys, 4)) {
  if ((adjacency[a] ?? []).includes(b)) continue; // base-adjacent: handled above
  const subsA = seaSubs.get(a) ?? [], subsB = seaSubs.get(b) ?? [];
  let hit = null;
  for (const sa of subsA) { for (const sb of subsB) if (subsTouch(sa, sb)) { hit = [sa, sb]; break; } if (hit) break; }
  addEdge(a, b, hit ? sideOf(a, hit[0]) : null, hit ? sideOf(b, hit[1]) : null);
  waterBorders++;
}
// manual coastal corrections: ur's shore water lives in neighbour polygons
for (const [land, subs] of Object.entries(MANUAL)) {
  for (const s of subs) { const nb = subArea(s); if (byId.has(land) && byId.has(nb)) addEdge(land, nb, null, sideOf(nb, s)); }
}

/** Side label: null when the area has ≤1 sea sub (no §23.57 ambiguity). */
function sideOf(areaId, subId) {
  return (seaSubs.get(areaId)?.length ?? 0) > 1 ? subId : null;
}

edges.sort((e, f) => e.a.localeCompare(f.a) || e.b.localeCompare(f.b));
fs.writeFileSync('src/data/ship-edges.json', JSON.stringify({
  _meta: { note: 'RAW §23.52 ship-move graph (scripts/build-ship-edges.mjs). Edge = base-adjacent areas whose shared border includes water; a ship hop crosses one edge. aSide/bSide = coastline sub used for the crossing (§23.57), null when unambiguous.' },
  edges,
}, null, 0));

// ---- report ----
const deg = new Map();
for (const e of edges) { deg.set(e.a, (deg.get(e.a) ?? 0) + 1); deg.set(e.b, (deg.get(e.b) ?? 0) + 1); }
const coastalLands = areas.filter((a) => !a.isWater && (adjacency[a.id] ?? []).some((n) => byId.get(n)?.isWater || edges.some((e) => (e.a === a.id && e.b === n) || (e.b === a.id && e.a === n))));
console.log(`ship edges: ${edges.length}  (water-water ${edges.filter((e) => byId.get(e.a).isWater && byId.get(e.b).isWater).length}, land-water ${edges.filter((e) => byId.get(e.a).isWater !== byId.get(e.b).isWater).length}, land-land coastal ${edges.filter((e) => !byId.get(e.a).isWater && !byId.get(e.b).isWater).length}; incl. ${waterBorders} all-water printed borders)`);
console.log(`areas with ship access: ${deg.size} of ${areas.length}`);
console.log(`edges with a §23.57 side restriction: ${edges.filter((e) => e.aSide || e.bSide).length}`);
// the reporter's route + earlier trouble spots
const has = (a, b) => edges.some((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
for (const [a, b] of [['thapsus', 'carthago'], ['carthago', 'palermo'], ['palermo', 'milazzo'], ['milazzo', 'campania'], ['galatia', 'cilicia'], ['ur', 'charax'], ['thyras', 'black-sea'], ['phaestos', 'aegean-sea'], ['babylon', 'ur']]) {
  console.log(`  ${a} <-> ${b}: ${has(a, b) ? 'SHIP EDGE' : 'no'}`);
}
console.log('wrote src/data/ship-edges.json');
