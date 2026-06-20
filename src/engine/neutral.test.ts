import { describe, expect, it } from 'vitest';
import { adapter, createGame } from './index.js';
import { areas, adjacency, areaById, pieceCounts } from '../data/index.js';
import { cityCount, pieceConservationProblems, populationCount } from './helpers.js';
import type { GameState, PlayerId } from './types.js';

const BARB = '__barbarian__';
const PIRATE = '__pirate__';
const land = areas.filter((a) => !a.isWater);

/** An adjacent pair of land areas [x, y]. */
function landPair(): [string, string] {
  for (const a of land) for (const n of adjacency[a.id] ?? []) if (!areaById.get(n)?.isWater) return [a.id, n];
  throw new Error('no land pair');
}

function scenario(setup: (s: GameState) => void): GameState {
  const s = createGame({ players: ['egypt', 'babylon'], seed: 1, maxTurns: 99 });
  s.areas = {};
  for (const id of s.seating) s.players[id]!.hand = {};
  setup(s);
  for (const id of s.seating) {
    const p = s.players[id]!;
    let board = 0, c = 0, ships = 0;
    for (const a of Object.values(s.areas)) { board += a.tokens[id] ?? 0; if (a.city === id) c++; ships += a.ships?.[id] ?? 0; }
    p.stock = pieceCounts.tokens - board; p.citiesAvailable = pieceCounts.cities - c; p.shipsAvailable = pieceCounts.ships - ships; p.treasury = 0;
  }
  s.phase = 'movement'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
  return s;
}

/** Resolve the rest of the current turn's auto phases (conflict etc.) by passing
 *  through interactive phases until the turn advances. */
function endTurn(s: GameState): GameState {
  const t = s.turn;
  let guard = 0;
  while (s.turn === t && adapter.result(s) == null && guard++ < 200) {
    const actor = adapter.currentActor(s);
    if (actor == null) break;
    s = adapter.applyAction(s, { type: 'pass' }, actor);
  }
  return s;
}

describe('persistent neutral forces (§30.5235 / §30.913)', () => {
  it('barbarians persist across a turn and never multiply', () => {
    const [x] = landPair();
    let s = scenario((g) => { g.areas[x] = { tokens: { [BARB]: 8 } }; });
    s = endTurn(s); // crosses population expansion + surplus removal of the next turn
    expect(s.areas[x]!.tokens[BARB]).toBe(8); // unchanged: don't grow, not removed
  });

  it('barbarians and pirate cities count for no player (census / cities / score)', () => {
    const [x, y] = landPair();
    const s = scenario((g) => { g.areas[x] = { tokens: { [BARB]: 5 } }; g.areas[y] = { tokens: {}, city: PIRATE, pirateCity: true }; g.players['egypt']!.advances = []; });
    expect(populationCount(s, 'egypt')).toBe(0);
    expect(cityCount(s, 'egypt')).toBe(0);
    expect(cityCount(s, 'babylon')).toBe(0);
  });

  it('a player can clear barbarians by attacking on a later turn', () => {
    const [x, b] = landPair();
    let s = scenario((g) => { g.areas[x] = { tokens: { egypt: 6 } }; g.areas[b] = { tokens: { [BARB]: 3 } }; });
    s = adapter.applyAction(s, { type: 'move', moves: [{ from: x, to: b, count: 6 }] }, 'egypt');
    s = endTurn(s); // conflict resolves egypt vs barbarians
    expect(s.areas[b]!.tokens[BARB] ?? 0).toBe(0); // barbarians wiped out
    expect(s.areas[b]!.tokens['egypt'] ?? 0).toBeGreaterThan(0); // egypt holds the area
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
  });

  it('a player can storm and destroy a pirate city (and pillage)', () => {
    const [x, c] = landPair();
    let s = scenario((g) => { g.areas[x] = { tokens: { egypt: 8 } }; g.areas[c] = { tokens: {}, city: PIRATE, pirateCity: true }; });
    s = adapter.applyAction(s, { type: 'move', moves: [{ from: x, to: c, count: 8 }] }, 'egypt');
    s = endTurn(s);
    expect(s.areas[c]!.city).toBeUndefined(); // pirate city destroyed
    expect(s.players['egypt']!.treasury).toBe(3); // pillage (§24.34/§30.913)
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
  });

  it('an unattacked pirate city remains on the board', () => {
    const [, c] = landPair();
    let s = scenario((g) => { g.areas[c] = { tokens: {}, city: PIRATE, pirateCity: true }; });
    s = endTurn(s);
    expect(s.areas[c]!.city).toBe(PIRATE);
  });
});
