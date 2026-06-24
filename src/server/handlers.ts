// Platform-agnostic API router for Advanced Civilization online multiplayer.
// BOTH the Node dev host (src/server/http.ts, FsStore) and the Cloudflare Pages
// Function (functions/api/[[path]].ts, SupabaseStore) build a GameServer and
// delegate here. Keeping routing in one place is what makes local dev and
// production true parity — only the store/notifier/broadcaster differ.
import type { GameServer, ReportSubmission, BugReportRow, ReportFilter } from 'digital-boardgame-framework/server';
import { createGame, type Action, type GameState } from '../engine/index.js';
import { REPORT_CATEGORY } from '../report-meta.js';
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

/** Route one request. `query` carries the per-seat `?token=`. `putReport` (when
 *  provided) backs the standalone `POST /api/report` used by hotseat play, which
 *  has no game/token to attach a report to. */
export async function handleApi(
  server: Server,
  method: string,
  pathname: string,
  query: URLSearchParams,
  body: unknown,
  putReport?: (row: BugReportRow) => Promise<void>,
): Promise<ApiResult> {
  const segs = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (segs[0] !== 'api') return { status: 404, body: { error: 'not found' } };

  // ---- a reporter's own reports + resolutions (responses inbox) ----
  if (segs[1] === 'report' && segs.length === 2 && method === 'GET') {
    const reporter = query.get('reporter');
    if (!reporter) return { status: 422, body: { error: 'reporter required' } };
    const marker = `reporter:${reporter}`;
    try {
      const all = await server.listReports();
      const mine = all
        .filter((r) => {
          const msg = r.message ?? '';
          if (msg.includes(marker)) return true;
          // Legacy reports submitted before reporter-tagging existed: in the
          // single-reporter hotseat context, surface untagged hotseat reports too.
          const untagged = !/<!--\s*reporter:/.test(msg);
          return untagged && r.gameId === 'hotseat' && (r.clientBuild ?? '').includes('web-ui-hotseat');
        })
        .map((r) => ({
          reportId: r.reportId,
          message: (r.message ?? '').replace(/\s*<!--\s*reporter:[^>]*-->\s*/g, '').trim(),
          severity: r.severity,
          category: r.category,
          createdAt: r.createdAt,
          resolution: r.resolution ?? null,
          // tagged = this exact device filed it (safe to auto-pop). Untagged
          // legacy reports show in the list but are not auto-popped to everyone.
          tagged: (r.message ?? '').includes(marker),
        }))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return { status: 200, body: { reports: mine } };
    } catch (e) {
      return { status: 500, body: { error: (e as Error).message } };
    }
  }

  // ---- standalone bug report (hotseat — no game) ----
  if (segs[1] === 'report' && segs.length === 2 && method === 'POST') {
    if (!putReport) return { status: 501, body: { error: 'reporting is not configured on this host' } };
    const b = (body ?? {}) as Partial<BugReportRow> & { snapshot?: string };
    if (typeof b.message !== 'string' || !b.message.trim()) return { status: 422, body: { error: 'message required' } };
    const reportId = (globalThis.crypto?.randomUUID?.() ?? `r-${Date.now()}-${Math.round(Math.random() * 1e9)}`);
    const snapshot = b.serverSnapshot ?? b.snapshot ?? '';
    try {
      await putReport({
        reportId,
        gameId: b.gameId ?? 'hotseat',
        reporterSide: b.reporterSide ?? '?',
        turnNumber: b.turnNumber ?? 0,
        serverSnapshot: snapshot,
        reporterView: snapshot,
        clientLog: Array.isArray(b.clientLog) ? b.clientLog : [],
        message: b.message,
        severity: b.severity ?? 'bug',
        category: b.category ?? REPORT_CATEGORY,
        clientBuild: b.clientBuild,
        userAgent: b.userAgent,
        createdAt: new Date().toISOString(),
      });
      return { status: 200, body: { reportId } };
    } catch (e) {
      return { status: 500, body: { error: (e as Error).message } };
    }
  }
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
        // Forward the supported filters so triage can scope by app (category),
        // severity, recency, or game. The shared backend holds several ports'
        // reports; `?category=advciv` is what isolates this game's queue.
        const filter: ReportFilter = {};
        if (query.get('unresolved') === '1') filter.unresolved = true;
        const category = query.get('category'); if (category) filter.category = category;
        const appId = query.get('app_id'); if (appId) filter.appId = appId;
        const severity = query.get('severity'); if (severity) filter.severity = severity;
        const since = query.get('since'); if (since) filter.since = since;
        const gameId = query.get('gameId'); if (gameId) filter.gameId = gameId;
        const hasFilter = Object.keys(filter).length > 0;
        return { status: 200, body: await server.listReports(hasFilter ? filter : undefined) };
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
