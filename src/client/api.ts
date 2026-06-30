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
  /** Returns the player's current hub identity token (for ranked attribution),
   *  or undefined when not signed in. Read fresh on each submit. */
  getIdentityToken?: () => string | undefined;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}
type View = { view: GameState; yourTurn: boolean; turn: number; gameOver: boolean; you?: string };

/** A GameClientApi bound to one game + seat token. Pass to `useGame(client)`. */
export function createCivClient({ baseUrl = '', gameId, token, getIdentityToken }: CivClientOpts): GameClientApi<GameState, Action> {
  const base = `${baseUrl}/api/games/${encodeURIComponent(gameId)}`;
  const q = `?token=${encodeURIComponent(token)}`;
  return {
    fetch: () => fetch(`${base}${q}`).then((r) => json<View>(r)),
    // Ranked: attach the seat's hub identity (if signed in) to each move so the
    // server attributes this seat (idempotent; race-free as turns are sequential).
    submit: (action) => fetch(`${base}/move${q}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, identityToken: getIdentityToken?.() }) }).then((r) => json<View>(r)),
    legalActions: () => fetch(`${base}/legal${q}`).then((r) => json<Action[]>(r)),
    // submitReportViaHttp enforces the never-silently-drop report contract.
    report: (submission) => submitReportViaHttp(`${base}/report${q}`, submission),
  };
}

/** Attach the player's hub identity to their seat (ranked attribution). Best-
 *  effort: a failure just leaves the seat unattributed (casual play). */
export async function claimSeat(baseUrl: string, gameId: string, token: string, identityToken: string): Promise<void> {
  try {
    await fetch(`${baseUrl}/api/games/${encodeURIComponent(gameId)}/claim?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identityToken }),
    });
  } catch { /* ignore — ranked attribution is optional */ }
}

/** Create a new networked game. `invites` maps each seat to a shareable URL; the
 *  per-seat secret is its `?token=` query param (use `tokenFromInvite`). */
export async function createNetworkGame(baseUrl: string, body: { players: string[]; seed?: number; maxTurns?: number; emails?: Record<string, string>; ai?: Record<string, string> }): Promise<{ gameId: string; invites: Record<string, string> }> {
  return fetch(`${baseUrl}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => json<{ gameId: string; invites: Record<string, string> }>(r));
}

/** A stable per-browser reporter id (localStorage), so a reporter can later see
 *  resolutions of their own reports. */
export function reporterId(): string {
  const key = 'civ-reporter-id';
  try {
    let v = localStorage.getItem(key);
    if (!v) { v = `r-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`; localStorage.setItem(key, v); }
    return v;
  } catch { return 'r-anon'; }
}

/** Submit a standalone bug report (hotseat — no game/token). Tags the message
 *  with the reporter id so the reply is findable. Resolves only on a server-
 *  confirmed reportId (never a silent success). */
export async function submitStandaloneReport(baseUrl: string, body: {
  message: string; severity?: string; category?: string;
  serverSnapshot?: string; reporterSide?: string; turnNumber?: number;
  clientLog?: { turn: number; kind: string; payload: string; ts: number }[];
  clientBuild?: string; userAgent?: string;
}): Promise<{ reportId: string }> {
  const tagged = { ...body, message: `${body.message}\n\n<!-- reporter:${reporterId()} -->` };
  const res = await fetch(`${baseUrl}/api/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tagged) });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const j = (await res.json()) as { reportId?: string };
  if (!j.reportId) throw new Error('server did not confirm the report');
  return { reportId: j.reportId };
}

/** A resolution may be a plain note string or a { note } object (depending on how
 *  it was recorded); this normalises it to the reply text. */
export type Resolution = string | { at?: string; note: string } | null | undefined;
export function resolutionNote(r: Resolution): string {
  return (typeof r === 'string' ? r : r?.note ?? '').trim();
}
export interface MyReport { reportId: string; message: string; severity: string; category?: string; createdAt: string; resolution?: Resolution; tagged?: boolean }

const SEEN_KEY = 'civ-seen-responses';
function getSeenResponses(): Set<string> {
  try { return new Set<string>(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch { return new Set(); }
}
export function markResponseSeen(reportId: string): void {
  try { const s = getSeenResponses(); s.add(reportId); localStorage.setItem(SEEN_KEY, JSON.stringify([...s])); } catch { /* ignore */ }
}

/** Resolved reports the reporter hasn't seen yet — to pop on game open. */
export async function fetchUnseenResponses(baseUrl: string): Promise<MyReport[]> {
  const seen = getSeenResponses();
  const reports = await fetchMyReports(baseUrl);
  // Only auto-pop responses to reports THIS device filed (tagged), with a real
  // reply written, unseen.
  return reports.filter((r) => r.tagged && resolutionNote(r.resolution) && !seen.has(r.reportId));
}

/** Fetch this browser's own reports (with any resolutions). */
export async function fetchMyReports(baseUrl: string): Promise<MyReport[]> {
  try {
    const res = await fetch(`${baseUrl}/api/report?reporter=${encodeURIComponent(reporterId())}`);
    if (!res.ok) return [];
    return ((await res.json()) as { reports?: MyReport[] }).reports ?? [];
  } catch { return []; }
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
