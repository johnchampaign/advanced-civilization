import { describe, expect, it } from 'vitest';
import { adapter, createGame, normalize } from './index.js';
import { bundleFace, pieceConservationProblems } from './helpers.js';
import { pieceCounts } from '../data/index.js';
import type { Action, GameState, TradeBundle } from './types.js';

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
  while (guard++ < 500) {
    const actor = adapter.currentActor(s);
    if (actor == null) break;
    if (s.phase === 'trade') { s = adapter.applyAction(s, { type: 'pass' }, actor); continue; }
    // Drive interactive calamity choices (the affected player takes the default).
    if (s.pendingCityChoice || s.pendingUnitLoss || s.pendingAllocation) {
      const suggested = adapter.legalActions(s, actor).find((a) => a.type === 'chooseCities' || a.type === 'chooseUnits' || a.type === 'allocateLoss');
      if (suggested) { s = adapter.applyAction(s, suggested, actor); continue; }
    }
    break;
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
    // from posts an offer (gives salt2+ochre1, wants iron); the turn advances.
    s = adapter.applyAction(s, { type: 'postOffer', give: { actual: { salt: 2, ochre: 1 }, declared: { salt: 2 }, count: 3, claimed: { ochre: 1 } }, wants: ['iron'] }, from);
    expect(adapter.currentActor(s)).toBe(to); // round-robin: turn passed to babylon
    const offerId = s.negotiation.offers[0]!.id;
    // to responds with iron2+hides1; turn advances back to from.
    s = adapter.applyAction(s, { type: 'respondOffer', offerId, give: { actual: { iron: 2, hides: 1 }, declared: { iron: 2 }, count: 3 } }, to);
    // from accepts the response → deal executes.
    s = adapter.applyAction(s, { type: 'acceptResponse', offerId, responder: to }, from);
    expect(s.players[from]!.hand).toEqual({ ochre: 1, iron: 2, hides: 1 });
    expect(s.players[to]!.hand).toEqual({ hides: 1, salt: 2, ochre: 1 });
    expect((s.negotiation.completed ?? []).length).toBe(1);
    expect(s.negotiation.offers.length).toBe(0); // both offers consumed
  });

  it('allows a bluff in the non-binding claims — while secretly giving a calamity (§28.3)', () => {
    let s = toTradePhase(createGame({ players: ['egypt', 'babylon'], seed: 5, maxTurns: 60 }));
    const from = adapter.currentActor(s)!;
    const to = s.seating.find((p) => p !== from)!;
    for (const id of s.seating) s.players[id]!.hand = {};
    s.players[from]!.hand = { salt: 2, 'calamity:epidemic': 1 };
    s.players[to]!.hand = { iron: 3 };
    s.calamityTradedFrom = {};
    // from names "salt, salt" (guaranteed) and claims the third is wine — really Epidemic.
    s = adapter.applyAction(s, { type: 'postOffer', give: { actual: { salt: 2, 'calamity:epidemic': 1 }, declared: { salt: 2 }, count: 3, claimed: { wine: 1 } }, wants: ['iron'] }, from);
    const offerId = s.negotiation.offers[0]!.id;
    // Others see the count, the named cards and the (false) claim — not the calamity.
    const toView = adapter.viewFor(s, to);
    expect(toView.negotiation.offers[0]!.give.declared).toEqual({ salt: 2 });
    expect(toView.negotiation.offers[0]!.give.claimed).toEqual({ wine: 1 });
    expect(toView.negotiation.offers[0]!.give.count).toBe(3);
    expect(toView.negotiation.offers[0]!.give.actual).toEqual({});
    s = adapter.applyAction(s, { type: 'respondOffer', offerId, give: { actual: { iron: 3 }, declared: { iron: 2 }, count: 3, claimed: { iron: 1 } } }, to);
    s = adapter.applyAction(s, { type: 'acceptResponse', offerId, responder: to }, from);
    // The calamity crossed to `to`; provenance recorded; resolves against the recipient.
    expect(s.players[to]!.hand['calamity:epidemic']).toBe(1);
    expect(s.players[from]!.hand['calamity:epidemic']).toBeUndefined();
    expect(s.calamityTradedFrom['epidemic']).toBe(from);
    s = endTrade(s);
    expect(s.log.some((l) => (l.msg ?? '').includes(to) && (l.msg ?? '').includes('Epidemic'))).toBe(true);
    expect(s.log.some((l) => (l.msg ?? '').includes(from) && (l.msg ?? '').includes('suffers Epidemic'))).toBe(false);
  });

  it('rejects offers that break §28.3 (report eb3d4cdf)', () => {
    let s = toTradePhase(createGame({ players: ['egypt', 'babylon'], seed: 9, maxTurns: 60 }));
    const from = adapter.currentActor(s)!;
    s.players[from]!.hand = { salt: 2, ochre: 2, 'calamity:volcano': 1 };
    const bad = (give: TradeBundle, wants: string[] = ['iron'], why?: RegExp) =>
      expect(() => adapter.applyAction(s, { type: 'postOffer', give, wants }, from)).toThrow(why);
    bad({ actual: { salt: 2 }, declared: { salt: 2 }, count: 2 }); // fewer than 3 cards
    bad({ actual: { salt: 2, ochre: 1 }, declared: { salt: 2 }, count: 4 }, ['iron'], /honest number/); // dishonest count
    bad({ actual: { salt: 2, ochre: 1 }, declared: { salt: 2, ochre: 1 } }, ['iron'], /honest number/); // no count (the old form)
    bad({ actual: { salt: 2, ochre: 1 }, declared: { salt: 1 }, count: 3 }, ['iron'], /at least two/); // only one named
    bad({ actual: { salt: 2, ochre: 1 }, declared: { salt: 1, iron: 1 }, count: 3 }, ['iron'], /must really be in the trade/); // a named card is false
    bad({ actual: { salt: 2, ochre: 1 }, declared: { salt: 2 }, count: 3, claimed: { iron: 2 } }, ['iron'], /not named/); // claims more cards than left unnamed
    bad({ actual: { salt: 2, 'calamity:volcano': 1 }, declared: { salt: 2 }, count: 3 }); // non-tradable calamity given
    bad({ actual: { salt: 2, ochre: 1 }, declared: { salt: 2 }, count: 3 }, []); // no wanted commodity
  });

  it('lets the unnamed cards go unspecified, and shows others the count (§28.3)', () => {
    let s = toTradePhase(createGame({ players: ['egypt', 'babylon'], seed: 9, maxTurns: 60 }));
    const from = adapter.currentActor(s)!;
    const to = s.seating.find((p) => p !== from)!;
    s.players[from]!.hand = { salt: 2, ochre: 2 };
    s = adapter.applyAction(s, { type: 'postOffer', give: { actual: { salt: 2, ochre: 2 }, declared: { salt: 2 }, count: 4 }, wants: ['iron'] }, from);
    const face = bundleFace(adapter.viewFor(s, to).negotiation.offers[0]!.give);
    expect(face).toMatchObject({ count: 4, guaranteed: { salt: 2 }, claimed: {}, unspecified: 2, legacy: false });
    // An offer made before this model (no count) reads as all-announced, none guaranteed.
    expect(bundleFace({ declared: { salt: 2, wine: 1 } })).toMatchObject({ count: 3, guaranteed: {}, legacy: true });
  });

  // §27.51: "Trade cards are purchased from the ninth stack immediately after the
  // purchasing player collects his trade cards, before any other players collect
  // their trade cards" (report 797ee201).
  const toCollection = (treasury: Record<string, number>) => {
    const s = createGame({ players: ['egypt', 'babylon'], seed: 11, maxTurns: 60 });
    s.areas['thebes'] = { tokens: {}, city: 'egypt' };
    s.areas['susa'] = { tokens: {}, city: 'babylon' };
    for (const id of s.seating) {
      const p = s.players[id]!;
      p.citiesAvailable -= 1; p.hand = {}; p.treasury = treasury[id] ?? 0;
      let board = 0; for (const a of Object.values(s.areas)) board += a.tokens[id] ?? 0;
      p.stock = 55 - board - p.treasury;
    }
    s.phase = 'tradeAcquisition'; s.ninthStack = undefined; s.activeOrder = [...s.seating]; s.actedThisPhase = [];
    normalize(s);
    return s;
  };
  it('offers Gold/Ivory right after a player draws, before the next player draws (§27.51)', () => {
    let s = toCollection({ egypt: 40 });
    expect(s.ninthStack?.awaiting).toBe(true);
    expect(adapter.currentActor(s)).toBe('egypt');
    const draws = () => s.log.filter((e) => e.kind === 'trade.cards.draw').map((e) => e.side);
    expect(draws()).toEqual(['egypt']); // babylon hasn't drawn yet
    const counts = adapter.legalActions(s, 'egypt').filter((a) => a.type === 'buyTradeCard').map((a) => (a as { count: number }).count);
    expect(counts).toEqual([1, 2]); // 40 treasury buys at most two at 18 each
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
    s = adapter.applyAction(s, { type: 'buyTradeCard', count: 1 }, 'egypt');
    expect(s.players['egypt']!.treasury).toBe(22);
    expect(Object.values(s.players['egypt']!.hand).reduce((x, y) => x + y, 0)).toBe(2); // 1 drawn + 1 bought
    const kinds = s.log.filter((e) => e.kind === 'trade.buyNinth' || e.kind === 'trade.cards.draw').map((e) => `${e.kind}:${e.side}`);
    expect(kinds).toEqual(['trade.cards.draw:egypt', 'trade.buyNinth:egypt', 'trade.cards.draw:babylon']);
    expect(s.ninthStack).toBeUndefined();
    expect(s.phase).toBe('trade');
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
  });
  it('skips the window for players who cannot afford a card, and may be declined', () => {
    let s = toCollection({ babylon: 18 });
    expect(adapter.currentActor(s)).toBe('babylon'); // egypt (0 treasury) drew without pausing
    s = adapter.applyAction(s, { type: 'pass' }, 'babylon');
    expect(s.players['babylon']!.treasury).toBe(18);
    expect(s.log.some((e) => e.kind === 'trade.buyNinth.skip')).toBe(true);
    expect(s.phase).toBe('trade');
  });
  it('no longer sells Gold/Ivory during trading', () => {
    let s = toTradePhase(createGame({ players: ['egypt', 'babylon'], seed: 11, maxTurns: 60 }));
    const actor = adapter.currentActor(s)!;
    s.players[actor]!.stock -= 40; s.players[actor]!.treasury += 40;
    expect(() => adapter.applyAction(s, { type: 'buyTradeCard', count: 1 }, actor)).toThrow(/§27\.51/);
    expect(adapter.legalActions(s, actor).some((a) => a.type === 'buyTradeCard')).toBe(false);
  });

  it('redacts open offers/responses and completed deals per seat', () => {
    let s = toTradePhase(createGame({ players: ['egypt', 'babylon', 'crete'], seed: 13, maxTurns: 60 }));
    const from = adapter.currentActor(s)!;
    const other = s.seating.find((p) => p !== from)!;
    s.players[from]!.hand = { salt: 2, ochre: 1 };
    s = adapter.applyAction(s, { type: 'postOffer', give: { actual: { salt: 2, ochre: 1 }, declared: { salt: 2 }, count: 3, claimed: { ochre: 1 } }, wants: ['iron'] }, from);
    const otherView = adapter.viewFor(s, other);
    expect(otherView.negotiation.offers[0]!.give.declared).toEqual({ salt: 2 });
    expect(otherView.negotiation.offers[0]!.give.count).toBe(3);
    expect(otherView.negotiation.offers[0]!.give.actual).toEqual({}); // actual hidden
    expect(otherView.players[from]!.hand).toEqual({}); // hand hidden
  });
});
