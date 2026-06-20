import { describe, expect, it } from 'vitest';
import { adapter, createGame } from './index.js';
import { areas, adjacency, areaById, civById, pieceCounts } from '../data/index.js';
import { cityCount, pieceConservationProblems, populationCount } from './helpers.js';
import type { GameState, PlayerId } from './types.js';

const coastal = areas.filter((a) => !a.isWater && (adjacency[a.id] ?? []).some((n) => areaById.get(n)?.isWater));
const land = areas.filter((a) => !a.isWater);

interface Opts { players?: PlayerId[]; tokens?: Record<PlayerId, Record<string, number>>; cities?: Record<PlayerId, string[]>; hands?: Record<PlayerId, Record<string, number>>; tradedFrom?: Record<string, PlayerId>; }

/** Controlled board at the trade phase; ending the trade triggers the calamity
 *  phase, which resolves whatever calamity cards players hold. */
function scenario(o: Opts): GameState {
  const s = createGame({ players: o.players ?? ['egypt', 'babylon'], seed: 1, maxTurns: 60 });
  s.areas = {};
  for (const [owner, places] of Object.entries(o.tokens ?? {})) for (const [aid, n] of Object.entries(places)) (s.areas[aid] ??= { tokens: {} }).tokens[owner] = n;
  for (const [owner, aids] of Object.entries(o.cities ?? {})) for (const aid of aids) (s.areas[aid] ??= { tokens: {} }).city = owner;
  for (const id of s.seating) {
    const p = s.players[id]!;
    let board = 0, c = 0;
    for (const a of Object.values(s.areas)) { board += a.tokens[id] ?? 0; if (a.city === id) c++; }
    p.treasury = 0; p.stock = pieceCounts.tokens - board; p.citiesAvailable = pieceCounts.cities - c; p.advances = [];
    p.hand = o.hands?.[id] ?? {};
  }
  s.calamityTradedFrom = o.tradedFrom ?? {};
  s.phase = 'trade';
  s.activeOrder = [...s.seating];
  s.actedThisPhase = [];
  s.negotiation = { turnPointer: 0, passStreak: 0, pendingOffer: null };
  return s;
}

function resolve(s: GameState): GameState {
  let guard = 0;
  while (s.phase === 'trade' && guard++ < 50) s = adapter.applyAction(s, { type: 'pass' }, adapter.currentActor(s)!);
  return s;
}

describe('§30.41 Civil War', () => {
  it('defects a faction to the player with the most reserves', () => {
    // egypt (victim) has a big board army; babylon sits in reserve (most stock).
    let s = scenario({
      tokens: { egypt: { [land[0]!.id]: 40 } },
      hands: { egypt: { 'calamity:civilwar': 1 } },
    });
    expect(populationCount(s, 'babylon')).toBe(0);
    s = resolve(s);
    // ~35 unit points (15 + beneficiary's 20) defect from egypt to babylon.
    expect(populationCount(s, 'egypt')).toBeLessThan(10);
    expect(populationCount(s, 'babylon')).toBeGreaterThan(20);
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
  });

  it('fizzles when the victim holds the most reserves', () => {
    // egypt has almost nothing on board (huge reserve); babylon also reserve.
    let s = scenario({
      tokens: { egypt: { [land[0]!.id]: 40 }, babylon: { [land[1]!.id]: 40 } },
      hands: { egypt: { 'calamity:civilwar': 1 } },
    });
    // Make egypt the reserve leader by emptying its board after stock is set.
    s.players['egypt']!.stock += 40; s.areas[land[0]!.id]!.tokens['egypt'] = 0;
    s = resolve(s);
    expect(populationCount(s, 'babylon')).toBe(40); // unchanged: no defection
  });
});

describe('§30.52 Barbarian Hordes', () => {
  it('lands in a start area, breaks the defenders and razes the city', () => {
    const start = civById.get('egypt')!.start; // barbarians land in a start area
    let s = scenario({
      tokens: { egypt: { [start]: 3 } },
      cities: { egypt: [start] },
      hands: { egypt: { 'calamity:barbarianhordes': 1 } },
    });
    expect(cityCount(s, 'egypt')).toBe(1);
    s = resolve(s);
    expect(cityCount(s, 'egypt')).toBe(0); // 15-horde overwhelms 3 defenders, razes the city
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
  });

  it('Crete is immune as the primary victim', () => {
    const start = civById.get('crete')!.start;
    let s = scenario({
      players: ['crete', 'babylon'],
      tokens: { crete: { [start]: 12 } },
      hands: { crete: { 'calamity:barbarianhordes': 1 } },
    });
    s = resolve(s);
    expect(populationCount(s, 'crete')).toBe(12); // untouched
  });
});

