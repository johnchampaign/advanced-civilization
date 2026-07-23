// Pure helper functions for the engine: commodity set scoring, advance-purchase
// credit calculation, adjacency, and turn-order derivation. Kept side-effect
// free so they are straightforward to unit-test.

import {
  advanceById,
  advances as ALL_ADVANCES,
  adjacency,
  areaById,
  calamities as CALAMITIES,
  civById,
  commodities as COMMODITIES,
  commodityById,
  shipNeighbors,
  type AdvanceGroup,
} from '../data/index.js';
import type { GameState, PlayerId, PlayerState } from './types.js';
import { hasCitySite, outOfPlaySet } from './boards.js';

/** Value of a single commodity set of `n` identical cards (rules §28.51):
 *  n^2 * value, with n capped at the printed maximum (the card count). */
export function commoditySetValue(commodityId: string, n: number): number {
  const c = commodityById.get(commodityId);
  if (!c || n <= 0) return 0;
  const capped = Math.min(n, c.count);
  return capped * capped * c.value;
}

/** Total value of a hand of commodity cards: sum of each commodity's set value.
 *  `mining` lets the holder treat one mineable set as one card larger (§32.261);
 *  applied to the single set that gains the most. */
export function handValue(hand: Record<string, number>, opts?: { mining?: boolean }): number {
  let total = 0;
  let bestMiningGain = 0;
  for (const [id, n] of Object.entries(hand)) {
    if (n <= 0) continue;
    total += commoditySetValue(id, n);
    if (opts?.mining) {
      const c = commodityById.get(id);
      if (c && ['iron', 'bronze', 'silver', 'gems', 'gold'].includes(id) && n < c.count) {
        const gain = commoditySetValue(id, n + 1) - commoditySetValue(id, n);
        if (gain > bestMiningGain) bestMiningGain = gain;
      }
    }
  }
  return total + bestMiningGain;
}

/** Credit a player's owned advances provide toward buying `targetId`
 *  (rules §31.5, §32). Sums byGroup credits (per matching group of the target,
 *  excluding self) and byCard credits. */
export function creditTowards(owned: string[], targetId: string): number {
  const target = advanceById.get(targetId);
  if (!target) return 0;
  let credit = 0;
  for (const ownedId of owned) {
    if (ownedId === targetId) continue;
    const a = advanceById.get(ownedId);
    if (!a) continue;
    // byCard: direct named credit.
    if (a.credits.byCard[targetId]) credit += a.credits.byCard[targetId];
    // byGroup: credit applies if target shares that group.
    for (const [group, pts] of Object.entries(a.credits.byGroup)) {
      if (target.groups.includes(group as AdvanceGroup)) {
        credit += pts ?? 0;
        break; // a single owned card credits a target once via group
      }
    }
  }
  return credit;
}

/** Net cost to buy `targetId` after credits (never below 0). */
export function netAdvanceCost(owned: string[], targetId: string): number {
  const a = advanceById.get(targetId);
  if (!a) return Infinity;
  return Math.max(0, a.cost - creditTowards(owned, targetId));
}

/** Distinct AST color-groups represented by a set of owned advances. Cards in
 *  two groups count for both (§31.551 / §33.23). */
export function cardGroupsHeld(owned: string[]): Set<AdvanceGroup> {
  const groups = new Set<AdvanceGroup>();
  for (const id of owned) {
    const a = advanceById.get(id);
    if (!a) continue;
    for (const g of a.groups) groups.add(g);
  }
  return groups;
}

/** Total face value of owned advances (for AST / victory). */
export function advancesFaceValue(owned: string[]): number {
  return owned.reduce((s, id) => s + (advanceById.get(id)?.cost ?? 0), 0);
}

// ---- Play area (§16) ------------------------------------------------------
// A game may use only part of the map (state.board). Out-of-play areas are
// treated as nonexistent: every adjacency helper takes the state and filters
// them, so no movement, naval path, calamity or AI enumeration can reach them.

const EMPTY_SET: ReadonlySet<string> = new Set();
const outCache = new WeakMap<GameState, ReadonlySet<string>>();

/** The area ids out of play for this game (empty for older saves / full map).
 *  Cached per state object — states are cloned on every action. */
