import { describe, expect, it } from 'vitest';
import { Rng } from 'digital-boardgame-framework';
import { buildTradeStacks } from './setup.js';
import { adapter, createGame, normalize } from './index.js';
import { areas, calamities } from '../data/index.js';
import { cardConservationProblems } from './helpers.js';
import type { Action, GameState } from './types.js';

const isCal = (c: string) => c.startsWith('calamity:');

describe('trade-stack construction (§15.2)', () => {
  const numPlayers = 3;
  const ts = buildTradeStacks(new Rng(1), numPlayers);

  it('puts all 12 calamities into stacks 2-9, none in stack 1', () => {
    expect(ts.stacks[1]!.some(isCal)).toBe(false);
    const total = Object.values(ts.stacks).flat().filter(isCal).length;
    expect(total).toBe(calamities.length); // 12
  });

  it('keeps the top numPlayers cards of each stack calamity-free (the buffer)', () => {
    for (let s = 2; s <= 9; s++) {
      const top = ts.stacks[s]!.slice(-numPlayers); // drawn from the end
      expect(top.some(isCal), `stack ${s} buffer`).toBe(false);
    }
  });

  it('places every calamity just beneath the buffer (drawn on the numPlayers+1th draw, §15.2)', () => {
    for (const cal of calamities) {
      const stack = ts.stacks[cal.level]!;
      const calsAtLevel = calamities.filter((c) => c.level === cal.level).length;
      // The band directly below the top-of-stack buffer holds this level's calamities.
      const band = stack.slice(-(numPlayers + calsAtLevel), stack.length - numPlayers);
      expect(band, `stack ${cal.level} calamity band`).toContain(`calamity:${cal.id}`);
    }
  });
});

/** Put a calamity card in a player's hand at the trade phase, then end trade so
 *  it is resolved in the calamity phase. */
function resolveHeld(card: string, victim = 'egypt'): GameState {
  let s = createGame({ players: ['egypt', 'babylon'], seed: 2, maxTurns: 60 });
  s.areas = { [areas.find((a) => !a.isWater)!.id]: { tokens: { egypt: 8 } } };
  for (const id of s.seating) { const p = s.players[id]!; p.hand = {}; }
  s.players[victim]!.hand = { [card]: 1 };
  s.phase = 'trade';
  s.activeOrder = [...s.seating];
  s.actedThisPhase = [];
  s.negotiation = { turnPointer: 0, passStreak: 0, actions: 0, nextOfferId: 0, offers: [], completed: [] };
  let guard = 0;
  while (s.phase === 'trade' && guard++ < 50) s = adapter.applyAction(s, { type: 'pass' }, adapter.currentActor(s)!);
  return s;
}

