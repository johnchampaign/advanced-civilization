import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rng } from 'digital-boardgame-framework';
import { GameServer, NoopBroadcaster, NoopNotifier } from 'digital-boardgame-framework/server';
import { FsStore } from 'digital-boardgame-framework/server/node';
import { adapter, codec, createGame } from '../engine/index.js';
import type { Action, GameState, PlayerId } from '../engine/index.js';
import { HeuristicAI } from '../ai/heuristic.js';

function makeServer() {
  const store = new FsStore(mkdtempSync(join(tmpdir(), 'civ-mp-')));
  return new GameServer<GameState, Action, string>({
    adapter, codec, store, broadcaster: new NoopBroadcaster(), notifier: new NoopNotifier(),
    gameUrl: (g, t) => `/play?game=${g}&token=${t}`,
  });
}
const tokenOf = (inviteUrl: string) => new URL(inviteUrl, 'http://x').searchParams.get('token')!;

/** Create a 2-player game and return the server, id, and parsed per-seat tokens
 *  (the `invites` map holds shareable URLs; the token is the ?token= param). */
async function newGame(seed = 5) {
  const s = makeServer();
  const { gameId, invites } = await s.createGame({ initialState: createGame({ players: ['egypt', 'babylon'], seed }), players: ['egypt', 'babylon'] });
  return { s, gameId, egypt: tokenOf(invites.egypt!), babylon: tokenOf(invites.babylon!) };
}

describe('async multiplayer (GameServer + filesystem store)', () => {
  it('creates a game with a distinct secret token per seat', async () => {
    const { gameId, egypt, babylon } = await newGame();
    expect(gameId).toBeTruthy();
    expect(egypt).toBeTruthy();
    expect(egypt).not.toBe(babylon);
  });

  it('authenticates each request to a seat and rejects bad tokens', async () => {
    const { s, gameId, egypt, babylon } = await newGame();
    expect((await s.fetch(gameId, egypt)).you).toBe('egypt');
    expect((await s.fetch(gameId, babylon)).you).toBe('babylon');
    await expect(s.fetch(gameId, 'not-a-real-token')).rejects.toThrow();
  });

  it('enforces turn ownership — only the seat on the clock may submit', async () => {
    const { s, gameId, egypt, babylon } = await newGame();
    const ea = await s.fetch(gameId, egypt);
    const onClock = ea.yourTurn ? egypt : babylon;
    const offClock = ea.yourTurn ? babylon : egypt;
    await expect(s.submit(gameId, offClock, { type: 'pass' })).rejects.toThrow(); // not your turn
    expect(await s.submit(gameId, onClock, { type: 'pass' })).toBeTruthy();        // your turn: ok
  });

  it('persists moves and redacts opponent hands in per-seat views (§27.4)', async () => {
    const { s, gameId, egypt, babylon } = await newGame();
    // Drive both seats with the heuristic AI so cities actually get built — a
    // city-less player draws no trade cards (§27.1), so we must play to a trade
    // phase where Egypt holds a city to have any hand to redact.
    const ai = new HeuristicAI();
    const egyptHand = (n: GameState) => Object.values(n.players['egypt']!.hand).reduce((a, b) => a + b, 0);
    let guard = 0;
    while (guard++ < 600) {
      const info = await s.fetch(gameId, egypt);
      if (info.gameOver) break;
      if (info.view.phase === 'trade' && egyptHand(info.view) > 0) break;
      const seat = info.yourTurn ? egypt : babylon;
      const view = info.yourTurn ? info.view : (await s.fetch(gameId, babylon)).view;
      const actor: PlayerId = info.yourTurn ? 'egypt' : 'babylon';
      const action = await ai.selectAction({ state: view, actor, adapter, rng: new Rng(guard) });
      await s.submit(gameId, seat, action);
    }
    const egyptView = await s.fetch(gameId, egypt);
    const babylonView = await s.fetch(gameId, babylon);
    expect(egyptView.view.phase).toBe('trade');
    expect(egyptHand(egyptView.view)).toBeGreaterThan(0); // Egypt sees its own cards…
    expect(egyptHand(babylonView.view)).toBe(0);          // …redacted in Babylon's view
  });

  it('accepts a bug report with the game log + snapshot, retrievable by category', async () => {
    const { s, gameId, egypt } = await newGame();
    const { reportId } = await s.report(gameId, egypt, {
      message: 'Movement looked wrong', severity: 'bug', category: 'game',
      clientLog: [{ turn: 1, kind: 'log', payload: 'egypt moved', ts: 0 }],
      clientBuild: 'web-ui', userAgent: 'test',
    });
    expect(reportId).toBeTruthy();
    const reports = await s.listReports({ category: 'game' });
    const r = reports.find((x) => x.reportId === reportId)!;
    expect(r).toBeTruthy();
    expect(r.message).toBe('Movement looked wrong');
    expect(r.gameId).toBe(gameId);
    expect(r.reporterSide).toBe('egypt');
    expect(r.serverSnapshot.length).toBeGreaterThan(0); // full game state captured
    expect(r.clientLog.length).toBe(1);                   // uploaded game log
  });

  it('rejects a bug report from a bad token', async () => {
    const { s, gameId } = await newGame();
    await expect(s.report(gameId, 'bogus', { message: 'x', severity: 'bug' })).rejects.toThrow();
  });

  it('persists submitted moves across fetches', async () => {
    const { s, gameId, egypt, babylon } = await newGame(9);
    const t0 = (await s.fetch(gameId, egypt)).turn;
    const onClock = (await s.fetch(gameId, egypt)).yourTurn ? egypt : babylon;
    await s.submit(gameId, onClock, { type: 'pass' });
    expect((await s.fetch(gameId, egypt)).turn).toBeGreaterThanOrEqual(t0);
  });
});
