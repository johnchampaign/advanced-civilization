// Client-side API for async multiplayer: a GameClientApi (used by the framework's
// `useGame` hook) that talks to the HTTP host in src/server/http.ts, plus an
// optional Supabase Realtime subscription so clients refresh instantly on a move
// instead of only polling.
import { submitReportViaHttp } from 'digital-boardgame-framework/client';
import { subscribeSupabaseRealtime } from 'digital-boardgame-framework/client/realtime';
import type { GameClientApi } from 'digital-boardgame-framework/client';
import type { Action, GameState } from '../engine/index.js';

export interface CivClientOpts {
  baseUrl?: string; // HTTP host, e.g. http://localhost:8787
  gameId: string;
  token: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}
type View = { view: GameState; yourTurn: boolean; turn: number; gameOver: boolean; you?: string };

/** A GameClientApi bound to one game + seat token. Pass to `useGame(client)`. */
export function createCivClient({ baseUrl = '', gameId, token }: CivClientOpts): GameClientApi<GameState, Action> {
  const base = `${baseUrl}/api/games/${encodeURIComponent(gameId)}`;
  const q = `?token=${encodeURIComponent(token)}`;
  return {
    fetch: () => fetch(`${base}${q}`).then((r) => json<View>(r)),
    submit: (action) => fetch(`${base}/move${q}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) }).then((r) => json<View>(r)),
    legalActions: () => fetch(`${base}/legal${q}`).then((r) => json<Action[]>(r)),
    // submitReportViaHttp enforces the never-silently-drop report contract.
    report: (submission) => submitReportViaHttp(`${base}/report${q}`, submission),
  };
}

/** Create a new networked game. `invites` maps each seat to a shareable URL; the
 *  per-seat secret is its `?token=` query param (use `tokenFromInvite`). */
export async function createNetworkGame(baseUrl: string, body: { players: string[]; seed?: number; maxTurns?: number; emails?: Record<string, string> }): Promise<{ gameId: string; invites: Record<string, string> }> {
  return fetch(`${baseUrl}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => json<{ gameId: string; invites: Record<string, string> }>(r));
}

/** Extract a seat's secret token from its invite URL. */
export function tokenFromInvite(inviteUrl: string): string {
  return new URL(inviteUrl, location?.origin ?? 'http://localhost').searchParams.get('token') ?? '';
}

/** Optional realtime: refresh on a server "moved" broadcast. Wire into
 *  `useGame(client, { subscribe })`. Needs the public Supabase URL + anon key
 *  (safe in the bundle); falls back to polling when not configured. */
export function realtimeSubscribe(gameId: string, supabaseUrl?: string, anonKey?: string): ((onChange: () => void) => () => void) | undefined {
  if (!supabaseUrl || !anonKey) return undefined;
  return subscribeSupabaseRealtime({ supabaseUrl, anonKey, gameId });
}
