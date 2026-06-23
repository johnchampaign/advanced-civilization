import { describe, expect, it } from 'vitest';
import { adapter, createGame } from './index.js';
import { areas, pieceCounts } from '../data/index.js';
import { pieceConservationProblems } from './helpers.js';
import type { GameState, PlayerId } from './types.js';

const sus1 = areas.find((a) => !a.isWater && a.sustains === 1)!;
const sus2 = areas.find((a) => !a.isWater && a.sustains === 2)!;
const cityArea = areas.find((a) => !a.isWater && a.id !== sus1.id && a.id !== sus2.id)!;
const elsewhere = areas.filter((a) => !a.isWater && ![sus1.id, sus2.id, cityArea.id].includes(a.id));

interface Opts { advances?: Partial<Record<PlayerId, string[]>>; hands?: Partial<Record<PlayerId, Record<string, number>>>; seed?: number; }

/** Controlled board at the movement phase (conflict runs next). */
function scenario(tokens: Record<PlayerId, Record<string, number>>, cities: Record<PlayerId, string[]>, opts: Opts = {}): GameState {
  const s = createGame({ players: ['egypt', 'babylon'], seed: opts.seed ?? 1, maxTurns: 60 });
  s.areas = {};
  for (const [owner, places] of Object.entries(tokens)) for (const [aid, n] of Object.entries(places)) (s.areas[aid] ??= { tokens: {} }).tokens[owner] = n;
  for (const [owner, aids] of Object.entries(cities)) for (const aid of aids) (s.areas[aid] ??= { tokens: {} }).city = owner;
  for (const id of s.seating) {
    const p = s.players[id]!;
    let board = 0, c = 0;
    for (const a of Object.values(s.areas)) { board += a.tokens[id] ?? 0; if (a.city === id) c++; }
    p.treasury = 0; p.stock = pieceCounts.tokens - board; p.citiesAvailable = pieceCounts.cities - c;
    p.advances = opts.advances?.[id] ?? [];
    p.hand = opts.hands?.[id] ?? {};
  }
  s.phase = 'movement';
  s.activeOrder = ['egypt', 'babylon'];
  s.actedThisPhase = [];
  s.negotiation = { turnPointer: 0, passStreak: 0, actions: 0, nextOfferId: 0, offers: [], completed: [] };
  return s;
}

/** Pass through movement so conflict (auto) resolves; settles at cityConstruction. */
function runConflict(s: GameState): GameState {
  let guard = 0;
  while (s.phase === 'movement' && guard++ < 10) s = adapter.applyAction(s, { type: 'pass' }, adapter.currentActor(s)!);
  return s;
}

describe('§24.2 token attrition', () => {
  it('eliminates the weaker nation; the stronger keeps the difference', () => {
    let s = scenario({ egypt: { [sus1.id]: 3 }, babylon: { [sus1.id]: 5 } }, {});
    s = runConflict(s);
    expect(s.areas[sus1.id]!.tokens['egypt'] ?? 0).toBe(0);
    expect(s.areas[sus1.id]!.tokens['babylon']).toBe(3); // 5 - 2 alternating losses
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
  });

  it('allows coexistence once the total no longer exceeds the area limit', () => {
    let s = scenario({ egypt: { [sus2.id]: 2 }, babylon: { [sus2.id]: 2 } }, {});
    s = runConflict(s);
    expect(s.areas[sus2.id]!.tokens['egypt']).toBe(1);
    expect(s.areas[sus2.id]!.tokens['babylon']).toBe(1);
  });

  it('equal forces in a one-token area remove simultaneously and depopulate it (§24.22)', () => {
    let s = scenario({ egypt: { [sus1.id]: 1 }, babylon: { [sus1.id]: 1 } }, {});
    s = runConflict(s);
    expect(s.areas[sus1.id]!.tokens['egypt'] ?? 0).toBe(0);
    expect(s.areas[sus1.id]!.tokens['babylon'] ?? 0).toBe(0); // both go — no arbitrary survivor
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
  });

  it('Metalworking removes last, so it wins an otherwise-even fight', () => {
    // Even 2v2 in a limit-1 area: without Metalworking the first remover (by seat)
    // loses; egypt with Metalworking forces babylon to remove first and survives.
    let s = scenario({ egypt: { [sus1.id]: 2 }, babylon: { [sus1.id]: 2 } }, {}, { advances: { egypt: ['metalworking'] } });
    s = runConflict(s);
    expect(s.areas[sus1.id]!.tokens['egypt']).toBe(1);
    expect(s.areas[sus1.id]!.tokens['babylon'] ?? 0).toBe(0);
  });
});

