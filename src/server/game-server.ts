// Async-multiplayer wiring: builds the framework's GameServer around the Civ
// adapter. Storage/notifications/realtime are chosen from the environment so the
// same code runs locally (filesystem, no Supabase needed) and in production
// (Supabase + Resend + Supabase Realtime).
//
//   SUPABASE_URL + SUPABASE_SERVICE_KEY  -> SupabaseStore + SupabaseBroadcaster
//   (absent)                             -> FsStore (.data/games) + Noop
//   RESEND_API_KEY                       -> ResendNotifier (turn emails)
//   PUBLIC_BASE_URL                      -> base for shareable per-player URLs
import { GameServer, NoopBroadcaster, NoopNotifier, verifyIdentityToken, type GameBroadcaster, type Jwks, type Notifier, type SnapshotStore } from 'digital-boardgame-framework/server';
import { FsStore } from 'digital-boardgame-framework/server/node';
import { adapter, codec, createGame, type Action, type GameState, type NewGameOptions } from '../engine/index.js';
import { APP_ID } from '../report-meta.js';

const env = (k: string) => (typeof process !== 'undefined' ? process.env[k] : undefined);

// Hub identity verification (dev parity): fetch + cache the hub's JWKS (1h) so
// claimSeat verifies signed identity tokens locally too. Ratings auto-report is
// left OFF in dev (no ingest key) so local games don't hit the real leaderboard.
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

export async function makeStore(): Promise<SnapshotStore> {
  const url = env('SUPABASE_URL'), key = env('SUPABASE_SERVICE_KEY');
  if (url && key) {
    const { createClient } = await import('@supabase/supabase-js');
    const { SupabaseStore } = await import('digital-boardgame-framework/server');
    return new SupabaseStore(createClient(url, key));
  }
  return new FsStore(env('DBF_DATA_DIR') ?? '.data/games');
}

async function makeBroadcaster(): Promise<GameBroadcaster> {
  const url = env('SUPABASE_URL'), key = env('SUPABASE_SERVICE_KEY');
  if (url && key) {
    const { SupabaseBroadcaster } = await import('digital-boardgame-framework/server');
    return new SupabaseBroadcaster({ supabaseUrl: url, serviceKey: key });
  }
  return new NoopBroadcaster();
}

async function makeNotifier(): Promise<Notifier> {
  const apiKey = env('RESEND_API_KEY');
  if (apiKey) {
    const { ResendNotifier } = await import('digital-boardgame-framework/server');
    return new ResendNotifier({ apiKey, from: env('MAIL_FROM') ?? 'Advanced Civilization <noreply@example.com>' });
  }
  return new NoopNotifier();
}

export type CivGameServer = GameServer<GameState, Action, string>;

/** Build a configured GameServer. `baseUrl` is used for the shareable per-player
 *  links (and turn-email links). */
export async function buildGameServer(baseUrl = env('PUBLIC_BASE_URL') ?? 'http://localhost:8787'): Promise<CivGameServer> {
  const [store, broadcaster, notifier] = await Promise.all([makeStore(), makeBroadcaster(), makeNotifier()]);
  return new GameServer<GameState, Action, string>({
    adapter,
    codec,
    store,
    broadcaster,
    notifier,
    gameUrl: (gameId, token) => `${baseUrl}/?game=${encodeURIComponent(gameId)}&token=${encodeURIComponent(token)}`,
    // Stamp every in-game report with this app's id so triage can isolate our
    // reports on the shared backend.
    appId: APP_ID,
    // Best-effort games-played counter (mirrors the Pages Function): createGame
    // fires an 'online' beacon to the hub; never affects the request.
    playBeacon: { appId: APP_ID },
    // Dev parity: verify hub identity tokens for claimSeat.
    verifyIdentity: async (t) => verifyIdentityToken(t, await getJwks()),
  });
}

/** Initial state for a new networked game (same engine setup as hotseat). */
export function newGameState(opts: NewGameOptions): GameState {
  return createGame(opts);
}
