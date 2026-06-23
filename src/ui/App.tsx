import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Rng } from 'digital-boardgame-framework';
import { adapter, createGame } from '../engine/index.js';
import type { Action, GameState, PlayerId, CalamityEvent, CombatEvent } from '../engine/index.js';
import { advanceById, advances as ALL_ADVANCES, areaById, astTrackFor, calamityById, civById, civilizations, commodityById, epochs, ADVANCE_EFFECTS, CALAMITY_DESC } from '../data/index.js';
import { HeuristicAI } from '../ai/heuristic.js';
import { handValue, creditTowards, commoditySetValue } from '../engine/helpers.js';
import { submitStandaloneReport, fetchMyReports, resolutionNote, type MyReport } from '../client/api.js';
import { anchors, MAIN_VIEWBOX } from './anchors.js';

const DEFAULT_PLAYERS: PlayerId[] = ['egypt', 'babylon', 'crete', 'assyria'];
const ai = new HeuristicAI();
const BARB = '__barbarian__';
const PIRATE = '__pirate__';
export type View = 'map' | 'ast' | 'census' | 'tools' | 'goods';

/** Pre-game screen: the human picks which civilization to play and which AI
 *  opponents to face, instead of always being seated as Egypt. */
function CivSetup({ onStart, initial }: { onStart: (human: PlayerId, opponents: PlayerId[]) => void; initial: PlayerId }) {
  const all = useMemo(() => [...civilizations].sort((a, b) => a.astOrder - b.astOrder), []);
  const [human, setHuman] = useState<PlayerId>(initial);
  const [opps, setOpps] = useState<PlayerId[]>(() => DEFAULT_PLAYERS.filter((p) => p !== initial).slice(0, 3));
  const pickHuman = (id: PlayerId) => { setHuman(id); setOpps((o) => o.filter((x) => x !== id)); };
  const toggleOpp = (id: PlayerId) => setOpps((o) => (o.includes(id) ? o.filter((x) => x !== id) : o.length < 6 ? [...o, id] : o));
  const ok = opps.length >= 1 && opps.length <= 6;
  const swatch = (color: string, on: boolean) => ({ borderLeft: `6px solid ${color}`, opacity: on ? 1 : 0.6, fontWeight: on ? 700 : 400 } as const);
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, color: '#eee', padding: 24, overflowY: 'auto' }}>
      <h1 style={{ margin: 0 }}>Advanced Civilization</h1>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
        <div style={{ fontSize: 13, color: '#ffd23f', fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5 }}>Play as</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center', maxWidth: 700 }}>
          {all.map((c) => (
            <button key={c.id} className={`civ-btn ${human === c.id ? 'on' : ''}`} onClick={() => pickHuman(c.id)} style={swatch(c.color, human === c.id)}>{human === c.id ? '★ ' : ''}{c.name}</button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
        <div style={{ fontSize: 13, color: '#ffd23f', fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5 }}>Opponents — AI ({opps.length})</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center', maxWidth: 700 }}>
          {all.filter((c) => c.id !== human).map((c) => (
            <button key={c.id} className={`civ-btn ${opps.includes(c.id) ? 'on' : ''}`} onClick={() => toggleOpp(c.id)} style={swatch(c.color, opps.includes(c.id))}>{opps.includes(c.id) ? '✓ ' : ''}{c.name}</button>
          ))}
        </div>
      </div>
      <button className="civ-btn" disabled={!ok} style={{ fontSize: 16, padding: '10px 22px', fontWeight: 700 }} onClick={() => onStart(human, opps)}>Begin as {civById.get(human)?.name} →</button>
      <p className="civ-lbl" style={{ color: '#aaa', maxWidth: 520, textAlign: 'center' }}>You play {civById.get(human)?.name}; the others are run by the AI. Choose 1–6 opponents.</p>
    </div>
  );
}

export default function App() {
  // Pre-game civilization picker: the human chooses which civ to play (and its
  // AI opponents) instead of always being seated as Egypt.
  const [started, setStarted] = useState(false);
  const [config, setConfig] = useState<{ players: PlayerId[]; human: PlayerId }>(
    () => ({ players: DEFAULT_PLAYERS, human: DEFAULT_PLAYERS[0]! }),
  );
  const [seats, setSeats] = useState<Record<PlayerId, 'human' | 'ai'>>(
    () => Object.fromEntries(DEFAULT_PLAYERS.map((p, i) => [p, i === 0 ? 'human' : 'ai'])) as Record<PlayerId, 'human' | 'ai'>,
  );
  const [state, setState] = useState<GameState>(() => createGame({ players: DEFAULT_PLAYERS, seed: 7, maxTurns: 60 }));
  const [selectedArea, setSelectedArea] = useState<string | null>(null);
  const [view, setView] = useState<View>('map');
  const rng = useRef(new Rng(7));

  const startGame = useCallback((human: PlayerId, opponents: PlayerId[]) => {
    const players = [human, ...opponents];
    const seed = Date.now() & 0xffff;
    rng.current = new Rng(seed);
    setConfig({ players, human });
    setSeats(Object.fromEntries(players.map((p) => [p, p === human ? 'human' : 'ai'])) as Record<PlayerId, 'human' | 'ai'>);
    setState(createGame({ players, seed, maxTurns: 60 }));
    setView('map');
    setStarted(true);
  }, []);

  const actor = adapter.currentActor(state);
  const result = adapter.result(state);
  const legal = useMemo(() => (actor ? adapter.legalActions(state, actor) : []), [state, actor]);

  useEffect(() => {
    if (!actor || result || seats[actor] !== 'ai') return;
    const t = setTimeout(async () => {
      const action = await ai.selectAction({ state, actor, adapter, rng: rng.current });
      setState((s) => { const r = adapter.tryApplyAction(s, action, actor); return r.ok ? r.state : adapter.applyAction(s, { type: 'pass' }, actor); });
    }, 220);
    return () => clearTimeout(t);
  }, [state, actor, result, seats]);

  const apply = useCallback((a: Action) => {
    if (!actor) return;
    // Use tryApplyAction so a now-illegal action (e.g. accepting an offer the AI
    // just consumed) is ignored rather than throwing and blanking the screen.
    setState((s) => { const r = adapter.tryApplyAction(s, a, actor); if (!r.ok) { console.warn('action rejected:', r.reason, a); return s; } return r.state; });
    setSelectedArea(null);
  }, [actor]);

  const planner = useMovementPlanner(state, actor, legal, apply);
  const inMovement = !!actor && seats[actor] === 'human' && state.phase === 'movement';
  // Population-expansion placement by clicking the map (areas that can still grow).
  const inPlacement = !!actor && seats[actor] === 'human' && state.phase === 'populationExpansion';
  const placeCaps = (inPlacement && actor ? state.expansion?.caps[actor] : undefined) ?? {};
  const placeHighlight = useMemo(() => new Set(Object.entries(placeCaps).filter(([, c]) => c > 0).map(([a]) => a)), [placeCaps]);
  const onPlaceClick = useCallback((area: string | null) => { if (area && (placeCaps[area] ?? 0) > 0) apply({ type: 'placeTokens', placements: { [area]: 1 } }); }, [placeCaps, apply]);

  const boardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (view !== 'map') return;
    const target = inMovement && planner.origin ? planner.origin : (actor ? nationFocusArea(state, actor) : null);
    const t = setTimeout(() => scrollBoardTo(boardRef.current, target), 60);
    return () => clearTimeout(t);
  }, [actor, state.phase, view, inMovement, planner.origin]);

  const newGame = () => setStarted(false); // back to the civilization picker

  // Gate AFTER all hooks (hooks must run unconditionally on every render).
  if (!started) return <CivSetup onStart={startGame} initial={config.human} />;

  // The nation shown in the status/info panels: the current actor, else seat 0.
  const focus = actor ?? state.seating[0]!;

  return (
    <>
      <div ref={boardRef} style={{ flex: 1, position: 'relative', overflow: 'auto', background: '#0d3a4a' }}>
        <CombatModal events={state.lastCombats ?? []} you={focus} />
        {/* Replay calamities only once the phase is fully resolved (interactive
            choices happen inline during the phase, not via this replay). */}
        <CalamityModal events={state.phase === 'calamity' ? [] : (state.lastCalamities ?? [])} you={focus} />
        {view === 'map'
          ? <Board
              state={inMovement ? planner.previewState : state}
              selected={inMovement ? planner.origin : selectedArea}
              onSelect={inMovement ? planner.onBoardClick : inPlacement ? onPlaceClick : setSelectedArea}
              highlight={inMovement ? planner.highlight : inPlacement ? placeHighlight : legalAreas(legal, state.phase)}
              origin={inMovement ? planner.origin : null}
              moved={inMovement ? planner.moved : undefined}
              zoomTo={inMovement ? planner.origin : null}
            />
          : <InfoView view={view} state={state} focus={focus} />}
      </div>

      <div className="civ-bar" style={{ display: 'flex', gap: 6, padding: 6, minHeight: 170, maxHeight: '42vh' }}>
        {/* left nav */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, width: 78 }}>
          {(['map', 'ast', 'census', 'tools', 'goods'] as View[]).map((v) => (
            <button key={v} className={`civ-nav ${view === v ? 'on' : ''}`} onClick={() => setView(v)}>{v.toUpperCase()}</button>
          ))}
          <button className="civ-nav" onClick={newGame}>SYSTEM</button>
        </div>

        <StatusPanel state={state} id={focus} />

        {/* center: phase, message, actions */}
        <div className="civ-panel" style={{ flex: 1, padding: 8, display: 'flex', flexDirection: 'column', gap: 6, overflow: 'auto' }}>
          {result ? (
            <div className="civ-msg" style={{ padding: 10 }}>
              Game over — winner: <b>{result.winners.map((w) => civById.get(w)?.name).join(', ')}</b><br />
              <small>{result.reason}</small>
            </div>
          ) : (
            <>
              <div className="civ-msg" style={{ padding: '6px 10px', textAlign: 'center' }}>
                {actor ? <><b style={{ color: civById.get(actor)?.color }}>{civById.get(actor)?.name}</b> — {messageFor(state.phase)}</> : 'Resolving…'}
              </div>
              {actor && seats[actor] === 'human'
                ? (inMovement
                    ? <MovementControls planner={planner} />
                    : <ActionList legal={legal} selectedArea={selectedArea} phase={state.phase} onApply={apply} state={state} actor={actor} />)
                : <div className="civ-lbl" style={{ textAlign: 'center', padding: 8 }}>AI is taking its turn…</div>}
            </>
          )}
        </div>

        {/* right: phase + minimap */}
        <div className="civ-panel" style={{ width: 200, padding: 6, display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto', minHeight: 0 }}>
          <div style={{ textAlign: 'center', fontWeight: 800, letterSpacing: 1 }}>{prettyPhase(state.phase).toUpperCase()}</div>
          <div className="civ-lbl">Turn {state.turn}</div>
          <div style={{ flex: 1, border: '2px solid #7a4a18', background: '#0d3a4a', overflow: 'hidden', minHeight: 60 }} title="Click to jump the map here">
            <img src="/assets/map-main.svg" alt="mini" style={{ width: '100%', display: 'block', opacity: 0.9, cursor: 'pointer' }}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
                setView('map');
                setTimeout(() => { const el = boardRef.current; if (el) el.scrollTo({ left: fx * el.scrollWidth - el.clientWidth / 2, top: fy * el.scrollHeight - el.clientHeight / 2, behavior: 'smooth' }); }, 80);
              }} />
          </div>
          <HotseatReport state={state} focus={focus} />
        </div>
      </div>

      {/* turn-order tabs */}
      <div style={{ display: 'flex' }}>
        {state.activeOrder.map((id) => (
          <div key={id} className={`civ-tab ${actor === id ? 'act' : ''}`}>
            <span style={{ display: 'inline-block', width: 9, height: 9, background: civById.get(id)?.color, marginRight: 4, borderRadius: 2 }} />
            {civById.get(id)?.name}{seats[id] === 'ai' ? ' (AI)' : ''}
          </div>
        ))}
      </div>
    </>
  );
}

