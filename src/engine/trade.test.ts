import { describe, expect, it } from 'vitest';
import { adapter, createGame } from './index.js';
import { pieceConservationProblems } from './helpers.js';
import { pieceCounts } from '../data/index.js';
import type { Action, GameState } from './types.js';

/** Advance (by passing) until the interactive trade phase is reached. */
function toTradePhase(s: GameState): GameState {
  let guard = 0;
  while (s.phase !== 'trade' && adapter.result(s) == null && guard++ < 500) {
    const actor = adapter.currentActor(s);
    if (actor == null) break;
    s = adapter.applyAction(s, { type: 'pass' }, actor);
  }
  return s;
}

/** End the trade phase by having everyone pass until it's over. */
function endTrade(s: GameState): GameState {
  let guard = 0;
  while (s.phase === 'trade' && guard++ < 500) {
    const actor = adapter.currentActor(s);
    if (actor == null) break;
    s = adapter.applyAction(s, { type: 'pass' }, actor);
  }
  return s;
}

describe('trade negotiation', () => {
  it('reaches the trade phase with an actor to propose', () => {
    const s = toTradePhase(createGame({ players: ['egypt', 'babylon', 'crete'], seed: 7, maxTurns: 60 }));
    expect(s.phase).toBe('trade');
    expect(adapter.currentActor(s)).not.toBeNull();
  });

  it('executes a valid 3-for-3 trade, swapping the actual cards', () => {
    let s = toTradePhase(createGame({ players: ['egypt', 'babylon'], seed: 3, maxTurns: 60 }));
    const from = adapter.currentActor(s)!;
    const to = s.seating.find((p) => p !== from)!;
    // Give both players known hands.
    s.players[from]!.hand = { salt: 2, ochre: 2 };
    s.players[to]!.hand = { iron: 2, hides: 2 };
    s = adapter.applyAction(s, {
      type: 'proposeTrade', to,
      offer: { actual: { salt: 2, ochre: 1 }, declared: { salt: 2 } },
      request: { count: 3, declared: { iron: 2 } },
    }, from);
    // Now the target must respond.
    expect(adapter.currentActor(s)).toBe(to);
    s = adapter.applyAction(s, {
      type: 'respondTrade', accept: true,
      give: { actual: { iron: 2, hides: 1 }, declared: { iron: 2 } },
    }, to);
    // Cards swapped: from gave salt2+ochre1, received iron2+hides1.
    expect(s.players[from]!.hand).toEqual({ ochre: 1, iron: 2, hides: 1 });
    expect(s.players[to]!.hand).toEqual({ hides: 1, salt: 2, ochre: 1 });
  });

  it('passes a tradable calamity hidden among undeclared cards; recipient becomes victim', () => {
    let s = toTradePhase(createGame({ players: ['egypt', 'babylon'], seed: 5, maxTurns: 60 }));
    const from = adapter.currentActor(s)!;
    const to = s.seating.find((p) => p !== from)!;
    // Clean, controlled hands: proposer hides Epidemic (a tradable calamity)
    // as the undeclared third card.
    for (const id of s.seating) s.players[id]!.hand = {};
    s.players[from]!.hand = { salt: 2, 'calamity:epidemic': 1 };
    s.players[to]!.hand = { iron: 3 };
    s.calamityTradedFrom = {};
    s = adapter.applyAction(s, {
      type: 'proposeTrade', to,
      offer: { actual: { salt: 2, 'calamity:epidemic': 1 }, declared: { salt: 2 } },
      request: { count: 3, declared: { iron: 2 } },
    }, from);
    s = adapter.applyAction(s, {
      type: 'respondTrade', accept: true,
      give: { actual: { iron: 3 }, declared: { iron: 2 } },
    }, to);
    // The calamity is now held by `to`, and provenance recorded.
    expect(s.players[to]!.hand['calamity:epidemic']).toBe(1);
    expect(s.players[from]!.hand['calamity:epidemic']).toBeUndefined();
    expect(s.calamityTradedFrom['epidemic']).toBe(from);
    // Resolve: end trading -> calamity phase runs.
    s = endTrade(s);
    // Card discarded after resolution; the recipient took the hit, not the giver.
    expect(s.players[to]!.hand['calamity:epidemic']).toBeUndefined();
    expect(s.log.some((l) => l.includes(to) && l.includes('Epidemic'))).toBe(true);
    expect(s.log.some((l) => l.includes(from) && l.includes('suffers Epidemic'))).toBe(false);
  });

  it('rejects illegal proposals', () => {
    let s = toTradePhase(createGame({ players: ['egypt', 'babylon'], seed: 9, maxTurns: 60 }));
    const from = adapter.currentActor(s)!;
    const to = s.seating.find((p) => p !== from)!;
    s.players[from]!.hand = { salt: 2, ochre: 2, 'calamity:volcano': 1 };
    const bad = (a: Action) => expect(() => adapter.applyAction(s, a, from)).toThrow();
    // fewer than 3 cards
    bad({ type: 'proposeTrade', to, offer: { actual: { salt: 2 }, declared: { salt: 2 } }, request: { count: 3, declared: { iron: 2 } } });
    // fewer than 2 declared
    bad({ type: 'proposeTrade', to, offer: { actual: { salt: 2, ochre: 1 }, declared: { salt: 1 } }, request: { count: 3, declared: { iron: 2 } } });
    // declared not truthfully in actual
    bad({ type: 'proposeTrade', to, offer: { actual: { salt: 2, ochre: 1 }, declared: { iron: 2 } }, request: { count: 3, declared: { iron: 2 } } });
    // includes a NON-tradable calamity (Volcano)
    bad({ type: 'proposeTrade', to, offer: { actual: { salt: 2, 'calamity:volcano': 1 }, declared: { salt: 2 } }, request: { count: 3, declared: { iron: 2 } } });
    // request fewer than 3
    bad({ type: 'proposeTrade', to, offer: { actual: { salt: 2, ochre: 1 }, declared: { salt: 2 } }, request: { count: 2, declared: { iron: 2 } } });
  });

  it('buying a ninth-stack card converts treasury to a card + stock (conserved)', () => {
    let s = toTradePhase(createGame({ players: ['egypt', 'babylon'], seed: 11, maxTurns: 60 }));
    const actor = adapter.currentActor(s)!;
    // Move tokens stock -> treasury (don't invent pieces) so conservation holds.
    s.players[actor]!.stock -= 40;
    s.players[actor]!.treasury += 40;
    const before = pieceConservationProblems(s, pieceCounts);
    expect(before).toEqual([]);
    const handBefore = Object.values(s.players[actor]!.hand).reduce((a, b) => a + b, 0);
    s = adapter.applyAction(s, { type: 'buyTradeCard', count: 1 }, actor);
    expect(s.players[actor]!.treasury).toBe(22); // 40 - 18
    const handAfter = Object.values(s.players[actor]!.hand).reduce((a, b) => a + b, 0);
    expect(handAfter).toBe(handBefore + 1);
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]); // tokens conserved
  });

  it('hides opponent hands and the actual cards of a pending offer', () => {
    let s = toTradePhase(createGame({ players: ['egypt', 'babylon'], seed: 13, maxTurns: 60 }));
    const from = adapter.currentActor(s)!;
    const to = s.seating.find((p) => p !== from)!;
    s.players[from]!.hand = { salt: 2, ochre: 1 };
    s = adapter.applyAction(s, {
      type: 'proposeTrade', to,
      offer: { actual: { salt: 2, ochre: 1 }, declared: { salt: 2 } },
      request: { count: 3, declared: { iron: 2 } },
    }, from);
    const toView = adapter.viewFor(s, to);
    // Responder sees the declaration but not the proposer's actual cards.
    expect(toView.negotiation.pendingOffer!.offer.declared).toEqual({ salt: 2 });
    expect(toView.negotiation.pendingOffer!.offer.actual).toEqual({});
    // And cannot see the proposer's hand.
    expect(toView.players[from]!.hand).toEqual({});
  });
});
