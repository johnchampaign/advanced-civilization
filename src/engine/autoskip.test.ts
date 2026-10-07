// Skipping a player's turn in a phase where passing is their only option
// (report dcd9894a). Opt-in per game (`autoSkip`), like chooseStartAreas.
import { describe, expect, it } from 'vitest';
import { Rng } from 'digital-boardgame-framework';
import { adapter, createGame, normalize } from './index.js';
import { pieceConservationProblems } from './helpers.js';
import { pieceCounts } from '../data/index.js';
import { HeuristicAI } from '../ai/heuristic.js';
import type { GameState, Phase } from './types.js';

/** A two-player state sitting at the start of `phase`, egypt to act. */
function at(phase: Phase, setup: (s: GameState) => void, autoSkip = true): GameState {
  const s = createGame({ players: ['egypt', 'babylon'], seed: 3, maxTurns: 60, autoSkip });
  s.areas = { thebes: { tokens: { egypt: 2 } }, susa: { tokens: { babylon: 2 } } };
  for (const id of s.seating) { const p = s.players[id]!; p.hand = {}; p.treasury = 0; p.stock = pieceCounts.tokens - 2; p.advances = []; }
  setup(s);
  s.phase = phase; s.activeOrder = ['egypt', 'babylon']; s.actedThisPhase = [];
  s.negotiation = { turnPointer: 0, passStreak: 0, actions: 0, nextOfferId: 0, done: [], offers: [], completed: [] };
  normalize(s);
  return s;
}
const skips = (s: GameState) => s.log.filter((e) => e.kind === 'phase.skip').map((e) => `${e.side}:${(e.payload as { phase: string }).phase}`);

describe('auto-skip forced passes (report dcd9894a)', () => {
  it('is off unless the game asks for it', () => {
    const s = at('cityConstruction', () => {}, false);
    expect(s.phase).toBe('cityConstruction');
    expect(adapter.currentActor(s)).toBe('egypt');
  });

  it('skips city building when no city can be built', () => {
    const s = at('cityConstruction', () => {});
    expect(skips(s)).toEqual(expect.arrayContaining(['egypt:cityConstruction', 'babylon:cityConstruction']));
    expect(s.log.find((e) => e.kind === 'phase.skip')!.msg).toMatch(/no city can be built/);
  });

  it('stops when a city can be built', () => {
    const s = at('cityConstruction', (st) => { st.areas['thebes']!.tokens['egypt'] = 6; st.players['egypt']!.stock -= 4; });
    expect(s.phase).toBe('cityConstruction');
    expect(adapter.currentActor(s)).toBe('egypt');
    expect(skips(s)).toEqual([]);
  });

  it('skips buying advances when nothing is affordable, but not when something is', () => {
    expect(skips(at('acquireAdvances', () => {}))).toEqual(expect.arrayContaining(['egypt:acquireAdvances']));
    const s = at('acquireAdvances', (st) => { st.players['egypt']!.treasury = 50; st.players['egypt']!.stock -= 50; });
    expect(s.phase).toBe('acquireAdvances');
    expect(adapter.currentActor(s)).toBe('egypt');
  });

  it('skips trading under §28.3: fewer than three tradable cards, or nobody to trade with', () => {
    // egypt has 2 cards: may not trade. babylon has 5 but then no partner left.
    const s = at('trade', (st) => { st.players['egypt']!.hand = { salt: 2 }; st.players['babylon']!.hand = { iron: 3, wine: 2 }; });
    expect(skips(s).filter((k) => k.endsWith(':trade'))).toEqual(['egypt:trade', 'babylon:trade']);
    expect(s.log.filter((e) => e.kind === 'phase.skip' && e.phase === 'trade').map((e) => e.msg)).toEqual([
      expect.stringMatching(/fewer than three tradable cards/),
      expect.stringMatching(/no one else still trading has three cards/),
    ]);
    // Both able to trade: nobody is skipped.
    const t = at('trade', (st) => { st.players['egypt']!.hand = { salt: 3 }; st.players['babylon']!.hand = { iron: 3 }; });
    expect(t.phase).toBe('trade');
    expect(skips(t)).toEqual([]);
  });

  it('plays a whole AI game cleanly with skipping on', async () => {
    let s = createGame({ players: ['egypt', 'babylon', 'crete'], seed: 11, maxTurns: 30, autoSkip: true });
    const ai = new HeuristicAI(); const rng = new Rng(11);
    let steps = 0;
    while (adapter.result(s) == null && steps++ < 20000) {
      const actor = adapter.currentActor(s);
      if (actor == null) break;
      s = adapter.applyAction(s, await ai.selectAction({ state: s, actor, adapter, rng }), actor);
      expect(pieceConservationProblems(s, pieceCounts)).toEqual([]);
    }
    expect(adapter.result(s)).not.toBeNull();
    expect(s.log.some((e) => e.kind === 'phase.skip')).toBe(true);
  });
});
