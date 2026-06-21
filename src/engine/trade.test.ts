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

describe('trade negotiation (open-offer board)', () => {
  it('reaches the trade phase with an actor to act', () => {
    const s = toTradePhase(createGame({ players: ['egypt', 'babylon', 'crete'], seed: 7, maxTurns: 60 }));
    expect(s.phase).toBe('trade');
    expect(adapter.currentActor(s)).not.toBeNull();
  });

  it('posts an offer, a partner responds, and the owner accepts — swapping the actual cards', () => {
    let s = toTradePhase(createGame({ players: ['egypt', 'babylon'], seed: 3, maxTurns: 60 }));
    const from = adapter.currentActor(s)!;
    const to = s.seating.find((p) => p !== from)!;
    s.players[from]!.hand = { salt: 2, ochre: 2 };
    s.players[to]!.hand = { iron: 2, hides: 2 };
    // from posts an offer (gives salt2+ochre1, wants iron).
    s = adapter.applyAction(s, { type: 'postOffer', give: { actual: { salt: 2, ochre: 1 }, declared: { salt: 2, ochre: 1 } }, wants: ['iron'] }, from);
    expect(adapter.currentActor(s)).toBe(from); // turn stays until you pass
    const offerId = s.negotiation.offers[0]!.id;
    s = adapter.applyAction(s, { type: 'pass' }, from); // yield to babylon
    // to responds with iron2+hides1.
    s = adapter.applyAction(s, { type: 'respondOffer', offerId, give: { actual: { iron: 2, hides: 1 }, declared: { iron: 2, hides: 1 } } }, to);
    s = adapter.applyAction(s, { type: 'pass' }, to);
    // from accepts the response → deal executes.
    s = adapter.applyAction(s, { type: 'acceptResponse', offerId, responder: to }, from);
    expect(s.players[from]!.hand).toEqual({ ochre: 1, iron: 2, hides: 1 });
    expect(s.players[to]!.hand).toEqual({ hides: 1, salt: 2, ochre: 1 });
    expect((s.negotiation.completed ?? []).length).toBe(1);
    expect(s.negotiation.offers.length).toBe(0); // both offers consumed
  });

  it('allows a bluff — announcing a false card name while secretly giving another (incl. a calamity)', () => {
    let s = toTradePhase(createGame({ players: ['egypt', 'babylon'], seed: 5, maxTurns: 60 }));
    const from = adapter.currentActor(s)!;
    const to = s.seating.find((p) => p !== from)!;
    for (const id of s.seating) s.players[id]!.hand = {};
    s.players[from]!.hand = { salt: 2, 'calamity:epidemic': 1 };
    s.players[to]!.hand = { iron: 3 };
    s.calamityTradedFrom = {};
    // from announces "salt, salt, wine" but actually gives salt,salt + Epidemic (the bluff).
    s = adapter.applyAction(s, { type: 'postOffer', give: { actual: { salt: 2, 'calamity:epidemic': 1 }, declared: { salt: 2, wine: 1 } }, wants: ['iron'] }, from);
    const offerId = s.negotiation.offers[0]!.id;
    // Others see the bluffed declaration, not the calamity.
    const toView = adapter.viewFor(s, to);
    expect(toView.negotiation.offers[0]!.give.declared).toEqual({ salt: 2, wine: 1 });
    expect(toView.negotiation.offers[0]!.give.actual).toEqual({});
    s = adapter.applyAction(s, { type: 'pass' }, from);
    s = adapter.applyAction(s, { type: 'respondOffer', offerId, give: { actual: { iron: 3 }, declared: { iron: 3 } } }, to);
    s = adapter.applyAction(s, { type: 'pass' }, to);
    s = adapter.applyAction(s, { type: 'acceptResponse', offerId, responder: to }, from);
    // The calamity crossed to `to`; provenance recorded; resolves against the recipient.
    expect(s.players[to]!.hand['calamity:epidemic']).toBe(1);
    expect(s.players[from]!.hand['calamity:epidemic']).toBeUndefined();
    expect(s.calamityTradedFrom['epidemic']).toBe(from);
    s = endTrade(s);
    expect(s.log.some((l) => l.includes(to) && l.includes('Epidemic'))).toBe(true);
    expect(s.log.some((l) => l.includes(from) && l.includes('suffers Epidemic'))).toBe(false);
  });

  it('rejects illegal offers (too few cards, <2 truthful, dishonest count, non-tradable calamity)', () => {
    let s = toTradePhase(createGame({ players: ['egypt', 'babylon'], seed: 9, maxTurns: 60 }));
    const from = adapter.currentActor(s)!;
    s.players[from]!.hand = { salt: 2, ochre: 2, 'calamity:volcano': 1 };
    const bad = (give: { actual: Record<string, number>; declared: Record<string, number> }, wants: string[] = ['iron']) =>
      expect(() => adapter.applyAction(s, { type: 'postOffer', give, wants }, from)).toThrow();
    bad({ actual: { salt: 2 }, declared: { salt: 2 } }); // fewer than 3 cards
    bad({ actual: { salt: 2, ochre: 1 }, declared: { salt: 1, ochre: 1 } }); // dishonest count (declared 2 ≠ actual 3)
    bad({ actual: { salt: 2, ochre: 1 }, declared: { iron: 2, wine: 1 } }); // <2 truthful (all bluffed)
    bad({ actual: { salt: 2, 'calamity:volcano': 1 }, declared: { salt: 2, ochre: 1 } }); // non-tradable calamity given
    bad({ actual: { salt: 2, ochre: 1 }, declared: { salt: 2, ochre: 1 } }, []); // no wanted commodity
  });

  it('buying a ninth-stack card converts treasury to a card + stock (conserved)', () => {
    let s = toTradePhase(createGame({ players: ['egypt', 'babylon'], seed: 11, maxTurns: 60 }));
    const actor = adapter.currentActor(s)!;
    s.players[actor]!.stock -= 40;
    s.players[actor]!.treasury += 40;
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
    const handBefore = Object.values(s.players[actor]!.hand).reduce((a, b) => a + b, 0);
    s = adapter.applyAction(s, { type: 'buyTradeCard', count: 1 }, actor);
    expect(s.players[actor]!.treasury).toBe(22);
    const handAfter = Object.values(s.players[actor]!.hand).reduce((a, b) => a + b, 0);
    expect(handAfter).toBe(handBefore + 1);
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
  });

  it('redacts open offers/responses and completed deals per seat', () => {
    let s = toTradePhase(createGame({ players: ['egypt', 'babylon', 'crete'], seed: 13, maxTurns: 60 }));
    const from = adapter.currentActor(s)!;
    const other = s.seating.find((p) => p !== from)!;
    s.players[from]!.hand = { salt: 2, ochre: 1 };
    s = adapter.applyAction(s, { type: 'postOffer', give: { actual: { salt: 2, ochre: 1 }, declared: { salt: 2, ochre: 1 } }, wants: ['iron'] }, from);
    const otherView = adapter.viewFor(s, other);
    expect(otherView.negotiation.offers[0]!.give.declared).toEqual({ salt: 2, ochre: 1 });
    expect(otherView.negotiation.offers[0]!.give.actual).toEqual({}); // actual hidden
    expect(otherView.players[from]!.hand).toEqual({}); // hand hidden
  });
});
