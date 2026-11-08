import { describe, expect, it } from 'vitest';
import { Rng } from 'digital-boardgame-framework';
import { adapter, createGame, normalize } from '../engine/index.js';
import { landNeighbors, navalDestinations, pieceConservationProblems } from '../engine/helpers.js';
import { advances, areaById, commodityById, pieceCounts } from '../data/index.js';
import { availableNations, boardPresets } from '../engine/boards.js';
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

  it('offers fair value when it asks for a valuable card (report 257661f3)', async () => {
    // egypt collects gold; three ochre (3 points) for a 9-point card is a
    // lowball, so it names its better spares and offers ≥ 11 points.
    const s = tradeState({ egypt: { gold: 2, ochre: 3, hides: 2, wine: 1, salt: 1 }, babylon: {} });
    const action = await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });
    expect(action.type).toBe('postOffer');
    if (action.type !== 'postOffer') return;
    expect(action.wants).toEqual(['gold']);
    const worth = Object.entries(action.give.actual).reduce((t, [c, k]) => t + k * ({ ochre: 1, hides: 1, salt: 3, wine: 5 } as Record<string, number>)[c]!, 0);
    expect(worth).toBeGreaterThanOrEqual(11);
    expect(action.give.declared['wine']).toBe(1); // the best card is named (binding)
  });

  it('names other cards it would take as well as its favourite (report c53fa825)', async () => {
    // Its favourite and a card it likes nearly as much; hides would barely help.
    const s = tradeState({ egypt: { spices: 1, oil: 1, grain: 2, wine: 1, cloth: 1, ochre: 3, hides: 1 }, babylon: {} });
    const action = await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });
    expect(action.type).toBe('postOffer');
    if (action.type !== 'postOffer') return;
    expect(action.wants.length).toBeGreaterThan(1);
    expect(action.wants).not.toContain('hides');
    for (const w of action.wants) expect(action.give.actual[w] ?? 0).toBe(0);
  });

  it('answers with both cards when an offer pays for both (report 59c76b15)', async () => {
    const s = tradeState({ egypt: { wine: 2, ochre: 1 }, babylon: { salt: 1, grain: 1, wine: 1, hides: 1, ochre: 1 } });
    s.negotiation.offers = [{
      id: 1, from: 'egypt', wants: ['salt', 'grain'], responses: [],
      give: { actual: { wine: 2, ochre: 1 }, declared: { wine: 2 }, count: 3, claimed: { ochre: 1 } },
    }];
    s.negotiation.turnPointer = 1;
    s.negotiation.posted = { babylon: 3 }; // it has posted its own, so it answers
    const action = await ai.selectAction({ state: s, actor: 'babylon', adapter, rng: new Rng(1) });
    expect(action.type).toBe('respondOffer');
    if (action.type !== 'respondOffer') return;
    expect(action.give.declared).toEqual({ salt: 1, grain: 1 }); // named, so binding
  });

  it('never lowballs, nor pays a better card for a worse one, when spares fall short', async () => {
    const s = tradeState({ egypt: { gold: 1, salt: 1, ochre: 2, hides: 1 }, babylon: {} });
    const action = await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });
    if (action.type === 'postOffer') {
      expect(action.wants).not.toEqual(['gold']);
      expect(action.give.actual['gold'] ?? 0).toBe(0);
    }
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
    expect(s.log.some((l) => (l.msg ?? '').includes('egypt') && (l.msg ?? '').includes('suffers Epidemic'))).toBe(false);
  });

  it('keeps a calamity-dump offer looking fair: asks for a cheap card (report 8697595a)', async () => {
    // Nothing fair to offer for gold, but a tradable calamity to pass on: two
    // hides plus the calamity (claimed as ochre) ask for a card worth about as
    // little — iron, the cheapest commodity the offer doesn't mention — not gold.
    const s = tradeState({ egypt: { gold: 1, hides: 2, 'calamity:epidemic': 1 }, babylon: {} });
    const action = await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });
    expect(action.type).toBe('postOffer');
    if (action.type === 'postOffer') expect(action.wants).toEqual(['iron']);
  });

  it('stops posting offers after a few per phase, so AI-only deals do not run trading to its cap (report 34c4f05f)', async () => {
    const s = tradeState({ egypt: { salt: 3, iron: 2, ochre: 1 }, babylon: {} });
    s.negotiation.posted = { egypt: 3 };
    const action = await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });
    expect(action.type).not.toBe('postOffer');
  });

  it('does not respond to an offer it cannot benefit from', async () => {
    // egypt offers iron/ochre wanting salt; babylon holds only wine and gains nothing.
    const s = tradeState({ egypt: { iron: 5, ochre: 1 }, babylon: { wine: 3 } });
    s.negotiation.offers = [{
      id: 1, from: 'egypt', wants: ['salt'], responses: [],
      // An offer in the pre-§28.3 shape (no count) — also exercises the AI's
      // reading of offers posted before the trade-declaration change.
      give: { actual: { iron: 2, ochre: 1 }, declared: { iron: 2, ochre: 1 } },
    }];
    s.negotiation.turnPointer = 1; // babylon's turn
    const respond = await ai.selectAction({ state: s, actor: 'babylon', adapter, rng: new Rng(1) });
    // It holds three cards and egypt is still trading, so it waits rather than
    // leaving (report d17b8c78) — but it doesn't answer this offer.
    expect(respond.type).toBe('tradeWait');
  });

  const ownOffer = () => ({
    id: 2, from: 'babylon', wants: ['salt'], responses: [],
    give: { actual: { hides: 2, ochre: 1 }, declared: { hides: 2 }, count: 3, claimed: { ochre: 1 } },
  });

  it('hands over a good wanted card when the offer\'s named cards repay it', async () => {
    // egypt names two bronze and asks for wine; babylon's lone wine is its best
    // card, but two bronze (24) outweigh it (5), so it answers with the wine.
    const s = tradeState({ egypt: { bronze: 2, ochre: 1 }, babylon: { wine: 1, ochre: 2, hides: 2 } });
    s.negotiation.offers = [{
      id: 1, from: 'egypt', wants: ['wine'], responses: [],
      give: { actual: { bronze: 2, ochre: 1 }, declared: { bronze: 2 }, count: 3, claimed: { ochre: 1 } },
    }, ownOffer()]; // babylon already has its own offer up, so it turns to answering
    s.negotiation.turnPointer = 1;
    const respond = await ai.selectAction({ state: s, actor: 'babylon', adapter, rng: new Rng(1) });
    expect(respond.type).toBe('respondOffer');
    if (respond.type === 'respondOffer') expect(respond.give.declared['wine']).toBe(1);
  });

  it('keeps a good card when the offer only names cheap ones', async () => {
    const s = tradeState({ egypt: { ochre: 2, hides: 1 }, babylon: { gold: 1, ochre: 1, iron: 2, papyrus: 2 } });
    s.negotiation.offers = [{
      id: 1, from: 'egypt', wants: ['gold'], responses: [],
      give: { actual: { ochre: 2, hides: 1 }, declared: { ochre: 2 }, count: 3, claimed: { hides: 1 } },
    }, ownOffer()];
    s.negotiation.turnPointer = 1;
    const respond = await ai.selectAction({ state: s, actor: 'babylon', adapter, rng: new Rng(1) });
    expect(respond.type).toBe('respondOffer'); // it still answers (it holds ochre) …
    if (respond.type === 'respondOffer') expect(respond.give.actual['gold'] ?? 0).toBe(0); // … but keeps the gold
  });

  it('answers an offer without the asked-for card with cards worth what it names, not ochre and hides (report 11132aca)', async () => {
    // egypt names two bronze (12) and asks for gems; babylon has no gems but
    // collects bronze, so its answer must match the 12, not be its cheapest three.
    const s = tradeState({
      egypt: { bronze: 2, ochre: 1 },
      babylon: { bronze: 1, ochre: 2, hides: 1, salt: 2, timber: 1, 'calamity:epidemic': 1 },
    });
    s.negotiation.offers = [{
      id: 1, from: 'egypt', wants: ['gems'], responses: [],
      give: { actual: { bronze: 2, ochre: 1 }, declared: { bronze: 2 }, count: 3, claimed: { ochre: 1 } },
    }, ownOffer()];
    s.negotiation.turnPointer = 1;
    const respond = await ai.selectAction({ state: s, actor: 'babylon', adapter, rng: new Rng(1) });
    expect(respond.type).toBe('respondOffer');
    if (respond.type !== 'respondOffer') return;
    const worth = Object.entries(respond.give.actual).reduce((t, [c, k]) => t + (commodityById.get(c)?.value ?? 0) * k, 0);
    expect(worth).toBeGreaterThanOrEqual(12);
  });

  it('does not pad an answer with the very goods the offer names (report d382881b)', async () => {
    // egypt names Grain; babylon collects Grain, but answering with its own Grain is no trade.
    const s = tradeState({
      egypt: { grain: 2, ochre: 1 },
      babylon: { grain: 1, ochre: 1, hides: 1, salt: 1, timber: 1 },
    });
    s.negotiation.offers = [{
      id: 1, from: 'egypt', wants: ['gems'], responses: [],
      give: { actual: { grain: 2, ochre: 1 }, declared: { grain: 2 }, count: 3, claimed: { ochre: 1 } },
    }, ownOffer()];
    s.negotiation.turnPointer = 1;
    const respond = await ai.selectAction({ state: s, actor: 'babylon', adapter, rng: new Rng(1) });
    if (respond.type === 'respondOffer') expect(respond.give.actual['grain'] ?? 0).toBe(0);
  });

  it('does not answer an offer just to slip a calamity into junk cards', async () => {
    // Nothing egypt names or wants is in babylon's hand; only the calamity would
    // tempt it, and an ochre-and-hides reply is no answer at all.
    const s = tradeState({ egypt: { bronze: 2, ochre: 1 }, babylon: { hides: 2, iron: 1, 'calamity:epidemic': 1 } });
    s.negotiation.offers = [{
      id: 1, from: 'egypt', wants: ['gems'], responses: [],
      give: { actual: { bronze: 2, ochre: 1 }, declared: { bronze: 2 }, count: 3, claimed: { ochre: 1 } },
    }, ownOffer()];
    s.negotiation.turnPointer = 1;
    const respond = await ai.selectAction({ state: s, actor: 'babylon', adapter, rng: new Rng(1) });
    expect(respond.type).not.toBe('respondOffer');
  });

  it('declines a junk answer to its own offer but takes one naming the card it asked for', async () => {
    const s = tradeState({ egypt: { ochre: 2, hides: 1, gems: 1 }, babylon: { iron: 1, salt: 1, ochre: 1, gems: 1 } });
    const offer = {
      id: 2, from: 'babylon' as PlayerId, wants: ['gems'],
      give: { actual: { iron: 1, salt: 1, ochre: 1 }, declared: { iron: 1, salt: 1 }, count: 3, claimed: { ochre: 1 } },
    };
    const junk = { from: 'egypt' as PlayerId, give: { actual: { ochre: 2, hides: 1 }, declared: { ochre: 2 }, count: 3, claimed: { hides: 1 } } };
    s.negotiation.offers = [{ ...offer, responses: [junk] }];
    s.negotiation.turnPointer = 1;
    const declined = await ai.selectAction({ state: s, actor: 'babylon', adapter, rng: new Rng(1) });
    expect(declined.type).not.toBe('acceptResponse');
    const real = { from: 'egypt' as PlayerId, give: { actual: { gems: 1, ochre: 2 }, declared: { gems: 1, ochre: 1 }, count: 3, claimed: { ochre: 1 } } };
    s.negotiation.offers = [{ ...offer, responses: [real] }];
    const taken = await ai.selectAction({ state: s, actor: 'babylon', adapter, rng: new Rng(1) });
    expect(taken.type).toBe('acceptResponse');
  });

  it('declines an answer that names the card it asked for if the swap costs it a set', async () => {
    const reply = { from: 'egypt' as PlayerId, give: { actual: { gems: 1, ochre: 2 }, declared: { gems: 1, ochre: 1 }, count: 3, claimed: { ochre: 1 } } };
    const s = tradeState({ egypt: { ochre: 2, hides: 1, gems: 1 }, babylon: { bronze: 2, ochre: 1, wine: 1 } });
    s.negotiation.offers = [{
      id: 2, from: 'babylon', wants: ['gems'], responses: [reply],
      give: { actual: { bronze: 2, ochre: 1 }, declared: { bronze: 2 }, count: 3, claimed: { ochre: 1 } },
    }];
    s.negotiation.turnPointer = 1;
    expect((await ai.selectAction({ state: s, actor: 'babylon', adapter, rng: new Rng(1) })).type).not.toBe('acceptResponse');
    // The same swap is worth it when it also gets a calamity off its hands.
    s.players['babylon']!.hand = { bronze: 2, wine: 1, 'calamity:epidemic': 1 };
    s.negotiation.offers = [{
      id: 2, from: 'babylon', wants: ['gems'], responses: [reply],
      give: { actual: { bronze: 2, 'calamity:epidemic': 1 }, declared: { bronze: 2 }, count: 3, claimed: {} },
    }];
    expect((await ai.selectAction({ state: s, actor: 'babylon', adapter, rng: new Rng(1) })).type).toBe('acceptResponse');
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

  it('drives an eight-player §16.2 game (raw-8p board, 47 tokens)', async () => {
    const nations = availableNations(boardPresets(8)[0]!.config);
    expect(nations.length).toBeGreaterThanOrEqual(8);
    let s = createGame({ players: nations.slice(0, 8), seed: 8, maxTurns: 10, boardPreset: 'raw-8p' });
    const rng = new Rng(8);
    let steps = 0;
    while (adapter.result(s) == null && steps++ < 20000) {
      const actor = adapter.currentActor(s);
      if (actor == null) break;
      s = adapter.applyAction(s, await ai.selectAction({ state: s, actor, adapter, rng }), actor);
      expect(pieceConservationProblems(s, { ...pieceCounts, tokens: 47 })).toEqual([]);
    }
    expect(adapter.result(s)).not.toBeNull();
  });

  it('builds cities and buys advances over a game (makes real progress)', async () => {
    let s = createGame({ players: ['egypt', 'babylon'], seed: 4, maxTurns: 40 });
    const started = Object.fromEntries(Object.entries(s.trade.stacks).map(([n, pile]) => [n, pile.length]));
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
    // The public stack counts add up to what's really in each stack.
    expect(Object.keys(s.trade.returned ?? {}).length).toBeGreaterThan(0);
    for (const [n, pile] of Object.entries(s.trade.stacks)) {
      const k = Number(n);
      expect(pile.length).toBe(started[n]! - (s.trade.drawn?.[k] ?? 0) + (s.trade.returned?.[k] ?? 0));
    }
  });
});

