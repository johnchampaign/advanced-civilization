import { describe, expect, it } from 'vitest';
import { Rng } from 'digital-boardgame-framework';
import { adapter, createGame } from '../engine/index.js';
import { pieceConservationProblems } from '../engine/helpers.js';
import { pieceCounts } from '../data/index.js';
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

  it('passes rather than respond to an offer it cannot benefit from', async () => {
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
    expect(respond.type).toBe('pass');
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

