import { describe, expect, it } from 'vitest';
import { adapter, createGame, normalize } from './index.js';
import { areas, adjacency, areaById, pieceCounts } from '../data/index.js';
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
  it('scraps a ship the owner cannot pay for (no treasury, empty area)', () => {
    let s = base();
    const x = coastal[0]!.id;
    s.areas[x] = { tokens: {}, ships: { egypt: 1 } }; // ship alone, no tokens to levy
    fixSupply(s); s.players['egypt']!.treasury = 0;
    // Enter ship construction via the auto phase before it, triggering maintenance.
    s.phase = 'census'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    normalize(s);
    expect(s.phase).toBe('shipConstruction');
    expect(s.areas[x]!.ships?.['egypt'] ?? 0).toBe(0); // scrapped
    expect(s.players['egypt']!.shipsAvailable).toBe(4); // returned to stock
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
  });

  it('maintains a ship for 1 treasury token', () => {
    let s = base();
    const x = coastal[0]!.id;
    s.areas[x] = { tokens: { egypt: 1 }, ships: { egypt: 1 } };
    fixSupply(s); s.players['egypt']!.stock -= 5; s.players['egypt']!.treasury = 5;
    s.phase = 'census'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    normalize(s);
    expect(s.areas[x]!.ships?.['egypt']).toBe(1); // kept
    expect(s.players['egypt']!.treasury).toBe(4); // paid 1
  });
});

describe('§23.5 naval movement', () => {
  it('ferries tokens across water and relocates the ship', () => {
    // Find a coastal area with a reachable coastal destination.
    let x = '', y = '';
    for (const a of coastal) { const d = navalDestinations(a.id, 4, false); if (d.size) { x = a.id; y = [...d][0]!; break; } }
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
    for (const a of coastal) { const d = navalDestinations(a.id, 4, false); if (d.size) { x = a.id; y = [...d][0]!; break; } }
    const s = base();
    s.areas[x] = { tokens: { egypt: 8 } }; // no ship
    fixSupply(s);
    s.phase = 'movement'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    expect(() => adapter.applyAction(s, { type: 'move', moves: [{ from: x, to: y, count: 3, byShip: true }] }, 'egypt')).toThrow();
    // With a ship but over the 5-token capacity.
    s.areas[x]!.ships = { egypt: 1 };
    expect(() => adapter.applyAction(s, { type: 'move', moves: [{ from: x, to: y, count: 6, byShip: true }] }, 'egypt')).toThrow();
  });
});

describe('naval range helper', () => {
  it('reaches at least as far with more range, and Astronomy never reduces reach', () => {
    const a = coastal.find((c) => navalDestinations(c.id, 4, false).size > 0)!.id;
    const r4 = navalDestinations(a, 4, false);
    const r5 = navalDestinations(a, 5, false);
    const r4astro = navalDestinations(a, 4, true);
    for (const d of r4) expect(r5.has(d)).toBe(true);          // range 5 ⊇ range 4
    for (const d of r4) expect(r4astro.has(d)).toBe(true);     // Astronomy ⊇ no-Astronomy
  });
});