describe('heuristic AI: movement and advances (reports 341f4378 / 9b9885cd)', () => {
  /** A state at `phase` with egypt's tokens placed and egypt to act. */
  function at(phase: GameState['phase'], tokens: Record<string, number>): GameState {
    const s = createGame({ players: ['egypt', 'babylon'], seed: 1, maxTurns: 60 });
    s.areas = Object.fromEntries(Object.entries(tokens).map(([aid, n]) => [aid, { tokens: { egypt: n } }]));
    s.players['egypt']!.stock = pieceCounts.tokens - Object.values(tokens).reduce((t, n) => t + n, 0);
    s.phase = phase; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    return s;
  }

  it('gathers for every city it can support and spreads surplus, all in one movement', async () => {
    // 20 tokens on the Nile: enough for two cities (6 each + 2 support each).
    // Memphis (an empty city site) can be filled from Alexandria/Tanis/Fayum.
    const s = at('movement', { alexandria: 5, tanis: 4, fayum: 6, 'upper-egypt': 5 });
    const action = await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });
    expect(action.type).toBe('move');
    const t = adapter.applyAction(s, action, 'egypt');
    const sites = ['alexandria', 'tanis', 'fayum', 'memphis'].filter((aid) => (t.areas[aid]?.tokens['egypt'] ?? 0) >= 6);
    expect(sites.length).toBe(2);
    // Upper Egypt's token over its limit of 4 went to fresh land rather than being lost.
    const seeded = Object.keys(t.areas).filter((aid) => !(aid in s.areas) && aid !== 'memphis' && (t.areas[aid]?.tokens['egypt'] ?? 0) > 0);
    expect(seeded.length).toBeGreaterThan(0);
  });

  it('storms a rival city it can take (§24.3)', async () => {
    // Babylon's city in Memphis, ringed by egypt's tokens; egypt has no city
    // pieces left to build, so its spare strength goes into an assault.
    const s = at('movement', { alexandria: 6, tanis: 6, fayum: 6 });
    s.areas['memphis'] = { tokens: {}, city: 'babylon' };
    s.players['egypt']!.citiesAvailable = 0;
    const action = await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });
    const t = adapter.applyAction(s, action, 'egypt');
    expect(t.areas['memphis']?.tokens['egypt']).toBeGreaterThanOrEqual(7); // enough to storm
    // The passive variant leaves the city alone.
    const calm = await new HeuristicAI({ aggressive: false }).selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });
    const u = adapter.applyAction(s, calm, 'egypt');
    expect(u.areas['memphis']?.tokens['egypt'] ?? 0).toBe(0);
  });

  it('lands tokens by ship to complete a storm force (§23.51)', async () => {
    // Babylon's city in Alexandria: Memphis and Tanis can spare 6 between them,
    // one short of 7; egypt's ship in Gaza brings the seventh.
    const s = at('movement', { memphis: 4, tanis: 4, gaza: 2, thebes: 6 });
    s.areas['gaza']!.ships = { egypt: 1 };
    s.players['egypt']!.shipsAvailable -= 1;
    s.areas['alexandria'] = { tokens: {}, city: 'babylon' };
    s.players['egypt']!.citiesAvailable = 0;
    const action = await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });
    if (action.type !== 'move') throw new Error(`expected a move, got ${action.type}`);
    expect(action.moves).toContainEqual({ from: 'gaza', to: 'alexandria', count: 1, byShip: true });
    const t = adapter.applyAction(s, action, 'egypt');
    expect(t.areas['alexandria']?.tokens['egypt']).toBe(7);
  });

  it('clears Barbarians off land with regular tokens, not just surplus (report 39184c86)', async () => {
    // Tanis has one token over its limit of 3 — not enough alone. Three of its
    // four go after the two Barbarians in Sinai (limit 1) and win, two surviving.
    const s = at('movement', { tanis: 4 });
    s.areas['sinai'] = { tokens: { __barbarian__: 2 } };
    const action = await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });
    if (action.type !== 'move') throw new Error(`expected a move, got ${action.type}`);
    expect(action.moves).toContainEqual({ from: 'tanis', to: 'sinai', count: 3 });
    // Two tokens of a nation are fought only with surplus (here none).
    s.areas['sinai'] = { tokens: { babylon: 2 } };
    s.areas['tanis']!.tokens['egypt'] = 3;
    const calm = await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });
    expect(calm.type === 'move' && calm.moves.some((m) => m.to === 'sinai')).toBe(false);
  });

  it('defends a city a rival could storm, with just enough tokens (§24.41)', async () => {
    // Babylon has 8 tokens next to egypt's Memphis: 7 could storm it. Two
    // defenders leave too few survivors (7 v 2 ends 6 v 0, short of 7).
    const s = at('movement', { alexandria: 4, tanis: 4 });
    s.areas['memphis'] = { tokens: {}, city: 'egypt' };
    s.areas['western-desert'] = { tokens: { babylon: 8 } };
    s.players['egypt']!.citiesAvailable -= 1;
    const action = await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });
    const t = adapter.applyAction(s, action, 'egypt');
    expect(t.areas['memphis']?.tokens['egypt']).toBe(2);
    // No threat, no defenders: they would only be lost to surplus removal.
    delete s.areas['western-desert'];
    const calm = adapter.applyAction(s, await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) }), 'egypt');
    expect(calm.areas['memphis']?.tokens['egypt'] ?? 0).toBe(0);
  });

  it('throws surplus tokens at a rival it can clear off the land (§24.2)', async () => {
    // Tanis holds 6 against a limit of 3: three would be lost to surplus anyway,
    // and three beat Babylon's two in Sinai (limit 1), leaving egypt in charge.
    const s = at('movement', { tanis: 6 });
    s.areas['sinai'] = { tokens: { babylon: 2 } };
    const action = await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });
    expect(action.type).toBe('move');
    if (action.type !== 'move') return;
    expect(action.moves).toContainEqual({ from: 'tanis', to: 'sinai', count: 3 });
  });

  it('scraps a stranded ship instead of paying its upkeep (§22.3, report c2fa4b00)', async () => {
    // A ship left in Nineveh with none of babylon's tokens beside it.
    const s = createGame({ players: ['egypt', 'babylon'], seed: 1, maxTurns: 60 });
    s.areas = { babylon: { tokens: { babylon: 4 } }, niniveh: { tokens: {}, ships: { babylon: 1 } } };
    s.players['babylon']!.stock = pieceCounts.tokens - 4; s.players['babylon']!.shipsAvailable -= 1; s.players['babylon']!.treasury = 5;
    s.phase = 'shipConstruction'; s.activeOrder = ['babylon', 'egypt']; s.actedThisPhase = [];
    s.shipMaintOwed = { babylon: 1, egypt: 0 }; s.shipsBuiltThisPhase = {}; s.shipSteps = {};
    const action = await ai.selectAction({ state: s, actor: 'babylon', adapter, rng: new Rng(1) });
    expect(action).toEqual({ type: 'scrapShip', area: 'niniveh' });
  });

  it("won't build a ship just to carry tokens to a land neighbour (report 03a70fab)", async () => {
    // Elam's lake reaches Nineveh and Lesser Armenia, but both border Elam by
    // land; everything only a ship could reach is taken.
    const s = createGame({ players: ['assyria', 'babylon'], seed: 1, maxTurns: 60 });
    s.areas = {
      elam: { tokens: { assyria: 5 } },
      armenia: { tokens: { babylon: 1 } }, caucasus: { tokens: { babylon: 1 } }, nisa: { tokens: { babylon: 1 } },
    };
    s.players['assyria']!.stock = pieceCounts.tokens - 5; s.players['assyria']!.treasury = 10;
    s.players['babylon']!.stock = pieceCounts.tokens - 3;
    s.phase = 'shipConstruction'; s.activeOrder = ['assyria', 'babylon']; s.actedThisPhase = [];
    s.shipMaintOwed = { assyria: 0, babylon: 0 }; s.shipsBuiltThisPhase = {}; s.shipSteps = {};
    const action = await ai.selectAction({ state: s, actor: 'assyria', adapter, rng: new Rng(1) });
    expect(action.type).toBe('pass');
    // With Nisa open the lake ship is worth having.
    s.areas['nisa'] = { tokens: {} };
    const again = await ai.selectAction({ state: s, actor: 'assyria', adapter, rng: new Rng(1) });
    expect(again.type).toBe('buildShips');
  });

  it('pays for a new ship from treasury so the shore keeps tokens to sail', async () => {
    const { areas, adjacency, areaById } = await import('../data/index.js');
    const coast = areas.find((a) => !a.isWater && a.sustains > 0 && (adjacency[a.id] ?? []).some((n) => areaById.get(n)?.isWater))!;
    const s = at('shipConstruction', { [coast.id]: 4 });
    s.players['egypt']!.treasury = 6;
    const action = await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });
    expect(action.type).toBe('buildShips');
    if (action.type === 'buildShips') expect(action.builds[0]!.payFrom).toBe('treasury');
  });

  it('buys a basket of advances with whole sets, wasting as little as possible', async () => {
    // 97 points of cards: salt ×4 (48), wine ×3 (45), hides ×2 (4).
    const s = at('acquireAdvances', { thebes: 2 });
    s.players['egypt']!.hand = { salt: 4, wine: 3, hides: 2 };
    s.players['egypt']!.treasury = 0;
    const action = await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });
    expect(action.type).toBe('buyAdvance');
    if (action.type !== 'buyAdvance') return;
    expect(action.advances?.length ?? 1).toBeGreaterThanOrEqual(2); // two 45-50 cards, not one
    const t = adapter.applyAction(s, action, 'egypt');
    expect(t.players['egypt']!.advances.length).toBeGreaterThanOrEqual(2);
    // Excess card value is lost (§31.58): spending the whole hand on one card
    // would throw away ~50 points; the pooled purchase overpays by at most a few.
    const buy = t.log.find((e) => e.kind === 'advance.buy')!.payload as { cost: number; paid: number };
    expect(buy.paid - buy.cost).toBeLessThanOrEqual(4);
  });
  it('counts each new colour group, so two-colour Mysticism beats Pottery (reports 2542b4ad, 06164e25)', async () => {
    // A fresh nation with 55 in treasury affords one of them, not both.
    const s = at('acquireAdvances', { thebes: 2 });
    const p = s.players['egypt']!;
    p.hand = {}; p.treasury = 55; p.stock -= 55;
    const action = await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });
    expect(action.type).toBe('buyAdvance');
    if (action.type !== 'buyAdvance') return;
    const bought = action.advances ?? [action.advance];
    expect(bought).toContain('mysticism');
    expect(bought).not.toContain('pottery');
  });
  it('with cities to lose, prefers an advance that softens a calamity (Medicine over Coinage)', async () => {
    // Everything else owned: Coinage nets 50 after credits, Medicine 80, and 80
    // in treasury buys only one. On points per point paid Coinage wins; with
    // three cities, Medicine's halved Epidemic losses (§30.61) tip it.
    const pick = async (cities: string[]) => {
      const s = at('acquireAdvances', { thebes: 2 });
      for (const aid of cities) s.areas[aid] = { tokens: {}, city: 'egypt' };
      const p = s.players['egypt']!;
      p.citiesAvailable -= cities.length;
      p.advances = advances.map((a) => a.id).filter((id) => id !== 'coinage' && id !== 'medicine');
      p.hand = {}; p.treasury = 80; p.stock -= 80;
      const action = await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });
      return action.type === 'buyAdvance' ? action.advance ?? action.advances : action.type;
    };
    expect(await pick([])).toBe('coinage');
    expect(await pick(['memphis', 'tanis', 'sais'])).toBe('medicine');
  });
});

