import { describe, expect, it } from 'vitest';
import { Rng } from 'digital-boardgame-framework';
import { validateData, advanceById, commodities, calamities, pieceCounts } from '../data/index.js';
import {
  commoditySetValue,
  handValue,
  creditTowards,
  netAdvanceCost,
  cardGroupsHeld,
  pieceCensus,
  pieceConservationProblems,
} from './helpers.js';
import { createGame, adapter, victoryScore, normalize, setupTaxation, monotheismTargets, militaryLast, astOrder, censusOrder } from './index.js';
import type { Action, GameState } from './types.js';

describe('data integrity', () => {
  it('has no cross-reference problems', () => {
    expect(validateData()).toEqual([]);
  });
  it('has 114 commodity cards total', () => {
    expect(commodities.reduce((s, c) => s + c.count, 0)).toBe(114);
  });
  it('forms one connected map across all three panels (seam areas merged)', async () => {
    const { areas, adjacency, areaById } = await import('../data/index.js');
    // BFS over the whole adjacency graph from any area.
    const seen = new Set<string>([areas[0]!.id]);
    const stack = [areas[0]!.id];
    while (stack.length) { const x = stack.pop()!; for (const n of adjacency[x] ?? []) if (!seen.has(n)) { seen.add(n); stack.push(n); } }
    expect(seen.size).toBe(areas.length); // single connected component
    // All three panels are represented and therefore mutually reachable.
    const boards = new Set(areas.map((a) => a.board));
    expect(boards).toEqual(new Set(['western', 'main', 'eastern']));
    // Adjacency is symmetric and references only real areas.
    for (const [id, nbrs] of Object.entries(adjacency)) {
      for (const n of nbrs) { expect(areaById.has(n)).toBe(true); expect(adjacency[n]).toContain(id); }
    }
  });
});

describe('calamity trade status (verified vs rules §9.1)', () => {
  it('is exactly 8 tradable / 4 non-tradable', () => {
    expect(calamities.filter((c) => c.tradable).map((c) => c.id).sort()).toEqual(
      ['barbarianhordes', 'civildisorder', 'epidemic', 'iconoclasm', 'piracy', 'slaverevolt', 'superstition', 'treachery'].sort(),
    );
    expect(calamities.filter((c) => !c.tradable).map((c) => c.id).sort()).toEqual(
      ['civilwar', 'famine', 'flood', 'volcano'].sort(),
    );
  });
});

describe('commodity scoring', () => {
  it('values a set as n^2 * value, capped at count', () => {
    expect(commoditySetValue('salt', 3)).toBe(9 * 3); // value 3
    expect(commoditySetValue('gold', 2)).toBe(4 * 9);
    // capped at count (salt count 9)
    expect(commoditySetValue('salt', 99)).toBe(81 * 3);
  });
  it('sums hand value across commodities', () => {
    expect(handValue({ salt: 2, gold: 1 })).toBe(4 * 3 + 1 * 9);
  });
  it('matches the printed card value rows (verified vs rules p.5)', () => {
    // Iron (value 2, 8 cards): 2,8,18,32,50,72,98,128
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => commoditySetValue('iron', n))).toEqual([2, 8, 18, 32, 50, 72, 98, 128]);
    // Wine (value 5, 6 cards): 5,20,45,80,125,180
    expect([1, 2, 3, 4, 5, 6].map((n) => commoditySetValue('wine', n))).toEqual([5, 20, 45, 80, 125, 180]);
    // Ivory (value 9, 4 cards): 9,36,81,144
    expect([1, 2, 3, 4].map((n) => commoditySetValue('ivory', n))).toEqual([9, 36, 81, 144]);
  });
  it('mining bumps the best mineable set by one card', () => {
    const base = handValue({ iron: 2 });
    const mined = handValue({ iron: 2 }, { mining: true });
    expect(mined).toBeGreaterThan(base);
    // iron value 2: set of 3 (18) vs set of 2 (8) => gain 10
    expect(mined - base).toBe(commoditySetValue('iron', 3) - commoditySetValue('iron', 2));
  });
});

