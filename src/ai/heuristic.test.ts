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
  s.negotiation = { turnPointer: 0, passStreak: 0, pendingOffer: null };
  return s;
}

describe('AI trade negotiation', () => {
  it('proposes and completes a mutually-beneficial set-building swap', async () => {
    // egypt collects salt, babylon collects iron; each holds spares of the other's
    // commodity plus a junk card.
    let s = tradeState({
      egypt: { salt: 3, iron: 2, ochre: 1 },
      babylon: { iron: 3, salt: 2, hides: 1 },
    });
    const propose = await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });
    expect(propose.type).toBe('proposeTrade');
    s = adapter.applyAction(s, propose, 'egypt');
    expect(adapter.currentActor(s)).toBe('babylon');
    const respond = await ai.selectAction({ state: s, actor: 'babylon', adapter, rng: new Rng(1) });
    expect(respond.type).toBe('respondTrade');
    expect((respond as { accept: boolean }).accept).toBe(true);
    s = adapter.applyAction(s, respond, 'babylon');
    // Both grew their collections.
    expect(s.players['egypt']!.hand['salt']).toBe(5);
    expect(s.players['babylon']!.hand['iron']).toBe(5);
  });

  it('dumps a tradable calamity onto the trade partner', async () => {
    let s = tradeState({
      egypt: { salt: 3, iron: 2, 'calamity:epidemic': 1 },
      babylon: { iron: 3, salt: 2, hides: 1 },
    });
    s = adapter.applyAction(s, await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) }), 'egypt');
    s = adapter.applyAction(s, await ai.selectAction({ state: s, actor: 'babylon', adapter, rng: new Rng(1) }), 'babylon');
    // The calamity slipped across with the undeclared card.
    expect(s.players['egypt']!.hand['calamity:epidemic']).toBeUndefined();
    expect(s.players['babylon']!.hand['calamity:epidemic']).toBe(1);
    expect(s.calamityTradedFrom['epidemic']).toBe('egypt');
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

  it('proposes blind — it never inspects the opponent\'s hand', async () => {
    // The partner's hand is empty: a hand-peeking planner would find no willing
    // partner and pass. A multiplayer-fair (blind) planner still proposes.
    const s = tradeState({ egypt: { salt: 3, iron: 2, ochre: 1 }, babylon: {} });
    const action = await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });
    expect(action.type).toBe('proposeTrade');
    expect((action as { to: string }).to).toBe('babylon');
  });

  it('declines a trade it cannot fulfil or gain from', async () => {
    // babylon is asked for salt it does not have, and gains nothing.
    let s = tradeState({ egypt: { iron: 5, ochre: 1 }, babylon: { wine: 3 } });
    // Force a pending offer egypt->babylon requesting salt.
    s.negotiation.pendingOffer = {
      from: 'egypt', to: 'babylon',
      offer: { actual: { iron: 2, ochre: 1 }, declared: { iron: 2 } },
      request: { count: 3, declared: { salt: 2 } },
    };
    const respond = await ai.selectAction({ state: s, actor: 'babylon', adapter, rng: new Rng(1) });
    expect((respond as { accept: boolean }).accept).toBe(false);
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
