// Pure helper functions for the engine: commodity set scoring, advance-purchase
// credit calculation, adjacency, and turn-order derivation. Kept side-effect
// free so they are straightforward to unit-test.

import {
  advanceById,
  advances as ALL_ADVANCES,
  adjacency,
  areaById,
  calamities as CALAMITIES,
  commodities as COMMODITIES,
  commodityById,
  type AdvanceGroup,
} from '../data/index.js';
import type { GameState, PlayerId, PlayerState } from './types.js';

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

export function landNeighbors(areaId: string): string[] {
  return (adjacency[areaId] ?? []).filter((n) => !areaById.get(n)?.isWater);
}

/** Coastal land areas a ship docked at `start` can reach (§23.5): BFS across up
 *  to `range` water areas (4, or 5 with Cloth Making §23.53); open-sea areas are
 *  only traversable with Astronomy (§23.52/.54). Returns the debark candidates
 *  (land areas adjacent to a reachable water area), excluding `start`. */
export function navalDestinations(start: string, range: number, astronomy: boolean): Set<string> {
  const s = areaById.get(start);
  const dests = new Set<string>();
  if (!s || s.isWater) return dests; // ships dock at coastal land areas
  const passable = (id: string) => { const a = areaById.get(id); return !!a?.isWater && (astronomy || !a.isOpenSea); };
  const visited = new Set<string>();
  let frontier = (adjacency[start] ?? []).filter(passable);
  for (let depth = 1; depth <= range && frontier.length; depth++) {
    const next: string[] = [];
    for (const w of frontier) {
      if (visited.has(w)) continue;
      visited.add(w);
      for (const nb of adjacency[w] ?? []) {
        const a = areaById.get(nb);
        if (!a) continue;
        if (a.isWater) { if (passable(nb) && !visited.has(nb)) next.push(nb); }
        else if (nb !== start) dests.add(nb);
      }
    }
    frontier = next;
  }
  return dests;
}

export function neighbors(areaId: string): string[] {
  return adjacency[areaId] ?? [];
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
export function censusOrder(state: GameState): PlayerId[] {
  const seatIdx = new Map(state.seating.map((p, i) => [p, i]));
  return [...state.seating].sort((a, b) => {
    const pa = populationCount(state, a);
    const pb = populationCount(state, b);
    if (pa !== pb) return pb - pa;
    return (seatIdx.get(a) ?? 0) - (seatIdx.get(b) ?? 0);
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