describe('advance credits', () => {
  it('pottery credits 10 to other crafts and to democracy/monotheism', () => {
    expect(creditTowards(['pottery'], 'clothmaking')).toBe(10);
    expect(creditTowards(['pottery'], 'democracy')).toBe(10);
    expect(creditTowards(['pottery'], 'astronomy')).toBe(0); // sciences, not credited by pottery
  });
  it('credits reduce net cost but never below zero', () => {
    // engineering (140) gives 20 to philosophy; with many sciences could exceed.
    const owned = ['astronomy', 'coinage', 'medicine', 'engineering', 'mathematics'];
    const net = netAdvanceCost(owned, 'philosophy');
    expect(net).toBeGreaterThanOrEqual(0);
    expect(net).toBeLessThan(advanceById.get('philosophy')!.cost);
  });
  it('counts dual-group cards in both groups', () => {
    // mysticism is Religion + Arts
    const groups = cardGroupsHeld(['mysticism']);
    expect(groups.has('Religion')).toBe(true);
    expect(groups.has('Arts')).toBe(true);
  });
  it('does not grant a freshly-bought card’s credit in the same turn (§31.53)', () => {
    const s = createGame({ players: ['egypt', 'babylon'], seed: 1, maxTurns: 60 });
    s.phase = 'acquireAdvances'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    s.players['egypt']!.hand = {}; s.players['egypt']!.treasury = 80; // pay by treasury only
    // Buy Pottery (45). It credits 10 toward Cloth Making — but not until next turn.
    const after = adapter.applyAction(s, { type: 'buyAdvance', advance: 'pottery', spendCommodities: {}, spendTreasury: 45 }, 'egypt');
    expect(after.players['egypt']!.advances).toContain('pottery');
    // 35 treasury left; Cloth Making costs 45. With the (illegal) same-turn credit it
    // would be affordable; §31.53 forbids it, so this must be rejected.
    expect(() => adapter.applyAction(after, { type: 'buyAdvance', advance: 'clothmaking', spendCommodities: {}, spendTreasury: 35 }, 'egypt')).toThrow(/insufficient/);
  });
});