describe('heuristic AI: treasury, stock and tax (report ba6a5bda)', () => {
  /** Egypt at its ninth-stack window (§27.51): one city, `onBoard` tokens. */
  function atNinth(treasury: number, onBoard: number): GameState {
    const s = createGame({ players: ['egypt', 'babylon'], seed: 11, maxTurns: 60 });
    s.areas = { thebes: { tokens: {}, city: 'egypt' }, memphis: { tokens: { egypt: onBoard } }, susa: { tokens: {}, city: 'babylon' } };
    for (const id of s.seating) { const p = s.players[id]!; p.citiesAvailable -= 1; p.hand = {}; p.treasury = id === 'egypt' ? treasury : 0; }
    s.players['egypt']!.stock = pieceCounts.tokens - onBoard - treasury;
    s.players['babylon']!.stock = pieceCounts.tokens;
    s.phase = 'tradeAcquisition'; s.ninthStack = undefined; s.activeOrder = [...s.seating]; s.actedThisPhase = [];
    normalize(s);
    return s;
  }
  const pick = (s: GameState) => ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });

  it('buys Gold/Ivory to grow a set in hand, not as a lone random card', async () => {
    expect(await pick(atNinth(40, 5))).toEqual({ type: 'pass' }); // one card is worth 9, not 18
    const s = atNinth(40, 5);
    s.players['egypt']!.hand['gold'] = (s.players['egypt']!.hand['gold'] ?? 0) + 1;
    expect(await pick(s)).toEqual({ type: 'buyTradeCard', count: 1 });
  });

  it('buys one when next turn’s tax would leave stock short (§19.31)', async () => {
    // 20 in treasury and 34 on the board leaves 1 in stock: not enough for 2 tax.
    expect(await pick(atNinth(20, 34))).toEqual({ type: 'buyTradeCard', count: 1 });
  });

  it('buys past the hand limit only to save a city from revolting (§31.71)', async () => {
    const full = (s: GameState) => { s.players['egypt']!.hand = { ochre: 8, gold: 1 }; return s; };
    expect(await pick(full(atNinth(20, 34)))).toEqual({ type: 'buyTradeCard', count: 1 });
    expect(await pick(full(atNinth(40, 5)))).toEqual({ type: 'pass' }); // stock covers tax: no room, no buy
  });

  it('spreads surplus only as far as treasury can really refill stock', async () => {
    // One city, stock empty, 4 tokens of surplus beside land we hold below its
    // limit: all of it is owed to next turn's tax unless the ninth stack can
    // turn treasury back into stock.
    const around = (id: string) => landNeighbors(null, id).map((n) => areaById.get(n)!);
    const a = [...areaById.values()].find((x) => !x.isWater && !x.isCitySite && x.sustains >= 1 && around(x.id).length > 0
      && around(x.id).every((n) => !n.isCitySite && n.sustains >= 1 && n.sustains <= 2) && around(x.id).some((n) => n.sustains === 2))!;
    const fromSurplus = async (treasury: number, stack9 = true) => {
      const s = createGame({ players: ['egypt', 'babylon'], seed: 11, maxTurns: 60 });
      s.areas = { thebes: { tokens: {}, city: 'egypt' }, [a.id]: { tokens: { egypt: a.sustains + 4 } } };
      for (const n of around(a.id)) s.areas[n.id] = { tokens: { egypt: 1 } };
      const p = s.players['egypt']!;
      p.stock = 0; p.treasury = treasury; p.citiesAvailable -= 1;
      if (!stack9) s.trade.stacks[9] = [];
      s.phase = 'movement'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
      normalize(s);
      const act = await pick(s);
      return act.type === 'move' ? act.moves.filter((m) => m.from === a.id).reduce((n, m) => n + m.count, 0) : 0;
    };
    expect(await fromSurplus(17)).toBe(0); // no card in reach: the surplus stays to pay tax
    expect(await fromSurplus(18)).toBeGreaterThan(0); // a Gold/Ivory card brings 18 back
    expect(await fromSurplus(18, false)).toBe(0); // ...unless the ninth stack is empty
  });
});