function messageFor(phase: string): string {
  const verbs: Record<string, string> = {
    movement: 'is moving', cityConstruction: 'is building cities', trade: 'is trading', acquireAdvances: 'is acquiring advances',
  };
  return verbs[phase] ?? prettyPhase(phase);
}

/** The area best representing a nation's position (largest stack / a city), used
 *  to recenter the map on the player. */
export function nationFocusArea(state: GameState, id: PlayerId): string | null {
  let best: string | null = null, bestScore = -1;
  for (const [aid, a] of Object.entries(state.areas)) {
    if (!anchors[aid]) continue;
    const score = (a.tokens[id] ?? 0) + (a.city === id ? 6 : 0);
    if (score > bestScore && score > 0) { bestScore = score; best = aid; }
  }
  return best;
}

/** Smoothly scroll the board's scroll container so `areaId` is centered. The map
 *  SVG has no height until it loads, so defer until the image is ready. */
export function scrollBoardTo(container: HTMLElement | null, areaId: string | null) {
  if (!container || !areaId) return;
  const an = anchors[areaId];
  const img = container.querySelector('img[alt="map"]') as HTMLImageElement | null;
  if (!an || !img) return;
  const doScroll = () => {
    if (!img.clientWidth || !img.clientHeight) return;
    const sx = img.clientWidth / MAIN_VIEWBOX.w, sy = img.clientHeight / MAIN_VIEWBOX.h;
    container.scrollTo({ left: an.x * sx - container.clientWidth / 2, top: an.y * sy - container.clientHeight / 2, behavior: 'smooth' });
  };
  if (img.complete && img.clientHeight) doScroll();
  else img.addEventListener('load', doScroll, { once: true });
}

export function legalAreas(legal: Action[], _phase: string): Set<string> {
  const set = new Set<string>();
  for (const a of legal) {
    if (a.type === 'move') a.moves.forEach((m) => set.add(m.to));
    if (a.type === 'buildCity') set.add(a.area);
  }
  return set;
}

// ---- Board ---------------------------------------------------------------