describe('game setup', () => {
  it('creates a normalized state waiting on an interactive decision', () => {
    const s = createGame({ players: ['egypt', 'babylon', 'crete'], seed: 7 });
    expect(s.turn).toBe(1);
    // After the auto phases (taxation/expansion/census) the first interactive
    // phase with a waiting actor is ship construction.
    expect(adapter.currentActor(s)).not.toBeNull();
    expect(['shipConstruction', 'movement', 'cityConstruction', 'acquireAdvances']).toContain(s.phase);
  });
  it('places one starting token per civ and stocks the rest', () => {
    const s = createGame({ players: ['egypt', 'babylon'], seed: 1 });
    // population should be >=1 each after growth
    for (const id of s.seating) {
      let pop = 0;
      for (const a of Object.values(s.areas)) pop += a.tokens[id] ?? 0;
      expect(pop).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('legal actions are always non-empty and applicable', () => {
  it('every legal action applies without throwing', () => {
    const s = createGame({ players: ['egypt', 'babylon', 'crete'], seed: 3 });
    const actor = adapter.currentActor(s)!;
    const actions = adapter.legalActions(s, actor);
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) {
      expect(() => adapter.applyAction(s, a, actor)).not.toThrow();
    }
  });
});

/** Drive a full game with random-but-legal play; it must terminate with a
 *  winner and never throw or stall. */
function playRandomGame(seed: number, maxTurns = 40): GameState {
  let s = createGame({ players: ['egypt', 'babylon', 'crete', 'assyria'], seed, maxTurns });
  const rng = new Rng(seed ^ 0x9e3779b9);
  let steps = 0;
  while (adapter.result(s) == null && steps++ < 20000) {
    const actor = adapter.currentActor(s);
    if (actor == null) break;
    const actions = adapter.legalActions(s, actor);
    // Bias slightly toward non-pass so the game progresses, but pass is always last.
    const choice = actions.length > 1 && rng.next() < 0.7
      ? actions[rng.int(actions.length - 1)]!
      : { type: 'pass' as const };
    s = adapter.applyAction(s, choice as Action, actor);
  }
  return s;
}

describe('full random playthrough', () => {
  it('terminates with a winner under a turn cap', () => {
    const s = playRandomGame(42, 30);
    const res = adapter.result(s);
    expect(res).not.toBeNull();
    expect(res!.winners.length).toBeGreaterThanOrEqual(1);
  });
  it('is deterministic for a fixed seed', () => {
    const a = playRandomGame(99, 25);
    const b = playRandomGame(99, 25);
    expect(victoryScore(a, a.seating[0]!)).toBe(victoryScore(b, b.seating[0]!));
    expect(a.turn).toBe(b.turn);
  });
});

describe('physical component conservation', () => {
  it('starts with the full fixed supply (55 tokens / 9 cities / 4 ships) per nation', () => {
    const s = createGame({ players: ['egypt', 'babylon', 'crete', 'assyria'], seed: 8 });
    for (const id of s.seating) {
      expect(pieceCensus(s, id)).toEqual({ tokens: 55, cities: 9, ships: 4 });
    }
    expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
  });

  // The invariant: across stock + treasury + board, every nation's tokens,
  // cities and ships must ALWAYS sum to the fixed per-nation totals — checked
  // after every action, across many seeds and player counts.
  it.each([1, 7, 21, 42, 99, 123, 777, 2024])(
    'conserves every nations pieces after every action of a full game (seed %i)',
    (seed) => {
      let s = createGame({ players: ['egypt', 'babylon', 'crete', 'assyria'], seed, maxTurns: 30 });
      const rng = new Rng(seed);
      let steps = 0;
      expect(pieceConservationProblems(s, pieceCounts)).toEqual([]); // at setup
      while (adapter.result(s) == null && steps++ < 20000) {
        const actor = adapter.currentActor(s);
        if (actor == null) break;
        const actions = adapter.legalActions(s, actor);
        const choice = actions.length > 1 && rng.next() < 0.7 ? actions[rng.int(actions.length - 1)]! : { type: 'pass' as const };
        s = adapter.applyAction(s, choice as Action, actor);
        const problems = pieceConservationProblems(s, pieceCounts);
        expect(problems, `seed ${seed} step ${steps} (${s.phase})`).toEqual([]);
      }
      expect(steps).toBeGreaterThan(5);
    },
  );

  it('holds for a 2-player and a 6-player game too', () => {
    for (const players of [['egypt', 'babylon'], ['egypt', 'babylon', 'crete', 'assyria', 'thrace', 'illyria']]) {
      let s = createGame({ players, seed: 55, maxTurns: 20 });
      const rng = new Rng(55);
      let steps = 0;
      while (adapter.result(s) == null && steps++ < 20000) {
        const actor = adapter.currentActor(s);
        if (actor == null) break;
        const actions = adapter.legalActions(s, actor);
        s = adapter.applyAction(s, (actions.length > 1 && rng.next() < 0.6 ? actions[rng.int(actions.length - 1)]! : { type: 'pass' as const }) as Action, actor);
        expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
      }
    }
  });
});

describe('victory scoring', () => {
  it('counts AST, cities, treasury, cards and commodities', () => {
    const s = createGame({ players: ['egypt', 'babylon'], seed: 5 });
    const p = s.players['egypt']!;
    p.treasury = 50;
    p.astSpace = 2;
    p.advances = ['pottery']; // face 45
    p.hand = { salt: 2 }; // 4*3 = 12
    // find an empty area to give egypt a city
    const aid = Object.keys(s.areas)[0]!;
    s.areas[aid] = { tokens: {}, city: 'egypt' };
    const score = victoryScore(s, 'egypt');
    // 45 (advance) + 12 (salt set) + 50 (treasury) + 2*100 (ast) + 1*50 (city)
    expect(score).toBe(45 + 12 + 50 + 200 + 50);
  });
});

describe('movement & trade-card acquisition rules', () => {
  // Advance the game (everyone passing) until it reaches the given phase.
  function advanceToPhase(s: GameState, phase: string, cap = 400): GameState {
    let g = s, n = 0;
    while (g.phase !== phase && n++ < cap) {
      const actor = adapter.currentActor(g);
      if (!actor) break;
      g = adapter.applyAction(g, { type: 'pass' }, actor);
    }
    return g;
  }

  it('accepts a partial-count move via tryApplyAction (subset of a stack)', () => {
    const g = advanceToPhase(createGame({ players: ['egypt', 'babylon'], seed: 7 }), 'movement');
    expect(g.phase).toBe('movement');
    const actor = adapter.currentActor(g)!;
    // Find an area where the actor has >= 2 tokens and a non-water neighbour.
    const moves = adapter.legalActions(g, actor).filter((a): a is Extract<Action, { type: 'move' }> => a.type === 'move' && !a.moves[0]!.byShip);
    const full = moves.find((m) => m.moves[0]!.count >= 2)!;
    expect(full).toBeTruthy();
    const { from, to } = full.moves[0]!;
    const before = g.areas[from]!.tokens[actor]!;
    // Move just ONE token — not an enumerated full-stack option.
    const r = adapter.tryApplyAction(g, { type: 'move', moves: [{ from, to, count: 1 }] }, actor);
    expect(r.ok).toBe(true);
    expect(r.state.areas[from]!.tokens[actor] ?? 0).toBe(before - 1);
    expect(r.state.areas[to]!.tokens[actor] ?? 0).toBe(1);
  });

  it('rejects an illegal move (too many tokens) via tryApplyAction', () => {
    const g = advanceToPhase(createGame({ players: ['egypt', 'babylon'], seed: 7 }), 'movement');
    const actor = adapter.currentActor(g)!;
    const move = adapter.legalActions(g, actor).find((a): a is Extract<Action, { type: 'move' }> => a.type === 'move')!;
    const { from, to } = move.moves[0]!;
    const r = adapter.tryApplyAction(g, { type: 'move', moves: [{ from, to, count: 999 }] }, actor);
    expect(r.ok).toBe(false);
  });

  it('a city-less player draws no trade cards (§27.1)', () => {
    // Everyone passes for a full turn, so no city is ever built.
    let g = createGame({ players: ['egypt', 'babylon'], seed: 7 });
    let n = 0;
    while (g.turn < 2 && n++ < 400) {
      const actor = adapter.currentActor(g);
      if (!actor) break;
      g = adapter.applyAction(g, { type: 'pass' }, actor);
    }
    // A full turn (incl. trade-card acquisition) has elapsed with no cities.
    for (const id of g.seating) {
      const cities = Object.values(g.areas).filter((a) => a.city === id).length;
      const hand = Object.values(g.players[id]!.hand).reduce((x, y) => x + y, 0);
      expect(cities).toBe(0);
      expect(hand).toBe(0);
    }
  });
});

describe('taxation (§19 / §32.421 Coinage)', () => {
  it('auto-taxes a non-Coinage player at rate 2 (no pause)', () => {
    const s = createGame({ players: ['egypt', 'babylon'], seed: 7 });
    // Fresh game: nobody holds Coinage, so taxation never pauses.
    expect(s.phase).not.toBe('taxation');
  });

  it('unpayable cities revolt and are taken over; Democracy is immune (§19.31/.34)', async () => {
    async function run(democracy: boolean) {
      const { areas } = await import('../data/index.js');
      const land = areas.filter((a) => !a.isWater).slice(0, 3).map((a) => a.id);
      const s = createGame({ players: ['egypt', 'babylon'], seed: 7 });
      s.areas = {} as typeof s.areas;
      for (const aid of land) s.areas[aid] = { tokens: {}, city: 'egypt' }; // 3 egypt cities
      s.players['egypt']!.stock = 2; // can only pay for 1 city at rate 2
      s.players['egypt']!.citiesAvailable = 6;
      if (democracy) s.players['egypt']!.advances = ['democracy'];
      s.players['babylon']!.stock = 50; s.players['babylon']!.citiesAvailable = 5; // reserve leader → taker
      s.phase = 'taxation'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
      setupTaxation(s);
      normalize(s); // §19.31: revolts resolve once taxation completes (population-expansion entry)
      return s;
    }
    const revolted = await run(false);
    expect(Object.values(revolted.areas).filter((a) => a.city === 'egypt').length).toBe(1); // 2 revolted
    expect(Object.values(revolted.areas).filter((a) => a.city === 'babylon').length).toBe(2); // taken over
    const democratic = await run(true);
    expect(Object.values(democratic.areas).filter((a) => a.city === 'egypt').length).toBe(3); // none revolt
  });

  it('defers tax revolts until every player has paid (§19.31)', async () => {
    const { areas } = await import('../data/index.js');
    const land = areas.filter((a) => !a.isWater).slice(0, 3).map((a) => a.id);
    const s = createGame({ players: ['egypt', 'babylon'], seed: 7 });
    s.areas = {} as typeof s.areas;
    for (const aid of land) s.areas[aid] = { tokens: {}, city: 'egypt' };
    s.players['egypt']!.stock = 0; s.players['egypt']!.citiesAvailable = 6; // can't pay → all 3 revolt
    s.players['babylon']!.stock = 50; s.players['babylon']!.citiesAvailable = 5;
    s.phase = 'taxation'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    setupTaxation(s);
    expect(s.pendingRevolts!['egypt']).toBe(3); // recorded during taxation, NOT yet resolved
    expect(Object.values(s.areas).filter((a) => a.city === 'egypt').length).toBe(3);
    normalize(s); // taxation completes → revolts settle
    expect(s.pendingRevolts).toEqual({});
    expect(Object.values(s.areas).filter((a) => a.city === 'babylon').length).toBe(3); // taken over
  });

  it('pauses for a Coinage holder with cities to choose their rate, which collects', () => {
    let s = createGame({ players: ['egypt', 'babylon'], seed: 7 });
    // Give egypt Coinage + a city + stock, then re-enter taxation.
    s.players['egypt']!.advances = ['coinage'];
    const land = Object.keys(s.areas)[0]!;
    s.areas[land] = { tokens: { egypt: 1 }, city: 'egypt' };
    s.players['egypt']!.stock = 10; s.players['egypt']!.treasury = 0;
    s.phase = 'taxation'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    setupTaxation(s); // babylon auto-collected; egypt (Coinage + city) left to choose
    normalize(s);
    expect(s.phase).toBe('taxation');
    expect(adapter.currentActor(s)).toBe('egypt');
    const rates = adapter.legalActions(s, 'egypt').filter((a) => a.type === 'setTaxRate');
    expect(rates).toHaveLength(3);
    s = adapter.applyAction(s, { type: 'setTaxRate', rate: 3 }, 'egypt');
    expect(s.players['egypt']!.treasury).toBe(3); // 1 city × rate 3, stock → treasury
    expect(s.phase).not.toBe('taxation'); // advanced past taxation
  });
});

describe('advance refinements (§32.261/.631/.251)', () => {
  it('Mining boosts commodity value in the victory score (§32.261)', () => {
    const s = createGame({ players: ['egypt', 'babylon'], seed: 7 });
    const e = s.players['egypt']!;
    e.treasury = 0; e.astSpace = 0;
    const vs = (adv: string[], hand: Record<string, number>) => { e.advances = adv; e.hand = hand; return victoryScore(s, 'egypt'); };
    const miningBase = vs(['mining'], {});
    const miningIron = vs(['mining'], { iron: 3 }); // set valued as 4 cards: 32
    const plainBase = vs([], {});
    const plainIron = vs([], { iron: 3 }); // set of 3: 18
    expect(miningIron - miningBase).toBe(32); // §32.261 one card larger
    expect(plainIron - plainBase).toBe(18);
  });

  it('Architecture assists only one city per turn (§32.631)', async () => {
    const { areas } = await import('../data/index.js');
    const sites = areas.filter((a) => !a.isWater && a.isCitySite).slice(0, 2).map((a) => a.id);
    let s = createGame({ players: ['egypt', 'babylon'], seed: 7 });
    s.areas = {} as typeof s.areas;
    for (const aid of sites) s.areas[aid] = { tokens: { egypt: 3 } }; // 3 on-board (city site needs 6)
    s.players['egypt']!.advances = ['architecture'];
    s.players['egypt']!.treasury = 20; s.players['egypt']!.citiesAvailable = 9;
    s.phase = 'cityConstruction'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    s = adapter.applyAction(s, { type: 'buildCity', area: sites[0]!, useTreasury: 3 }, 'egypt'); // ok: 3+3
    expect(s.areas[sites[0]!]!.city).toBe('egypt');
    // Second city the same turn can't draw on treasury → 3 on-board < 6 → illegal.
    expect(() => adapter.applyAction(s, { type: 'buildCity', area: sites[1]!, useTreasury: 3 }, 'egypt')).toThrow();
  });

  it('Roadbuilding cannot pass through an area holding an enemy city (§32.251)', async () => {
    const { adjacency, areaById } = await import('../data/index.js');
    const isLand = (id: string) => !areaById.get(id)?.isWater;
    let chain: [string, string, string] | null = null;
    for (const b of Object.keys(adjacency)) {
      if (!isLand(b)) continue;
      const nb = (adjacency[b] ?? []).filter(isLand);
      for (const a of nb) for (const c of nb) {
        if (a !== c && !(adjacency[a] ?? []).includes(c)) { chain = [a, b, c]; break; }
      }
      if (chain) break;
    }
    expect(chain).not.toBeNull();
    const [a, b, c] = chain!;
    const base = () => {
      const s = createGame({ players: ['egypt', 'babylon'], seed: 7 });
      s.areas = {} as typeof s.areas;
      s.areas[a] = { tokens: { egypt: 3 } };
      s.players['egypt']!.advances = ['roadbuilding', 'engineering'];
      s.phase = 'movement'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
      return s;
    };
    // Clear pass-through: the road move is legal.
    let ok = base();
    ok = adapter.applyAction(ok, { type: 'move', moves: [{ from: a, to: c, count: 2, via: b }] }, 'egypt');
    expect(ok.areas[c]!.tokens['egypt']).toBe(2);
    // Enemy city in the pass-through area blocks it.
    const blocked = base();
    blocked.areas[b] = { tokens: {}, city: 'babylon' };
    expect(() => adapter.applyAction(blocked, { type: 'move', moves: [{ from: a, to: c, count: 2, via: b }] }, 'egypt')).toThrow();

    // §32.251: tokens that arrived by road may not then board a ship the same phase.
    const s = base();
    expect(() => adapter.applyAction(s, { type: 'move', moves: [
      { from: a, to: c, count: 2, via: b },
      { from: c, to: a, count: 1, byShip: true },
    ] }, 'egypt')).toThrow(/road into .* board a ship/);
  });
});

describe('commodity-card hand limit (§31.71)', () => {
  it('pauses for the player to choose which surplus cards to discard; calamities are exempt', () => {
    const s = createGame({ players: ['egypt', 'babylon'], seed: 7 });
    s.players['egypt']!.hand = { ochre: 5, gold: 5, 'calamity:flood': 1 }; // 10 commodities + 1 calamity
    s.phase = 'astAdjustment'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    normalize(s); // astAdjustment pauses for the over-limit discard choice

    // §31.71: the over-limit player (egypt) must choose 2 cards to surrender.
    expect(adapter.currentActor(s)).toBe('egypt');
    expect(s.pendingDiscard).toEqual({ holder: 'egypt', count: 2 });
    const offered = adapter.legalActions(s, 'egypt');
    expect(offered).toHaveLength(1);
    expect(offered[0]).toMatchObject({ type: 'chooseDiscard' });
    expect((offered[0] as { cards: string[] }).cards).toEqual(['ochre', 'ochre']); // cheapest-first default

    // The player may pick any 2 commodity cards (here: drop 2 gold, keep the ochre).
    const after = adapter.applyAction(s, { type: 'chooseDiscard', cards: ['gold', 'gold'] }, 'egypt');
    const h = after.players['egypt']!.hand;
    const commodities = Object.entries(h).filter(([c]) => !c.startsWith('calamity:')).reduce((t, [, n]) => t + n, 0);
    expect(commodities).toBe(8); // 8 of 10 kept
    expect(h['gold']).toBe(3); // surrendered the 2 chosen
    expect(h['ochre']).toBe(5); // kept the ochre the player elected to keep
    expect(h['calamity:flood']).toBe(1); // calamity retained, doesn't count toward the 8
    expect(after.pendingDiscard).toBeUndefined(); // resolved; phase resumes

    // Discarding the wrong count is rejected (§31.71).
    expect(() => adapter.applyAction(s, { type: 'chooseDiscard', cards: ['gold'] }, 'egypt')).toThrow(/exactly 2/);
  });
});

describe('A.S.T. order (§17.4)', () => {
  it('is a fixed nation order — Africa first, Iberia second, Egypt last (§17.4)', () => {
    const s = createGame({ players: ['egypt', 'iberia', 'africa', 'babylon'], seed: 7 });
    expect(astOrder(s)).toEqual(['africa', 'iberia', 'babylon', 'egypt']);
    // §17.4 anchors: Africa precedes all, Egypt follows all; Iberia (which replaces
    // Italy on the Western map) takes the second slot.
    const s2 = createGame({ players: ['indus', 'iberia', 'asia', 'africa', 'egypt'], seed: 1 });
    const order = astOrder(s2);
    expect(order[0]).toBe('africa');
    expect(order[1]).toBe('iberia'); // second, ahead of the rest
    expect(order.at(-1)).toBe('egypt');
    expect(order.indexOf('asia')).toBeLessThan(order.indexOf('indus'));
  });

  it('breaks census ties by A.S.T. order, not seating', () => {
    const s = createGame({ players: ['egypt', 'africa'], seed: 7 });
    // Equal population → Africa (lower A.S.T. rank) comes first regardless of seat.
    s.areas = { a: { tokens: { egypt: 1 } }, b: { tokens: { africa: 1 } } } as typeof s.areas;
    expect(censusOrder(s)).toEqual(['africa', 'egypt']);
  });
});

describe('Military move order (§32.831)', () => {
  it('puts Military holders after non-Military, preserving census order within each group', () => {
    const s = createGame({ players: ['egypt', 'babylon', 'crete'], seed: 7 });
    s.players['egypt']!.advances = ['military'];
    s.players['crete']!.advances = ['military'];
    expect(militaryLast(s, ['egypt', 'babylon', 'crete'])).toEqual(['babylon', 'egypt', 'crete']);
    expect(militaryLast(s, ['egypt', 'babylon', 'crete']).slice(-2).sort()).toEqual(['crete', 'egypt']);
  });
});

describe('Monotheism conversion (§32.94)', () => {
  async function twoAdjacentLand() {
    // Find a land area with a land neighbour, both usable.
    const { areas, adjacency } = await import('../data/index.js') as { areas: { id: string; isWater?: boolean }[]; adjacency: Record<string, string[]> };
    const water = new Set(areas.filter((a) => a.isWater).map((a) => a.id));
    for (const a of areas) {
      if (a.isWater) continue;
      const nb = (adjacency[a.id] ?? []).find((n) => !water.has(n));
      if (nb) return [a.id, nb] as const;
    }
    throw new Error('no adjacent land pair');
  }

  it('lets a Monotheism holder take over an adjacent enemy area, replacing pieces', async () => {
    let s = createGame({ players: ['egypt', 'babylon'], seed: 7 });
    const [mine, theirs] = await twoAdjacentLand();
    s.areas = {} as typeof s.areas;
    s.areas[mine] = { tokens: { egypt: 1 } };
    s.areas[theirs] = { tokens: { babylon: 3 }, city: 'babylon' };
    s.players['egypt']!.advances = ['monotheism'];
    s.players['egypt']!.stock = 5; s.players['egypt']!.citiesAvailable = 2;
    const babyStock = s.players['babylon']!.stock;
    s.phase = 'calamity'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    const legal = adapter.legalActions(s, 'egypt').filter((a) => a.type === 'convertArea');
    expect(legal.some((a) => (a as Extract<Action, { type: 'convertArea' }>).area === theirs)).toBe(true);
    s = adapter.applyAction(s, { type: 'convertArea', area: theirs }, 'egypt');
    expect(s.areas[theirs]!.city).toBe('egypt');
    expect(s.areas[theirs]!.tokens['egypt']).toBe(3);
    expect(s.areas[theirs]!.tokens['babylon']).toBeUndefined();
    expect(s.players['babylon']!.stock).toBe(babyStock + 3); // their tokens returned
    expect(s.players['egypt']!.convertedThisTurn).toBe(true);
  });

  it('cannot convert a player who also holds Monotheism or Theology (§32.942/.952)', async () => {
    const s = createGame({ players: ['egypt', 'babylon'], seed: 7 });
    const [mine, theirs] = await twoAdjacentLand();
    s.areas = {} as typeof s.areas;
    s.areas[mine] = { tokens: { egypt: 1 } };
    s.areas[theirs] = { tokens: { babylon: 2 } };
    s.players['egypt']!.advances = ['monotheism']; s.players['egypt']!.stock = 5;
    s.players['babylon']!.advances = ['theology'];
    s.phase = 'calamity'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    const targets = monotheismTargets(s, 'egypt');
    expect(targets).not.toContain(theirs);
  });
});

describe('population expansion (§13 placement when stock-limited)', () => {
  it('auto-grows when stock is ample (no pause at expansion)', () => {
    const ample = createGame({ players: ['egypt', 'babylon'], seed: 7 });
    expect(ample.phase).not.toBe('populationExpansion'); // grew automatically
  });

  it('pauses for the player to place limited tokens', async () => {
    const { areas } = await import('../data/index.js');
    let s = createGame({ players: ['egypt', 'babylon'], seed: 7 });
    const ids = areas.filter((a) => !a.isWater).slice(0, 8).map((a) => a.id); // 8 land areas
    s.areas = {} as typeof s.areas;
    for (const a of ids) s.areas[a] = { tokens: { egypt: 2 } }; // each wants +2 → needs 16 growth
    s.players['egypt']!.stock = 4; s.players['egypt']!.treasury = 20;
    s.players['babylon']!.stock = 4; s.players['babylon']!.treasury = 20;
    s.phase = 'taxation'; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
    setupTaxation(s); // prime taxation (no Coinage → auto-collect; 0 cities → no-op)
    normalize(s); // → population expansion; egypt is stock-short → pauses
    expect(s.phase).toBe('populationExpansion');
    expect(adapter.currentActor(s)).toBe('egypt');
    expect(s.expansion!.remaining['egypt']!).toBeGreaterThan(0);
    const legal = adapter.legalActions(s, 'egypt').filter((a): a is Extract<Action, { type: 'placeTokens' }> => a.type === 'placeTokens');
    expect(legal.length).toBeGreaterThan(0);
    const before = s.players['egypt']!.stock;
    const aid = Object.keys(legal[0]!.placements)[0]!;
    s = adapter.applyAction(s, { type: 'placeTokens', placements: { [aid]: 1 } }, 'egypt');
    expect(s.players['egypt']!.stock).toBe(before - 1);
    expect(s.areas[aid]!.tokens['egypt']).toBe(3); // 2 + 1 placed
  });
});
