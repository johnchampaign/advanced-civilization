// Coast review — overlays the auto-extracted coast sub-areas (land / sea) on the
// board so the owner can check and fix them: reclassify a sub-area (sea↔land),
// delete a spurious one, and Save to repo. Geometry is read-only here (re-run
// scripts/build-coasts.mjs to re-derive shapes); this pass is about correctness of
// the land/sea split before it drives ship routing.
import { useEffect, useMemo, useRef, useState } from 'react';
import { COASTLINES, cloneCoasts, loadCoastEdits, saveCoastEdits, type CoastTerritory, type SubKind } from '../../data/coastlines.js';

const BOARD_SRC = '/dev-assets/board.png';
const NW = COASTLINES.image.width, NH = COASTLINES.image.height;
const DISPLAY_W = 1900, SCALE = DISPLAY_W / NW, DISPLAY_H = Math.round(NH * SCALE);
const SEA_FILL = 'rgba(20,90,150,0.5)', LAND_FILL = 'rgba(200,168,106,0.45)';

export default function CoastsTab() {
  const [base, setBase] = useState<CoastTerritory[]>([]);
  const [terrs, setTerrs] = useState<CoastTerritory[]>([]);
  const [selSub, setSelSub] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [filter, setFilter] = useState('');
  const scRef = useRef<HTMLDivElement | null>(null);
  const dScale = SCALE * zoom, W2 = Math.round(DISPLAY_W * zoom), H2 = Math.round(DISPLAY_H * zoom);

  useEffect(() => { const b = cloneCoasts(COASTLINES.territories); setBase(b); setTerrs(loadCoastEdits() ?? cloneCoasts(b)); }, []);
  useEffect(() => { if (base.length) saveCoastEdits(terrs, base); }, [terrs, base]);
  const isDirty = base.length > 0 && JSON.stringify(terrs) !== JSON.stringify(base);

  const subIndex = useMemo(() => { const m = new Map<string, { t: CoastTerritory; kind: SubKind; centroid: [number, number] }>(); for (const t of terrs) for (const s of t.sub) m.set(s.subId, { t, kind: s.kind, centroid: s.centroid }); return m; }, [terrs]);
  const counts = { sea: 0, land: 0 }; for (const t of terrs) for (const s of t.sub) counts[s.kind]++;
  const noSea = terrs.filter((t) => t.category === 'coastal' && !t.sub.some((s) => s.kind === 'sea'));

  const setKind = (subId: string, kind: SubKind) => setTerrs((ts) => ts.map((t) => ({ ...t, sub: t.sub.map((s) => (s.subId === subId ? { ...s, kind } : s)) })));
  const delSub = (subId: string) => setTerrs((ts) => ts.map((t) => ({ ...t, sub: t.sub.filter((s) => s.subId !== subId) })));
  const scrollTo = (c: [number, number]) => { const el = scRef.current; if (!el) return; el.scrollTo({ left: c[0] * dScale - el.clientWidth / 2, top: c[1] * dScale - el.clientHeight / 2, behavior: 'smooth' }); };

  const save = async () => {
    try {
      const out = { image: { width: NW, height: NH }, count: terrs.length, territories: terrs };
      const r = await fetch('/__save-coastlines', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) });
      const j = await r.json(); alert(j.ok ? `Saved ${j.count} territories' coasts to src/data/coastlines.json` : `Save failed: ${j.error}`);
    } catch (e) { alert('Save failed: ' + e); }
  };

  const sel = selSub ? subIndex.get(selSub) : null;
  const btn: React.CSSProperties = { padding: '4px 10px', background: '#2a2d34', color: '#e8e8ea', border: '1px solid #3a3d44', borderRadius: 4, cursor: 'pointer', fontSize: 13 };

  return (
    <div style={{ color: '#e8e8ea', fontFamily: 'system-ui, sans-serif', padding: 12 }}>
      <h2 style={{ marginTop: 0 }}>Coast review</h2>
      <div style={{ fontSize: 13, color: '#b8bcc4', marginBottom: 10, maxWidth: 1100, lineHeight: 1.5 }}>
        Each coastal territory is split by its black coast into <span style={{ color: '#6cc0ff' }}>sea</span> and <span style={{ color: '#e6c07f' }}>land</span> sub-areas.
        Click a sub-area to select it, then <strong>reclassify</strong> (sea↔land) or <strong>delete</strong> a spurious one.
        Geometry is read-only — to reshape, edit the polygon in the Territories tab and re-run <code>build-coasts</code>.
      </div>

      <div style={{ marginBottom: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button style={{ ...btn, color: '#80dc78', borderColor: '#3a5a3a' }} onClick={save}>💾 Save to repo</button>
        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', marginLeft: 4 }}>
          <button style={{ ...btn, padding: '4px 9px' }} title="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, +(z / 1.25).toFixed(3)))}>−</button>
          <button style={{ ...btn, padding: '4px 9px' }} onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button style={{ ...btn, padding: '4px 9px' }} title="Zoom in" onClick={() => setZoom((z) => Math.min(6, +(z * 1.25).toFixed(3)))}>+</button>
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9aa0a8' }}>
          {terrs.length} territories · <span style={{ color: '#6cc0ff' }}>{counts.sea} sea</span> · <span style={{ color: '#e6c07f' }}>{counts.land} land</span> · <span style={{ color: '#ff6b6b' }}>{noSea.length} coastal-no-sea</span>{isDirty ? ' · *unsaved' : ''}
        </span>
      </div>

      <div style={{ marginBottom: 10, minHeight: 30, display: 'flex', gap: 8, alignItems: 'center' }}>
        {sel ? (
          <>
            <span style={{ fontSize: 13, color: '#ffd54a' }}>{selSub} <span style={{ color: '#9aa0a8' }}>in {sel.t.name ?? '#' + sel.t.id} [{sel.t.category}]</span>:</span>
            <button style={{ ...btn, borderColor: '#3a5a72', color: '#6cc0ff' }} onClick={() => setKind(selSub!, 'sea')}>Sea</button>
            <button style={{ ...btn, borderColor: '#6a5a30', color: '#e6c07f' }} onClick={() => setKind(selSub!, 'land')}>Land</button>
            <button style={{ ...btn, color: '#ff8866' }} onClick={() => { delSub(selSub!); setSelSub(null); }}>Delete sub-area</button>
          </>
        ) : <span style={{ fontSize: 12, color: '#777' }}>Click a sub-area on the board, or a row in the list.</span>}
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <div style={{ flex: '0 0 210px', height: DISPLAY_H, display: 'flex', flexDirection: 'column', background: '#15171c', border: '1px solid #2a2d34', borderRadius: 4 }}>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter name / 'nosea' / 'multisea'…" style={{ margin: 6, padding: '4px 8px', background: '#0e0f13', color: '#e8e8ea', border: '1px solid #3a3d44', borderRadius: 4, fontSize: 12 }} />
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {terrs.filter((t) => { const f = filter.trim().toLowerCase(); if (!f) return true;
              const seaN = t.sub.filter((s) => s.kind === 'sea').length;
              if (f === 'nosea') return t.category === 'coastal' && seaN === 0;
              if (f === 'multisea') return seaN > 1;
              return (t.name ?? '').toLowerCase().includes(f) || String(t.id) === f; })
              .sort((a, b) => a.id - b.id).map((t) => {
                const seaN = t.sub.filter((s) => s.kind === 'sea').length, landN = t.sub.length - seaN;
                const flag = t.category === 'coastal' && seaN === 0;
                const selHere = sel?.t.id === t.id;
                return (
                  <div key={t.id} onClick={() => { const c = t.sub[0]?.centroid; if (c) scrollTo(c); if (t.sub[0]) setSelSub(t.sub[0].subId); }}
                    style={{ padding: '3px 8px', cursor: 'pointer', background: selHere ? '#2a2030' : 'transparent', fontSize: 12, display: 'flex', gap: 6 }}>
                    <span style={{ color: selHere ? '#ffd54a' : '#cfcfd4', minWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name ?? '#' + t.id}</span>
                    <span style={{ color: '#6cc0ff' }}>{seaN}s</span><span style={{ color: '#e6c07f' }}>{landN}l</span>
                    {flag && <span title="coastal but no sea sub-area" style={{ color: '#ff6b6b', marginLeft: 'auto' }}>⚠</span>}
                  </div>
                );
              })}
          </div>
        </div>

        <div ref={scRef} style={{ position: 'relative', width: DISPLAY_W, height: DISPLAY_H, overflow: 'auto', border: '1px solid #2a2d34', userSelect: 'none' }}>
          <div style={{ position: 'relative', width: W2, height: H2 }}>
            <img src={BOARD_SRC} width={W2} height={H2} alt="board" draggable={false} style={{ display: 'block' }} />
            <svg width={W2} height={H2} style={{ position: 'absolute', top: 0, left: 0 }}>
              {terrs.flatMap((t) => t.sub.map((s) => {
                const pts = s.exterior.map(([x, y]) => `${(x * dScale).toFixed(1)},${(y * dScale).toFixed(1)}`).join(' ');
                const isSel = selSub === s.subId;
                return <polygon key={s.subId} points={pts} onMouseDown={(e) => { e.stopPropagation(); setSelSub(s.subId); }}
                  style={{ fill: s.kind === 'sea' ? SEA_FILL : LAND_FILL, stroke: isSel ? '#ffd54a' : '#ff2d2d', strokeWidth: isSel ? 3 : 0.8, strokeLinejoin: 'round', cursor: 'pointer', pointerEvents: 'all' }} />;
              }))}
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