describe('heuristic AI: building overseas (§23.51)', () => {
  it('sails tokens to finish a city on a site it holds across the water', async () => {
    const s = createGame({ players: ['egypt', 'babylon'], seed: 11, maxTurns: 60 });
    const land = [...areaById.values()].filter((a) => !a.isWater);
    const pair = land.flatMap((x) => [...navalDestinations(s, x.id, 4, false)].map((to) => [x, areaById.get(to)!] as const))
      .find(([x, to]) => x.sustains >= 2 && !to.isWater && to.isCitySite && !landNeighbors(s, to.id).includes(x.id))!;
    const [from, site] = pair;
    s.areas = { [from.id]: { tokens: { egypt: 12 }, ships: { egypt: 1 } }, [site.id]: { tokens: { egypt: 1 } } };
    s.players['egypt']!.citiesAvailable = 9;
    s.phase = 'movement'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    normalize(s);
    const act = await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });
    if (act.type !== 'move') throw new Error(`expected a move, got ${act.type}`);
    expect(act.moves).toContainEqual({ from: from.id, to: site.id, count: 5, byShip: true });
    expect(act.moves.filter((m) => m.byShip && m.from === from.id)).toHaveLength(1); // one voyage a turn
    adapter.applyAction(s, act, 'egypt');
  });

  /** Two shores with free land only a ship can reach. */
  function shores() {
    const s = createGame({ players: ['egypt', 'babylon'], seed: 11, maxTurns: 60 });
    const shore = [...areaById.values()].filter((x) => !x.isWater && x.sustains >= 2
      && [...navalDestinations(s, x.id, 4, false)].some((to) => !areaById.get(to)!.isWater && !landNeighbors(s, x.id).includes(to)));
    return { s, big: shore[0]!, small: shore[1]!, third: shore[2]!, fourth: shore[3]! };
  }
  const shipPhase = (s: GameState) => {
    s.players['egypt']!.treasury = 10;
    s.phase = 'shipConstruction'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    s.shipMaintOwed = { egypt: 0, babylon: 0 }; s.shipsBuiltThisPhase = {}; s.shipSteps = {};
    return s;
  };

  it('adds a ship on a shore without one, the largest stack first', async () => {
    const { s, big, small, third } = shores();
    s.areas = { [third.id]: { tokens: { egypt: 8 }, ships: { egypt: 1 } }, [small.id]: { tokens: { egypt: 4 } }, [big.id]: { tokens: { egypt: 7 } } };
    s.players['egypt']!.shipsAvailable -= 1;
    const act = await ai.selectAction({ state: shipPhase(s), actor: 'egypt', adapter, rng: new Rng(1) });
    if (act.type !== 'buildShips') throw new Error(`expected buildShips, got ${act.type}`);
    expect(act.builds[0]!.area).toBe(big.id);
  });

  it('stops at a fleet of three', async () => {
    const { s, big, small, third, fourth } = shores();
    s.areas = { [big.id]: { tokens: { egypt: 8 }, ships: { egypt: 1 } }, [small.id]: { tokens: { egypt: 8 }, ships: { egypt: 1 } }, [third.id]: { tokens: { egypt: 8 }, ships: { egypt: 1 } }, [fourth.id]: { tokens: { egypt: 8 } } };
    s.players['egypt']!.shipsAvailable -= 3;
    const act = await ai.selectAction({ state: shipPhase(s), actor: 'egypt', adapter, rng: new Rng(1) });
    expect(act.type).not.toBe('buildShips');
  });
});

