import { describe, expect, it } from 'vitest';
import { Rng } from 'digital-boardgame-framework';
import { adapter, createGame } from '../engine/index.js';
import { pieceConservationProblems } from '../engine/helpers.js';
import { pieceCounts } from '../data/index.js';
import { HeuristicAI } from './heuristic.js';
import type { GameState, PlayerId } from '../engine/types.js';

const ai = new HeuristicAI();

/** A trade-phase state with controlled hands. */
function tradeState(hands: Record<PlayerId, Record<string, number>>): GameState {
  const s = createGame({ players: ['egypt', 'babylon'], seed: 1, maxTurns: 60 });
  for (const id of s.seating) s.players[id]!.hand = hands[id] ?? {};
  s.phase = 'trade';
  s.activeOrder = ['egypt', 'babylon'];
  s.actedThisPhase = [];
  s.negotiation = { turnPointer: 0, passStreak: 0, actions: 0, nextOfferId: 0, offers: [], completed: [] };
  return s;
}

/** Drive the AI through the trade phase (each actor in turn) until it ends or a
 *  cap. Returns the final state. */
async function runTradePhase(s0: GameState, seed = 1): Promise<GameState> {
  let s = s0; let guard = 0;
  while (guard++ < 60) {
    const actor = adapter.currentActor(s);
    if (!actor || s.phase !== 'trade') break;
    const action = await ai.selectAction({ state: s, actor, adapter, rng: new Rng(seed + guard) });
    s = adapter.applyAction(s, action, actor);
  }
  return s;
}

describe('AI trade negotiation (open-offer board)', () => {
  it('posts, responds to, and completes a set-building swap', async () => {
    // egypt's most-valuable growing set is salt, babylon's is iron (each holds
    // spares of what the other is collecting), so a complementary swap forms.
    const s = await runTradePhase(tradeState({
      egypt: { salt: 4, iron: 4, ochre: 2 },
      babylon: { iron: 5, salt: 2, hides: 2 },
    }));
    // A deal was struck and both grew their collections.
    expect((s.negotiation.completed ?? []).length).toBeGreaterThan(0);
    expect(s.players['egypt']!.hand['salt']! + s.players['babylon']!.hand['iron']!).toBeGreaterThan(6);
  });

  it('posts an offer even with no visible willing partner (multiplayer-fair, blind)', async () => {
    const s = tradeState({ egypt: { salt: 3, iron: 2, ochre: 1 }, babylon: {} });
    const action = await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });
    expect(action.type).toBe('postOffer'); // blind — it doesn't peek at babylon's empty hand
  });

  it('dumps a tradable calamity onto a trade partner (bluffed, then passed on the deal)', async () => {
    const s = await runTradePhase(tradeState({
      egypt: { salt: 3, iron: 2, 'calamity:epidemic': 1 },
      babylon: { iron: 3, salt: 2, hides: 1 },
    }));
    // The calamity left egypt via a completed trade; egypt recorded as the giver,
    // so egypt is immune as a secondary victim (§29.61) and isn't the primary one.
    expect(s.players['egypt']!.hand['calamity:epidemic']).toBeUndefined();
    expect((s.negotiation.completed ?? []).length).toBeGreaterThan(0);
    expect(s.log.some((l) => l.includes('egypt') && l.includes('suffers Epidemic'))).toBe(false);
  });

  it('passes rather than respond to an offer it cannot benefit from', async () => {
    // egypt offers iron/ochre wanting salt; babylon holds only wine and gains nothing.
    const s = tradeState({ egypt: { iron: 5, ochre: 1 }, babylon: { wine: 3 } });
    s.negotiation.offers = [{
      id: 1, from: 'egypt', wants: ['salt'], responses: [],
      give: { actual: { iron: 2, ochre: 1 }, declared: { iron: 2, ochre: 1 } },
    }];
    s.negotiation.turnPointer = 1; // babylon's turn
    const respond = await ai.selectAction({ state: s, actor: 'babylon', adapter, rng: new Rng(1) });
    expect(respond.type).toBe('pass');
  });

  it('builds a ship from a coastal foothold with spare tokens', async () => {
    const { areas, adjacency, areaById } = await import('../data/index.js');
    const coast = areas.find((a) => !a.isWater && (adjacency[a.id] ?? []).some((n) => areaById.get(n)?.isWater))!;
    const s = createGame({ players: ['egypt', 'babylon'], seed: 1, maxTurns: 60 });
    s.areas = { [coast.id]: { tokens: { egypt: 6 } } };
    s.players['egypt']!.stock = 55 - 6; s.players['egypt']!.shipsAvailable = 4;
    s.phase = 'shipConstruction'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    const action = await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });
    expect(action.type).toBe('buildShips');
  });
});

describe('heuristic AI', () => {
  it('drives a 3-player game to a winner under a turn cap', async () => {
    let s = createGame({ players: ['egypt', 'babylon', 'crete'], seed: 11, maxTurns: 40 });
    const ai = new HeuristicAI();
    const rng = new Rng(11);
    let steps = 0;
    while (adapter.result(s) == null && steps++ < 20000) {
      const actor = adapter.currentActor(s);
      if (actor == null) break;
      const action = await ai.selectAction({ state: s, actor, adapter, rng });
      s = adapter.applyAction(s, action, actor);
      expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
    }
    const res = adapter.result(s);
    expect(res).not.toBeNull();
    expect(res!.winners.length).toBeGreaterThanOrEqual(1);
  });

  it('builds cities and buys advances over a game (makes real progress)', async () => {
    let s = createGame({ players: ['egypt', 'babylon'], seed: 4, maxTurns: 40 });
    const ai = new HeuristicAI();
    const rng = new Rng(4);
    let steps = 0;
    while (adapter.result(s) == null && steps++ < 20000) {
      const actor = adapter.currentActor(s);
      if (actor == null) break;
      s = adapter.applyAction(s, await ai.selectAction({ state: s, actor, adapter, rng }), actor);
    }
    const totalAdvances = Object.values(s.players).reduce((n, p) => n + p.advances.length, 0);
    expect(totalAdvances).toBeGreaterThan(0);
  });
});
