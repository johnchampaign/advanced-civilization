import { describe, expect, it } from 'vitest';
import { adapter, createGame, normalize } from './index.js';
import { areas, adjacency, areaById, pieceCounts, shipNeighbors } from '../data/index.js';
import { navalDestinations, pieceConservationProblems } from './helpers.js';
import type { GameState, PlayerId } from './types.js';

const isCoastal = (id: string) => (adjacency[id] ?? []).some((n) => areaById.get(n)?.isWater);
const coastal = areas.filter((a) => !a.isWater && isCoastal(a.id));

function base(): GameState {
  const s = createGame({ players: ['egypt', 'babylon'], seed: 1, maxTurns: 60 });
  s.areas = {};
  for (const id of s.seating) { const p = s.players[id]!; p.hand = {}; }
  return s;
}
function fixSupply(s: GameState) {
  for (const id of s.seating) {
    const p = s.players[id]!;
    let board = 0, ships = 0;
    for (const a of Object.values(s.areas)) { board += a.tokens[id] ?? 0; ships += a.ships?.[id] ?? 0; }
    p.stock = pieceCounts.tokens - board; p.shipsAvailable = pieceCounts.ships - ships;
  }
}

describe('§22 ship construction', () => {
  it('builds a ship for 2 tokens (returned to stock), conserving the supply', () => {
    const s = base();
    const x = coastal[0]!.id;
    s.areas[x] = { tokens: { egypt: 5 } };
    fixSupply(s); s.players['egypt']!.treasury = 0;
    s.phase = 'shipConstruction'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
    const out = adapter.applyAction(s, { type: 'buildShips', builds: [{ area: x, count: 1 }] }, 'egypt');
    expect(out.areas[x]!.ships!['egypt']).toBe(1);
    expect(out.areas[x]!.tokens['egypt']).toBe(3); // 2 spent
    expect(out.players['egypt']!.stock).toBe(s.players['egypt']!.stock + 2); // returned to stock
    expect(out.players['egypt']!.shipsAvailable).toBe(3);
    expect(pieceConservationProblems(out, pieceCounts)).toEqual([]);
  });

  it('enforces the 4-ship cap (§22.4)', () => {
    const s = base();
    const x = coastal[0]!.id;
    s.areas[x] = { tokens: { egypt: 20 }, ships: { egypt: 4 } };
    fixSupply(s);
    s.phase = 'shipConstruction'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    expect(() => adapter.applyAction(s, { type: 'buildShips', builds: [{ area: x, count: 1 }] }, 'egypt')).toThrow();
  });
});

describe('§22.3 ship maintenance', () => {
  it('scraps a ship the owner cannot pay for when finishing the phase (§22.3)', () => {
    let s = base();
    const x = coastal[0]!.id;
    s.areas[x] = { tokens: {}, ships: { egypt: 1 } }; // ship alone, no tokens to levy
    fixSupply(s); s.players['egypt']!.treasury = 0;
    s.phase = 'census'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    normalize(s);
    expect(s.phase).toBe('shipConstruction');
    while (s.phase === 'shipConstruction') s = adapter.applyAction(s, { type: 'pass' }, adapter.currentActor(s)!); // §22.3 maintenance resolves as each finishes
    expect(s.areas[x]!.ships?.['egypt'] ?? 0).toBe(0); // scrapped — couldn't pay
    expect(s.players['egypt']!.shipsAvailable).toBe(4); // returned to stock
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
  });

  it('maintains a ship for 1 treasury token when finishing the phase', () => {
    let s = base();
    const x = coastal[0]!.id;
    s.areas[x] = { tokens: { egypt: 1 }, ships: { egypt: 1 } };
    fixSupply(s); s.players['egypt']!.stock -= 5; s.players['egypt']!.treasury = 5;
    s.phase = 'census'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    normalize(s);
    while (s.phase === 'shipConstruction') s = adapter.applyAction(s, { type: 'pass' }, adapter.currentActor(s)!);
    expect(s.areas[x]!.ships?.['egypt']).toBe(1); // kept
    expect(s.players['egypt']!.treasury).toBe(4); // paid 1
  });

  it('lets a player scrap a ship instead of maintaining it (§22.3)', () => {
    let s = base();
    const x = coastal[0]!.id;
    s.areas[x] = { tokens: { egypt: 1 }, ships: { egypt: 1 } };
    fixSupply(s); s.players['egypt']!.stock -= 5; s.players['egypt']!.treasury = 5; // treasury tokens come out of stock
    s.phase = 'census'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    normalize(s);
    const t0 = s.players['egypt']!.treasury;
    while (adapter.currentActor(s) !== 'egypt') s = adapter.applyAction(s, { type: 'pass' }, adapter.currentActor(s)!);
    s = adapter.applyAction(s, { type: 'scrapShip', area: x }, 'egypt'); // voluntarily scrap
    while (s.phase === 'shipConstruction') s = adapter.applyAction(s, { type: 'pass' }, adapter.currentActor(s)!); // finish — no maintenance owed now
    expect(s.areas[x]!.ships?.['egypt'] ?? 0).toBe(0); // ship gone
    expect(s.players['egypt']!.treasury).toBe(t0); // no maintenance paid (declined, §22.3)
    expect(s.players['egypt']!.shipsAvailable).toBe(4);
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
  });
});

