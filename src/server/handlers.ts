// Platform-agnostic API router for Advanced Civilization online multiplayer.
// BOTH the Node dev host (src/server/http.ts, FsStore) and the Cloudflare Pages
// Function (functions/api/[[path]].ts, SupabaseStore) build a GameServer and
// delegate here. Keeping routing in one place is what makes local dev and
// production true parity — only the store/notifier/broadcaster differ.
import type { GameServer, ReportSubmission } from 'digital-boardgame-framework/server';
import { createGame, type Action, type GameState } from '../engine/index.js';
// NOTE: import createGame from the engine (node-free), NOT newGameState from
// game-server.ts — that module top-level-imports FsStore (node:fs), which would
// break the Cloudflare Workers build of this shared router.
const newGameState = createGame;

export interface ApiResult {
  status: number;
  body: unknown;
}

type Server = GameServer<GameState, Action, string>;

// Map known framework error strings to HTTP status codes.
function errToStatus(message: string): number {
  if (message.includes('not found') || message.includes('No snapshot')) return 404;
  if (message.includes('Invalid token')) return 401;
  if (message.includes('Not your turn')) return 403;
  if (message.includes('Illegal action')) return 422;
  if (message.includes('already exists')) return 409; // concurrent write
  return 400;
}

/** Route one request. `query` carries the per-seat `?token=`. */
export async function handleApi(
  server: Server,
  method: string,
  pathname: string,
  query: URLSearchParams,
  body: unknown,
): Promise<ApiResult> {
  const segs = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (segs[0] !== 'api') return { status: 404, body: { error: 'not found' } };
  const token = query.get('token') ?? '';

  try {
    // ---- games ----
    if (segs[1] === 'games') {
      // POST /api/games  { players, seed?, maxTurns?, emails? }
      if (segs.length === 2 && method === 'POST') {
        const b = (body ?? {}) as { players?: string[]; seed?: number; maxTurns?: number; emails?: Record<string, string> };
        if (!Array.isArray(b.players) || b.players.length < 2 || b.players.length > 6) {
          return { status: 422, body: { error: 'players must be an array of 2-6 nation ids' } };
        }
        const initialState = newGameState({ players: b.players, seed: b.seed, maxTurns: b.maxTurns });
        return { status: 200, body: await server.createGame({ initialState, players: b.players, emails: b.emails }) };
      }

      const gameId = segs[2];
      if (!gameId) return { status: 404, body: { error: 'not found' } };

      // GET /api/games/:id
      if (segs.length === 3 && method === 'GET') return { status: 200, body: await server.fetch(gameId, token) };
      // GET /api/games/:id/legal
      if (segs[3] === 'legal' && method === 'GET') return { status: 200, body: await server.legalActions(gameId, token) };
      // POST /api/games/:id/move  { action }
      if (segs[3] === 'move' && method === 'POST') {
        return { status: 200, body: await server.submit(gameId, token, (body as { action: Action }).action) };
      }
      // GET/POST /api/games/:id/messages
      if (segs[3] === 'messages') {
        if (method === 'GET') return { status: 200, body: await server.listMessages(gameId, token) };
        if (method === 'POST') return { status: 200, body: await server.postMessage(gameId, token, (body as { body: string }).body) };
      }
      // POST /api/games/:id/report
      if (segs[3] === 'report' && method === 'POST') {
        return { status: 200, body: await server.report(gameId, token, body as ReportSubmission) };
      }
    }

    // ---- reports (public triage, PII-free; see CLAUDE.md trust-tier split) ----
    if (segs[1] === 'reports') {
      if (segs.length === 2 && method === 'GET') {
        const unresolved = query.get('unresolved') === '1';
        return { status: 200, body: await server.listReports(unresolved ? { unresolved: true } : undefined) };
      }
      if (segs[3] === 'resolve' && method === 'POST') {
        await server.resolveReport(segs[2]!, (body as { note?: string })?.note ?? '');
        return { status: 200, body: { ok: true } };
      }
    }

    return { status: 404, body: { error: 'no route', pathname, method } };
  } catch (e) {
    // Supabase/PostgREST throw a plain object ({ message, ... }); String(e) on
    // that is "[object Object]". Pull .message when present.
    const message =
      e instanceof Error ? e.message
      : e && typeof e === 'object' ? ((e as { message?: string }).message ?? JSON.stringify(e))
      : String(e);
    return { status: errToStatus(message), body: { error: message } };
  }
}
