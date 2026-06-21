import { describe, expect, it } from 'vitest';
import { adapter, createGame } from './index.js';
import { areas, areaById, pieceCounts } from '../data/index.js';
import { cityCount, pieceConservationProblems } from './helpers.js';
import type { GameState, PlayerId } from './types.js';

const citySite = areas.find((a) => a.isCitySite && !a.isWater)!;
const nonSite2 = areas.find((a) => !a.isCitySite && !a.isWater && a.sustains === 2)!;
const land = areas.filter((a) => !a.isWater && a.id !== citySite.id && a.id !== nonSite2.id);

/** Build a controlled board at the city-construction phase, with stock/cities
 *  set so the fixed supply is conserved. */
function scenario(tokens: Record<PlayerId, Record<string, number>>, cities: Record<PlayerId, string[]>): GameState {
  const s = createGame({ players: ['egypt', 'babylon'], seed: 1, maxTurns: 60 });
  s.areas = {};
  for (const [owner, places] of Object.entries(tokens)) {
    for (const [aid, n] of Object.entries(places)) {
      (s.areas[aid] ??= { tokens: {} }).tokens[owner] = n;
    }
  }
  for (const [owner, aids] of Object.entries(cities)) {
    for (const aid of aids) (s.areas[aid] ??= { tokens: {} }).city = owner;
  }
  for (const id of s.seating) {
    const p = s.players[id]!;
    let board = 0, c = 0;
    for (const a of Object.values(s.areas)) { board += a.tokens[id] ?? 0; if (a.city === id) c++; }
    p.treasury = 0; p.hand = {};
    p.stock = pieceCounts.tokens - board;
    p.citiesAvailable = pieceCounts.cities - c;
  }
  s.phase = 'cityConstruction';
  s.activeOrder = ['egypt', 'babylon'];
  s.actedThisPhase = [];
  s.negotiation = { turnPointer: 0, passStreak: 0, actions: 0, nextOfferId: 0, offers: [], completed: [] };
  return s;
}

/** Pass both players through city construction so the removeSurplus auto-phase
 *  runs; returns the state once it settles (in the trade phase). */
function runSurplus(s: GameState): GameState {
  let guard = 0;
  while (s.phase === 'cityConstruction' && guard++ < 10) {
    const actor = adapter.currentActor(s)!;
    s = adapter.applyAction(s, { type: 'pass' }, actor);
  }
  return s;
}

describe('§26 surplus removal', () => {
  it('clears tokens from a city area and caps other areas at their limit', () => {
    let s = scenario(
      { egypt: { [citySite.id]: 2, [nonSite2.id]: 3, [land[0]!.id]: 2, [land[1]!.id]: 2 } },
      { egypt: [citySite.id] },
    );
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
    s = runSurplus(s);
    // City area holds no tokens (§26.1) but keeps its city (supported: 6 elsewhere).
    expect(s.areas[citySite.id]!.tokens['egypt'] ?? 0).toBe(0);
    expect(s.areas[citySite.id]!.city).toBe('egypt');
    // Non-city area capped at its limit (2); the surplus 3rd token returned.
    expect(s.areas[nonSite2.id]!.tokens['egypt']).toBe(2);
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
  });
});

describe('§26.31 city support', () => {
  it('reduces a city the player cannot support (fewer than 2 tokens/city)', () => {
    let s = scenario(
      { egypt: { [land[0]!.id]: 1 } }, // only 1 board token, but a city needs 2 support
      { egypt: [citySite.id] },
    );
    expect(cityCount(s, 'egypt')).toBe(1);
    s = runSurplus(s);
    expect(cityCount(s, 'egypt')).toBe(0); // city reduced for lack of support
    expect(s.areas[citySite.id]!.city).toBeUndefined();
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
  });

  it('keeps a city the player can support', () => {
    // 2 board tokens supports 1 city — spread across two areas so neither is
    // capped away by surplus removal.
    let s = scenario(
      { egypt: { [land[0]!.id]: 1, [land[1]!.id]: 1 } },
      { egypt: [citySite.id] },
    );
    s = runSurplus(s);
    expect(cityCount(s, 'egypt')).toBe(1);
  });
});

describe('§26 sequencing: a city built from consolidated tokens survives', () => {
  it('lets 6 tokens gathered on a city site become a supported city', () => {
    // 6 on the city site (to build) + 2 elsewhere (to support, spread across two
    // areas so they survive surplus removal) — within the turn, before the cap.
    let s = scenario({ egypt: { [citySite.id]: 6, [land[0]!.id]: 1, [land[1]!.id]: 1 } }, {});
    const actor = adapter.currentActor(s)!;
    expect(actor).toBe('egypt');
    // The build action should be legal and on the city site.
    const build = adapter.legalActions(s, 'egypt').find((a) => a.type === 'buildCity' && a.area === citySite.id);
    expect(build).toBeDefined();
    s = adapter.applyAction(s, build!, 'egypt');
    s = runSurplus(s);
    expect(s.areas[citySite.id]!.city).toBe('egypt');
    expect(cityCount(s, 'egypt')).toBe(1);
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
  });
});