describe('§23.5 naval movement', () => {
  it('ferries tokens across water and relocates the ship', () => {
    // Find a coastal area with a reachable coastal destination.
    let x = '', y = '';
    for (const a of coastal) { const d = navalDestinations(null, a.id, 4, false); if (d.size) { x = a.id; y = [...d][0]!; break; } }
    expect(x).not.toBe('');
    const s = base();
    s.areas[x] = { tokens: { egypt: 4 }, ships: { egypt: 1 } };
    fixSupply(s);
    s.phase = 'movement'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    const out = adapter.applyAction(s, { type: 'move', moves: [{ from: x, to: y, count: 3, byShip: true }] }, 'egypt');
    expect(out.areas[y]!.tokens['egypt']).toBe(3);
    expect(out.areas[x]!.tokens['egypt']).toBe(1);
    expect(out.areas[y]!.ships!['egypt']).toBe(1); // ship sailed along
    expect(out.areas[x]!.ships?.['egypt'] ?? 0).toBe(0);
    expect(pieceConservationProblems(out, pieceCounts)).toEqual([]);
  });

  it('rejects a sea move with no ship, over capacity, or out of range', () => {
    let x = '', y = '';
    for (const a of coastal) { const d = navalDestinations(null, a.id, 4, false); if (d.size) { x = a.id; y = [...d][0]!; break; } }
    const s = base();
    s.areas[x] = { tokens: { egypt: 8 } }; // no ship
    fixSupply(s);
    s.phase = 'movement'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    expect(() => adapter.applyAction(s, { type: 'move', moves: [{ from: x, to: y, count: 3, byShip: true }] }, 'egypt')).toThrow();
    // With a ship but over the 5-token capacity.
    s.areas[x]!.ships = { egypt: 1 };
    expect(() => adapter.applyAction(s, { type: 'move', moves: [{ from: x, to: y, count: 6, byShip: true }] }, 'egypt')).toThrow();
  });

  it('one ship makes one sailing: a second sailing from the same area is rejected (report ce1713db)', () => {
    let x = '', y = '', z = '';
    for (const a of coastal) {
      const d = [...navalDestinations(null, a.id, 4, false)];
      if (d.length >= 2) { x = a.id; y = d[0]!; z = d[1]!; break; }
    }
    expect(x).not.toBe('');
    const s = base();
    s.areas[x] = { tokens: { egypt: 6 }, ships: { egypt: 1 } };
    fixSupply(s);
    s.phase = 'movement'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    // The lone ship cannot drop tokens in two places — the batch must be refused
    // whole, not silently split into two ships.
    expect(() => adapter.applyAction(s, { type: 'move', moves: [
      { from: x, to: y, count: 2, byShip: true },
      { from: x, to: z, count: 2, byShip: true },
    ] }, 'egypt')).toThrow();
    // Two ships, two sailings — fine, and each ship ends at its own destination.
    s.areas[x]!.ships = { egypt: 2 };
    fixSupply(s);
    const out = adapter.applyAction(s, { type: 'move', moves: [
      { from: x, to: y, count: 2, byShip: true },
      { from: x, to: z, count: 2, byShip: true },
    ] }, 'egypt');
    expect(out.areas[y]!.ships!['egypt']).toBe(1);
    expect(out.areas[z]!.ships!['egypt']).toBe(1);
    expect(out.areas[x]!.ships?.['egypt'] ?? 0).toBe(0);
    expect(pieceConservationProblems(out, pieceCounts)).toEqual([]);
  });
});