export function Board({ state, selected, onSelect, highlight, zoomTo, origin, moved }: {
  state: GameState; selected: string | null; onSelect: (a: string | null) => void; highlight: Set<string>;
  /** When set, the board zooms in toward this area's anchor (e.g. a chosen move origin). */
  zoomTo?: string | null;
  /** The move origin, drawn with a distinct marker so destinations read clearly. */
  origin?: string | null;
  /** Areas that received planned-but-not-official moves (dashed marker). */
  moved?: Set<string>;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  void zoomTo; // (was a CSS scale-zoom; removed — it created overflow that the
  // scroll container couldn't pan, hiding edge territories. We scroll-center on
  // the origin instead, which keeps the whole map reachable.)
  return (
    <div style={{ position: 'relative', width: MAIN_VIEWBOX.w, maxWidth: '100%', margin: '0 auto' }}>
      <img src="/assets/map-main.svg" alt="map" style={{ width: '100%', display: 'block' }} />
      <svg viewBox={`0 0 ${MAIN_VIEWBOX.w} ${MAIN_VIEWBOX.h}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
        {/* Render every anchored area (not just occupied ones) so empty
            destination areas are clickable during movement. */}
        {Object.keys(anchors).map((aid) => {
          const an = anchors[aid]!;
          const a = state.areas[aid] ?? { tokens: {} as Record<string, number> };
          const meta = areaById.get(aid);
          const owners = Object.entries(a.tokens).filter(([, n]) => n > 0);
          // Carrying-capacity tag, shown when tokens/city would cover the printed
          // number on the map (occupied non-water areas).
          const showCap = !!meta && !meta.isWater && (owners.length > 0 || !!a.city) && meta.sustains > 0;
          const isHi = highlight.has(aid);
          const isSel = selected === aid;
          const isOrigin = origin === aid;
          const isMoved = !!moved?.has(aid);
          const isPirate = a.city === PIRATE;
          const cityColor = a.city ? (isPirate ? '#111' : (civById.get(a.city)?.color ?? '#444')) : null;
          const ships = Object.entries(a.ships ?? {}).filter(([, n]) => n > 0);
          return (
            <g key={aid} data-area={aid} onClick={() => onSelect(isSel ? null : aid)} onMouseEnter={() => setHovered(aid)} onMouseLeave={() => setHovered((h) => (h === aid ? null : h))} style={{ cursor: 'pointer' }}>
              {/* Invisible hit target so areas with no markers still capture clicks. */}
              <circle cx={an.x} cy={an.y} r={an.r + 6} fill="transparent" />
              {(isHi || isSel || isOrigin) && <circle cx={an.x} cy={an.y} r={an.r + 10} fill="none" stroke={isOrigin ? '#ffd23f' : isSel ? '#fff' : '#5cf'} strokeWidth={isOrigin ? 5 : 4} pointerEvents="none" />}
              {isMoved && <circle cx={an.x} cy={an.y} r={an.r + 13} fill="none" stroke="#ffd23f" strokeWidth={3} strokeDasharray="5 4" pointerEvents="none" />}
              {a.city && <rect x={an.x - an.r} y={an.y - an.r} width={an.r * 2} height={an.r * 2} fill={cityColor!} stroke="#000" strokeWidth={2} />}
              {isPirate && <text x={an.x} y={an.y + an.r * 0.45} textAnchor="middle" fontSize={an.r * 1.3} fill="#fff">☠</text>}
              {owners.map(([owner, n], i) => {
                const barb = owner === BARB;
                return (
                  <g key={owner}>
                    <circle cx={an.x + i * 6} cy={an.y} r={an.r} fill={barb ? '#1a1a1a' : (civById.get(owner)?.color ?? '#888')} stroke={barb ? '#c33' : '#000'} strokeWidth={2} opacity={0.95} />
                    <text x={an.x + i * 6} y={an.y + an.r * 0.4} textAnchor="middle" fontSize={an.r * 1.1} fontWeight="bold" fill={barb ? '#f55' : '#fff'}>{barb ? '⚔' : n}</text>
                  </g>
                );
              })}
              {ships.map(([owner], i) => (
                <text key={'s' + owner} x={an.x - an.r + i * 7} y={an.y - an.r - 2} fontSize={an.r * 0.9} fill={civById.get(owner)?.color ?? '#888'}>⛵</text>
              ))}
              {showCap && (
                // Carrying-capacity hint, shown as "≤N" so it reads as a limit,
                // not a token/city. (Hover the area for the full breakdown.)
                <g pointerEvents="none">
                  <rect x={an.x + an.r - 2} y={an.y - an.r - 9} width={17} height={11} rx={5} fill="#0d3a4a" stroke="#cfe8ff" strokeWidth={0.5} opacity={0.85} />
                  <text x={an.x + an.r + 6.5} y={an.y - an.r - 0.5} textAnchor="middle" fontSize={8} fontWeight="bold" fill="#cfe8ff">≤{meta!.sustains}</text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
      {hovered && anchors[hovered] && <AreaTooltip areaId={hovered} state={state} zoomed={!!zoomTo} />}
    </div>
  );
}

/** Hover detail card for an area — shows population limit and occupants, since
 *  token markers can cover the printed carrying-capacity number on the map. */
function AreaTooltip({ areaId, state, zoomed }: { areaId: string; state: GameState; zoomed: boolean }) {
  const an = anchors[areaId]!;
  const meta = areaById.get(areaId);
  const a = state.areas[areaId];
  const owners = Object.entries(a?.tokens ?? {}).filter(([, n]) => n > 0);
  const ships = Object.entries(a?.ships ?? {}).filter(([, n]) => n > 0);
  const cityOwner = a?.city;
  const right = an.x > MAIN_VIEWBOX.w * 0.7; // flip to the left near the east edge
  const flags = [meta?.isCitySite && 'city site', meta?.isFloodplain && 'floodplain', meta?.isVolcanoSite && 'volcano', meta?.isOpenSea && 'open sea'].filter(Boolean).join(' · ');
  const nameOf = (o: string) => (o === BARB ? 'Barbarians' : o === PIRATE ? 'Pirates' : civById.get(o)?.name ?? o);
  return (
    <div style={{
      position: 'absolute', left: `${(an.x / MAIN_VIEWBOX.w) * 100}%`, top: `${(an.y / MAIN_VIEWBOX.h) * 100}%`,
      transform: `translate(${right ? 'calc(-100% - 14px)' : '14px'}, -50%) scale(${zoomed ? 0.56 : 1})`,
      transformOrigin: right ? 'right center' : 'left center',
      zIndex: 20, pointerEvents: 'none', background: 'rgba(26,20,16,0.96)', color: '#fff',
      border: '2px solid #ffd23f', borderRadius: 6, padding: '6px 9px', fontSize: 13, lineHeight: 1.35,
      maxWidth: 230, boxShadow: '0 2px 10px rgba(0,0,0,0.6)',
    }}>
      <div style={{ fontWeight: 800 }}>{meta?.name ?? areaId}</div>
      <div style={{ fontSize: 11, opacity: 0.85 }}>{meta?.isWater ? 'Sea' : `Population limit: ${meta?.sustains ?? '?'}`}{flags && ` · ${flags}`}</div>
      {cityOwner && <div style={{ marginTop: 2 }}>🏛 {nameOf(cityOwner)} city</div>}
      {owners.length > 0 && (
        <div style={{ marginTop: 2, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {owners.map(([o, n]) => (
            <span key={o}><span style={{ display: 'inline-block', width: 9, height: 9, background: o === BARB ? '#1a1a1a' : (civById.get(o)?.color ?? '#888'), borderRadius: 2, marginRight: 3, verticalAlign: 'middle' }} />{nameOf(o)} {o === BARB ? '⚔' : n}</span>
          ))}
        </div>
      )}
      {ships.length > 0 && <div style={{ marginTop: 2 }}>⛵ {ships.map(([o, n]) => `${nameOf(o)} ${n}`).join(', ')}</div>}
      {owners.length === 0 && !cityOwner && !meta?.isWater && <div style={{ fontSize: 11, opacity: 0.7 }}>empty</div>}
    </div>
  );
}

// ---- Status panel (In Stock / On Map / Treasury) -------------------------

export function StatusPanel({ state, id }: { state: GameState; id: PlayerId }) {
  const p = state.players[id]!;
  let boardTokens = 0, boardCities = 0;
  for (const a of Object.values(state.areas)) { boardTokens += a.tokens[id] ?? 0; if (a.city === id) boardCities += 1; }
  const Row = ({ label, vals }: { label: string; vals: [string, number][] }) => (
    <div>
      <div className="civ-lbl">{label}</div>
      <div style={{ display: 'flex', gap: 10, fontWeight: 800 }}>{vals.map(([t, n]) => <span key={t}>{t}{n}</span>)}</div>
    </div>
  );
  return (
    <div className="civ-panel" style={{ width: 150, padding: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ background: civById.get(id)?.color, color: '#fff', textAlign: 'center', fontWeight: 800, padding: 2, borderRadius: 3 }}>
        {civById.get(id)?.name.toUpperCase()}
      </div>
      <Row label="IN STOCK" vals={[['◾', p.stock], ['🏛', p.citiesAvailable], ['⛵', p.shipsAvailable]]} />
      <Row label="ON MAP" vals={[['◾', boardTokens], ['🏛', boardCities]]} />
      <Row label="TREASURY" vals={[['💰', p.treasury]]} />
      <div className="civ-lbl">AST space {p.astSpace} · {epochs.find((e) => e.id === p.epoch)?.name}</div>
    </div>
  );
}

// ---- Info views (AST / Census / Tools / Goods) ---------------------------

export function InfoView({ view, state, focus }: { view: View; state: GameState; focus: PlayerId }) {
  if (view === 'ast') return <AstView state={state} />;
  if (view === 'census') return <CensusView state={state} />;
  if (view === 'tools') return <ToolsView state={state} focus={focus} />;
  return <GoodsView state={state} focus={focus} />;
}

const EPOCH_COLOR: Record<string, string> = {
  stone: '#8a5bb0', earlyBronze: '#3aa0d8', lateBronze: '#46b35a', earlyIron: '#e8c84a', lateIron: '#e07a3a',
};

function AstView({ state }: { state: GameState }) {
  return (
    <div style={{ padding: 16, color: '#eee' }}>
      <h2 style={{ marginTop: 0 }}>Archaeological Succession Table</h2>
      <div style={{ display: 'flex', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
        {epochs.map((e) => (
          <span key={e.id} style={{ fontSize: 12 }}>
            <span style={{ display: 'inline-block', width: 12, height: 12, background: EPOCH_COLOR[e.id], marginRight: 4 }} />{e.name}
          </span>
        ))}
      </div>
      <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
        <tbody>
          {state.seating.map((id) => {
            const track = astTrackFor(id);
            const p = state.players[id]!;
            const liaStart = track.epochStart['lateIron'] ?? track.finishSpace;
            return (
              <tr key={id}>
                <td style={{ padding: '2px 8px', fontWeight: 800, color: civById.get(id)?.color }}>{civById.get(id)?.name}</td>
                {Array.from({ length: track.finishSpace }, (_, i) => i + 1).map((space) => {
                  const epoch = [...epochs].reverse().find((e) => space >= (track.epochStart[e.id] ?? 1))!;
                  const here = p.astSpace === space;
                  const liaVal = track.lateIronThresholds?.[space - liaStart];
                  return (
                    <td key={space} style={{ width: 30, height: 26, textAlign: 'center', background: EPOCH_COLOR[epoch.id], border: '1px solid #333', color: '#1a1a1a', position: 'relative' }}>
                      {liaVal ?? ''}
                      {here && <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <span style={{ width: 14, height: 14, borderRadius: '50%', background: civById.get(id)?.color, border: '2px solid #fff' }} /></span>}
                    </td>
                  );
                })}
                <td style={{ padding: '2px 6px' }}>🏁</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="civ-lbl" style={{ color: '#ccc' }}>Numbers in Late Iron Age spaces are the civilization-card point total needed to enter (§33.25). Dots are nation markers.</p>
    </div>
  );
}

function CensusView({ state }: { state: GameState }) {
  const rows = state.seating.map((id) => {
    let tokens = 0, cities = 0; for (const a of Object.values(state.areas)) { tokens += a.tokens[id] ?? 0; if (a.city === id) cities++; }
    return { id, tokens, cities };
  }).sort((a, b) => b.tokens - a.tokens);
  return (
    <div style={{ padding: 16, color: '#eee' }}>
      <h2 style={{ marginTop: 0 }}>Census</h2>
      <table style={{ fontSize: 14 }}><tbody>
        <tr style={{ textAlign: 'left' }}><th>Order</th><th>Nation</th><th>Population</th><th>Cities</th></tr>
        {rows.map((r, i) => (
          <tr key={r.id}><td>{i + 1}</td><td style={{ color: civById.get(r.id)?.color, fontWeight: 700, paddingRight: 20 }}>{civById.get(r.id)?.name}</td><td>{r.tokens}</td><td>{r.cities}</td></tr>
        ))}
      </tbody></table>
    </div>
  );
}

/** Concise credit summary for an advance (what buying it discounts later). */
function creditSummary(id: string): string {
  const a = advanceById.get(id); if (!a) return '';
  const parts: string[] = [];
  for (const [g, v] of Object.entries(a.credits.byGroup)) parts.push(`+${v} to other ${g}`);
  for (const [c, v] of Object.entries(a.credits.byCard)) parts.push(`+${v} to ${advanceById.get(c)?.name ?? c}`);
  return parts.join(', ');
}

/** Full-details hover panel for an advance (groups, cost, prereqs, effect, credits). */
function AdvanceTip({ id }: { id: string }) {
  const a = advanceById.get(id)!;
  const credits = creditSummary(id);
  return (
    <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 3, zIndex: 60, width: 270, background: '#1a160f', border: '1px solid #c79a3a', borderRadius: 6, padding: 10, boxShadow: '0 6px 24px #000', color: '#eee', fontSize: 12, lineHeight: 1.5, textAlign: 'left', whiteSpace: 'normal' }}>
      <div style={{ fontWeight: 800, color: '#ffd98a' }}>{a.name}</div>
      <div style={{ color: '#9a8d6a' }}>{a.groups.join(' / ')} · cost {a.cost}{a.prerequisites?.length ? ` · needs ${a.prerequisites.map((p) => advanceById.get(p)?.name ?? p).join(', ')}` : ''}</div>
      <div style={{ margin: '6px 0', color: '#ece4d2' }}>{ADVANCE_EFFECTS[id] ?? ''}</div>
      {credits && <div style={{ color: '#9ab8c8' }}>Credits: {credits}</div>}
    </div>
  );
}

/** An advance cell that reveals full details on hover. */
function AdvanceChip({ id, owned }: { id: string; owned: boolean }) {
  const a = advanceById.get(id)!;
  const [hover, setHover] = useState(false);
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ position: 'relative', padding: 6, borderRadius: 4, border: '1px solid #555', background: owned ? '#2e6b3a' : '#222', opacity: owned ? 1 : 0.6, cursor: 'help' }}>
      <b>{a.name}</b><br /><small>{a.groups.join('/')} · {a.cost}</small>
      {hover && <AdvanceTip id={id} />}
    </div>
  );
}

function ToolsView({ state, focus }: { state: GameState; focus: PlayerId }) {
  const owned = new Set(state.players[focus]!.advances);
  return (
    <div style={{ padding: 16, color: '#eee' }}>
      <h2 style={{ marginTop: 0 }}>Civilization Advances — {civById.get(focus)?.name}</h2>
      <div className="civ-lbl" style={{ color: '#b9ad8e', marginBottom: 8 }}>Hover any advance for its full effect, prerequisites and credits.</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6, maxWidth: 720 }}>
        {ALL_ADVANCES.map((a) => <AdvanceChip key={a.id} id={a.id} owned={owned.has(a.id)} />)}
      </div>
    </div>
  );
}

function GoodsView({ state, focus }: { state: GameState; focus: PlayerId }) {
  const hand = state.players[focus]!.hand;
  const mining = state.players[focus]!.advances.includes('mining');
  const entries = Object.entries(hand).filter(([, n]) => n > 0).sort(([a], [b]) => byCardValue(a, b));
  const commCount = entries.filter(([c]) => !isCal(c)).reduce((a, [, n]) => a + n, 0);
  return (
    <div style={{ padding: 16, color: '#eee' }}>
      <h2 style={{ marginTop: 0 }}>Trade Cards — {civById.get(focus)?.name}</h2>
      <p className="civ-lbl" style={{ marginTop: 0 }}>
        {commCount} commodity card{commCount === 1 ? '' : 's'} · total value <b>{handValue(hand, { mining })}</b>
        {' '}— a card alone is worth its number; a set of n of the same commodity is worth n² × its value, so collecting pays off.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {entries.length === 0 && <span>(no cards)</span>}
        {entries.map(([c, n]) => {
          const cal = isCal(c);
          const setVal = cal ? 0 : commoditySetValue(c, n);
          return (
            <div key={c} style={{ padding: 8, borderRadius: 4, background: cal ? '#7a2a2a' : '#33506a', minWidth: 90 }}>
              <b>{cal ? `⚠ ${c.slice(9)}` : commodityById.get(c)?.name ?? c}</b><br />
              <small>{cal ? 'calamity' : `value ${commodityById.get(c)?.value} ×${n} = ${setVal}`}</small>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- Movement planner (click origin → set count → click destination) -----

interface QueuedMove { from: string; to: string; count: number; byShip?: boolean; via?: string }

export interface MovementPlanner {
  active: boolean;
  origin: string | null;
  count: number;
  queued: QueuedMove[];
  /** Areas to ring on the board: legal destinations when an origin is picked,
   *  else all areas the actor can move tokens out of. */
  highlight: Set<string>;
  /** Tokens still available to move out of `area` (start count minus queued). */
  available: (area: string) => number;
  /** Reachable destinations from the current origin (for off-screen fallback buttons). */
  destinations: { to: string; byShip?: boolean }[];
  onBoardClick: (area: string | null) => void;
  setCount: (n: number) => void;
  removeQueued: (i: number) => void;
  /** Undo the most recently planned move. */
  undoLast: () => void;
  /** Submit the queued moves as one `move` action (player then done for phase). */
  commit: () => void;
  /** Pass without moving. */
  pass: () => void;
  /** The board state with all queued moves applied — render this during movement
   *  so planned moves show as already done (units sitting at their destinations). */
  previewState: GameState;
  /** Areas that received queued (not-yet-official) tokens, to mark on the board. */
  moved: Set<string>;
}

/** Drives the click-to-move flow, shared by hotseat and online clients. Pass the
 *  per-seat `legal` actions; the engine accepts any subset count, so we build the
 *  move from the chosen origin/destination/count rather than the enumerated
 *  full-stack options. */
export function useMovementPlanner(
  state: GameState, actor: PlayerId | null, legal: Action[], onApply: (a: Action) => void,
): MovementPlanner {
  const active = !!actor && state.phase === 'movement';
  const [origin, setOrigin] = useState<string | null>(null);
  const [count, setCountRaw] = useState(1);
  const [queued, setQueued] = useState<QueuedMove[]>([]);

  // Reset whenever the turn, phase, or seat changes (e.g. after a commit/pass).
  useEffect(() => { setOrigin(null); setQueued([]); setCountRaw(1); }, [actor, state.phase, state.turn]);

  // Legal move options grouped by origin: to-area -> { max, byShip, via }.
  const moveOpts = useMemo(() => {
    const byFrom = new Map<string, Map<string, { max: number; byShip?: boolean; via?: string }>>();
    for (const a of legal) {
      if (a.type !== 'move') continue;
      const m = a.moves[0]!;
      if (!byFrom.has(m.from)) byFrom.set(m.from, new Map());
      const dest = byFrom.get(m.from)!;
      // Prefer the land option if an area is reachable both ways.
      if (!dest.has(m.to) || (!m.byShip && dest.get(m.to)!.byShip)) {
        dest.set(m.to, { max: m.count, ...(m.byShip ? { byShip: true } : {}), ...(m.via ? { via: m.via } : {}) });
      }
    }
    return byFrom;
  }, [legal]);

  const queuedFrom = useCallback((area: string) => queued.filter((q) => q.from === area).reduce((s, q) => s + q.count, 0), [queued]);
  const available = useCallback((area: string) => (state.areas?.[area]?.tokens[actor ?? ''] ?? 0) - queuedFrom(area), [state, actor, queuedFrom]);

  const origins = useMemo(() => {
    const set = new Set<string>();
    for (const from of moveOpts.keys()) if (available(from) > 0) set.add(from);
    return set;
  }, [moveOpts, available]);

  const dests = origin ? moveOpts.get(origin) : undefined;
  const highlight = useMemo(() => new Set(origin && dests ? [...dests.keys()] : [...origins]), [origin, dests, origins]);

  const setCount = useCallback((n: number) => {
    const cap = origin ? available(origin) : 1;
    setCountRaw(Math.max(1, Math.min(n, Math.max(1, cap))));
  }, [origin, available]);

  const onBoardClick = useCallback((area: string | null) => {
    if (!active || !area) return;
    if (!origin) {
      if (origins.has(area)) { setOrigin(area); setCountRaw(1); }
      return;
    }
    if (area === origin) { setOrigin(null); return; }
    const opt = dests?.get(area);
    if (opt) {
      const max = Math.min(available(origin), opt.byShip ? 5 : Infinity);
      const n = Math.max(1, Math.min(count, max));
      setQueued((q) => [...q, { from: origin, to: area, count: n, ...(opt.byShip ? { byShip: true } : {}), ...(opt.via ? { via: opt.via } : {}) }]);
      setOrigin(null); setCountRaw(1);
      return;
    }
    if (origins.has(area)) { setOrigin(area); setCountRaw(1); } // switch origin
  }, [active, origin, origins, dests, count, available]);

  const removeQueued = useCallback((i: number) => setQueued((q) => q.filter((_, j) => j !== i)), []);
  const undoLast = useCallback(() => setQueued((q) => q.slice(0, -1)), []);
  const commit = useCallback(() => { if (queued.length) onApply({ type: 'move', moves: queued }); }, [queued, onApply]);
  const pass = useCallback(() => onApply({ type: 'pass' }), [onApply]);

  // Preview: apply queued moves to a clone so the board shows them as done.
  const previewState = useMemo(() => {
    if (!active || !actor || queued.length === 0) return state;
    const clone: GameState = JSON.parse(JSON.stringify(state));
    for (const q of queued) {
      const from = clone.areas[q.from] ?? (clone.areas[q.from] = { tokens: {} });
      const to = clone.areas[q.to] ?? (clone.areas[q.to] = { tokens: {} });
      from.tokens[actor] = (from.tokens[actor] ?? 0) - q.count;
      if ((from.tokens[actor] ?? 0) <= 0) delete from.tokens[actor];
      to.tokens[actor] = (to.tokens[actor] ?? 0) + q.count;
      if (q.byShip) {
        from.ships = from.ships ?? {}; to.ships = to.ships ?? {};
        from.ships[actor] = (from.ships[actor] ?? 0) - 1;
        if ((from.ships[actor] ?? 0) <= 0) delete from.ships[actor];
        to.ships[actor] = (to.ships[actor] ?? 0) + 1;
      }
    }
    return clone;
  }, [active, actor, state, queued]);

  const moved = useMemo(() => new Set(queued.map((q) => q.to)), [queued]);

  const destinations = origin && dests ? [...dests.entries()].map(([to, o]) => ({ to, ...(o.byShip ? { byShip: true as const } : {}) })) : [];
  return { active, origin, count, queued, highlight, available, destinations, onBoardClick, setCount, removeQueued, undoLast, commit, pass, previewState, moved };
}

export function MovementControls({ planner }: { planner: MovementPlanner }) {
  const { origin, count, queued, available, setCount, removeQueued, undoLast, commit, pass } = planner;
  const cap = origin ? available(origin) : 0;
  const name = (a: string) => areaById.get(a)?.name ?? a;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {!origin ? (
        <span className="civ-lbl">Click an area with your tokens to move <b>from</b>. Planned moves show on the map right away (dashed marker) and aren't final until you finish.</span>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="civ-lbl">From <b>{name(origin)}</b> — choose how many, then click a highlighted destination on the map <i>or a button below</i>:</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <button className="civ-btn" onClick={() => setCount(count - 1)} disabled={count <= 1}>−</button>
            <input type="range" min={1} max={Math.max(1, cap)} value={count} onChange={(e) => setCount(+e.target.value)} style={{ width: 120 }} />
            <button className="civ-btn" onClick={() => setCount(count + 1)} disabled={count >= cap}>+</button>
            <b>{count}</b> <span className="civ-lbl">of {cap}</span>
            <button className="civ-btn" onClick={() => setCount(cap)}>All</button>
            <button className="civ-btn" onClick={() => planner.onBoardClick(origin)}>Cancel</button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {planner.destinations.map((d) => (
              <button className="civ-btn" key={d.to} onClick={() => planner.onBoardClick(d.to)}>{d.byShip ? '⛵ ' : '→ '}{name(d.to)}</button>
            ))}
          </div>
        </div>
      )}

      {queued.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minHeight: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="civ-lbl">Planned moves — {queued.length} (not final):</span>
            <button className="civ-btn" onClick={undoLast}>↶ Undo last</button>
          </div>
          {/* Compact, scrollable grid so a long move list never crowds out the map. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: '2px 8px', maxHeight: 96, overflowY: 'auto', paddingRight: 4 }}>
            {queued.map((q, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{q.byShip ? '⛵ ' : ''}{name(q.from)} → {name(q.to)} ({q.count})</span>
                <button className="civ-btn" style={{ padding: '0 6px', lineHeight: '18px' }} onClick={() => removeQueued(i)}>✕</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 4 }}>
        <button className="civ-btn" onClick={() => (queued.length ? commit() : pass())}>
          {queued.length ? `Finish moving — make ${queued.length} move${queued.length === 1 ? '' : 's'} official` : 'Finish moving (no move)'}
        </button>
      </div>
    </div>
  );
}

// ---- Per-phase action controls (reused) ----------------------------------

export function ActionList({ legal, selectedArea, phase, onApply, state, actor }: {
  legal: Action[]; selectedArea: string | null; phase: string; onApply: (a: Action) => void; state: GameState; actor: PlayerId;
}) {
  const pass = legal.find((a) => a.type === 'pass');
  if (state.pendingDiscard?.holder === actor) return <DiscardControls state={state} onApply={onApply} />;
  if (phase === 'taxation') {
    const rates = legal.filter((a) => a.type === 'setTaxRate') as Extract<Action, { type: 'setTaxRate' }>[];
    const cities = Object.values(state.areas).filter((a) => a.city === actor).length;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span className="civ-lbl"><b>Coinage</b> — choose your tax rate (§32.421). You collect <b>cities × rate</b> ({cities} cit{cities === 1 ? 'y' : 'ies'}) tokens from stock into your treasury:</span>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {rates.map((r) => <button className="civ-btn" key={r.rate} onClick={() => onApply(r)}>Rate {r.rate} → collect {cities * r.rate}</button>)}
        </div>
      </div>
    );
  }
  if (phase === 'populationExpansion') {
    const places = legal.filter((a) => a.type === 'placeTokens') as Extract<Action, { type: 'placeTokens' }>[];
    const rem = state.expansion?.remaining[actor] ?? 0;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span className="civ-lbl">Not enough tokens in stock for full growth — place your <b>{rem}</b> remaining token{rem === 1 ? '' : 's'} (§13): <b>click a highlighted area on the map</b> to add one, or use a button below.</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {places.map((b, i) => { const aid = Object.keys(b.placements)[0]!; return <button className="civ-btn" key={i} onClick={() => onApply(b)}>+1 {areaById.get(aid)?.name}</button>; })}
        </div>
        {pass && <button className="civ-btn" onClick={() => onApply(pass)}>Done placing (forfeit rest)</button>}
      </div>
    );
  }
  if (phase === 'shipConstruction') {
    const builds = legal.filter((a) => a.type === 'buildShips') as Extract<Action, { type: 'buildShips' }>[];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {builds.length === 0 && <span className="civ-lbl">No ship can be built (need a coastal area + 2 tokens, max 4 ships).</span>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {builds.map((b, i) => <button className="civ-btn" key={i} onClick={() => onApply(b)}>⛵ Build ship in {areaById.get(b.builds[0]!.area)?.name} (2)</button>)}
        </div>
        {pass && <button className="civ-btn" onClick={() => onApply(pass)}>Done (pass)</button>}
      </div>
    );
  }
  // Movement is handled by <MovementControls> (click origin → count → destination).
  if (phase === 'cityConstruction') {
    const builds = legal.filter((a) => a.type === 'buildCity') as Extract<Action, { type: 'buildCity' }>[];
    // §26.31: each city needs 2 supporting tokens elsewhere on the board (a city
    // area holds none; over-limit tokens are culled). Warn if a build would lose
    // the city for lack of support, so it isn't an instant, silent loss.
    const cities = Object.values(state.areas).filter((a) => a.city === actor).length;
    const supportAfter = (buildArea: string) => Object.entries(state.areas)
      .filter(([aid]) => aid !== buildArea)
      .reduce((sum, [aid, a]) => sum + Math.min(a.tokens[actor] ?? 0, areaById.get(aid)?.sustains ?? 0), 0);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {builds.length === 0 && <span className="civ-lbl">No city can be built (need 6 tokens on a city site).</span>}
        <span className="civ-lbl">A city needs <b>2 supporting tokens elsewhere</b> on the board (§26.31) — tokens left in the city's own area are returned to stock.</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {builds.map((b, i) => {
            const unsupported = supportAfter(b.area) < 2 * (cities + 1);
            return (
              <button className="civ-btn" key={i} style={unsupported ? { borderColor: '#c0392b' } : undefined}
                title={unsupported ? 'You lack 2 supporting tokens elsewhere — this city would be reduced immediately (§26.31).' : ''}
                onClick={() => { if (!unsupported || confirm(`You don't have 2 supporting tokens elsewhere, so the city in ${areaById.get(b.area)?.name} will be lost immediately (§26.31). Build anyway?`)) onApply(b); }}>
                Build city in {areaById.get(b.area)?.name}{unsupported ? ' ⚠' : ''}
              </button>
            );
          })}
        </div>
        {pass && <button className="civ-btn" onClick={() => onApply(pass)}>Done building (pass)</button>}
      </div>
    );
  }
  if (phase === 'calamity' && state.pendingCityChoice?.holder === actor) return <CityChoiceControls state={state} legal={legal} onApply={onApply} />;
  if (phase === 'calamity' && state.pendingUnitLoss?.holder === actor) return <UnitLossControls state={state} legal={legal} onApply={onApply} />;
  if (phase === 'calamity' && state.pendingAllocation?.holder === actor) return <AllocationControls state={state} legal={legal} onApply={onApply} />;
  if (phase === 'calamity') return <ConversionControls state={state} legal={legal} onApply={onApply} />;
  if (phase === 'acquireAdvances') return <AdvancePicker state={state} actor={actor} onApply={onApply} />;
  if (phase === 'trade') return <TradeControls state={state} actor={actor} onApply={onApply} />;
  return <button className="civ-btn" onClick={() => pass && onApply(pass)}>Continue</button>;
}