describe('non-tradable calamity delivery & circulation (§29.7)', () => {
  it('resolves a drawn non-tradable calamity and returns it to the bottom of its stack', () => {
    const s = resolveHeld('calamity:volcano'); // Volcano is non-tradable, level 2
    // No longer in any hand.
    for (const id of s.seating) expect(s.players[id]!.hand['calamity:volcano']).toBeUndefined();
    // Back at the bottom of stack 2, ready to circulate into play again.
    expect(s.trade.stacks[2]![0]).toBe('calamity:volcano');
  });

  it('a player drawing from a depleted higher stack receives the non-tradable calamity', () => {
    // A player with 2 cities draws from stacks 1 and 2; with stack 2 worn down to
    // its bottom, the next draw is the non-tradable Volcano.
    const land = areas.filter((a) => !a.isWater);
    let s = createGame({ players: ['egypt', 'babylon'], seed: 1, maxTurns: 60 });
    s.areas = {
      [land[0]!.id]: { tokens: {}, city: 'egypt' },
      [land[1]!.id]: { tokens: {}, city: 'egypt' },
      [land[2]!.id]: { tokens: { egypt: 1 } },
      [land[3]!.id]: { tokens: { egypt: 1 } },
      [land[4]!.id]: { tokens: { egypt: 1 } },
      [land[5]!.id]: { tokens: { egypt: 1 } },
    };
    const e = s.players['egypt']!;
    e.stock = 55 - 4; e.citiesAvailable = 9 - 2; e.treasury = 0; e.hand = {};
    s.players['babylon']!.hand = {};
    s.trade.stacks[2] = ['ochre', 'calamity:volcano']; // pop() -> volcano first
    s.phase = 'tradeAcquisition';
    s.activeOrder = ['egypt', 'babylon'];
    s.actedThisPhase = [];
    normalize(s); // runs acquisition, stops at the trade phase
    expect(e.hand['calamity:volcano']).toBe(1); // egypt drew the non-tradable calamity
    // End trading -> it resolves and returns to the bottom of stack 2.
    let guard = 0;
    while (s.phase === 'trade' && guard++ < 50) s = adapter.applyAction(s, { type: 'pass' }, adapter.currentActor(s)!);
    expect(s.players['egypt']!.hand['calamity:volcano']).toBeUndefined();
    expect(s.trade.stacks[2]![0]).toBe('calamity:volcano');
  });
});

describe('trade-card deck conservation', () => {
  it('starts with the full 126-card deck conserved', () => {
    const s = createGame({ players: ['egypt', 'babylon', 'crete'], seed: 4 });
    expect(cardConservationProblems(s)).toEqual([]);
  });

  it('conserves the deck after every action of a full game (cards circulate, never vanish)', () => {
    let s = createGame({ players: ['egypt', 'babylon', 'crete', 'assyria'], seed: 31, maxTurns: 30 });
    const rng = new Rng(31);
    let steps = 0;
    expect(cardConservationProblems(s)).toEqual([]);
    while (adapter.result(s) == null && steps++ < 20000) {
      const actor = adapter.currentActor(s);
      if (actor == null) break;
      const acts = adapter.legalActions(s, actor);
      const choice = acts.length > 1 && rng.next() < 0.7 ? acts[rng.int(acts.length - 1)]! : { type: 'pass' as const };
      s = adapter.applyAction(s, choice as Action, actor);
      expect(cardConservationProblems(s), `step ${steps} (${s.phase})`).toEqual([]);
    }
  });

  it('returns commodity cards spent on an advance to the bottom of their stack', () => {
    const land = areas.find((a) => !a.isWater)!;
    let s = createGame({ players: ['egypt', 'babylon'], seed: 6, maxTurns: 60 });
    // Drive to the acquire-advances phase by passing through interactive phases.
    let guard = 0;
    while (s.phase !== 'acquireAdvances' && adapter.result(s) == null && guard++ < 200) {
      const actor = adapter.currentActor(s);
      if (actor == null) break;
      s = adapter.applyAction(s, { type: 'pass' }, actor);
    }
    expect(s.phase).toBe('acquireAdvances');
    const actor = adapter.currentActor(s)!;
    // Give the actor a buyable hand: 7 ochre (49 > Pottery's 45).
    s.players[actor]!.hand = { ochre: 7 };
    const stack1Before = s.trade.stacks[1]!.length;
    s = adapter.applyAction(s, { type: 'buyAdvance', advance: 'pottery', spendCommodities: { ochre: 7 } }, actor);
    expect(s.players[actor]!.advances).toContain('pottery');
    // The 7 ochre are back at the bottom of stack 1, not gone.
    expect(s.trade.stacks[1]!.length).toBe(stack1Before + 7);
    expect(s.trade.stacks[1]!.slice(0, 7)).toEqual(['ochre', 'ochre', 'ochre', 'ochre', 'ochre', 'ochre', 'ochre']);
    // (Deck conservation isn't asserted here — the test injected an ochre hand;
    //  the full-game test verifies conservation end-to-end.)
  });
});