describe('§23.5 ship model: area-to-area voyages (reports 5d177c1b, 2811ba36)', () => {
  function movePhase(s: GameState) { s.phase = 'movement'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = []; }

  it('sails Thapsus->Carthago->Palermo->Milazzo->Campania: 4 areas, legal at range 4 without Astronomy (§23.52, report 5d177c1b)', () => {
    expect(navalDestinations(null, 'thapsus', 4, false).has('campania')).toBe(true);
    const s = base();
    s.areas['thapsus'] = { tokens: { egypt: 4 }, ships: { egypt: 1 } };
    fixSupply(s); movePhase(s);
    const out = adapter.applyAction(s, { type: 'move', moves: [{ from: 'thapsus', to: 'campania', count: 3, byShip: true }] }, 'egypt');
    expect(out.areas['campania']!.tokens['egypt']).toBe(3);
    expect(out.areas['campania']!.ships!['egypt']).toBe(1);
    expect(pieceConservationProblems(out, pieceCounts)).toEqual([]);
  });

  it('ferries two loads across the Carthago|Palermo strait with one ship (§23.56, report 2811ba36)', () => {
    const s = base();
    s.areas['carthago'] = { tokens: { egypt: 8 }, ships: { egypt: 1 } };
    fixSupply(s); movePhase(s);
    const out = adapter.applyAction(s, { type: 'move', moves: [], voyages: [[
      { area: 'carthago', load: 5 }, { area: 'palermo', unload: 5 },
      { area: 'carthago', load: 3 }, { area: 'palermo', unload: 3 },
    ]] }, 'egypt');
    expect(out.areas['palermo']!.tokens['egypt']).toBe(8); // 8 tokens crossed with ONE ship
    expect(out.areas['carthago']!.tokens['egypt'] ?? 0).toBe(0);
    expect(out.areas['palermo']!.ships!['egypt']).toBe(1);
    expect(pieceConservationProblems(out, pieceCounts)).toEqual([]);
  });

  it('rejects a voyage that leaves tokens aboard at phase end (§23.56)', () => {
    const s = base();
    s.areas['carthago'] = { tokens: { egypt: 4 }, ships: { egypt: 1 } };
    fixSupply(s); movePhase(s);
    expect(() => adapter.applyAction(s, { type: 'move', moves: [], voyages: [[
      { area: 'carthago', load: 2 }, { area: 'palermo' },
    ]] }, 'egypt')).toThrow(/23\.56/);
  });

  it('a debarked token has moved: it may not board a second ship this phase (§23.56)', () => {
    const s = base();
    s.areas['carthago'] = { tokens: { egypt: 2 }, ships: { egypt: 1 } };
    s.areas['palermo'] = { tokens: {}, ships: { egypt: 1 } };
    fixSupply(s); movePhase(s);
    expect(() => adapter.applyAction(s, { type: 'move', moves: [], voyages: [
      [{ area: 'carthago', load: 2 }, { area: 'palermo', unload: 2 }],
      [{ area: 'palermo', load: 2 }, { area: 'milazzo', unload: 2 }],
    ] }, 'egypt')).toThrow(/23\.5/);
  });

  it('caps cargo at 5 at every moment of the voyage (§23.51)', () => {
    const s = base();
    s.areas['carthago'] = { tokens: { egypt: 3 }, ships: { egypt: 1 } };
    s.areas['palermo'] = { tokens: { egypt: 5 } };
    fixSupply(s); movePhase(s);
    expect(() => adapter.applyAction(s, { type: 'move', moves: [], voyages: [[
      { area: 'carthago', load: 3 }, { area: 'palermo', load: 3 }, { area: 'milazzo', unload: 6 },
    ]] }, 'egypt')).toThrow(/23\.51/);
  });

  it('blocks open sea without Astronomy, and forbids ENDING on open sea even with it (§23.52/.54/.55)', () => {
    const s = base();
    s.areas['phaestos'] = { tokens: { egypt: 1 }, ships: { egypt: 1 } };
    fixSupply(s); movePhase(s);
    expect(() => adapter.applyAction(s, { type: 'move', moves: [], voyages: [[
      { area: 'phaestos' }, { area: 'central-mediterranean' },
    ]] }, 'egypt')).toThrow(/Astronomy|23\.5/);
    s.players['egypt']!.advances.push('astronomy');
    expect(() => adapter.applyAction(s, { type: 'move', moves: [], voyages: [[
      { area: 'phaestos' }, { area: 'central-mediterranean' },
    ]] }, 'egypt')).toThrow(/23\.55/);
  });

  it('anchors: a voyage may end in a non-open water area (§23.55), and the ship can sail on next phase', () => {
    const s = base();
    s.areas['phaestos'] = { tokens: {}, ships: { egypt: 1 } };
    fixSupply(s); movePhase(s);
    const out = adapter.applyAction(s, { type: 'move', moves: [], voyages: [[
      { area: 'phaestos' }, { area: 'aegean-sea' },
    ]] }, 'egypt');
    expect(out.areas['aegean-sea']!.ships!['egypt']).toBe(1);
    expect(navalDestinations(null, 'aegean-sea', 4, false).size).toBeGreaterThan(0);
    expect(pieceConservationProblems(out, pieceCounts)).toEqual([]);
  });

  it('a two-coastline area must be left by the coastline it was entered (§23.57)', () => {
    // Find, from the data, a middle area M entered from X on one coastline where
    // some exit Y uses a different coastline.
    let X = '', M = '', Y = '';
    outer: for (const [m, hops] of shipNeighbors) {
      for (const h1 of hops) for (const h2 of hops) {
        if (h1.side != null && h2.side != null && h1.side !== h2.side && h1.to !== h2.to) { M = m; X = h1.to; Y = h2.to; break outer; }
      }
    }
    expect(M).not.toBe('');
    const s = base();
    s.areas[X] = { tokens: {}, ships: { egypt: 1 } };
    fixSupply(s); movePhase(s);
    expect(() => adapter.applyAction(s, { type: 'move', moves: [], voyages: [[
      { area: X }, { area: M }, { area: Y },
    ]] }, 'egypt')).toThrow(/23\.57/);
  });
});

