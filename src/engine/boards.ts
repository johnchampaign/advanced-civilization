// Rules §16 — THE NUMBER OF PLAYERS: board configurations, per-player token
// counts, and nation availability. Pure functions over the derived play-area
// data (src/data/playAreas.json); the engine stores a BoardConfig on GameState
// and consults these to decide what is in play.

import {
  areaById,
  areas,
  civilizations,
  playAreas,
  type CropKey,
} from '../data/index.js';

/** A §16 board configuration. The main board is always present, minus the
 *  union of `crops`; the western/eastern extension boards toggle whole. */
export interface BoardConfig {
  /** Western Extension Mapboard in play (§16.2-16.6). */
  west: boolean;
  /** Eastern extension board in play (not part of rules §16 — a house toggle
   *  for the module's eastern map and its nations). */
  east: boolean;
  /** Main-board regions OUT of play (unioned — §16.5's five-player game drops
   *  a panel from each end). */
  crops: CropKey[];
  /** §16.8 (two players): city sites on islands are disregarded — 12 tokens
   *  build a city there. */
  disregardIslandCitySites?: boolean;
  /** Explicit nation allow-list where §16 names one (2-4 players). Nations
   *  must ALSO have an in-play start area (§16.12) regardless. */
  nations?: string[];
}

/** The pre-§16 behavior (and the fallback for older saved games): the whole
 *  stitched map, every nation, 55 tokens. */
export const FULL_BOARD: BoardConfig = { west: true, east: true, crops: [] };

export interface BoardPreset {
  id: string;
  /** Short label for the setup UI. */
  label: string;
  /** Which §16 clause this implements (or 'house' for the full-map variant). */
  rule: string;
  config: BoardConfig;
  /** Tokens each player uses (§16.2-16.8: 47 or 55). */
  tokensPerPlayer: number;
}

const RAW_2P_NATIONS = ['italy', 'africa', 'illyria', 'thrace'];
const RAW_3P_NATIONS = ['italy', 'africa', 'illyria', 'thrace', 'crete'];
const RAW_4P_EAST_NATIONS = ['egypt', 'babylon', 'assyria', 'asia'];
// §16.6 prints "Italy" for the four-player Western-Extension scenario, but the
// extension's own rules put the red player-race in Iberia when its map is in
// play (see the note on availableNations) — so the list fields Iberia.
const RAW_4P_WEST_NATIONS = ['iberia', 'africa', 'illyria', 'thrace', 'crete'];

/** Every §16-legal board configuration for a player count, first = the
 *  default, plus the full-map house variant (always last). */
export function boardPresets(numPlayers: number): BoardPreset[] {
  const raw: BoardPreset[] = [];
  const p = (id: string, label: string, rule: string, tokensPerPlayer: number, config: BoardConfig) =>
    raw.push({ id, label, rule, tokensPerPlayer, config });
  switch (numPlayers) {
    case 2:
      p('raw-2p', 'Middle panels (west of the dotted line)', '§16.8', 55,
        { west: false, east: false, crops: ['eastOfDotted'], disregardIslandCitySites: true, nations: RAW_2P_NATIONS });
      break;
    case 3:
      p('raw-3p', 'Middle panels (west of the dotted line)', '§16.7', 47,
        { west: false, east: false, crops: ['eastOfDotted'], nations: RAW_3P_NATIONS });
      break;
    case 4:
      p('raw-4p-east', 'Eastern panels (east of the dotted line)', '§16.6', 55,
        { west: false, east: false, crops: ['westOfDotted'], nations: RAW_4P_EAST_NATIONS });
      p('raw-4p-west', 'Western portion + Western Extension', '§16.6', 55,
        { west: true, east: false, crops: ['eastOfDotted'], nations: RAW_4P_WEST_NATIONS });
      break;
    case 5:
      p('raw-5p-east', 'Panels 2-4', '§16.5', 47, { west: false, east: false, crops: ['panel1'] });
      p('raw-5p-mid', 'Panels 1-3', '§16.5', 47, { west: false, east: false, crops: ['panel4'] });
      p('raw-5p-west', 'Western Extension + panels 1-2', '§16.5', 47, { west: true, east: false, crops: ['panel34'] });
      break;
    case 6:
      p('raw-6p', 'All four main panels', '§16.4', 55, { west: false, east: false, crops: [] });
      p('raw-6p-west', 'Western Extension + panels 1-3', '§16.4', 55, { west: true, east: false, crops: ['panel4'] });
      break;
    case 7:
      p('raw-7p', 'All panels + Western Extension', '§16.3', 55, { west: true, east: false, crops: [] });
      break;
    case 8:
      p('raw-8p', 'All panels + Western Extension', '§16.2', 47, { west: true, east: false, crops: [] });
      break;
  }
  raw.push({ id: 'full-map', label: 'Full map (all boards)', rule: 'house', tokensPerPlayer: 55, config: FULL_BOARD });
  return raw;
}

