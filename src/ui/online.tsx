import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGame } from 'digital-boardgame-framework/client';
import type { GameClientApi } from 'digital-boardgame-framework/client';
import type { LogEntry } from 'digital-boardgame-framework';
import { adapter } from '../engine/index.js';
import type { Action, GameState, PlayerId } from '../engine/index.js';
import { civilizations, civById } from '../data/index.js';
import { createCivClient, createNetworkGame, realtimeSubscribe, tokenFromInvite } from '../client/api.js';
import { ActionList, Board, CalamityModal, InfoView, MovementControls, StatusPanel, TaxRateControl, legalAreas, nationFocusArea, prettyPhase, scrollBoardTo, useMovementPlanner, type View } from './App.js';

const API = ''; // same-origin; Vite proxies /api -> the GameServer host
// Placeholder so the movement-planner hook can run before the game view loads.
const EMPTY_STATE = { areas: {}, players: {}, phase: '', turn: 0 } as unknown as GameState;

// ---- Lobby ----------------------------------------------------------------

export function Lobby() {
  const [picked, setPicked] = useState<PlayerId[]>(['egypt', 'babylon']);
  const [created, setCreated] = useState<{ gameId: string; invites: Record<string, string> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: PlayerId) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  async function create() {
    setError(null);
    try {
      const seed = Math.floor(Math.random() * 0xffff);
      setCreated(await createNetworkGame(API, { players: picked, seed, maxTurns: 60 }));
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <div style={{ padding: 24, color: '#eee', maxWidth: 760, margin: '0 auto' }}>
      <h1 style={{ marginTop: 0 }}>Advanced Civilization — Online</h1>
      {!created ? (
        <>
          <p className="civ-lbl" style={{ color: '#ccc' }}>Pick 2–6 nations, then create a game and share each seat's link.</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {civilizations.map((c) => (
              <button key={c.id} className={`civ-btn ${picked.includes(c.id) ? 'on' : ''}`} onClick={() => toggle(c.id)}>
                <span style={{ display: 'inline-block', width: 10, height: 10, background: c.color, marginRight: 5, borderRadius: 2 }} />{c.name}
              </button>
            ))}
          </div>
          <button className="civ-btn" disabled={picked.length < 2 || picked.length > 6} onClick={create}>Create game ({picked.length} players)</button>
          {error && <p style={{ color: '#f88' }}>{error}</p>}
        </>
      ) : (
        <>
          <p>Game <code>{created.gameId}</code> created. Send each player their link; open one yourself to start.</p>
          <table style={{ width: '100%', fontSize: 13 }}><tbody>
            {Object.entries(created.invites).map(([seat, url]) => (
              <tr key={seat}>
                <td style={{ fontWeight: 800, color: civById.get(seat)?.color, padding: '4px 8px' }}>{civById.get(seat)?.name ?? seat}</td>
                <td><input readOnly value={url} style={{ width: '100%' }} onFocus={(e) => e.currentTarget.select()} /></td>
                <td><button className="civ-btn" onClick={() => navigator.clipboard?.writeText(url)}>Copy</button></td>
                <td><button className="civ-btn" onClick={() => { location.search = `?game=${encodeURIComponent(created.gameId)}&token=${encodeURIComponent(tokenFromInvite(url))}`; }}>Open as {civById.get(seat)?.name ?? seat}</button></td>
              </tr>
            ))}
          </tbody></table>
        </>
      )}
    </div>
  );
}

// ---- Online game (driven by useGame) --------------------------------------