const isCal = (c: string) => c.startsWith('calamity:');
/** A card you may put in a trade offer: any commodity, or a TRADABLE calamity
 *  (non-tradable ones — Volcano/Famine/Civil War/Flood — can't be passed, §9.1). */
const isGivableCard = (c: string) => !isCal(c) || calamityById.get(c.slice(9))?.tradable === true;
const cardLabel = (c: string) => (isCal(c) ? `⚠ ${c.slice(9)}` : c);
/** Sort card ids: commodities ascending by value, calamities last. */
const byCardValue = (a: string, b: string) => (isCal(a) ? 1000 : commodityById.get(a)?.value ?? 0) - (isCal(b) ? 1000 : commodityById.get(b)?.value ?? 0);

const COMMODITY_ORDER = ['ochre', 'hides', 'iron', 'papyrus', 'salt', 'timber', 'grain', 'oil', 'cloth', 'wine', 'bronze', 'silver', 'resin', 'spices', 'dye', 'gems', 'gold', 'ivory'];

/** Acquire-advances panel (§31): pick an advance, then choose exactly which
 *  commodity cards to spend and how much treasury — instead of auto-paying. */
/** §29/§32.94 Monotheism conversion picker, shown during the calamity phase. */
/** §29.63 / §30.41: choose which of your own units to lose (Famine/Epidemic/Flood)
 *  or cede (Civil War) — tokens per area + whole cities, covering the required loss. */
