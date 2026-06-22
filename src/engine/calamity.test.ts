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
  s.negotiation = { turnPointer: 0, passStreak: 0, actions: 0, nextOfferId: 0, offers: [], completed: [] };
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
    // §30.4121: egypt keeps a first faction of 15 unit points; the remaining 25
    // defect to babylon (the player with the most reserves).
    expect(populationCount(s, 'egypt')).toBe(15);
    expect(populationCount(s, 'babylon')).toBeGreaterThanOrEqual(20);
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

describe('advance modifiers on calamities (§30/§32)', () => {
  const cityAreas = [land[1]!.id, land[2]!.id, land[3]!.id, land[4]!.id, land[5]!.id, land[6]!.id];

  function superstitionCitiesLeft(adv: string[]): number {
    let s = scenario({
      tokens: { egypt: { [land[0]!.id]: 20 } },
      cities: { egypt: cityAreas.slice(0, 4) },
      hands: { egypt: { 'calamity:superstition': 1 } },
    });
    s.players['egypt']!.advances = adv;
    return cityCount(resolve(s), 'egypt');
  }
  it('Superstition reduces 3 cities, softened by the highest Religion card (§30.322)', () => {
    expect(superstitionCitiesLeft([])).toBe(1); // 4 - 3
    expect(superstitionCitiesLeft(['mysticism'])).toBe(2); // 4 - 2
    expect(superstitionCitiesLeft(['deism'])).toBe(3); // 4 - 1
    expect(superstitionCitiesLeft(['enlightenment'])).toBe(4); // nullified
    expect(superstitionCitiesLeft(['mysticism', 'deism', 'enlightenment'])).toBe(4); // highest governs
  });

  function faminePopLeft(adv: string[], grain: number): number {
    let s = scenario({
      tokens: { egypt: { [land[0]!.id]: 10 }, babylon: { [land[7]!.id]: 30 } },
      hands: { egypt: { 'calamity:famine': 1, grain } },
    });
    s.players['egypt']!.advances = adv;
    return populationCount(resolve(s), 'egypt');
  }
  it('Famine costs 10 unit points; Pottery softens 4 per Grain card held (§30.312)', () => {
    expect(faminePopLeft([], 0)).toBe(0); // lost all 10
    expect(faminePopLeft(['pottery'], 2)).toBe(8); // 10 - 8 = 2 lost
    expect(faminePopLeft(['pottery'], 0)).toBe(0); // Pottery without Grain does nothing
  });

  function disorderCitiesLeft(adv: string[]): number {
    let s = scenario({
      tokens: { egypt: { [land[0]!.id]: 20 } },
      cities: { egypt: cityAreas.slice(0, 6) },
      hands: { egypt: { 'calamity:civildisorder': 1 } },
    });
    s.players['egypt']!.advances = adv;
    return cityCount(resolve(s), 'egypt');
  }
  it('Civil Disorder reduces all but 3 cities, ±1 per advance (§30.712-.714)', () => {
    expect(disorderCitiesLeft([])).toBe(3); // 6 → keep 3
    expect(disorderCitiesLeft(['music', 'drama'])).toBe(5); // 3 reduced − 2 = 1 reduced
    expect(disorderCitiesLeft(['music', 'drama', 'law', 'democracy'])).toBe(6); // none reduced
    expect(disorderCitiesLeft(['military'])).toBe(2); // 3 + 1 = 4 reduced
  });

  function slaveRevoltCitiesLeft(adv: string[]): number {
    let s = scenario({
      tokens: { egypt: { [land[0]!.id]: 20 } },
      cities: { egypt: cityAreas.slice(0, 5) },
      hands: { egypt: { 'calamity:slaverevolt': 1 } },
    });
    s.players['egypt']!.advances = adv;
    return cityCount(resolve(s), 'egypt');
  }
  it('Slave Revolt: Enlightenment eases it, Mining worsens it (§30.423)', () => {
    const none = slaveRevoltCitiesLeft([]);
    expect(slaveRevoltCitiesLeft(['enlightenment'])).toBeGreaterThanOrEqual(none);
    expect(slaveRevoltCitiesLeft(['mining'])).toBeLessThanOrEqual(none);
    expect(slaveRevoltCitiesLeft(['mining'])).toBeLessThan(5); // it does bite
  });

  it('Earthquake: Engineering reduces a city instead of destroying an area (§30.213)', () => {
    function quakePop(eng: boolean): number {
      let s = scenario({
        tokens: { egypt: { [land[0]!.id]: 8 } },
        cities: { egypt: [land[1]!.id] },
        hands: { egypt: { 'calamity:volcano': 1 } },
      });
      s.players['egypt']!.advances = eng ? ['engineering'] : [];
      return populationCount(resolve(s), 'egypt');
    }
    expect(quakePop(true)).toBeGreaterThan(quakePop(false)); // keeps the 8-token area
  });

  it('reduced cities are replaced by tokens, +1 with Agriculture (§26.41/§32.241)', () => {
    function sub(adv: string[]): number {
      let s = scenario({
        tokens: { egypt: { [land[0]!.id]: 20 } },
        cities: { egypt: [land[1]!.id] },
        hands: { egypt: { 'calamity:superstition': 1 } },
      });
      s.players['egypt']!.advances = adv;
      s = resolve(s);
      return s.areas[land[1]!.id]?.tokens['egypt'] ?? 0;
    }
    const limit = areaById.get(land[1]!.id)!.sustains;
    expect(sub([])).toBe(limit); // city → max tokens the area allows
    expect(sub(['agriculture'])).toBe(limit + 1); // Agriculture clause 2
  });
});

