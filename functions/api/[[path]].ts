// Cloudflare Pages Function — the PRODUCTION online-multiplayer API. Catches all
// /api/* requests and delegates to the same handleApi router the Node dev host
// uses (true dev/prod parity). Local dev does NOT use this file.
//
// Imports the Workers-SAFE server barrel only (no node:fs). FsStore lives at
// digital-boardgame-framework/server/node and is NEVER imported here.
import { GameServer, SupabaseStore, SupabaseBroadcaster, ResendNotifier, NoopNotifier, verifyIdentityToken, type Jwks } from 'digital-boardgame-framework/server';
import { createClient } from '@supabase/supabase-js';
import { adapter, codec, type Action, type GameState } from '../../src/engine/index.js';
import { handleApi } from '../../src/server/handlers.js';
import { APP_ID } from '../../src/report-meta.js';

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  PUBLIC_BASE_URL?: string;
  /** Shared secret matching the hub's RATINGS_INGEST_KEY (enables ranked play). */
  RATINGS_INGEST_KEY?: string;
}

// Hub identity verification: fetch + cache the hub's JWKS (1h) so claimSeat can
// verify the signed identity tokens players present.
const HUB = 'https://games-hub-5vo.pages.dev';
let _jwks: Jwks | undefined;
let _jwksAt = 0;
async function getJwks(): Promise<Jwks> {
  if (!_jwks || Date.now() - _jwksAt > 3_600_000) {
    _jwks = (await (await fetch(`${HUB}/id/jwks`)).json()) as Jwks;
    _jwksAt = Date.now();
  }
  return _jwks;
}

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      },
    });
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const notifier = env.RESEND_API_KEY
    ? new ResendNotifier({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM ?? 'Advanced Civilization <noreply@example.com>' })
    : new NoopNotifier();
  const site = (env.PUBLIC_BASE_URL ?? url.origin).replace(/\/$/, '');

  const store = new SupabaseStore(supabase);
  const server = new GameServer<GameState, Action, string>({
    snapshotHistory: 20,   // cap per-game snapshot history (framework >=0.32)
    adapter,
    codec,
    store,
    broadcaster: new SupabaseBroadcaster({ supabaseUrl: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY }),
    notifier,
    gameUrl: (gameId, token) => `${site}/?game=${encodeURIComponent(gameId)}&token=${encodeURIComponent(token)}`,
    // Stamp every in-game report with this app's id so triage can isolate our
    // reports on the shared backend.
    appId: APP_ID,
    // Best-effort games-played counter: createGame fires an 'online' beacon to
    // the hub. Never affects the request (failures/timeouts are swallowed).
    playBeacon: { appId: APP_ID },
    // Ranked play: verify hub identity tokens (claimSeat) + auto-report results
    // to the leaderboard when the ingest key is configured.
    verifyIdentity: async (t) => verifyIdentityToken(t, await getJwks()),
    ...(env.RATINGS_INGEST_KEY
      ? { ratings: { game: 'advanced-civilization', ingestKey: env.RATINGS_INGEST_KEY } }
      : {}),
  });

  let body: unknown = undefined;
  if (request.method === 'POST') {
    try { body = await request.json(); } catch { body = {}; }
  }

  const result = await handleApi(server, request.method, url.pathname, url.searchParams, body, (row) => store.putReport({ ...row, appId: APP_ID }));
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
};