describe('naval range helper', () => {
  it('reaches at least as far with more range, and Astronomy never reduces reach', () => {
    const a = coastal.find((c) => navalDestinations(null, c.id, 4, false).size > 0)!.id;
    const r4 = navalDestinations(null, a, 4, false);
    const r5 = navalDestinations(null, a, 5, false);
    const r4astro = navalDestinations(null, a, 4, true);
    for (const d of r4) expect(r5.has(d)).toBe(true);          // range 5 ⊇ range 4
    for (const d of r4) expect(r4astro.has(d)).toBe(true);     // Astronomy ⊇ no-Astronomy
  });
});

describe('§23.3 islands are all-water — population must embark to leave (issue #1)', () => {
  // Each island group and its members; every off-island land edge must be cut so
  // tokens can only leave by ship. (Owner-confirmed against the board.)
  const ISLANDS: Record<string, string[]> = {
    crete: ['knossos', 'phaestos'], cyprus: ['cyprus', 'salamis'], corsica: ['corsica-2'],
    sardinia: ['sardinia-2', 'carales-2'], baleares: ['baleares', 'ebusus'],
    rhodes: ['rhodes'], thera: ['thera'], lesbos: ['lesbos'], sicily: ['syracus', 'milazzo', 'palermo'],
  };
  it('no island area has a land neighbour outside its own island', () => {
    for (const members of Object.values(ISLANDS)) {
      const set = new Set(members);
      for (const id of members)
        for (const n of adjacency[id] ?? [])
          if (!areaById.get(n)?.isWater && !set.has(n))
            throw new Error(`${id} still walks to off-island land area ${n}`);
    }
  });
  it('the engine offers no on-foot move off Crete or across the Strait of Messina', () => {
    let s = base();
    s.areas['phaestos'] = { tokens: { egypt: 3 } };
    s.areas['syracus'] = { tokens: { egypt: 3 } };
    s.phase = 'movement'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    const dests = new Set<string>();
    for (const a of adapter.legalActions(s, 'egypt'))
      if (a.type === 'move') for (const m of (a as { moves: { from: string; to: string }[] }).moves) dests.add(`${m.from}->${m.to}`);
    expect(dests.has('phaestos->argos')).toBe(false);
    expect(dests.has('phaestos->sparta')).toBe(false);
    expect(dests.has('syracus->campania')).toBe(false); // Messina is ship-only
  });
  it('does not walk Thapsus->Tripoli: their shared border is all water (report 96195bca)', () => {
    // The two meet only out in the gulf — no land boundary — so §23.3 gives no
    // overland move. The land route runs inland through Sabrata.
    expect(adjacency['thapsus']).not.toContain('tripoli');
    expect(adjacency['tripoli']).not.toContain('thapsus');
    expect(adjacency['thapsus']).toContain('sabrata');
    expect(adjacency['sabrata']).toContain('tripoli');
    let s = base();
    s.areas['thapsus'] = { tokens: { egypt: 3 } };
    s.phase = 'movement'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    const dests = new Set<string>();
    for (const a of adapter.legalActions(s, 'egypt'))
      if (a.type === 'move') for (const m of (a as { moves: { from: string; to: string; byShip?: boolean }[] }).moves)
        if (!m.byShip) dests.add(`${m.from}->${m.to}`);
    expect(dests.has('thapsus->tripoli')).toBe(false);
    expect(dests.has('thapsus->sabrata')).toBe(true);
  });
});