export function boardPreset(numPlayers: number, id: string): BoardPreset | undefined {
  return boardPresets(numPlayers).find((b) => b.id === id);
}

/** The area ids NOT in play under a configuration: dropped extension boards
 *  plus the union of the main-board crops. */
export function outOfPlaySet(cfg: BoardConfig): Set<string> {
  const out = new Set<string>();
  for (const a of areas) {
    if (a.board === 'western' && !cfg.west) out.add(a.id);
    if (a.board === 'eastern' && !cfg.east) out.add(a.id);
  }
  for (const crop of cfg.crops) for (const id of playAreas.outOfPlay[crop] ?? []) out.add(id);
  return out;
}

/** §16.11: does the area count as having a city site under this configuration?
 *  (6 tokens build a city on a site, 12 elsewhere §25.2.) A site is voided if
 *  its printed symbol sits on an out-of-play panel, or — in a two-player game —
 *  if it is on an island (§16.8). */
export function hasCitySite(cfg: BoardConfig | undefined, areaId: string): boolean {
  if (!areaById.get(areaId)?.isCitySite) return false;
  if (!cfg) return true;
  if (cfg.disregardIslandCitySites && playAreas.islandCitySites.includes(areaId)) return false;
  return !cfg.crops.some((c) => (playAreas.suppressedCitySites[c] ?? []).includes(areaId));
}

/** The start areas a nation may open in under a configuration (§16.12: only
 *  in-play ones count; Africa's Western-Extension start is in the module data). */
export function startAreasFor(cfg: BoardConfig, civId: string): string[] {
  const civ = civilizations.find((c) => c.id === civId);
  if (!civ) return [];
  const out = outOfPlaySet(cfg);
  return civ.startAreas.filter((a) => !out.has(a));
}

/** §16.12 + §16.6-16.8: the nations selectable under a configuration — those
 *  §16 names for the player count (when it names any) that still have an
 *  in-play start area.
 *
 *  Italy and Iberia are one player-race, never both in a game: the West
 *  Extension Map's rules state "Iberia now starts from any of the three areas
 *  on the western edge of the peninsula (replacing Italy as a player-race)"
 *  (guide p.2) — they share the physical red pieces and the second A.S.T. row.
 *  So the extension in play fields Iberia and retires Italy; without it Iberia
 *  does not exist (its starts are all on the extension board anyway). This is
 *  also what rules §16.12's "the start areas for Africa and Italy are changed
 *  accordingly" refers to, together with Africa's added Cirta opening. */
export function availableNations(cfg: BoardConfig): string[] {
  return civilizations
    .filter((c) => !cfg.nations || cfg.nations.includes(c.id))
    .filter((c) => startAreasFor(cfg, c.id).length > 0)
    .filter((c) => (cfg.west ? c.id !== 'italy' : c.id !== 'iberia'))
    .map((c) => c.id);
}

/** Why a nation can't be seated under this configuration (undefined = it can).
 *  For setup-screen tooltips. */
export function unavailableReason(cfg: BoardConfig, civId: string): string | undefined {
  if (availableNations(cfg).includes(civId)) return undefined;
  if (civId === 'italy' && cfg.west) return 'Iberia replaces Italy as a player-race when the Western Extension Map is in play';
  if (civId === 'iberia' && !cfg.west) return 'Iberia plays only with the Western Extension Map (it replaces Italy)';
  if (cfg.nations && !cfg.nations.includes(civId)) return 'Not one of the nations §16 names for this player count';
  return 'No start area in play on this board (§16.12)';
}