describe('heuristic AI: tokens head for open city sites', () => {
  const land = [...areaById.values()].filter((a) => !a.isWater);
  const nearSite = (id: string) => [id, ...landNeighbors(null, id)].some((n) => areaById.get(n)!.isCitySite);

  it('places limited growth beside an open site before bigger land elsewhere', async () => {
    const big = land.find((a) => a.sustains >= 2 && !nearSite(a.id))!;
    const site = land.find((a) => a.isCitySite && a.id !== big.id)!;
    const near = landNeighbors(null, site.id).find((n) => !areaById.get(n)!.isWater)!;
    const s = createGame({ players: ['egypt', 'babylon'], seed: 11, maxTurns: 60 });
    s.areas = { [big.id]: { tokens: { egypt: 3 } }, [near]: { tokens: { egypt: 1 } } };
    s.players['egypt']!.stock = 1;
    s.phase = 'populationExpansion'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    s.expansion = { remaining: { egypt: 1 }, caps: { egypt: { [big.id]: 2, [near]: 1 } }, placed: {} };
    const act = await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });
    expect(act).toEqual({ type: 'placeTokens', placements: { [near]: 1 } });
  });

  it('spreads surplus onto land beside an open site first', async () => {
    const from = land.find((a) => {
      if (a.isCitySite || a.sustains < 1 || nearSite(a.id)) return false;
      const ns = landNeighbors(null, a.id).map((n) => areaById.get(n)!).filter((n) => n.sustains >= 1);
      const bySite = (id: string) => landNeighbors(null, id).some((m) => areaById.get(m)!.isCitySite);
      return ns.length >= 2 && !bySite(ns[0]!.id) && ns.some((n) => bySite(n.id)); // map order alone would pick wrong
    })!;
    const s = createGame({ players: ['egypt', 'babylon'], seed: 11, maxTurns: 60 });
    s.areas = { [from.id]: { tokens: { egypt: from.sustains + 1 } } };
    s.players['egypt']!.stock = 30;
    s.phase = 'movement'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    normalize(s);
    const act = await ai.selectAction({ state: s, actor: 'egypt', adapter, rng: new Rng(1) });
    if (act.type !== 'move') throw new Error(`expected a move, got ${act.type}`);
    expect(act.moves).toHaveLength(1);
    expect(landNeighbors(null, act.moves[0]!.to).some((m) => areaById.get(m)!.isCitySite)).toBe(true);
  });
});