describe('§24.3 city assault', () => {
  it('leaves the city standing when the attacker brings fewer than 7 tokens', () => {
    let s = scenario({ egypt: { [cityArea.id]: 5 } }, { babylon: [cityArea.id] });
    s = runConflict(s);
    expect(s.areas[cityArea.id]!.city).toBe('babylon');
    expect(s.areas[cityArea.id]!.tokens['egypt'] ?? 0).toBe(0); // attackers removed
  });

  it('storms the city with 7+ tokens: city falls, attacker pillages and steals a card', () => {
    let s = scenario({ egypt: { [cityArea.id]: 7 } }, { babylon: [cityArea.id] }, { hands: { babylon: { ochre: 2 } } });
    s = runConflict(s);
    expect(s.areas[cityArea.id]!.city).toBeUndefined();
    // City replaced by 6 defenders; 7 vs 6 round-robin -> attacker keeps 2.
    expect(s.areas[cityArea.id]!.tokens['egypt']).toBe(2);
    expect(s.players['babylon']!.citiesAvailable).toBe(pieceCounts.cities); // city returned
    expect(s.players['egypt']!.treasury).toBe(3); // pillage (was 0)
    // Stole one of babylon's ochre cards.
    expect(s.players['egypt']!.hand['ochre']).toBe(1);
    expect(s.players['babylon']!.hand['ochre']).toBe(1);
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
  });

  it('Engineering lets an attacker storm a city with only 6 tokens', () => {
    const without = runConflict(scenario({ egypt: { [cityArea.id]: 6 } }, { babylon: [cityArea.id] }));
    expect(without.areas[cityArea.id]!.city).toBe('babylon'); // 6 < 7, fails

    const withEng = runConflict(scenario({ egypt: { [cityArea.id]: 6 } }, { babylon: [cityArea.id] }, { advances: { egypt: ['engineering'] } }));
    expect(withEng.areas[cityArea.id]!.city).toBeUndefined(); // 6 >= 6, succeeds
  });

  it('a defender with Engineering needs the attacker to bring 8', () => {
    const seven = runConflict(scenario({ egypt: { [cityArea.id]: 7 } }, { babylon: [cityArea.id] }, { advances: { babylon: ['engineering'] } }));
    expect(seven.areas[cityArea.id]!.city).toBe('babylon'); // 7 < 8, fails
  });
});

describe('combat step-through capture (lastCombats)', () => {
  it('records before forces, losses and the Metalworking modifier per area', () => {
    const s = runConflict(scenario({ egypt: { [sus1.id]: 3 }, babylon: { [sus1.id]: 5 } }, {}, { advances: { babylon: ['metalworking'] } }));
    const ev = s.lastCombats?.find((c) => c.area === sus1.id);
    expect(ev).toBeTruthy();
    expect(ev!.before.map((f) => f.id).sort()).toEqual(['babylon', 'egypt']);
    expect(ev!.before.find((f) => f.id === 'egypt')!.tokens).toBe(3); // forces at the start
    expect(ev!.modifiers.some((m) => /Metalworking/.test(m))).toBe(true); // §32.231 surfaced
    expect(ev!.after.find((f) => f.id === 'egypt')?.tokens ?? 0).toBe(0); // egypt wiped
  });
});
