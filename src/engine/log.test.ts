// Log completeness (report 283a6cda): a played game must put every phase's
// state changes and decisions on the record — movement, placement, census,
// surplus — with stable seq ids and no leaked card identities.
import { describe, expect, it } from 'vitest';
import { Rng } from 'digital-boardgame-framework';
import { adapter, createGame } from './index.js';
import { HeuristicAI } from '../ai/heuristic.js';
import type { GameState } from './types.js';

async function drive(seed: number, players: string[], maxTurn: number): Promise<GameState> {
  let s: GameState = createGame({ players: players as never, seed, maxTurns: 40 });
  const ai = new HeuristicAI();
  const rng = new Rng(seed);
  let guard = 0;
  while (adapter.result(s) == null && s.turn <= maxTurn && guard++ < 8000) {
    const actor = adapter.currentActor(s);
    if (actor == null) break;
    const action = await ai.selectAction({ state: s, actor, adapter, rng });
    s = adapter.applyAction(s, action, actor);
  }
  return s;
}

describe('game log completeness (report 283a6cda)', () => {
  it('records movement, placement and census events over a driven game, with unique monotonic seq ids', async () => {
    const s = await drive(7, ['egypt', 'babylon', 'assyria'], 5);
    const kinds = new Set(s.log.map((e) => e.kind));
    expect(kinds.has('tokens.grow') || kinds.has('tokens.place')).toBe(true); // §13 growth (auto or hand-placed)
    expect(kinds.has('census.order')).toBe(true);   // §21 turn census
    expect(kinds.has('move.land')).toBe(true);      // §23.3 land moves
    // seq is unique and monotonic — the permanent line-item id.
    const seqs = s.log.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it('never names commodity cards in draw/trade/discard entries (per-viewer secrecy at the source)', async () => {
    const s = await drive(3, ['egypt', 'babylon'], 4);
    for (const e of s.log) {
      if (e.kind === 'trade.cards.draw' || e.kind === 'trade.complete' || e.kind === 'hand.discard') {
        expect(e.msg ?? '').not.toMatch(/\b(hides|ochre|iron|papyrus|salt|timber|grain|oil|cloth|wine|bronze|silver|spice|resin|gems|dye|gold|ivory)\b/i);
      }
    }
  });
});