function UnitLossControls({ state, legal, onApply }: { state: GameState; legal: Action[]; onApply: (a: Action) => void }) {
  const u = state.pendingUnitLoss!;
  const keepMode = u.mode === 'cede'; // Civil War: you pick the faction you KEEP; the rest defect.
  const scope = u.areas ?? Object.keys(state.areas);
  const inv = scope.map((aid) => ({ aid, tokens: state.areas[aid]?.tokens[u.holder] ?? 0, city: state.areas[aid]?.city === u.holder }))
    .filter((x) => x.tokens > 0 || x.city);
  // Start with NO pre-selection (reporters disliked the auto-picked default); a
  // Suggest button fills in the sensible play if wanted.
  const [tok, setTok] = useState<Record<string, number>>({});
  const [cities, setCities] = useState<string[]>([]);
  const avail = inv.reduce((t, x) => t + x.tokens + (x.city ? u.cityWorth : 0), 0);
  const lose = Math.min(u.points, avail);            // points that go away (lost, or defect to the beneficiary)
  const target = keepMode ? avail - lose : lose;     // what the selection should total: kept faction, or units lost
  const total = Object.values(tok).reduce((t, n) => t + n, 0) + cities.length * u.cityWorth;
  const effectiveLost = keepMode ? avail - total : total; // points actually given up by this selection
  const ok = effectiveLost >= lose && effectiveLost - lose < u.cityWorth;
  const setT = (aid: string, max: number, d: number) => setTok((s) => ({ ...s, [aid]: Math.max(0, Math.min(max, (s[aid] ?? 0) + d)) }));
  // The engine's suggestion is the cheapest set to GIVE UP. For keep mode, the
  // recommended keep is its complement (hold your strongest units & cities).
  const sugg = (legal.find((x) => x.type === 'chooseUnits') as Extract<Action, { type: 'chooseUnits' }> | undefined);
  const suggest = () => {
    if (!sugg) return;
    if (!keepMode) { setTok({ ...sugg.tokens }); setCities([...(sugg.cities ?? [])]); return; }
    const giveT = sugg.tokens ?? {}; const giveC = new Set(sugg.cities ?? []);
    const keepT: Record<string, number> = {};
    for (const x of inv) { const k = x.tokens - (giveT[x.aid] ?? 0); if (k > 0) keepT[x.aid] = k; }
    setTok(keepT); setCities(inv.filter((x) => x.city && !giveC.has(x.aid)).map((x) => x.aid));
  };
  const submit = () => {
    if (!keepMode) { onApply({ type: 'chooseUnits', tokens: tok, cities }); return; }
    // Cede everything NOT kept: per-area token complement + cities not kept.
    const cededT: Record<string, number> = {};
    for (const x of inv) { const c = x.tokens - (tok[x.aid] ?? 0); if (c > 0) cededT[x.aid] = c; }
    onApply({ type: 'chooseUnits', tokens: cededT, cities: inv.filter((x) => x.city && !cities.includes(x.aid)).map((x) => x.aid) });
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {CALAMITY_DESC[u.calamityId] && <span className="civ-lbl" style={{ color: '#cfc7b4' }}>⚠ {CALAMITY_DESC[u.calamityId]}</span>}
      {keepMode
        ? <span className="civ-lbl">Your nation splits in two. Choose the faction you <b>keep</b> (<b>{target}</b> points); everything else defects to <b style={{ color: nationColor(u.beneficiary!) }}>{nationName(u.beneficiary!)}</b>:</span>
        : <span className="civ-lbl">Choose units to <b>lose</b> totalling <b>{target}</b> point{target === 1 ? '' : 's'}{u.areas ? ' (on the flood plain)' : ''}:</span>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: '30vh', overflowY: 'auto' }}>
        {inv.map((x) => (
          <div key={x.aid} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 110, color: nationColor(u.holder) }}>{areaById.get(x.aid)?.name ?? x.aid}</span>
            {x.tokens > 0 && <>
              <button className="civ-btn" style={{ padding: '0 7px' }} onClick={() => setT(x.aid, x.tokens, -1)}>−</button>
              <b style={{ width: 36, textAlign: 'center' }}>{tok[x.aid] ?? 0}/{x.tokens}</b>
              <button className="civ-btn" style={{ padding: '0 7px' }} onClick={() => setT(x.aid, x.tokens, +1)}>+</button>
              <span className="civ-lbl" style={{ color: '#9a8d6a' }}>{keepMode ? 'keep' : 'tokens'}</span>
            </>}
            {x.city && <button className={`civ-btn ${cities.includes(x.aid) ? 'on' : ''}`} style={{ fontSize: 11 }} onClick={() => setCities((c) => c.includes(x.aid) ? c.filter((y) => y !== x.aid) : [...c, x.aid])}>{cities.includes(x.aid) ? (keepMode ? '★ ' : '✗ ') : ''}{keepMode ? 'keep city' : 'city'} ({u.cityWorth})</button>}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span className="civ-lbl" style={{ color: ok ? '#7caa6a' : '#caa05a' }}>{keepMode ? `keeping ${total} / ${target}` : `${total} / ${target} points`}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {sugg && <button className="civ-btn" style={{ fontSize: 11 }} onClick={suggest}>Suggest</button>}
          <button className="civ-btn" disabled={!ok} onClick={submit}>{keepMode ? 'Keep this faction' : 'Lose these'}</button>
        </div>
      </div>
    </div>
  );
}

/** §31.71: over the 8-card hand limit — choose which surplus commodity cards to
 *  surrender (the rest are kept). */