export function OnlineGame({ gameId, token }: { gameId: string; token: string }) {
  const client: GameClientApi<GameState, Action> = useMemo(() => createCivClient({ baseUrl: API, gameId, token }), [gameId, token]);
  const subscribe = useMemo(() => realtimeSubscribe(gameId, import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY), [gameId]);
  const game = useGame<GameState, Action>(client, { pollMs: 2500, ...(subscribe ? { subscribe } : {}) });
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View>('map');

  // Hooks must run unconditionally (before the loading/error early-returns below).
  const submitAction = useCallback((a: Action) => { void game.submit(a); setSelected(null); }, [game]);
  const moveActor = game.view && game.yourTurn && game.view.phase === 'movement' ? ((game.you ?? null) as PlayerId | null) : null;
  const planner = useMovementPlanner(game.view ?? EMPTY_STATE, moveActor, game.legalActions, submitAction);

  const boardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!game.view || view !== 'map') return;
    const me = (game.you ?? game.view.seating[0]!) as PlayerId;
    const inMove = !!game.yourTurn && game.view.phase === 'movement';
    const target = inMove && planner.origin ? planner.origin : nationFocusArea(game.view, me);
    const t = setTimeout(() => scrollBoardTo(boardRef.current, target), 60);
    return () => clearTimeout(t);
  }, [game.view?.phase, game.yourTurn, game.you, planner.origin, view]);

  if (game.error) return <Centered>Connection error: {game.error.message}</Centered>;
  if (!game.view) return <Centered>Connecting to game {gameId}…</Centered>;
  const s = game.view;
  const you = (game.you ?? s.seating[0]!) as PlayerId;
  const onClock = adapter.currentActor(s); // safe on a redacted view (no hidden info used)
  const inMovement = !!game.yourTurn && s.phase === 'movement';
  // Population-expansion placement by clicking the map.
  const inPlacement = !!game.yourTurn && s.phase === 'populationExpansion';
  const placeCaps = (inPlacement ? s.expansion?.caps[you] : undefined) ?? {};
  const placeHighlight = new Set(Object.entries(placeCaps).filter(([, c]) => c > 0).map(([a]) => a));
  const onPlaceClick = (area: string | null) => { if (area && (placeCaps[area] ?? 0) > 0) submitAction({ type: 'placeTokens', placements: { [area]: 1 } }); };

  return (
    <>
      <div ref={boardRef} style={{ flex: 1, position: 'relative', overflow: 'auto', background: '#0d3a4a' }}>
        <CalamityModal events={s.lastCalamities ?? []} you={you} />
        {view === 'map'
          ? <Board
              state={inMovement ? planner.previewState : s}
              selected={inMovement ? planner.origin : selected}
              onSelect={inMovement ? planner.onBoardClick : inPlacement ? onPlaceClick : setSelected}
              highlight={inMovement ? planner.highlight : inPlacement ? placeHighlight : legalAreas(game.legalActions, s.phase)}
              origin={inMovement ? planner.origin : null}
              moved={inMovement ? planner.moved : undefined}
              zoomTo={inMovement ? planner.origin : null}
            />
          : <InfoView view={view} state={s} focus={you} />}
      </div>
      <div className="civ-bar" style={{ display: 'flex', gap: 6, padding: 6, minHeight: 170, maxHeight: '42vh' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, width: 78 }}>
          {(['map', 'ast', 'census', 'tools', 'goods'] as View[]).map((v) => (
            <button key={v} className={`civ-nav ${view === v ? 'on' : ''}`} onClick={() => setView(v)}>{v.toUpperCase()}</button>
          ))}
        </div>
        <StatusPanel state={s} id={you} />
        <div className="civ-panel" style={{ flex: 1, padding: 8, display: 'flex', flexDirection: 'column', gap: 6, overflow: 'auto' }}>
          {game.gameOver ? (
            <div className="civ-msg" style={{ padding: 10 }}>Game over.</div>
          ) : game.yourTurn ? (
            <>
              <div className="civ-msg" style={{ padding: '6px 10px', textAlign: 'center' }}>Your turn — {prettyPhase(s.phase)}</div>
              <TaxRateControl state={s} actor={you} onApply={submitAction} />
              {inMovement
                ? <MovementControls planner={planner} />
                : <ActionList legal={game.legalActions} selectedArea={selected} phase={s.phase} onApply={submitAction} state={s} actor={you} />}
            </>
          ) : (
            <div className="civ-lbl" style={{ textAlign: 'center', padding: 8 }}>
              Waiting for <b style={{ color: onClock ? civById.get(onClock)?.color : '#fff' }}>{onClock ? civById.get(onClock)?.name : '…'}</b> ({prettyPhase(s.phase)})
            </div>
          )}
        </div>
        <div className="civ-panel" style={{ width: 210, padding: 6, display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', minHeight: 0 }}>
          <div style={{ textAlign: 'center', fontWeight: 800, letterSpacing: 1 }}>{prettyPhase(s.phase).toUpperCase()}</div>
          <div className="civ-lbl">Turn {s.turn} · you are <b style={{ color: civById.get(you)?.color }}>{civById.get(you)?.name}</b></div>
          <button className="civ-btn" onClick={() => downloadLog(s, gameId)}>Download game log</button>
          <BugReport client={client} view={s} />
        </div>
      </div>
    </>
  );
}

// ---- Bug reporting + log upload -------------------------------------------

function BugReport({ client, view }: { client: GameClientApi<GameState, Action>; view: GameState }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [severity, setSeverity] = useState<'bug' | 'rules-question' | 'feedback'>('bug');
  const [status, setStatus] = useState<string | null>(null);

  async function send() {
    setStatus('Sending…');
    // Attach the game's move log as the report's clientLog; the server also stores
    // the full game snapshot automatically, so the whole game is uploaded.
    const clientLog: LogEntry[] = view.log.map((m, i) => ({ turn: view.turn, kind: 'log', payload: m, ts: i }));
    try {
      const { reportId } = await client.report({ message, severity, category: 'game', clientLog, clientBuild: 'web-ui', userAgent: navigator.userAgent } as never);
      setStatus(`Thanks! Report ${reportId} received.`);
      setMessage('');
    } catch (e) {
      setStatus(`Could not send: ${(e as Error).message}`); // never a false success
    }
  }

  if (!open) return <button className="civ-btn" onClick={() => setOpen(true)}>Report a bug</button>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <select value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)} style={{ fontSize: 11 }}>
        <option value="bug">Bug</option><option value="rules-question">Rules question</option><option value="feedback">Feedback</option>
      </select>
      <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What happened?" rows={3} style={{ fontSize: 12 }} />
      <div style={{ display: 'flex', gap: 4 }}>
        <button className="civ-btn" disabled={!message.trim()} onClick={send}>Send (uploads this game's log)</button>
        <button className="civ-btn" onClick={() => { setOpen(false); setStatus(null); }}>Close</button>
      </div>
      {status && <span className="civ-lbl" style={{ color: '#5a2d0a' }}>{status}</span>}
    </div>
  );
}

function downloadLog(s: GameState, gameId: string) {
  const text = `Advanced Civilization — game ${gameId}, turn ${s.turn}\n\n${s.log.join('\n')}`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url; a.download = `civ-${gameId}-log.txt`; a.click();
  URL.revokeObjectURL(url);
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#eee', fontSize: 18 }}>{children}</div>;
}