describe('Monotheism conversion timing (§29/§32.941)', () => {
  it('is offered during the calamity phase, before advance acquisition', () => {
    const a0 = land[0]!.id;
    const a1 = (adjacency[a0] ?? []).find((n) => !areaById.get(n)?.isWater)!;
    let s = scenario({ tokens: { egypt: { [a0]: 1 }, babylon: { [a1]: 2 } } });
    s.players['egypt']!.advances = ['monotheism'];
    s.players['egypt']!.stock = 10;
    s = resolve(s); // pass through trade
    expect(s.phase).toBe('calamity'); // paused here, not acquireAdvances
    expect(adapter.currentActor(s)).toBe('egypt');
    const conv = adapter.legalActions(s, 'egypt').filter((a) => a.type === 'convertArea');
    expect(conv.length).toBeGreaterThan(0);
    s = adapter.applyAction(s, conv[0]!, 'egypt');
    expect(s.areas[a1]!.tokens['egypt']).toBe(2); // took over babylon's tokens
    expect(s.phase).not.toBe('calamity'); // conversion done → phase advances
  });
});

describe('Flood & Volcano geography (§30.51 / §30.21)', () => {
  const nile = ['alexandria', 'tanis', 'memphis', 'fayum', 'upper-egypt']; // one flood-plain region

  function floodPop(adv: string[]): number {
    const tokens: Record<string, number> = {};
    for (const aid of nile) tokens[aid] = 4; // 20 unit points on the Nile flood plain
    let s = scenario({ tokens: { egypt: tokens }, hands: { egypt: { 'calamity:flood': 1 } } });
    s.players['egypt']!.advances = adv;
    return populationCount(resolve(s), 'egypt');
  }
  it('Flood removes up to 17 unit points from the flood plain, 7 with Engineering (§30.511/.515)', () => {
    expect(floodPop([])).toBe(3); // 20 − 17
    expect(floodPop(['engineering'])).toBe(13); // 20 − 7
  });

  it('Flood with no flood-plain units eliminates a coastal city (§30.514)', () => {
    const dry = coastal.find((a) => !a.isFloodplain)!.id; // a coastal, non-flood-plain area
    let s = scenario({ tokens: { egypt: { [dry]: 6 } }, cities: { egypt: [dry] }, hands: { egypt: { 'calamity:flood': 1 } } });
    s = resolve(s);
    expect(s.areas[dry]?.city).toBeUndefined(); // the coastal city is gone
  });

  it('Volcanic Eruption destroys every unit in the volcano’s areas (§30.211)', () => {
    let s = scenario({ tokens: { egypt: { campania: 3, neapolis: 2 } }, cities: { egypt: ['campania'] }, hands: { egypt: { 'calamity:volcano': 1 } } });
    s = resolve(s);
    expect(s.areas['campania']?.city).toBeUndefined();
    expect(populationCount(s, 'egypt')).toBe(0); // Vesuvius wipes campania + neapolis
  });

  it('volcano-site data matches the three §4.41 volcanoes (guards the engine grouping)', () => {
    const ids = areas.filter((a) => a.isVolcanoSite).map((a) => a.id).sort();
    expect(ids).toEqual(['campania', 'milazzo', 'neapolis', 'syracus', 'thera'].sort());
  });

  it('Earthquake (no volcano-area city) destroys a city; Engineering reduces it instead (§30.212/.213)', () => {
    function quakePop(eng: boolean): number {
      let s = scenario({
        tokens: { egypt: { [land[0]!.id]: 6 } }, // enough to support the surviving city
        cities: { egypt: [land[1]!.id, land[2]!.id] },
        hands: { egypt: { 'calamity:volcano': 1 } },
      });
      s.players['egypt']!.advances = eng ? ['engineering'] : [];
      s = resolve(s);
      expect(cityCount(s, 'egypt')).toBe(1); // exactly one city lost either way
      return populationCount(s, 'egypt');
    }
    expect(quakePop(true)).toBeGreaterThan(quakePop(false)); // Engineering substitutes tokens
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
    // §30.611: no more than 10 may be ordered from any one player. crete (the
    // trader) is exempt, so babylon — the only eligible rival — absorbs just 10.
    expect(populationCount(s, 'babylon')).toBe(30 - 10);
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
