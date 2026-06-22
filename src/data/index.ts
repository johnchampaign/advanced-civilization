// Typed loader for the static game data extracted from the VASSAL module and
// the rules. All JSON lives alongside this file; these types describe its shape
// and the named exports give the engine typed, validated access.

import areasRaw from './areas.json' with { type: 'json' };
import adjacencyRaw from './adjacency.json' with { type: 'json' };
import advancesRaw from './advances.json' with { type: 'json' };
import commoditiesRaw from './commodities.json' with { type: 'json' };
import calamitiesRaw from './calamities.json' with { type: 'json' };
import civilizationsRaw from './civilizations.json' with { type: 'json' };
import astRaw from './ast.json' with { type: 'json' };

export type Board = 'western' | 'main' | 'eastern';

export interface Area {
  id: string;
  name: string;
  board: Board;
  /** Max population the area supports (0 for water). */
  sustains: number;
  isWater: boolean;
  /** Printed city site: 6 tokens build a city here; 12 elsewhere (§25.2). */
  isCitySite: boolean;
  /** Flood calamity applies here (§30.51). */
  isFloodplain: boolean;
  /** Open sea — crossable only with Astronomy (§32.411). */
  isOpenSea: boolean;
  /** Can be struck by Volcanic Eruption / Earthquake (§30.21). */
  isVolcanoSite: boolean;
  /** If set, a legal opening area for the named nation. */
  startRegion: string | null;
  path: [number, number][];
  flags: Record<string, string>;
}

export type AdvanceGroup = 'Crafts' | 'Arts' | 'Civics' | 'Sciences' | 'Religion';

export interface Advance {
  id: string;
  name: string;
  groups: AdvanceGroup[];
  cost: number;
  prerequisites?: string[];
  credits: {
    byGroup: Partial<Record<AdvanceGroup, number>>;
    byCard: Record<string, number>;
  };
}

export interface Commodity {
  id: string;
  name: string;
  stack: number;
  value: number;
  count: number;
}

export interface Calamity {
  id: string;
  name: string;
  level: number;
  tradable: boolean;
  severity: number;
  effect: { kind: string; [k: string]: unknown };
  reducedBy?: string[];
  worsenedBy?: string[];
  nullifiedBy?: string[];
}

export interface Civilization {
  id: string;
  name: string;
  color: string;
  /** Canonical default opening area (first of startAreas). */
  start: string;
  /** All legal opening areas (from VASSAL StartRegion tags). */
  startAreas: string[];
  /** Fixed A.S.T. rank (§17.4): Africa=0 first … Egypt=13 last. Used as the
   *  census tie-breaker and the primary actor order for the phases the rules run
   *  in A.S.T. order (taxation, population expansion, advance acquisition). */
  astOrder: number;
}

export interface Epoch {
  id: string;
  name: string;
  requirements: {
    cities?: number;
    cards?: number;
    cardGroups?: number;
    perSpaceCardValue?: boolean;
  };
}

export const areas: Area[] = areasRaw as Area[];
export const adjacency: Record<string, string[]> = adjacencyRaw as Record<string, string[]>;
export const advances: Advance[] = (advancesRaw as unknown as { advances: Advance[] }).advances;
export const advanceGroups: AdvanceGroup[] = (advancesRaw as unknown as { groups: AdvanceGroup[] }).groups;
export const commodities: Commodity[] = (commoditiesRaw as unknown as { commodities: Commodity[] }).commodities;
export const mineableCommodities: string[] = (commoditiesRaw as { mineableCommodities: string[] }).mineableCommodities;
export const calamities: Calamity[] = (calamitiesRaw as unknown as { calamities: Calamity[] }).calamities;
export const civilizations: Civilization[] = (civilizationsRaw as unknown as { civilizations: Civilization[] }).civilizations;
export const pieceCounts = (civilizationsRaw as { pieceCounts: { tokens: number; cities: number; ships: number } }).pieceCounts;
export const epochs: Epoch[] = (astRaw as { epochs: Epoch[] }).epochs;
export interface AstTrack {
  spaces: number;
  finishSpace: number;
  pointsPerSpace: number;
  epochStart: Record<string, number>;
  /** Civ-card point value required to enter each successive Late Iron Age space
   *  (§33.25); its length = number of LIA spaces. */
  lateIronThresholds?: number[];
}
export const astTrack: AstTrack = (astRaw as unknown as { track: AstTrack }).track;
export const astTracksByCiv: Record<string, AstTrack> = (astRaw as unknown as { tracksByCiv: Record<string, AstTrack> }).tracksByCiv ?? {};
export const victoryScoring = (astRaw as { victoryScoring: { pointsPerAstSpace: number; pointsPerCity: number } }).victoryScoring;

/** The AST track a nation uses (per-civ override, else the shared board track). */
export function astTrackFor(civId: string): AstTrack {
  return astTracksByCiv[civId] ?? astTrack;
}

// Indexed lookups.
export const areaById = new Map(areas.map((a) => [a.id, a]));
export const advanceById = new Map(advances.map((a) => [a.id, a]));
export const commodityById = new Map(commodities.map((c) => [c.id, c]));
export const calamityById = new Map(calamities.map((c) => [c.id, c]));
export const civById = new Map(civilizations.map((c) => [c.id, c]));

/** Validate cross-references at load; returns a list of problems (empty = ok). */
export function validateData(): string[] {
  const problems: string[] = [];
  for (const [id, nbrs] of Object.entries(adjacency)) {
    if (!areaById.has(id)) problems.push(`adjacency references unknown area ${id}`);
    for (const n of nbrs) if (!areaById.has(n)) problems.push(`adjacency ${id} -> unknown ${n}`);
  }
  for (const c of civilizations) {
    if (!areaById.has(c.start)) problems.push(`civ ${c.id} start area '${c.start}' not found`);
    if (!c.startAreas.includes(c.start)) problems.push(`civ ${c.id} start '${c.start}' not in startAreas`);
    for (const sa of c.startAreas) {
      const area = areaById.get(sa);
      if (!area) problems.push(`civ ${c.id} startArea '${sa}' not found`);
      else if (!area.startRegion) problems.push(`civ ${c.id} startArea '${sa}' is not a StartRegion zone`);
    }
  }
  for (const a of advances) {
    for (const p of a.prerequisites ?? []) if (!advanceById.has(p)) problems.push(`advance ${a.id} prereq ${p} unknown`);
    for (const card of Object.keys(a.credits.byCard)) if (!advanceById.has(card)) problems.push(`advance ${a.id} credit -> unknown ${card}`);
  }
  // §17.4: every nation has a unique A.S.T. rank forming a 0..n-1 sequence.
  const ranks = civilizations.map((c) => c.astOrder).sort((x, y) => x - y);
  ranks.forEach((r, i) => { if (r !== i) problems.push(`civ astOrder not a 0..n-1 permutation (got ${r} at position ${i})`); });
  return problems;
}
