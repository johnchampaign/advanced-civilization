// A tiny Node HTTP host for the GameServer — enough to play async multiplayer
// locally (filesystem store, no Supabase). The same endpoints map cleanly to a
// Cloudflare Pages Function / Worker for production. Run: `npm run serve`.
import { createServer } from 'node:http';
import { buildGameServer, newGameState } from './game-server.js';
import type { Action } from '../engine/index.js';

const PORT = Number(process.env.PORT ?? 8787);

const server = await buildGameServer();

function send(res: import('node:http').ServerResponse, code: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
  res.end(data);
}
async function readJson(req: import('node:http').IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const http = createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const parts = url.pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
    const token = url.searchParams.get('token') ?? '';

    // POST /api/games  { players, seed?, maxTurns?, emails? }
    if (req.method === 'POST' && parts[0] === 'games' && parts.length === 1) {
      const body = await readJson(req);
      const initialState = newGameState({ players: body.players, seed: body.seed, maxTurns: body.maxTurns });
      const result = await server.createGame({ initialState, players: body.players, emails: body.emails });
      return send(res, 200, result); // { gameId, invites: { player -> token } }
    }
    const gameId = parts[1] ?? '';
    // GET /api/games/:id?token=
    if (req.method === 'GET' && parts[0] === 'games' && parts.length === 2) return send(res, 200, await server.fetch(gameId, token));
    // GET /api/games/:id/legal?token=
    if (req.method === 'GET' && parts[2] === 'legal') return send(res, 200, await server.legalActions(gameId, token));
    // POST /api/games/:id/move?token=  { action }
    if (req.method === 'POST' && parts[2] === 'move') return send(res, 200, await server.submit(gameId, token, (await readJson(req)).action as Action));
    // GET/POST /api/games/:id/messages?token=
    if (parts[2] === 'messages') {
      if (req.method === 'GET') return send(res, 200, await server.listMessages(gameId, token));
      if (req.method === 'POST') return send(res, 200, await server.postMessage(gameId, token, (await readJson(req)).body));
    }
    // POST /api/games/:id/report?token=
    if (req.method === 'POST' && parts[2] === 'report') return send(res, 200, await server.report(gameId, token, await readJson(req)));
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: (e as Error).message });
  }
});

http.listen(PORT, () => console.log(`Advanced Civilization server on http://localhost:${PORT} (store: ${process.env.SUPABASE_URL ? 'Supabase' : 'filesystem .data/games'})`));