export function outOfPlay(s: GameState | null | undefined): ReadonlySet<string> {
  if (!s?.board) return EMPTY_SET;
  let v = outCache.get(s);
  if (!v) { v = outOfPlaySet(s.board); outCache.set(s, v); }
  return v;
}

export function inPlay(s: GameState | null | undefined, areaId: string): boolean {
  return !outOfPlay(s).has(areaId);
}

/** §16.11/§16.8: does the area count as having a city site in this game? */
export function citySiteIn(s: GameState | null | undefined, areaId: string): boolean {
  return hasCitySite(s?.board, areaId);
}

export function neighbors(s: GameState | null | undefined, areaId: string): string[] {
  const out = outOfPlay(s);
  if (out.has(areaId)) return [];
  return (adjacency[areaId] ?? []).filter((n) => !out.has(n));
}

export function landNeighbors(s: GameState | null | undefined, areaId: string): string[] {
  return neighbors(s, areaId).filter((n) => !areaById.get(n)?.isWater);
}

/** Ship-voyage BFS over the §23.52 ship-move graph (data/ship-edges): a ship
 *  hops area-to-area, each hop crossing a border that includes water, entering
 *  up to `range` areas per phase (4, or 5 with Cloth Making §23.53). Open-sea
 *  areas may only be ENTERED with Astronomy (§23.52/.54), and a voyage may
 *  never END on open sea (§23.55). §23.57: a two-coastline area must be left
 *  by the coastline it was entered — BFS states are (area, entry-side).
 *  Returns, for every reachable end area, one shortest legal path (the areas
 *  entered after `start`, in order). */
