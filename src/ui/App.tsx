import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Rng } from 'digital-boardgame-framework';
import { adapter, createGame } from '../engine/index.js';
import type { Action, GameState, PlayerId } from '../engine/index.js';
import { advanceById, advances as ALL_ADVANCES, areaById, astTrackFor, civById, commodityById, epochs } from '../data/index.js';
import { HeuristicAI } from '../ai/heuristic.js';
import { handValue, creditTowards, commoditySetValue } from '../engine/helpers.js';
import { submitStandaloneReport, fetchMyReports, type MyReport } from '../client/api.js';
import { anchors, MAIN_VIEWBOX } from './anchors.js';

const DEFAULT_PLAYERS: PlayerId[] = ['egypt', 'babylon', 'crete', 'assyria'];
const ai = new HeuristicAI();
const BARB = '__barbarian__';
const PIRATE = '__pirate__';
export type View = 'map' | 'ast' | 'census' | 'tools' | 'goods';

export default function App() {
  const [seats, setSeats] = useState<Record<PlayerId, 'human' | 'ai'>>(
    () => Object.fromEntries(DEFAULT_PLAYERS.map((p, i) => [p, i === 0 ? 'human' : 'ai'])) as Record<PlayerId, 'human' | 'ai'>,
  );
  const [state, setState] = useState<GameState>(() => createGame({ players: DEFAULT_PLAYERS, seed: 7, maxTurns: 60 }));
  const [selectedArea, setSelectedArea] = useState<string | null>(null);
  const [view, setView] = useState<View>('map');
  const rng = useRef(new Rng(7));

  const actor = adapter.currentActor(state);
  const result = adapter.result(state);
  const legal = useMemo(() => (actor ? adapter.legalActions(state, actor) : []), [state, actor]);

  useEffect(() => {
    if (!actor || result || seats[actor] !== 'ai') return;
    const t = setTimeout(async () => {
      const action = await ai.selectAction({ state, actor, adapter, rng: rng.current });
      setState((s) => adapter.applyAction(s, action, actor));
    }, 220);
    return () => clearTimeout(t);
  }, [state, actor, result, seats]);

  const apply = useCallback((a: Action) => {
    if (!actor) return;
    setState((s) => adapter.applyAction(s, a, actor));
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

  const newGame = () => { const seed = Date.now() & 0xffff; rng.current = new Rng(seed); setState(createGame({ players: DEFAULT_PLAYERS, seed, maxTurns: 60 })); setView('map'); };

  // The nation shown in the status/info panels: the current actor, else seat 0.
  const focus = actor ?? state.seating[0]!;

  return (
    <>
      <div ref={boardRef} style={{ flex: 1, position: 'relative', overflow: 'auto', background: '#0d3a4a' }}>
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
                ? (<>
                    <TaxRateControl state={state} actor={actor} onApply={apply} />
                    {inMovement
                      ? <MovementControls planner={planner} />
                      : <ActionList legal={legal} selectedArea={selectedArea} phase={state.phase} onApply={apply} state={state} actor={actor} />}
                  </>)
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
  const zoomAnchor = zoomTo ? anchors[zoomTo] : null;
  const zoomStyle = zoomAnchor
    ? {
        transform: 'scale(1.8)',
        transformOrigin: `${(zoomAnchor.x / MAIN_VIEWBOX.w) * 100}% ${(zoomAnchor.y / MAIN_VIEWBOX.h) * 100}%`,
        transition: 'transform 0.25s ease',
      }
    : { transform: 'scale(1)', transition: 'transform 0.25s ease' };
  return (
    <div style={{ position: 'relative', width: MAIN_VIEWBOX.w, maxWidth: '100%', margin: '0 auto', ...zoomStyle }}>
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
                <g pointerEvents="none">
                  <rect x={an.x + an.r - 1} y={an.y - an.r - 9} width={13} height={12} rx={2} fill="#1a1410" stroke="#ffd23f" strokeWidth={0.6} opacity={0.92} />
                  <text x={an.x + an.r + 5.5} y={an.y - an.r + 0.5} textAnchor="middle" fontSize={9} fontWeight="bold" fill="#ffd23f">{meta!.sustains}</text>
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

function ToolsView({ state, focus }: { state: GameState; focus: PlayerId }) {
  const owned = new Set(state.players[focus]!.advances);
  return (
    <div style={{ padding: 16, color: '#eee' }}>
      <h2 style={{ marginTop: 0 }}>Civilization Advances — {civById.get(focus)?.name}</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6, maxWidth: 720 }}>
        {ALL_ADVANCES.map((a) => (
          <div key={a.id} style={{ padding: 6, borderRadius: 4, border: '1px solid #555', background: owned.has(a.id) ? '#2e6b3a' : '#222', opacity: owned.has(a.id) ? 1 : 0.6 }}>
            <b>{a.name}</b><br /><small>{a.groups.join('/')} · {a.cost}</small>
          </div>
        ))}
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

/** Tax-rate selector, shown only to a player who owns Coinage (§32.421). */
export function TaxRateControl({ state, actor, onApply }: { state: GameState; actor: PlayerId; onApply: (a: Action) => void }) {
  const p = state.players[actor];
  if (!p || !p.advances.includes('coinage')) return null;
  const rate = p.taxRate ?? 2;
  return (
    <div className="civ-lbl" style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
      <b>Tax rate</b> (Coinage):
      {[1, 2, 3].map((r) => <button key={r} className={`civ-btn ${rate === r ? 'on' : ''}`} style={{ padding: '0 8px' }} onClick={() => onApply({ type: 'setTaxRate', rate: r })}>{r}</button>)}
      <span>· applies at your next taxation</span>
    </div>
  );
}

// ---- Per-phase action controls (reused) ----------------------------------

export function ActionList({ legal, selectedArea, phase, onApply, state, actor }: {
  legal: Action[]; selectedArea: string | null; phase: string; onApply: (a: Action) => void; state: GameState; actor: PlayerId;
}) {
  const pass = legal.find((a) => a.type === 'pass');
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
  if (phase === 'acquireAdvances') return <AdvancePicker state={state} actor={actor} onApply={onApply} />;
  if (phase === 'trade') return <TradeControls state={state} actor={actor} onApply={onApply} />;
  return <button className="civ-btn" onClick={() => pass && onApply(pass)}>Continue</button>;
}

const isCal = (c: string) => c.startsWith('calamity:');
const cardLabel = (c: string) => (isCal(c) ? `⚠ ${c.slice(9)}` : c);
/** Sort card ids: commodities ascending by value, calamities last. */
const byCardValue = (a: string, b: string) => (isCal(a) ? 1000 : commodityById.get(a)?.value ?? 0) - (isCal(b) ? 1000 : commodityById.get(b)?.value ?? 0);

const COMMODITY_ORDER = ['ochre', 'hides', 'iron', 'papyrus', 'salt', 'timber', 'grain', 'oil', 'cloth', 'wine', 'bronze', 'silver', 'resin', 'spices', 'dye', 'gems', 'gold', 'ivory'];

/** Acquire-advances panel (§31): pick an advance, then choose exactly which
 *  commodity cards to spend and how much treasury — instead of auto-paying. */
function AdvancePicker({ state, actor, onApply }: { state: GameState; actor: PlayerId; onApply: (a: Action) => void }) {
  const p = state.players[actor]!;
  const mining = p.advances.includes('mining');
  const [sel, setSel] = useState<string>('');
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
          <button key={a.id} className={`civ-btn ${sel === a.id ? 'on' : ''}`} style={{ fontSize: 11 }} onClick={() => { setSel(a.id); setSpend({}); setTreasury(0); }}>
            {a.name} ({a.cost}{creditTowards(p.advances, a.id) ? `, −${creditTowards(p.advances, a.id)} credit` : ''})
          </button>
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
        {Object.entries(me.hand).filter(([, n]) => n > 0).sort((a, b) => byCardValue(a[0], b[0])).map(([c, n]) => (
          <button className="civ-btn" key={c} disabled={(give[c] ?? 0) >= n} onClick={() => add(c)}>{cName(c)} ×{n - (give[c] ?? 0)}</button>
        ))}
        {Object.keys(me.hand).length === 0 && <span className="civ-lbl">(no cards)</span>}
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

/** Bug-report + log download for hotseat play. Posts to the standalone
 *  /api/report endpoint (no game/token); falls back to a downloadable file. */
function HotseatReport({ state, focus }: { state: GameState; focus: PlayerId }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [severity, setSeverity] = useState<'bug' | 'rules-question' | 'feedback'>('bug');
  const [status, setStatus] = useState<string | null>(null);
  const [mine, setMine] = useState<MyReport[]>([]);
  const [showMine, setShowMine] = useState(false);

  const refreshMine = useCallback(() => { fetchMyReports('').then(setMine).catch(() => {}); }, []);
  useEffect(() => { refreshMine(); }, [refreshMine]);
  const answered = mine.filter((r) => r.resolution);

  const download = () => {
    const text = `Advanced Civilization — hotseat, turn ${state.turn}\n\n${state.log.join('\n')}\n\n--- state ---\n${JSON.stringify(state)}`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a'); a.href = url; a.download = `civ-hotseat-turn${state.turn}.txt`; a.click();
    URL.revokeObjectURL(url);
  };
  const send = async () => {
    setStatus('Sending…');
    try {
      const { reportId } = await submitStandaloneReport('', {
        message, severity, category: 'game',
        serverSnapshot: JSON.stringify(state), reporterSide: focus, turnNumber: state.turn,
        clientLog: state.log.map((m, i) => ({ turn: state.turn, kind: 'log', payload: m, ts: i })),
        clientBuild: 'web-ui-hotseat', userAgent: navigator.userAgent,
      });
      setStatus(`Thanks! Report ${reportId.slice(0, 8)} received.`); setMessage('');
      setTimeout(refreshMine, 500);
    } catch (e) {
      setStatus(`Couldn't send (${(e as Error).message}). Use “Download report” and email it.`);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {!open && <button className="civ-btn" onClick={() => setOpen(true)}>Report a problem</button>}
        {mine.length > 0 && <button className="civ-btn" onClick={() => { setShowMine((v) => !v); refreshMine(); }}>My reports{answered.length ? ` (${answered.length} ✓)` : ''}</button>}
      </div>

      {showMine && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 160, overflowY: 'auto', border: '1px solid #7a4a18', borderRadius: 4, padding: 5 }}>
          {mine.length === 0 && <span className="civ-lbl">No reports yet.</span>}
          {mine.map((r, i) => (
            <div key={i} style={{ fontSize: 11, borderBottom: '1px solid #7a4a1855', paddingBottom: 3 }}>
              <div><b>{r.severity}</b>: {r.message}</div>
              {r.resolution
                ? <div style={{ color: '#2e6b3a' }}>✓ <b>Response:</b> {r.resolution.note}</div>
                : <div className="civ-lbl">⏳ awaiting response</div>}
            </div>
          ))}
        </div>
      )}

      {open && (
        <>
          <select value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)} style={{ fontSize: 11 }}>
            <option value="bug">Bug</option><option value="rules-question">Rules question</option><option value="feedback">Feedback</option>
          </select>
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What happened?" rows={3} style={{ fontSize: 12 }} />
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            <button className="civ-btn" disabled={!message.trim()} onClick={send}>Send</button>
            <button className="civ-btn" onClick={download}>Download report</button>
            <button className="civ-btn" onClick={() => { setOpen(false); setStatus(null); }}>Close</button>
          </div>
          {status && <span className="civ-lbl" style={{ color: '#5a2d0a' }}>{status}</span>}
        </>
      )}
    </div>
  );
}

export function prettyPhase(p: string): string {
  return p.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}