describe('heuristic AI: start areas (§16.3)', () => {
  it('chooses start areas and plays on from them', async () => {
    let s = createGame({ players: ['egypt', 'babylon', 'assyria'], seed: 5, maxTurns: 3, chooseStartAreas: true });
    const rng = new Rng(5);
    let guard = 0;
    while (s.pendingStart && guard++ < 10) {
      const actor = adapter.currentActor(s)!;
      const action = await ai.selectAction({ state: s, actor, adapter, rng });
      expect(action.type).toBe('placeStart');
      s = adapter.applyAction(s, action, actor);
    }
    expect(s.pendingStart).toBeUndefined();
    let steps = 0;
    while (adapter.result(s) == null && steps++ < 3000) {
      const actor = adapter.currentActor(s);
      if (actor == null) break;
      s = adapter.applyAction(s, await ai.selectAction({ state: s, actor, adapter, rng }), actor);
      expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
    }
    expect(adapter.result(s)).not.toBeNull();
  });
  it('steers away from a rival who has already placed next door', async () => {
    const pick = async (s: GameState) => (await ai.selectAction({ state: s, actor: 'persia', adapter, rng: new Rng(1) })) as { type: string; area?: string };
    const s = createGame({ players: ['babylon', 'persia'], seed: 1, chooseStartAreas: true });
    // On an empty board Persia takes fertile Nisa (population limit 5).
    const alone: GameState = { ...s, pendingStart: { order: ['persia', 'babylon'] } };
    expect((await pick(alone)).area).toBe('nisa');
    // With Babylon already in Media, right next to Nisa, Persia starts elsewhere.
    let t: GameState = { ...s, pendingStart: { order: ['babylon', 'persia'] } };
    t = adapter.applyAction(t, { type: 'placeStart', area: 'media' }, 'babylon');
    const choice = (await pick(t)).area;
    expect(choice).not.toBe('nisa');
    expect(['prophtasia', 'randamar']).toContain(choice);
  });
});

