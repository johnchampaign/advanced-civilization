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
// Curated removals: land areas whose polygons touch only across a sea coastline
// (the extractor over-connects them). They must be crossed by ship via the sea
// area instead. Both stay reachable by land through other neighbours.
const REMOVE_EDGES = [
  ['ptolemais', 'sinai'],   // separated by the Red Sea (report 7ff3c698)
  ['ptolemais', 'midian'],  // separated by the Red Sea
  ['midian', 'sinai'],      // separated by the Gulf of Aqaba (report b9914628); still land-linked via Petra
  // Crete is an island (§23.3; GitHub issue #1, itowlson): population must embark
  // to leave it. Its land areas (knossos, phaestos) were over-connected across the
  // Aegean/Mediterranean to the mainland and neighbouring islands. Internal border
  // knossos↔phaestos is kept; all off-island land edges are cut (reach by ship).
  // These borders run through water, not open sea (a ship or Barbarians, §30.5233,
  // cross them directly; checked against the board art 2026-09-28).
  ['knossos', 'rhodes'],    // all-water border (Karpathian strait)
  ['knossos', 'thera'],     // all-water border (Thera's south line is Crete's north)
  ['phaestos', 'argos'],    // all-water border (to mainland Greece)
  ['phaestos', 'sparta'],   // all-water border (to mainland Greece)
  ['phaestos', 'thera'],    // all-water border
  // Remaining Mediterranean islands (§23.3; owner-confirmed against the board).
  // Each keeps its internal land borders; every off-island land edge is all-water
  // (reach only by ship). Groups: Cyprus{cyprus,salamis}, Corsica{corsica-2},
  // Sardinia{sardinia-2,carales-2}, Baleares{baleares,ebusus}, Rhodes, Thera,
  // Lesbos, Sicily{syracus,milazzo,palermo}.
  ['cyprus', 'galatia'], ['cyprus', 'lycia'],
  ['salamis', 'antiochia'], ['salamis', 'galatia'], ['salamis', 'phoenicia'],
  ['corsica-2', 'etruria-2'], ['corsica-2', 'massilia'], ['corsica-2', 'roma'],
  ['corsica-2', 'sardinia-2'], // Strait of Bonifacio (island↔island)
  ['baleares', 'iberus'], ['baleares', 'new-carthage'],
  ['rhodes', 'lycia'], ['rhodes', 'miletus'],
  ['thera', 'argos'], ['thera', 'athens'], ['thera', 'eretria'],
  ['lesbos', 'ionia'], ['lesbos', 'sardes'], ['lesbos', 'troy'],
  // Lemnos is an island in the middle of its area: every border runs through water
  // (checked against the board art 2026-09-28). Ship/Barbarian crossings only.
  ['lemnos', 'bycantinum'], ['lemnos', 'thessalonica'], ['lemnos', 'thrace'], ['lemnos', 'troy'],
  // Whole-map audit 2026-09-28: every land link was tested against the board art
  // (land on both sides along the shared border, rivers/floodplains counted as
  // land) and each hit confirmed by eye. These borders run only through water.
  // Islands:
  ['ithaka', 'appolonia'], ['ithaka', 'delphi'], ['ithaka', 'epirus'], ['ithaka', 'tarentum'],
  ['londinium', 'lugdunensis'], ['londinium', 'belgica'],            // Britain (English Channel)
  ['baleares', 'ebusus'],                                           // Mallorca and Ibiza are separate islands
  ['mazirah', 'mazun'], ['mazirah', 'wedi-samad'], ['mazirah', 'al-wusta'], // Masirah (al-wusta: a corner out at sea)
  ['tilmun', 'mana'], ['tilmun', 'gerrha'],                         // Bahrain (Gerrha's border hugs the coast offshore)
  // Straits and gulfs:
  ['appolonia', 'tarentum'],       // Strait of Otranto
  ['belgica', 'lugdunensis'],      // a bay; still joined overland via other areas
  ['crimea', 'danube'], ['caucasus', 'media'], ['antiochia', 'galatia'], ['banda-abbas', 'ummannar'], // Black Sea, Caspian, Gulf of Iskenderun, Hormuz
  // The only land links between Europe and Asia/Africa — all water on the art, so
  // cut on the owner's decision (2026-09-28). Europe is now reached by ship: each
  // is a single hop.
  ['corduba', 'west-mauretania'],  // Strait of Gibraltar
  ['bycantinum', 'troy'],          // Dardanelles / Sea of Marmara
  ['kuban', 'scythia'],            // Sea of Azov (the board edge cuts off any land route north)
  // Corner sweep 2026-09-28: these pairs meet only at a single point where four
  // borders cross (checked at high zoom on the art), so no boundary line divides
  // them (§4.31, §23.3) — same as Gulashkird|Pasagardes above.
  ['al-gharbia', 'ash-sharqija'], ['abu-dhabi', 'bat'], ['ash-sharqija', 'ummannar'],
  ['ash-sharqija', 'hadramaut'], ['moscha', 'rub-al-khali'], ['al-wusta', 'ash-sharqija'],
  ['arabia', 'mana'], ['gerrha', 'rub-al-khali'],
  ['artacona', 'randamar'], ['carmania', 'nurabad'], ['carmania', 'persepolis'],
  ['kurangan', 'pasagardes'], ['harmoza', 'pura'], ['gulashkird', 'megan'],
  ['lyan', 'shiraz'], ['nurabad', 'parsian'], ['harmoza', 'ummannar'],
  ['palermo', 'carthago'],   // Sicilian channel to Africa
  ['syracus', 'campania'], ['milazzo', 'campania'], // Strait of Messina — ship-only in AC
  // Euboea{chalkis,eretria} is an island on the board (report d4cb0ffe): the
  // Euripus / Gulf of Euboea is water, so it is left only by ship.
  ['chalkis', 'athens'], ['chalkis', 'delphi'], ['chalkis', 'thessaly'], ['chalkis', 'thessalonica'],
  ['eretria', 'athens'],
  // Four-corner crossings: these pairs meet only at a single point where four
  // borders cross, so no boundary line divides them (§4.31, §23.3). Report fe47506e.
  ['gulashkird', 'pasagardes'], ['carmania', 'kerman'],
  // Kerch Strait: Crimea's land ends short of its border with Kuban, which runs
  // entirely through water — a ship crossing, not a land route (report c5f03706).
  ['crimea', 'kuban'],
];
for (const [a, b] of REMOVE_EDGES) {
  if (adjacency[a]) adjacency[a] = adjacency[a].filter((x) => x !== b);
  if (adjacency[b]) adjacency[b] = adjacency[b].filter((x) => x !== a);
}
// Curated additions: coastal↔sea edges the geometric extractor missed because the
// polygons don't quite touch (gap > tolerance), causing a false embark-lock.
// Owner-confirmed against the board (GitHub issue #1).
const ADD_EDGES = [
  ['phaestos', 'aegean-sea'], // Crete's south coast reaches the navigable Aegean to its N (63px gap missed); embark w/o Astronomy
];
for (const [a, b] of ADD_EDGES) {
  if (adjacency[a] && !adjacency[a].includes(b)) adjacency[a].push(b);
  if (adjacency[b] && !adjacency[b].includes(a)) adjacency[b].push(a);
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
