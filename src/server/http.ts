// A tiny Node HTTP host for the GameServer — enough to play async multiplayer
// locally (filesystem store, no Supabase). The same endpoints map cleanly to a
// Cloudflare Pages Function / Worker for production. Run: `npm run serve`.
import { createServer } from 'node:http';
import { buildGameServer, makeStore } from './game-server.js';
import { handleApi } from './handlers.js';

const PORT = Number(process.env.PORT ?? 8787);

const server = await buildGameServer();
const store = await makeStore(); // backs standalone hotseat reports

function send(res: import('node:http').ServerResponse, code: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
  res.end(data);
}
async function readJson(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const http = createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    // Same router the Cloudflare Pages Function uses (dev/prod parity).
    const result = await handleApi(server, req.method ?? 'GET', url.pathname, url.searchParams, body, (row) => store.putReport(row));
    return send(res, result.status, result.body);
  } catch (e) {
    send(res, 400, { error: (e as Error).message });
  }
});

http.listen(PORT, () => console.log(`Advanced Civilization server on http://localhost:${PORT} (store: ${process.env.SUPABASE_URL ? 'Supabase' : 'filesystem .data/games'})`));