describe('heuristic AI: taking calamity losses', () => {
  const players = availableNations(boardPresets(8)[0]!.config).slice(0, 8);
  const me = players[0]!;
  const newGame = () => createGame({ players, seed: 1, maxTurns: 60, boardPreset: 'raw-8p' });
  const land = [...areaById.values()].filter((a) => !a.isWater);
  const sites = (n: number, sustains?: number) => land.filter((a) => a.isCitySite && (sustains === undefined || a.sustains === sustains)).slice(0, n).map((a) => a.id);

  /** One nation alone on the board with these cities and tokens, at a Famine loss. */
  function lossState(cities: string[], tokens: Record<string, number>, points = 10): GameState {
    const s = newGame();
    s.areas = {};
    for (const c of cities) s.areas[c] = { tokens: {}, city: me };
    for (const [aid, n] of Object.entries(tokens)) s.areas[aid] = { tokens: { [me]: n } };
    s.phase = 'calamity';
    s.pendingUnitLoss = { calamityId: 'famine', holder: me, points, cityWorth: 5, mode: 'remove', before: {}, overviewBefore: '' };
    return s;
  }
  /** Fill open land to its limit until there are `want` tokens. */
  function fill(want: number, skip: string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const a of land) {
      if (want <= 0) break;
      if (a.sustains < 2 || skip.includes(a.id)) continue;
      out[a.id] = Math.min(a.sustains, want);
      want -= out[a.id]!;
    }
    return out;
  }
  const choose = async (s: GameState) => {
    const act = await ai.selectAction({ state: s, actor: me, adapter, rng: new Rng(1) });
    if (act.type !== 'chooseUnits') throw new Error(`expected chooseUnits, got ${act.type}`);
    return act;
  };

  it('keeps its cities when enough tokens remain to support them, and holds its land', async () => {
    const cities = sites(3);
    const tokens = fill(24, cities);
    const act = await choose(lossState(cities, tokens));
    expect(act.cities).toEqual([]);
    expect(Object.values(act.tokens).reduce((t, n) => t + n, 0)).toBe(10);
    // Tokens come from stacks that growth refills, so no area is emptied.
    for (const [aid, n] of Object.entries(act.tokens)) expect(n).toBeLessThan(tokens[aid]!);
  });

  it('gives up a city towards the loss when losing tokens would cost it anyway', async () => {
    const cities = sites(3);
    const s = lossState(cities, fill(11, cities));
    const act = await choose(s);
    // Ten tokens would leave one, so support would take cities as well. A city
    // given up counts for five, saving five tokens — which support the other two.
    expect(act.cities).toHaveLength(1);
    expect(Object.values(act.tokens).reduce((t, n) => t + n, 0) - (act.cityKeep?.[act.cities[0]!] ?? 0)).toBe(5);
    const next = adapter.applyAction(s, act, me);
    expect(Object.values(next.areas).filter((a) => a.city === me)).toHaveLength(2);
  });

  it('reduces the city whose replacement tokens end a support shortfall', async () => {
    const small = sites(1, 2)[0]!, big = sites(1, 4)[0]!;
    const third = sites(3).find((c) => c !== small && c !== big)!;
    const s = lossState([small, big, third], fill(1, [small, big, third]));
    s.pendingUnitLoss = undefined;
    // Three cities on one token is five short. Reducing a city frees two and adds
    // the tokens that replace it, so only the larger area covers that at once.
    s.pendingSupport = { holder: me, candidates: [small, big], lock: 0, mode: 'support' };
    const act = await ai.selectAction({ state: s, actor: me, adapter, rng: new Rng(1) });
    expect(act).toEqual({ type: 'chooseCities', areas: [big] });
  });
});