describe('§30.61 Epidemic secondary victims', () => {
  it('orders 25 unit points of loss onto the strongest rival, sparing the trader', () => {
    let s = scenario({
      players: ['egypt', 'babylon', 'crete'],
      tokens: { egypt: { [land[0]!.id]: 20 }, babylon: { [land[1]!.id]: 30 }, crete: { [land[2]!.id]: 30 } },
      hands: { egypt: { 'calamity:epidemic': 1 } },
      tradedFrom: { epidemic: 'crete' }, // crete is exempt from secondary effects
    });
    s = resolve(s);
    expect(populationCount(s, 'egypt')).toBe(20 - 16); // primary -16
    expect(populationCount(s, 'babylon')).toBe(30 - 25); // strongest rival ordered -25
    expect(populationCount(s, 'crete')).toBe(30); // the trader is untouched
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
  });
});

describe('§30.81 Iconoclasm secondary victims', () => {
  it('reduces 2 rival cities, sparing the trader and any Theology holder', () => {
    const cityAreas = land.filter((a) => a.isCitySite).slice(0, 8).map((a) => a.id);
    const supp = land.filter((a) => !cityAreas.includes(a.id));
    let s = scenario({
      players: ['egypt', 'babylon', 'crete', 'assyria'],
      cities: { egypt: [cityAreas[0]!, cityAreas[1]!], babylon: [cityAreas[2]!, cityAreas[3]!], assyria: [cityAreas[4]!] },
      // support tokens spread one-per-area so they survive (2 per city).
      tokens: {
        egypt: { [supp[0]!.id]: 1, [supp[1]!.id]: 1, [supp[2]!.id]: 1, [supp[3]!.id]: 1 },
        babylon: { [supp[4]!.id]: 1, [supp[5]!.id]: 1, [supp[6]!.id]: 1, [supp[7]!.id]: 1 },
        assyria: { [supp[8]!.id]: 1, [supp[9]!.id]: 1 },
      },
      hands: { egypt: { 'calamity:iconoclasm': 1 } },
      tradedFrom: { iconoclasm: 'crete' },
    });
    s.players['assyria']!.advances = ['enlightenment', 'theology']; // Theology -> immune as secondary
    expect(cityCount(s, 'egypt')).toBe(2);
    s = resolve(s);
    expect(cityCount(s, 'egypt')).toBe(0); // primary loses up to 4 -> both its cities
    expect(cityCount(s, 'babylon')).toBe(0); // 2 secondary cities fall on the strongest rival
    expect(cityCount(s, 'assyria')).toBe(1); // Theology holder spared
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
  });
});

describe('§30.523 Barbarian march', () => {
  it('marches surplus barbarians into an adjacent area with the victim\'s units', () => {
    const start = civById.get('egypt')!.start;
    const nbr = (adjacency[start] ?? []).find((n) => !areaById.get(n)?.isWater)!;
    let s = scenario({
      tokens: { egypt: { [start]: 2, [nbr]: 2 } },
      hands: { egypt: { 'calamity:barbarianhordes': 1 } },
    });
    s = resolve(s);
    // The horde overran the start area and marched on into the neighbour.
    expect(populationCount(s, 'egypt')).toBeLessThan(4);
    expect(s.areas[nbr]!.tokens['egypt'] ?? 0).toBe(0);
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
  });
});

describe('§30.91 Piracy', () => {
  it('turns the victim\'s and secondary victims\' coastal cities into pirate cities', () => {
    let s = scenario({
      players: ['egypt', 'babylon', 'crete'],
      cities: { egypt: [coastal[0]!.id, coastal[1]!.id], babylon: [coastal[2]!.id] },
      tokens: { egypt: { [land[5]!.id]: 4 }, babylon: { [land[6]!.id]: 4 } }, // support
      hands: { egypt: { 'calamity:piracy': 1 } },
      tradedFrom: { piracy: 'crete' }, // crete (the trader) cannot be a secondary victim
    });
    expect(cityCount(s, 'egypt')).toBe(2);
    expect(cityCount(s, 'babylon')).toBe(1);
    s = resolve(s);
    expect(cityCount(s, 'egypt')).toBe(0); // both coastal cities lost
    expect(cityCount(s, 'babylon')).toBe(0); // secondary victim lost its coastal city
    // Pirate cities now stand on those coasts.
    expect(s.areas[coastal[0]!.id]!.city).toBe('__pirate__');
    expect(s.areas[coastal[0]!.id]!.pirateCity).toBe(true);
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
  });
});