export function shipReachable(s: GameState | null | undefined, start: string, range: number, astronomy: boolean): Map<string, string[]> {
  const out = outOfPlay(s);
  const found = new Map<string, string[]>();
  if (out.has(start) || !areaById.get(start)) return found;
  // state key: area + entry side (start is unrestricted — a docked ship has no recorded entry)
  const seen = new Set<string>([`${start}|*`]);
  let frontier: { area: string; side: string | null; path: string[] }[] = [{ area: start, side: null, path: [] }];
  for (let depth = 1; depth <= range && frontier.length; depth++) {
    const next: typeof frontier = [];
    for (const cur of frontier) {
      for (const hop of shipNeighbors.get(cur.area) ?? []) {
        // §23.57: leaving cur.area requires the same coastline it was entered by
        // (unrestricted at the voyage start or when either side is unknown).
        if (cur.path.length > 0 && cur.side != null && hop.side != null && hop.side !== cur.side) continue;
        const a = areaById.get(hop.to);
        if (!a || out.has(hop.to)) continue;
        if (a.isOpenSea && !astronomy) continue; // §23.54
        const key = `${hop.to}|${hop.toSide ?? '*'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const path = [...cur.path, hop.to];
        // §23.55: an open-sea area may be transited, never an end point.
        if (!a.isOpenSea && !found.has(hop.to)) found.set(hop.to, path);
        next.push({ area: hop.to, side: hop.toSide, path });
      }
    }
    frontier = next;
  }
  found.delete(start);
  return found;
}

/** Coastal LAND areas a ship at `start` can sail to (§23.5) — the debark
 *  candidates offered as simple one-hop-list ship moves. Water end points
 *  (§23.55 anchoring) are available via voyages, not this list. */
export function navalDestinations(s: GameState | null | undefined, start: string, range: number, astronomy: boolean): Set<string> {
  const dests = new Set<string>();
  for (const [dest] of shipReachable(s, start, range, astronomy)) {
    if (!areaById.get(dest)?.isWater) dests.add(dest);
  }
  return dests;
}

/** Number of cities a player has on the board. */
export function cityCount(state: GameState, player: PlayerId): number {
  let n = 0;
  for (const a of Object.values(state.areas)) if (a.city === player) n++;
  return n;
}

/** Total on-board population (tokens) for a player — the census count. */
export function populationCount(state: GameState, player: PlayerId): number {
  let n = 0;
  for (const a of Object.values(state.areas)) n += a.tokens[player] ?? 0;
  return n;
}

/** Census order: by population descending; ties broken by seating order
 *  (rules: highest census moves/acts first in most phases). */
/** A.S.T. rank of a nation (§17.4): Africa first … Egypt last. Lower acts first. */
export function astRank(id: PlayerId): number {
  return civById.get(id)?.astOrder ?? 99;
}

/** Players in fixed A.S.T. order (§17.4) — the primary order for taxation,
 *  population expansion, and advance acquisition. */
export function astOrder(state: GameState): PlayerId[] {
  return [...state.seating].sort((a, b) => astRank(a) - astRank(b));
}

export function censusOrder(state: GameState): PlayerId[] {
  return [...state.seating].sort((a, b) => {
    const pa = populationCount(state, a);
    const pb = populationCount(state, b);
    if (pa !== pb) return pb - pa;
    return astRank(a) - astRank(b); // §17.4: A.S.T. order breaks census ties
  });
}

/** The player whose turn it is to act in the current phase, or null if every
 *  player in the active order has acted (phase is complete). */
export function actingPlayer(state: GameState): PlayerId | null {
  for (const p of state.activeOrder) {
    if (!state.actedThisPhase.includes(p)) return p;
  }
  return null;
}

/** Count every physical piece a nation controls, wherever it sits. The supply
 *  is fixed (rules §5.1 / §11.1): tokens, cities and ships only move between
 *  stock, treasury and the board — none are ever created or destroyed. Used to
 *  assert conservation in tests and (optionally) at runtime. */
export function pieceCensus(state: GameState, id: PlayerId): { tokens: number; cities: number; ships: number } {
  const p = player(state, id);
  let boardTokens = 0;
  let boardCities = 0;
  let boardShips = 0;
  for (const a of Object.values(state.areas)) {
    boardTokens += a.tokens[id] ?? 0;
    if (a.city === id) boardCities += 1;
    if (a.ships) boardShips += a.ships[id] ?? 0;
  }
  return {
    // Tokens live in stock, treasury, or on the board (each on-board token is one
    // piece; the 6 that form a city have already returned to stock).
    tokens: p.stock + p.treasury + boardTokens,
    cities: p.citiesAvailable + boardCities,
    ships: p.shipsAvailable + boardShips,
  };
}

/** Check the fixed-supply invariant for every nation: tokens, cities and ships
 *  must each always sum (across stock, treasury and the board) to the per-nation
 *  totals in `expected`. Returns a list of violations (empty = conserved). Pure,
 *  so it can be used both as a test assertion and as a runtime self-check. */
export function pieceConservationProblems(
  state: GameState,
  expected: { tokens: number; cities: number; ships: number },
): string[] {
  const problems: string[] = [];
  for (const id of state.seating) {
    const c = pieceCensus(state, id);
    if (c.tokens !== expected.tokens) problems.push(`${id}: ${c.tokens} tokens (expected ${expected.tokens})`);
    if (c.cities !== expected.cities) problems.push(`${id}: ${c.cities} cities (expected ${expected.cities})`);
    if (c.ships !== expected.ships) problems.push(`${id}: ${c.ships} ships (expected ${expected.ships})`);
  }
  return problems;
}

/** Check the trade-card deck is conserved: every commodity (114 total) and every
 *  calamity (12) is always somewhere — in a stack or a hand — never created or
 *  destroyed (cards spent on advances or resolved as calamities return to the
 *  bottom of their stack, §31/§29.7). Returns violations (empty = ok). */
export function cardConservationProblems(state: GameState): string[] {
  const counts: Record<string, number> = {};
  const bump = (card: string, n: number) => { counts[card] = (counts[card] ?? 0) + n; };
  for (const pile of Object.values(state.trade.stacks)) for (const c of pile) bump(c, 1);
  for (const p of Object.values(state.players)) for (const [c, n] of Object.entries(p.hand)) bump(c, n);
  const problems: string[] = [];
  for (const c of COMMODITIES) {
    const got = counts[c.id] ?? 0;
    if (got !== c.count) problems.push(`commodity ${c.id}: ${got} (expected ${c.count})`);
  }
  for (const cal of CALAMITIES) {
    const got = counts[`calamity:${cal.id}`] ?? 0;
    if (got !== 1) problems.push(`calamity ${cal.id}: ${got} (expected 1)`);
  }
  return problems;
}

export function player(state: GameState, id: PlayerId): PlayerState {
  const p = state.players[id];
  if (!p) throw new Error(`unknown player ${id}`);
  return p;
}