function DiscardControls({ state, onApply }: { state: GameState; onApply: (a: Action) => void }) {
  const d = state.pendingDiscard!;
  const hand = state.players[d.holder]!.hand;
  const cards = Object.entries(hand).filter(([c, n]) => !isCal(c) && n > 0).flatMap(([c, n]) => Array<string>(n).fill(c)).sort((a, b) => byCardValue(a, b));
  const [sel, setSel] = useState<string[]>([]); // start empty — the player picks
  // Toggle one physical card by index (cards may repeat by name).
  const toggle = (i: number) => setSel((s) => { const next = [...s]; const at = next.indexOf(String(i)); if (at >= 0) next.splice(at, 1); else if (next.length < d.count) next.push(String(i)); return next; });
  const ok = sel.length === d.count;
  const submit = () => onApply({ type: 'chooseDiscard', cards: sel.map((i) => cards[Number(i)]!) });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="civ-lbl">You hold {cards.length} commodity cards — over the limit of 8 (§31.71). Choose <b>{d.count}</b> to discard; you keep the rest:</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
        {cards.map((c, i) => (
          <button key={i} className={`civ-btn ${sel.includes(String(i)) ? 'on' : ''}`} style={{ fontSize: 11 }} onClick={() => toggle(i)}>
            {sel.includes(String(i)) ? '✗ ' : ''}{commodityById.get(c)?.name ?? c} ({commodityById.get(c)?.value ?? '?'})
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span className="civ-lbl" style={{ color: ok ? '#7caa6a' : '#caa05a' }}>{sel.length} / {d.count} to discard</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="civ-btn" style={{ fontSize: 11 }} onClick={() => setSel(cards.map((_, i) => String(i)).slice(0, d.count))}>Cheapest</button>
          <button className="civ-btn" disabled={!ok} onClick={submit}>Discard these</button>
        </div>
      </div>
    </div>
  );
}

/** §30.321/.711/.811: as the primary victim of Superstition/Civil Disorder/
 *  Iconoclasm, choose which of your cities to reduce. */
function CityChoiceControls({ state, legal, onApply }: { state: GameState; legal: Action[]; onApply: (a: Action) => void }) {
  const c = state.pendingCityChoice!;
  const cities = Object.keys(state.areas).filter((a) => state.areas[a]!.city === c.holder);
  const suggested = (legal.find((x) => x.type === 'chooseCities') as Extract<Action, { type: 'chooseCities' }> | undefined)?.areas ?? [];
  const [sel, setSel] = useState<string[]>(suggested);
  const toggle = (aid: string) => setSel((s) => (s.includes(aid) ? s.filter((x) => x !== aid) : s.length < c.count ? [...s, aid] : s));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {CALAMITY_DESC[c.calamityId] && <span className="civ-lbl" style={{ color: '#cfc7b4' }}>⚠ {CALAMITY_DESC[c.calamityId]}</span>}
      <span className="civ-lbl">Choose <b>{c.count}</b> of your cit{c.count === 1 ? 'y' : 'ies'} to reduce:</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
        {cities.map((aid) => (
          <button key={aid} className={`civ-btn ${sel.includes(aid) ? 'on' : ''}`} style={{ fontSize: 11 }} onClick={() => toggle(aid)}>
            {sel.includes(aid) ? '✗ ' : ''}{areaById.get(aid)?.name ?? aid}{areaById.get(aid)?.isCitySite ? ' ⬚' : ''}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span className="civ-lbl" style={{ color: sel.length === c.count ? '#7caa6a' : '#caa05a' }}>{sel.length} / {c.count} chosen</span>
        <button className="civ-btn" disabled={sel.length !== c.count} onClick={() => onApply({ type: 'chooseCities', areas: sel })}>Reduce these</button>
      </div>
    </div>
  );
}

/** §29.64: as the primary victim of Famine/Epidemic/Iconoclasm, distribute the
 *  ordered secondary losses among rivals — you must direct the full amount. */
function AllocationControls({ state, legal, onApply }: { state: GameState; legal: Action[]; onApply: (a: Action) => void }) {
  const a = state.pendingAllocation!;
  const rivals = Object.keys(a.caps);
  const maxTotal = Math.min(a.pool, rivals.reduce((t, v) => t + a.caps[v]!, 0));
  const suggested = (legal.find((x) => x.type === 'allocateLoss') as Extract<Action, { type: 'allocateLoss' }> | undefined)?.allocation ?? {};
  const [alloc, setAlloc] = useState<Record<string, number>>(suggested);
  const total = rivals.reduce((t, v) => t + (alloc[v] ?? 0), 0);
  const unit = a.kind === 'cities' ? 'cities' : 'unit points';
  const set = (v: string, d: number) => setAlloc((s) => {
    const cur = s[v] ?? 0;
    const next = Math.max(0, Math.min(a.caps[v]!, cur + d));
    const others = total - cur;
    if (others + next > maxTotal) return s; // can't exceed the ordered amount
    return { ...s, [v]: next };
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="civ-lbl" style={{ color: '#e6b85a' }}>§29.64 — as the victim you direct the secondary losses:</span>
      <span className="civ-lbl">Direct <b>{maxTotal} {unit}</b> of loss onto rival nations (max {a.kind === 'cities' ? '' : `${a.pool === 20 ? 8 : 10} `}per nation):</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {rivals.map((v) => (
          <div key={v} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 90, color: nationColor(v), fontWeight: 700 }}>{nationName(v)}</span>
            <button className="civ-btn" style={{ padding: '0 8px' }} onClick={() => set(v, -1)}>−</button>
            <b style={{ width: 24, textAlign: 'center' }}>{alloc[v] ?? 0}</b>
            <button className="civ-btn" style={{ padding: '0 8px' }} onClick={() => set(v, +1)}>+</button>
            <span className="civ-lbl" style={{ color: '#9a8d6a' }}>/ {a.caps[v]} max</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span className="civ-lbl" style={{ color: total === maxTotal ? '#7caa6a' : '#caa05a' }}>directed {total} / {maxTotal}</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="civ-btn" onClick={() => setAlloc(suggested)}>Target the leader</button>
          <button className="civ-btn" disabled={total !== maxTotal} onClick={() => onApply({ type: 'allocateLoss', allocation: alloc })}>Confirm</button>
        </div>
      </div>
    </div>
  );
}

function ConversionControls({ state, legal, onApply }: { state: GameState; legal: Action[]; onApply: (a: Action) => void }) {
  const converts = legal.filter((a) => a.type === 'convertArea') as Extract<Action, { type: 'convertArea' }>[];
  const desc = (aid: string) => {
    const a = state.areas[aid]; const nm = areaById.get(aid)?.name ?? aid;
    const victim = a?.city && a.city in state.players ? a.city : Object.keys(a?.tokens ?? {}).find((o) => o in state.players);
    const cityHere = a?.city && a.city in state.players;
    const toks = victim ? a?.tokens[victim] ?? 0 : 0;
    return `${nm} — ${cityHere ? 'city' : ''}${cityHere && toks ? ' + ' : ''}${toks ? `${toks} token${toks > 1 ? 's' : ''}` : ''} of ${civById.get(victim ?? '')?.name ?? victim}`;
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="civ-lbl"><b>Monotheism</b> (§32.94) — convert <i>one</i> adjacent enemy area, replacing their pieces with your own (from stock):</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
        {converts.map((c) => <button key={c.area} className="civ-btn" style={{ fontSize: 11 }} onClick={() => onApply(c)}>✝ Convert {desc(c.area)}</button>)}
      </div>
      <button className="civ-btn" onClick={() => onApply({ type: 'pass' })}>Don't convert (pass)</button>
    </div>
  );
}

function AdvancePicker({ state, actor, onApply }: { state: GameState; actor: PlayerId; onApply: (a: Action) => void }) {
  const p = state.players[actor]!;
  const mining = p.advances.includes('mining');
  const [sel, setSel] = useState<string>('');
  const [tip, setTip] = useState<string>('');
  const [spend, setSpend] = useState<Record<string, number>>({});
  const [treasury, setTreasury] = useState(0);
  const cName = (c: string) => commodityById.get(c)?.name ?? c;
  const owned = new Set(p.advances);
  // Advances whose prerequisites are met and not yet owned.
  const available = ALL_ADVANCES.filter((a) => !owned.has(a.id) && (a.prerequisites ?? []).every((pre) => owned.has(pre)));
  const adv = sel ? advanceById.get(sel) : null;
  const commHand = Object.entries(p.hand).filter(([c, n]) => !isCal(c) && n > 0).sort((a, b) => byCardValue(a[0], b[0]));
  const cardVal = handValue(spend, { mining });
  const credit = adv ? creditTowards(p.advances, adv.id) : 0;
  // You pay only the remaining cost from treasury — never overpay.
  const treasuryNeeded = adv ? Math.max(0, adv.cost - cardVal - credit) : 0;
  const maxTreasury = Math.min(p.treasury, treasuryNeeded);
  const treasuryUsed = Math.min(treasury, maxTreasury);
  const paid = cardVal + treasuryUsed + credit;
  const canBuy = !!adv && paid >= adv.cost;
  const addSpend = (c: string) => setSpend((s) => ((s[c] ?? 0) >= (p.hand[c] ?? 0) ? s : { ...s, [c]: (s[c] ?? 0) + 1 }));
  const rmSpend = (c: string) => setSpend((s) => { const n = (s[c] ?? 0) - 1; const o = { ...s }; if (n <= 0) delete o[c]; else o[c] = n; return o; });
  const buy = () => { onApply({ type: 'buyAdvance', advance: sel, spendCommodities: spend, spendTreasury: treasuryUsed }); setSel(''); setSpend({}); setTreasury(0); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="civ-lbl">Acquire an advance — pick one, then choose how to pay (cards + treasury). Treasury available: {p.treasury}.</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
        {available.length === 0 && <span className="civ-lbl">No advance available (prerequisites unmet).</span>}
        {available.map((a) => (
          <span key={a.id} style={{ position: 'relative', display: 'inline-block' }} onMouseEnter={() => setTip(a.id)} onMouseLeave={() => setTip((t) => (t === a.id ? '' : t))}>
            <button className={`civ-btn ${sel === a.id ? 'on' : ''}`} style={{ fontSize: 11 }} onClick={() => { setSel(a.id); setSpend({}); setTreasury(0); }}>
              {a.name} ({a.cost}{creditTowards(p.advances, a.id) ? `, −${creditTowards(p.advances, a.id)} credit` : ''})
            </button>
            {tip === a.id && <AdvanceTip id={a.id} />}
          </span>
        ))}
      </div>
      {adv && (
        <div style={{ border: '1px solid #7a4a18', borderRadius: 4, padding: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div className="civ-lbl">Pay for <b>{adv.name}</b> — cost {adv.cost}{credit ? `, ${credit} free from cards you own` : ''}. Click cards to spend:</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            {commHand.length === 0 && <span className="civ-lbl">(no commodity cards)</span>}
            {commHand.map(([c, n]) => (
              <span key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, border: '1px solid #7a4a18', borderRadius: 4, padding: '0 3px', background: (spend[c] ?? 0) ? 'rgba(90,140,106,0.35)' : undefined }}>
                <button className="civ-btn" style={{ padding: '0 5px' }} onClick={() => addSpend(c)}>{cName(c)} {spend[c] ? `${spend[c]}/${n}` : `×${n}`}</button>
                {(spend[c] ?? 0) > 0 && <button className="civ-btn" style={{ padding: '0 4px' }} onClick={() => rmSpend(c)}>−</button>}
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span className="civ-lbl">Treasury</span>
            <input type="range" min={0} max={Math.max(0, maxTreasury)} value={treasuryUsed} onChange={(e) => setTreasury(+e.target.value)} style={{ width: 110 }} disabled={maxTreasury <= 0} />
            <b>{treasuryUsed}</b>
            <span className="civ-lbl">· paid <b style={{ color: canBuy ? '#2e6b3a' : '#8a3b12' }}>{paid}</b> / {adv.cost} (cards {cardVal}{credit ? ` + ${credit} credit` : ''} + {treasuryUsed} treasury) — exact, no overpay</span>
          </div>
          <button className="civ-btn" disabled={!canBuy} onClick={buy}>{canBuy ? `Buy ${adv.name}` : `Need ${adv.cost - paid} more`}</button>
        </div>
      )}
      <button className="civ-btn" onClick={() => onApply({ type: 'pass' })}>Done buying (pass)</button>
    </div>
  );
}

/** Build a give bundle: pick cards from your hand (the real `actual`), choose an
 *  announced name for each (truthful or a bluff), and submit. Used both to post
 *  an offer and to respond to one. */
function OfferBuilder({ me, submitLabel, onSubmit, wantPicker }: {
  me: { hand: Record<string, number> };
  submitLabel: string;
  onSubmit: (give: { actual: Record<string, number>; declared: Record<string, number> }, wants: string[]) => void;
  wantPicker: boolean;
}) {
  const [give, setGive] = useState<Record<string, number>>({});
  const [announce, setAnnounce] = useState<Record<string, string>>({}); // card type -> announced commodity (bluff)
  const [wants, setWants] = useState<string[]>([]);
  const cName = (c: string) => (isCal(c) ? `⚠ ${c.slice(9)}` : commodityById.get(c)?.name ?? c);
  const announcedFor = (c: string) => announce[c] ?? (isCal(c) ? 'ochre' : c);
  const declared: Record<string, number> = {};
  for (const [c, n] of Object.entries(give)) { const a = announcedFor(c); declared[a] = (declared[a] ?? 0) + n; }
  const total = Object.values(give).reduce((a, b) => a + b, 0);
  let truthful = 0; for (const [c, n] of Object.entries(give)) if (!isCal(c) && announcedFor(c) === c) truthful += n;
  const wantsOk = !wantPicker || (wants.length >= 1 && wants.length <= 5);
  const ok = total >= 3 && truthful >= 2 && wantsOk;
  const add = (c: string) => setGive((g) => ((g[c] ?? 0) >= (me.hand[c] ?? 0) ? g : { ...g, [c]: (g[c] ?? 0) + 1 }));
  const rm = (c: string) => setGive((g) => { const n = (g[c] ?? 0) - 1; const o = { ...g }; if (n <= 0) delete o[c]; else o[c] = n; return o; });
  const toggleWant = (c: string) => setWants((w) => (w.includes(c) ? w.filter((x) => x !== c) : w.length < 5 ? [...w, c] : w));
  const submit = () => { onSubmit({ actual: give, declared }, wants); setGive({}); setAnnounce({}); setWants([]); };
  const hint = total < 3 ? 'Pick at least 3 cards to give.' : truthful < 2 ? 'At least 2 announced cards must be truthful.' : !wantsOk ? 'Pick 1–5 commodities you want.' : '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, border: '1px solid #7a4a18', borderRadius: 4, padding: 6 }}>
      <span className="civ-lbl">Your hand — click to add to the offer:</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
        {Object.entries(me.hand).filter(([c, n]) => n > 0 && isGivableCard(c)).sort((a, b) => byCardValue(a[0], b[0])).map(([c, n]) => (
          <button className="civ-btn" key={c} disabled={(give[c] ?? 0) >= n} onClick={() => add(c)}>{cName(c)} ×{n - (give[c] ?? 0)}</button>
        ))}
        {Object.keys(me.hand).filter((c) => (me.hand[c] ?? 0) > 0 && isGivableCard(c)).length === 0 && <span className="civ-lbl">(no tradable cards)</span>}
      </div>
      {total > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span className="civ-lbl">You give ({total}) · {truthful} truthful{truthful < 2 ? ' (need ≥2)' : ''} — announce each (pick a bluff to lie):</span>
          {Object.entries(give).map(([c, n]) => (
            <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
              <span style={{ minWidth: 70 }}>{cName(c)} ×{n}</span>
              <span className="civ-lbl">announce as</span>
              <select value={announcedFor(c)} onChange={(e) => setAnnounce((a) => ({ ...a, [c]: e.target.value }))}>
                {!isCal(c) && <option value={c}>{commodityById.get(c)?.name ?? c} (true)</option>}
                {COMMODITY_ORDER.filter((x) => x !== c).map((x) => <option key={x} value={x}>{commodityById.get(x)?.name} (bluff)</option>)}
              </select>
              <button className="civ-btn" style={{ padding: '0 6px' }} onClick={() => rm(c)}>✕</button>
            </div>
          ))}
        </div>
      )}
      {wantPicker && (
        <div>
          <span className="civ-lbl">You want (1–5): {wants.map(cName).join(' or ') || '—'}</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 2 }}>
            {COMMODITY_ORDER.map((c) => <button key={c} className={`civ-btn ${wants.includes(c) ? 'on' : ''}`} style={{ padding: '0 6px', fontSize: 11 }} onClick={() => toggleWant(c)}>{commodityById.get(c)?.name}</button>)}
          </div>
        </div>
      )}
      {hint && <span className="civ-lbl" style={{ color: '#8a3b12' }}>{hint}</span>}
      <button className="civ-btn" disabled={!ok} onClick={submit}>{submitLabel}</button>
    </div>
  );
}

/** Trade panel (§28) — the open-offer board, after the 1995 game's trade screens:
 *  post one standing offer (with bluffs + up to 5 wanted commodities), see every
 *  player's offers, respond to any, and (as owner) accept a response to close the
 *  deal. Completed deals reveal what each side really gave (incl. the partner's
 *  bluff) — privately, to the two traders. */
function TradeControls({ state, actor, onApply }: { state: GameState; actor: PlayerId; onApply: (a: Action) => void }) {
  const me = state.players[actor]!;
  const n = state.negotiation;
  const myOffer = n.offers.find((o) => o.from === actor);
  const otherOffers = n.offers.filter((o) => o.from !== actor);
  const [respondTo, setRespondTo] = useState<number | null>(null);
  const cName = (c: string) => (isCal(c) ? `⚠ ${c.slice(9)}` : commodityById.get(c)?.name ?? c);
  const chips = (m: Record<string, number>) => Object.entries(m).map(([c, k]) => `${k}× ${cName(c)}`).join(', ') || '—';

  const handCards = Object.entries(me.hand).filter(([c, k]) => !isCal(c) && k > 0);
  const handTotal = handCards.reduce((a, [, k]) => a + k, 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="civ-lbl">Your hand: <b>{handTotal}</b> commodity card{handTotal === 1 ? '' : 's'} · rough value <b>{handValue(me.hand)}</b> (sets count more — value grows with the square of a set).</div>
      {(() => {
        const cals = Object.keys(me.hand).filter((c) => isCal(c) && (me.hand[c] ?? 0) > 0);
        if (cals.length === 0) return null;
        const tradable = cals.filter((c) => !c.startsWith('calamity:volcano') && !c.startsWith('calamity:famine') && !c.startsWith('calamity:civilwar') && !c.startsWith('calamity:flood'));
        return (
          <div className="civ-msg" style={{ padding: 6, fontSize: 12, background: 'rgba(120,42,42,0.5)' }}>
            ⚠ You hold {cals.length} calamity card{cals.length === 1 ? '' : 's'}: {cals.map((c) => c.slice(9)).join(', ')}. Whatever you still hold when trading ends <b>strikes you</b>. You can slip a <i>tradable</i> calamity into an offer to pass it on{tradable.length < cals.length ? '; the non-tradable ones (Volcano/Famine/Civil War/Flood) can’t be passed and will hit you' : ''}.
          </div>
        );
      })()}
      {/* Completed deals (Trade Details — private to you). */}
      {(n.completed ?? []).map((d, i) => {
        const youAreA = d.a === actor;
        const gave = youAreA ? d.aGave : d.bGave;
        const got = youAreA ? d.bGave : d.aGave;
        const partner = youAreA ? d.b : d.a;
        // What the partner really gave vs what they announced = their bluff.
        const bluff: Record<string, number> = {};
        for (const [c, k] of Object.entries(got.actual)) { const declaredK = got.declared[c] ?? 0; if (k > declaredK) bluff[c] = k - declaredK; }
        return (
          <div key={i} className="civ-msg" style={{ padding: 6, fontSize: 12 }}>
            ✅ Trade with <b style={{ color: civById.get(partner)?.color }}>{civById.get(partner)?.name}</b>: you gave {chips(gave.actual)}; you received <b>{chips(got.actual)}</b>.
            {Object.keys(bluff).length > 0 && <> <span style={{ color: '#8a3b12' }}>({civById.get(partner)?.name} bluffed with {chips(bluff)}!)</span></>}
          </div>
        );
      })}

      {/* Your standing offer, with responses to accept. */}
      {myOffer ? (
        <div style={{ border: '2px solid #ffd23f', borderRadius: 4, padding: 6 }}>
          <div className="civ-lbl">Your offer — gives {Object.values(myOffer.give.actual).reduce((a, b) => a + b, 0)} (announced {chips(myOffer.give.declared)}); wants {myOffer.wants.map(cName).join(' or ')}.</div>
          {myOffer.responses.length === 0 ? <div className="civ-lbl">Waiting for responses…</div> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 3 }}>
              <span className="civ-lbl">Responses — value is your hand-value gain <i>if they're not lying</i>:</span>
              {myOffer.responses.map((r) => {
                // If not lying: receive their declared cards, give away your offered cards.
                const after = { ...me.hand };
                for (const [c, k] of Object.entries(myOffer.give.actual)) { after[c] = (after[c] ?? 0) - k; if (after[c]! <= 0) delete after[c]; }
                for (const [c, k] of Object.entries(r.give.declared)) after[c] = (after[c] ?? 0) + k;
                const gain = handValue(after) - handValue(me.hand);
                return (
                  <div key={r.from} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    <span style={{ flex: 1 }}><b style={{ color: civById.get(r.from)?.color }}>{civById.get(r.from)?.name}</b> offers {chips(r.give.declared)}</span>
                    <b style={{ color: gain >= 0 ? '#2e6b3a' : '#8a3b12', minWidth: 38, textAlign: 'right' }}>{gain >= 0 ? '+' : ''}{gain}</b>
                    <button className="civ-btn" onClick={() => onApply({ type: 'acceptResponse', offerId: myOffer.id, responder: r.from })}>Accept</button>
                  </div>
                );
              })}
            </div>
          )}
          <button className="civ-btn" style={{ marginTop: 4 }} onClick={() => onApply({ type: 'withdrawOffer' })}>{myOffer.responses.length ? 'Reject all & withdraw' : 'Withdraw offer'}</button>
        </div>
      ) : (
        <div>
          <span className="civ-lbl">Post your offer:</span>
          <OfferBuilder me={me} wantPicker submitLabel="Post offer to the board" onSubmit={(give, wants) => onApply({ type: 'postOffer', give, wants })} />
        </div>
      )}

      {/* The board: everyone else's open offers. */}
      <div>
        <span className="civ-lbl">Offers on the board:</span>
        {otherOffers.length === 0 && <div className="civ-lbl">(none yet)</div>}
        {otherOffers.map((o) => (
          <div key={o.id} style={{ border: '1px solid #7a4a18', borderRadius: 4, padding: 6, marginTop: 3 }}>
            <div style={{ fontSize: 12 }}><b style={{ color: civById.get(o.from)?.color }}>{civById.get(o.from)?.name}</b> gives {Object.values(o.give.actual).reduce((a, b) => a + b, 0) || Object.values(o.give.declared).reduce((a, b) => a + b, 0)} (announced {chips(o.give.declared)}) · wants <b>{o.wants.map(cName).join(' or ')}</b></div>
            {o.responses.some((r) => r.from === actor) ? <span className="civ-lbl">You've responded.</span>
              : respondTo === o.id
                ? <OfferBuilder me={me} wantPicker={false} submitLabel={`Respond to ${civById.get(o.from)?.name}`} onSubmit={(give) => { onApply({ type: 'respondOffer', offerId: o.id, give }); setRespondTo(null); }} />
                : <button className="civ-btn" style={{ marginTop: 3 }} onClick={() => setRespondTo(o.id)}>Respond to this offer</button>}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {me.treasury >= 18 && (state.trade.stacks[9]?.length ?? 0) > 0 && (
          <button className="civ-btn" onClick={() => onApply({ type: 'buyTradeCard', count: 1 })}>Buy Gold/Ivory (18)</button>
        )}
        <button className="civ-btn" onClick={() => onApply({ type: 'pass' })}>Done trading (pass)</button>
      </div>
    </div>
  );
}

/** Centered problem-report modal (matches the sibling projects): a severity
 *  picker, a description box, Send/Download, and the player's past reports with
 *  any replies. Opened by a button; `onSend` returns the new report id. */
export function ReportModal({ mine, onSend, onDownload, onClose }: { mine: MyReport[]; onSend: (message: string, severity: string) => Promise<string>; onDownload?: () => void; onClose: () => void }) {
  const [message, setMessage] = useState('');
  const [severity, setSeverity] = useState<'bug' | 'rules-question' | 'feedback'>('bug');
  const [status, setStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const submit = async () => {
    setSending(true); setStatus('Sending…');
    try { const id = await onSend(message, severity); setStatus(`Thanks! Report ${id.slice(0, 8)} received — we read every one, please keep them coming.`); setMessage(''); }
    catch (e) { setStatus(`Couldn't send: ${(e as Error).message}${onDownload ? ' — use Download report and email it.' : ''}`); }
    finally { setSending(false); }
  };
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(8,6,3,0.8)', display: 'grid', placeItems: 'center', zIndex: 150 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#211c14', color: '#eee', padding: 22, borderRadius: 12, border: '2px solid #c79a3a', width: 500, maxWidth: '92vw', maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 8px 40px #000' }}>
        <div style={{ fontSize: 12, color: '#ffd23f', fontWeight: 800, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Report a problem</div>
        <div className="civ-lbl" style={{ color: '#cfc7b4', marginBottom: 8 }}>Spotted a bug, a rules mistake, or have feedback? Tell us — it really helps.</div>
        <select value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)} style={{ fontSize: 13, marginBottom: 8 }}>
          <option value="bug">Bug</option><option value="rules-question">Rules question</option><option value="feedback">Feedback</option>
        </select>
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What happened? What did you expect?" rows={4} style={{ fontSize: 13, width: '100%', boxSizing: 'border-box', marginBottom: 8 }} />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="civ-btn" disabled={!message.trim() || sending} onClick={submit} style={{ fontWeight: 700 }}>Send</button>
          {onDownload && <button className="civ-btn" onClick={onDownload}>Download report</button>}
          <button className="civ-btn" onClick={onClose}>Close</button>
        </div>
        {status && <div className="civ-lbl" style={{ color: '#e6b85a', marginTop: 8 }}>{status}</div>}
        {mine.length > 0 && (
          <div style={{ marginTop: 16, borderTop: '1px solid #7a4a18', paddingTop: 10 }}>
            <div style={{ fontSize: 12, color: '#ffd23f', fontWeight: 800, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Your reports</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '32vh', overflowY: 'auto' }}>
              {mine.map((r, i) => (
                <div key={i} style={{ fontSize: 12, borderBottom: '1px solid #7a4a1855', paddingBottom: 5 }}>
                  <div style={{ color: '#cfc7b4' }}><b style={{ textTransform: 'capitalize' }}>{r.severity}</b>: {r.message}</div>
                  {resolutionNote(r.resolution)
                    ? <div style={{ color: '#7caa6a', marginTop: 2 }}>✓ {resolutionNote(r.resolution)}</div>
                    : <div className="civ-lbl" style={{ color: '#9a8d6a' }}>⏳ awaiting a reply</div>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Bug-report button + log download for hotseat play. Opens the ReportModal;
 *  posts to the standalone /api/report endpoint, falls back to a download. */
function HotseatReport({ state, focus }: { state: GameState; focus: PlayerId }) {
  const [open, setOpen] = useState(false);
  const [mine, setMine] = useState<MyReport[]>([]);
  const refreshMine = useCallback(() => { fetchMyReports('').then(setMine).catch(() => {}); }, []);
  useEffect(() => { refreshMine(); }, [refreshMine]);
  const answered = mine.filter((r) => resolutionNote(r.resolution));
  const download = () => {
    const text = `Advanced Civilization — hotseat, turn ${state.turn}\n\n${state.log.join('\n')}\n\n--- state ---\n${JSON.stringify(state)}`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a'); a.href = url; a.download = `civ-hotseat-turn${state.turn}.txt`; a.click();
    URL.revokeObjectURL(url);
  };
  const send = async (message: string, severity: string) => {
    const { reportId } = await submitStandaloneReport('', {
      message, severity, category: 'game',
      serverSnapshot: JSON.stringify(state), reporterSide: focus, turnNumber: state.turn,
      clientLog: state.log.map((m, i) => ({ turn: state.turn, kind: 'log', payload: m, ts: i })),
      clientBuild: 'web-ui-hotseat', userAgent: navigator.userAgent,
    });
    setTimeout(refreshMine, 500);
    return reportId;
  };
  return (
    <>
      <button className="civ-btn" onClick={() => { refreshMine(); setOpen(true); }}>Report a problem{answered.length ? ` (${answered.length} ✓)` : ''}</button>
      {open && <ReportModal mine={mine} onSend={send} onDownload={download} onClose={() => setOpen(false)} />}
    </>
  );
}

const nationName = (id: string) => id === '__barbarian__' ? 'Barbarians' : id === '__pirate__' ? 'Pirates' : civById.get(id)?.name ?? id;
const nationColor = (id: string) => id === '__barbarian__' ? '#b08' : id === '__pirate__' ? '#000' : civById.get(id)?.color ?? '#ccc';

/** Generic step-through overlay: pages through `pages` one at a time, each behind
 *  an Acknowledge button; the final page's Continue dismisses it (tracked by
 *  `token` so a fresh batch of events re-opens it). */
function StepModal({ token, pages, accent }: { token: string; pages: ReactNode[]; accent: string }) {
  const [seen, setSeen] = useState('');
  const [i, setI] = useState(0);
  useEffect(() => { setI(0); }, [token]);
  if (!pages.length || seen === token) return null;
  const idx = Math.min(i, pages.length - 1);
  const last = idx >= pages.length - 1;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(8,6,3,0.82)', display: 'grid', placeItems: 'center', zIndex: 120 }}>
      <div style={{ background: '#211c14', color: '#eee', padding: 22, borderRadius: 12, border: `2px solid ${accent}`, width: 500, maxWidth: '92vw', maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 8px 40px #000' }}>
        {pages[idx]}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
          <span className="civ-lbl" style={{ color: '#9a8d6a' }}>{idx + 1} / {pages.length}</span>
          <button className="civ-btn" onClick={() => (last ? setSeen(token) : setI((x) => x + 1))}>{last ? 'Continue' : 'Acknowledge →'}</button>
        </div>
      </div>
    </div>
  );
}

const stepHead = (kicker: string, title: string, titleColor: string, sub?: ReactNode) => (
  <>
    <div style={{ fontSize: 12, color: '#e6b85a', fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5 }}>{kicker}</div>
    <h2 style={{ margin: '4px 0 6px', color: titleColor }}>{title}</h2>
    {sub}
  </>
);

/** Step-through of the latest calamities: for each — what it is + description,
 *  the effect on the victim, secondary victims (who & what), then a before/after
 *  overview, each behind an Acknowledge (§29). */
export function CalamityModal({ events, you }: { events: CalamityEvent[]; you?: PlayerId }) {
  const pages: ReactNode[] = [];
  // Skip your OWN calamities that you resolved interactively (you saw those step
  // by step inline as you chose) — only replay what you didn't actively handle.
  for (const e of events.filter((e) => !(e.holder === you && e.interactive))) {
    const mine = e.holder === you;
    const nm = nationName(e.holder);
    const head = (kicker: string) => stepHead(`Calamity · ${kicker}`, `⚠ ${e.calamity}`, mine ? '#ff6b5a' : '#fff',
      <div style={{ marginBottom: 10 }}>strikes <b style={{ color: nationColor(e.holder) }}>{nm}</b>{mine ? ' — that’s you!' : ''}</div>);
    const primary = e.steps.filter((st) => !st.secondary);
    const secondary = e.steps.filter((st) => st.secondary);
    const list = (steps: typeof e.steps) => (
      <ul style={{ margin: '0 0 4px', paddingLeft: 18, fontSize: 14, lineHeight: 1.6 }}>
        {steps.map((st, k) => <li key={k} style={{ color: st.player ? nationColor(st.player) : '#ece4d2' }}>{st.text}</li>)}
      </ul>
    );
    pages.push(<div key={`${e.calamityId}-i`}>{head('what happens')}<p style={{ fontSize: 13, color: '#cfc7b4', lineHeight: 1.5 }}>{e.description}</p></div>);
    pages.push(<div key={`${e.calamityId}-p`}>{head(`effect on ${nm}`)}{primary.length ? list(primary) : <div style={{ fontSize: 13, color: '#9a9' }}>No effect — nothing for it to take.</div>}</div>);
    if (secondary.length) pages.push(<div key={`${e.calamityId}-s`}>{head('secondary victims')}<div style={{ fontSize: 12, color: '#caa', marginBottom: 6 }}>{nm} directs these losses onto other nations:</div>{list(secondary)}</div>);
    pages.push(<div key={`${e.calamityId}-o`}>{head('before & after')}
      <div style={{ fontSize: 13, lineHeight: 1.6 }}><b style={{ color: '#9a8d6a' }}>Start:</b> {e.overviewBefore}</div>
      <div style={{ fontSize: 13, lineHeight: 1.6, marginTop: 4 }}><b style={{ color: '#9a8d6a' }}>End:</b> {e.overviewAfter}</div></div>);
  }
  return <StepModal token={`cal:${JSON.stringify(events)}`} pages={pages} accent="#c0392b" />;
}

/** Step-through of the latest conflict phase: each territory's combat in turn —
 *  the forces at the start, the modifiers that shape it (Metalworking removal
 *  order, Engineering thresholds), and the losses / outcome (§24). */
export function CombatModal({ events }: { events: CombatEvent[]; you?: PlayerId }) {
  const pages: ReactNode[] = events.map((e, n) => {
    const name = areaById.get(e.area)?.name ?? e.area;
    const afterById = new Map(e.after.map((f) => [f.id, f]));
    const forceRow = (f: CombatEvent['before'][number]) => (
      <li key={f.id} style={{ color: nationColor(f.id) }}>{nationName(f.id)}: {f.tokens} token{f.tokens === 1 ? '' : 's'}{f.city ? ' + city' : ''}</li>
    );
    const losses = e.before.map((f) => {
      const a = afterById.get(f.id);
      const lost = f.tokens - (a?.tokens ?? 0);
      const lostCity = f.city && !(a?.city);
      return { id: f.id, lost, lostCity };
    }).filter((l) => l.lost > 0 || l.lostCity);
    return (
      <div key={e.area}>
        {stepHead(`Conflict · territory ${n + 1} of ${events.length}`, `⚔ ${name}`, '#ffcf8a')}
        <div style={{ fontSize: 12, color: '#9a8d6a', marginTop: 4 }}>At the start:</div>
        <ul style={{ margin: '2px 0 8px', paddingLeft: 18, fontSize: 14 }}>{e.before.map(forceRow)}</ul>
        {e.modifiers.length > 0 && <>
          <div style={{ fontSize: 12, color: '#9a8d6a' }}>Modifiers:</div>
          <ul style={{ margin: '2px 0 8px', paddingLeft: 18, fontSize: 13, color: '#e6b85a' }}>{e.modifiers.map((m, k) => <li key={k}>{m}</li>)}</ul>
        </>}
        <div style={{ fontSize: 12, color: '#9a8d6a' }}>Losses:</div>
        {losses.length ? (
          <ul style={{ margin: '2px 0 8px', paddingLeft: 18, fontSize: 14 }}>
            {losses.map((l) => <li key={l.id} style={{ color: nationColor(l.id) }}>{nationName(l.id)}: −{l.lost} token{l.lost === 1 ? '' : 's'}{l.lostCity ? ', lost the city' : ''}</li>)}
          </ul>
        ) : <div style={{ fontSize: 13, color: '#9a9', margin: '2px 0 8px' }}>No losses (coexistence).</div>}
        {e.note && <div style={{ fontSize: 12, color: '#cfc7b4', fontStyle: 'italic' }}>{e.note}</div>}
      </div>
    );
  });
  return <StepModal token={`cmb:${JSON.stringify(events)}`} pages={pages} accent="#8a4b2a" />;
}

export function prettyPhase(p: string): string {
  return p.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}
