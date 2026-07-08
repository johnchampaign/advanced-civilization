// Territory editor — overlays the traced polygons on the combined board image and
// lets the owner: assign each cell a category (open sea / coastal / land), name it,
// reshape borders (drag vertices, add/delete points, move a whole cell), split a
// cell (drag one vertex onto another), draw or delete cells, and bulk-assign a
// shared name+category to several fragments (how a split-up sea like the Adriatic
// is reunified — same name+category = one logical area, matching the codebase's
// existing "areas sharing a name are one area" seam-merge).
//
// Edits persist to localStorage (LS_TERRITORIES). Export downloads territories.json.
import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import {
  TERRITORIES, cloneRegions, loadTerritoryEdits, saveTerritoryEdits,
  polygonCentroid, polygonArea, categoryMeta,
  type TerritoryRegion, type Category,
} from '../../data/territories.js';
import areasJson from '../../data/areas.json' with { type: 'json' };

// The game's named areas, each reduced to its centroid transformed into this
// polygon image's coordinate space (same West·Main·East layout as anchors.ts),
// so we can auto-assign each territory its game-area identity by containment.
type GameArea = { id: string; name: string; isWater: boolean; pt: [number, number] };
const AREA_PTS: GameArea[] = (() => {
  const WEST_W = 782.177, MAIN_W = 2323.12, HH = 1587.4;
  const OFF: Record<string, number> = { western: 0, main: WEST_W, eastern: WEST_W + MAIN_W };
  const COMB_W = WEST_W + MAIN_W + 1189.066;
  const sx = TERRITORIES.image.width / COMB_W, sy = TERRITORIES.image.height / HH;
  return (areasJson as unknown as Array<{ id: string; name: string; isWater: boolean; board: string; path: number[][] }>)
    .filter((a) => a.path && a.path.length >= 3)
    .map((a) => { const c = polygonCentroid(a.path as [number, number][]); return { id: a.id, name: a.name, isWater: a.isWater, pt: [(c[0] + (OFF[a.board] ?? 0)) * sx, c[1] * sy] as [number, number] }; });
})();

const BOARD_SRC = '/dev-assets/board.png';
const NATIVE_W = TERRITORIES.image.width;
const NATIVE_H = TERRITORIES.image.height;
const DISPLAY_W = 1900;
const SCALE = DISPLAY_W / NATIVE_W;
const DISPLAY_H = Math.round(NATIVE_H * SCALE);
const INV_SCALE = NATIVE_W / DISPLAY_W;

type Drag =
  | { kind: 'vertex'; id: number; index: number }
  | { kind: 'move'; id: number; last: [number, number] }
  | null;

const nextId = (rs: TerritoryRegion[]) => rs.reduce((m, r) => Math.max(m, r.id), -1) + 1;

function pointInPoly(p: [number, number], poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!, pj = poly[j]!;
    const xi = pi[0], yi = pi[1], xj = pj[0], yj = pj[1];
    if (((yi > p[1]) !== (yj > p[1])) && (p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function distToSeg(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a[0] + t * dx, cy = a[1] + t * dy;
  return (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
}

// Douglas–Peucker on a closed ring.
function dpRing(pts: [number, number][], eps: number): [number, number][] {
  if (pts.length < 4) return pts;
  const sq = eps * eps;
  const d2 = (p: [number, number], a: [number, number], b: [number, number]) => {
    const dx = b[0] - a[0], dy = b[1] - a[1]; const L = dx * dx + dy * dy;
    if (!L) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L; t = Math.max(0, Math.min(1, t));
    return (p[0] - (a[0] + t * dx)) ** 2 + (p[1] - (a[1] + t * dy)) ** 2;
  };
  const sim = (s: number, e: number, arr: [number, number][]): [number, number][] => {
    let idx = -1, mx = 0;
    for (let i = s + 1; i < e; i++) { const d = d2(arr[i]!, arr[s]!, arr[e]!); if (d > mx) { mx = d; idx = i; } }
    return (mx > sq && idx !== -1) ? [...sim(s, idx, arr), ...sim(idx, e, arr).slice(1)] : [arr[s]!, arr[e]!];
  };
  let a1 = 1, best = -1;
  for (let i = 1; i < pts.length; i++) { const d = (pts[i]![0] - pts[0]![0]) ** 2 + (pts[i]![1] - pts[0]![1]) ** 2; if (d > best) { best = d; a1 = i; } }
  const h1 = sim(0, a1, pts); const s2 = [...pts.slice(a1), pts[0]!]; const h2 = sim(0, s2.length - 1, s2);
  return [...h1.slice(0, -1), ...h2.slice(0, -1)];
}

// Trace the outer boundary of a filled binary mask (stitch pixel-edge segments).
function traceOutline(inside: (x: number, y: number) => boolean, W: number, H: number): [number, number][] | null {
  const edges: [number, number, number, number][] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (!inside(x, y)) continue;
    if (!inside(x, y - 1)) edges.push([x, y, x + 1, y]);
    if (!inside(x, y + 1)) edges.push([x, y + 1, x + 1, y + 1]);
    if (!inside(x - 1, y)) edges.push([x, y, x, y + 1]);
    if (!inside(x + 1, y)) edges.push([x + 1, y, x + 1, y + 1]); }
  if (!edges.length) return null;
  const adj = new Map<number, { to: number; e: string }[]>();
  const pts = new Map<number, [number, number]>(); const used = new Set<string>();
  const key = (x: number, y: number) => x * 100000 + y; const ek = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (const [ax, ay, bx, by] of edges) { const ka = key(ax, ay), kb = key(bx, by); pts.set(ka, [ax, ay]); pts.set(kb, [bx, by]); const e = ek(ka, kb);
    if (!adj.has(ka)) adj.set(ka, []); if (!adj.has(kb)) adj.set(kb, []); adj.get(ka)!.push({ to: kb, e }); adj.get(kb)!.push({ to: ka, e }); }
  let bestLoop: [number, number][] | null = null;
  for (const startK of adj.keys()) { let cur = startK; const loop: [number, number][] = []; let steps = 0, started = false;
    while (steps++ < edges.length * 2 + 5) { const opts = adj.get(cur)!.filter((o) => !used.has(o.e)); if (!opts.length) break; const o = opts[0]!; used.add(o.e); loop.push(pts.get(cur)!); cur = o.to; started = true; if (cur === startK) break; }
    if (started && loop.length >= 4 && (!bestLoop || loop.length > bestLoop.length)) bestLoop = loop; }
  return bestLoop;
}

// Count 4-connected white components (to reject a merge of non-touching cells).
function componentCount(inside: (x: number, y: number) => boolean, W: number, H: number): number {
  const seen = new Uint8Array(W * H); let comps = 0; const stack: number[] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (seen[i] || !inside(x, y)) continue;
    comps++; stack.length = 0; stack.push(i); seen[i] = 1;
    while (stack.length) { const p = stack.pop()!; const py = (p / W) | 0, px = p % W;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) { const nx = px + dx, ny = py + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const ni = ny * W + nx; if (!seen[ni] && inside(nx, ny)) { seen[ni] = 1; stack.push(ni); } } } }
  return comps;
}

// ---- planar-partition enforcement (no overlaps; islands become holes) --------
const RASTER_MAX = 700;
// Components smaller than this (display px²) are rasterisation noise, not real
// cells — cut/subtract discard them instead of emitting micro-slivers.
const MIN_COMPONENT_AREA = 150;
type Ring = [number, number][];
const bboxOf = (pts: Ring): [number, number, number, number] => { let a: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]; for (const p of pts) { if (p[0] < a[0]) a[0] = p[0]; if (p[1] < a[1]) a[1] = p[1]; if (p[0] > a[2]) a[2] = p[0]; if (p[1] > a[3]) a[3] = p[1]; } return a; };
const bboxOverlap = (a: number[], b: number[]) => a[0]! <= b[2]! && b[0]! <= a[2]! && a[1]! <= b[3]! && b[1]! <= a[3]!;
const polyAbsArea = (p: Ring) => { let s = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += p[j]![0] * p[i]![1] - p[i]![0] * p[j]![1]; return Math.abs(s) / 2; };
const regionContains = (r: TerritoryRegion, p: [number, number]) => pointInPoly(p, r.exterior) && !(r.holes || []).some((h) => pointInPoly(p, h));
const netArea = (ext: Ring, holes: Ring[]) => Math.round(polyAbsArea(ext) - holes.reduce((s, h) => s + polyAbsArea(h), 0));

// Stitch ALL closed loops from a pixel-edge set (component boundary = 1 outer + N holes).
function traceAllLoops(edges: [number, number, number, number][]): Ring[] {
  const adj = new Map<number, { to: number; e: string }[]>(); const pts = new Map<number, [number, number]>();
  const key = (x: number, y: number) => x * 100000 + y; const ek = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (const [ax, ay, bx, by] of edges) { const ka = key(ax, ay), kb = key(bx, by); pts.set(ka, [ax, ay]); pts.set(kb, [bx, by]); const e = ek(ka, kb);
    if (!adj.has(ka)) adj.set(ka, []); if (!adj.has(kb)) adj.set(kb, []); adj.get(ka)!.push({ to: kb, e }); adj.get(kb)!.push({ to: ka, e }); }
  const used = new Set<string>(); const loops: Ring[] = [];
  for (const s of adj.keys()) { let start: { to: number; e: string } | undefined;
    while ((start = adj.get(s)!.find((o) => !used.has(o.e)))) { const loop: Ring = [pts.get(s)!]; let cur = s; let step: { to: number; e: string } | undefined = start; let guard = 0;
      while (step && guard++ < edges.length + 5) { used.add(step.e); const nx = step.to; loop.push(pts.get(nx)!); if (nx === s) break; cur = nx; step = adj.get(cur)!.find((o) => !used.has(o.e)); }
      if (loop.length >= 4) loops.push(loop); } }
  return loops;
}

// A binary mask -> list of {exterior, holes} (one per connected component), raster coords.
function polygonsFromMask(inside: (x: number, y: number) => boolean, W: number, H: number): { exterior: Ring; holes: Ring[] }[] {
  const lab = new Int32Array(W * H).fill(-1); let nc = 0; const st: number[] = [];
  for (let i = 0; i < W * H; i++) { const x = i % W, y = (i / W) | 0; if (lab[i] !== -1 || !inside(x, y)) continue; const id = nc++; st.length = 0; st.push(i); lab[i] = id;
    while (st.length) { const p = st.pop()!; const px = p % W, py = (p / W) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) { const nx = px + dx, ny = py + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const ni = ny * W + nx; if (lab[ni] === -1 && inside(nx, ny)) { lab[ni] = id; st.push(ni); } } } }
  const compEdges: [number, number, number, number][][] = Array.from({ length: nc }, () => []);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H) ? -1 : lab[y * W + x]!;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const l = lab[y * W + x]!; if (l < 0) continue; const E = compEdges[l]!;
    if (at(x, y - 1) !== l) E.push([x, y, x + 1, y]); if (at(x, y + 1) !== l) E.push([x, y + 1, x + 1, y + 1]); if (at(x - 1, y) !== l) E.push([x, y, x, y + 1]); if (at(x + 1, y) !== l) E.push([x + 1, y, x + 1, y + 1]); }
  const out: { exterior: Ring; holes: Ring[] }[] = [];
  for (let c = 0; c < nc; c++) { const loops = traceAllLoops(compEdges[c]!); if (!loops.length) continue; loops.sort((a, b) => polyAbsArea(b) - polyAbsArea(a)); out.push({ exterior: loops[0]!, holes: loops.slice(1) }); }
  return out;
}

// subject MINUS winner (both display coords). Returns null when winner removes nothing.
function subtractWinner(subject: TerritoryRegion, winner: TerritoryRegion): { exterior: Ring; holes: Ring[] }[] | null {
  const [minx, miny, maxx, maxy] = bboxOf(subject.exterior);
  const bw = maxx - minx, bh = maxy - miny; if (bw <= 0 || bh <= 0) return null;
  const s = Math.min(1, RASTER_MAX / Math.max(bw, bh));
  const W = Math.max(2, Math.ceil(bw * s)), H = Math.max(2, Math.ceil(bh * s));
  const sh = subject.holes || [], wh = winner.holes || [];
  const mask = new Uint8Array(W * H); let removed = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const px = minx + (x + 0.5) / s, py = miny + (y + 0.5) / s;
    if (!pointInPoly([px, py], subject.exterior) || sh.some((h) => pointInPoly([px, py], h))) continue;
    if (pointInPoly([px, py], winner.exterior) && !wh.some((h) => pointInPoly([px, py], h))) { removed++; continue; }
    mask[y * W + x] = 1; }
  if (removed === 0) return null;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x] === 1;
  const toDisp = (loop: Ring) => dpRing(loop.map(([x, y]) => [+(minx + x / s).toFixed(1), +(miny + y / s).toFixed(1)] as [number, number]), 1.5);
  return polygonsFromMask(inside, W, H).map((c) => ({ exterior: toDisp(c.exterior), holes: c.holes.map(toDisp).filter((h) => h.length >= 3) })).filter((c) => c.exterior.length >= 3 && polyAbsArea(c.exterior) >= MIN_COMPONENT_AREA);
}

// Split a cell along a drawn poly-line: rasterise it, stamp the line as a barrier,
// re-trace the resulting pieces. Returns the pieces, or null if the line didn't
// cut all the way across (only one piece results).
function cutRegion(region: TerritoryRegion, path: Ring): { exterior: Ring; holes: Ring[] }[] | null {
  const [minx, miny, maxx, maxy] = bboxOf(region.exterior);
  const bw = maxx - minx, bh = maxy - miny; if (bw <= 0 || bh <= 0 || path.length < 2) return null;
  const s = Math.min(1, RASTER_MAX / Math.max(bw, bh));
  const W = Math.max(2, Math.ceil(bw * s)), H = Math.max(2, Math.ceil(bh * s));
  const holes = region.holes || [];
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const px = minx + (x + 0.5) / s, py = miny + (y + 0.5) / s;
    if (pointInPoly([px, py], region.exterior) && !holes.some((h) => pointInPoly([px, py], h))) mask[y * W + x] = 1; }
  const P: [number, number][] = path.map(([x, y]) => [(x - minx) * s, (y - miny) * s]);
  // extend the endpoints outward so the cut reaches the cell's boundary
  const extend = (a: [number, number], b: [number, number], len: number): [number, number] => { const dx = a[0] - b[0], dy = a[1] - b[1]; const d = Math.hypot(dx, dy) || 1; return [a[0] + dx / d * len, a[1] + dy / d * len]; };
  P[0] = extend(P[0]!, P[1]!, 16); P[P.length - 1] = extend(P[P.length - 1]!, P[P.length - 2]!, 16);
  const stamp = (cx: number, cy: number) => { for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { if (dx * dx + dy * dy > 4) continue; const nx = Math.round(cx) + dx, ny = Math.round(cy) + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H) mask[ny * W + nx] = 0; } };
  for (let i = 0; i + 1 < P.length; i++) { const a = P[i]!, b = P[i + 1]!; const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]))); for (let t = 0; t <= steps; t++) stamp(a[0] + (b[0] - a[0]) * t / steps, a[1] + (b[1] - a[1]) * t / steps); }
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x] === 1;
  const comps = polygonsFromMask(inside, W, H);
  if (comps.length < 2) return null;
  const toDisp = (loop: Ring) => dpRing(loop.map(([x, y]) => [+(minx + x / s).toFixed(1), +(miny + y / s).toFixed(1)] as [number, number]), 1.5);
  return comps.map((c) => ({ exterior: toDisp(c.exterior), holes: c.holes.map(toDisp).filter((h) => h.length >= 3) })).filter((c) => c.exterior.length >= 3 && polyAbsArea(c.exterior) >= MIN_COMPONENT_AREA);
}

// Reassign any colliding id to a fresh one so ids stay unique.
function ensureUniqueIds(regs: TerritoryRegion[]): TerritoryRegion[] {
  const seen = new Set<number>(); let max = regs.reduce((m, r) => Math.max(m, r.id), 0);
  return regs.map((r) => { if (seen.has(r.id)) { max += 1; seen.add(max); return { ...r, id: max }; } seen.add(r.id); return r; });
}
// Heal a loaded region set: drop degenerate/sub-threshold uncategorised slivers,
// then guarantee unique ids. Applied to base + localStorage on load so stale data
// (old slivers, duplicate ids from earlier bugs) self-corrects.
function sanitizeRegions(regs: TerritoryRegion[]): TerritoryRegion[] {
  const kept = regs.filter((r) => r.exterior && r.exterior.length >= 3 && !(polyAbsArea(r.exterior) < MIN_COMPONENT_AREA && !r.category));
  return ensureUniqueIds(kept);
}

const CATS: Category[] = ['openSea', 'coastal', 'land', 'cosmetic'];

export default function TerritoriesTab() {
  const [base, setBase] = useState<TerritoryRegion[]>([]);
  const [regions, setRegions] = useState<TerritoryRegion[]>([]);
  const [selIds, setSelIds] = useState<number[]>([]);
  const [selectedVertex, setSelectedVertex] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [draft, setDraft] = useState<[number, number][] | null>(null);
  const [cut, setCut] = useState<{ id: number; pts: [number, number][] } | null>(null);
  const [hideDone, setHideDone] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [filter, setFilter] = useState('');
  const svgRef = useRef<SVGSVGElement | null>(null);
  const boardScrollRef = useRef<HTMLDivElement | null>(null);
  const movedRef = useRef(false);

  // Re-establish the partition after `winnerId`'s geometry changed: subtract it
  // from every overlapping cell so nothing overlaps it (islands become holes;
  // fully-covered cells are dropped; a cell split in two becomes two cells).
  const enforcePartition = (regs: TerritoryRegion[], winnerId: number): TerritoryRegion[] => {
    const winner = regs.find((r) => r.id === winnerId); if (!winner) return regs;
    const wb = bboxOf(winner.exterior); let maxId = regs.reduce((m, r) => Math.max(m, r.id), 0);
    const out: TerritoryRegion[] = [];
    for (const r of regs) {
      if (r.id === winnerId) { out.push(r); continue; }
      if (!bboxOverlap(wb, bboxOf(r.exterior))) { out.push(r); continue; }
      const comps = subtractWinner(r, winner);
      if (comps === null) { out.push(r); continue; }         // winner removed nothing
      if (!comps.length) continue;                            // fully covered → drop
      comps.forEach((c, idx) => { const id = idx === 0 ? r.id : ++maxId;
        out.push({ ...r, id, exterior: c.exterior, holes: c.holes.length ? c.holes : undefined, area_px: netArea(c.exterior, c.holes), centroid: polygonCentroid(c.exterior) }); });
    }
    return ensureUniqueIds(out);
  };

  const dScale = SCALE * zoom;
  const W2 = Math.round(DISPLAY_W * zoom);
  const H2 = Math.round(DISPLAY_H * zoom);

  const primaryId = selIds.length ? selIds[selIds.length - 1]! : null;
  const selectedSet = new Set(selIds);

  useEffect(() => {
    const b = sanitizeRegions(cloneRegions(TERRITORIES.regions));
    setBase(b);
    const edits = loadTerritoryEdits();
    setRegions(edits ? sanitizeRegions(edits) : cloneRegions(b));
  }, []);

  useEffect(() => { if (base.length) saveTerritoryEdits(regions, base); }, [regions, base]);
  const isDirty = base.length > 0 && JSON.stringify(regions) !== JSON.stringify(base);

  const counts = { openSea: 0, coastal: 0, land: 0, cosmetic: 0, unset: 0 };
  for (const r of regions) counts[(r.category || 'unset') as keyof typeof counts]++;

  // Live game-area crosswalk: which game areas' centroids fall in each territory.
  // Recomputes as geometry changes, so splitting a merged cell re-resolves instantly.
  const areaAssign = useMemo(() => {
    const m = new Map<number, GameArea[]>(); for (const r of regions) m.set(r.id, []);
    for (const ap of AREA_PTS) { const hit = regions.find((r) => regionContains(r, ap.pt)); if (hit) m.get(hit.id)!.push(ap); }
    return m;
  }, [regions]);
  // Per-territory naming status.
  const nameStatus = (r: TerritoryRegion): { kind: 'ok' | 'merged' | 'empty' | 'mismatch' | 'cosmetic'; areas: GameArea[] } => {
    if (r.category === 'cosmetic') return { kind: 'cosmetic', areas: [] };
    const list = areaAssign.get(r.id) ?? [];
    if (list.length === 0) return { kind: 'empty', areas: [] };
    if (list.length > 1) return { kind: 'merged', areas: list };
    const only = list[0]!;
    if (only.isWater !== (r.category === 'openSea')) return { kind: 'mismatch', areas: list };
    return { kind: 'ok', areas: list };
  };
  const nameSummary = { ok: 0, merged: 0, empty: 0, mismatch: 0 };
  for (const r of regions) { const s = nameStatus(r).kind; if (s !== 'cosmetic') nameSummary[s]++; }

  // Bake the confident 1:1 matches into region.name (the persisted crosswalk).
  const assignAreas = () => {
    setRegions((rs) => rs.map((r) => { const s = nameStatus(r); return s.kind === 'ok' ? { ...r, name: s.areas[0]!.id } : r; }));
  };

  // Uses the SVG's actual on-screen size, so it stays correct at any zoom level.
  const toNative = useCallback((clientX: number, clientY: number): [number, number] | null => {
    if (!svgRef.current) return null;
    const rect = svgRef.current.getBoundingClientRect();
    return [Math.round((clientX - rect.left) * (NATIVE_W / rect.width)), Math.round((clientY - rect.top) * (NATIVE_H / rect.height))];
  }, []);

  // ---- selection ----
  const selectCell = (id: number, additive: boolean) => {
    setSelectedVertex(null);
    setSelIds((cur) => {
      if (additive) return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      return [id];
    });
  };

  // Center the board viewport on a cell (used by the list, and when zoomed in).
  const scrollToCell = (r: TerritoryRegion) => {
    const el = boardScrollRef.current; if (!el) return;
    const [cx, cy] = polygonCentroid(r.exterior);
    el.scrollTo({ left: cx * dScale - el.clientWidth / 2, top: cy * dScale - el.clientHeight / 2, behavior: 'smooth' });
  };

  // ---- category / name ----
  const setCategory = (cat: Category) => {
    if (!selIds.length) return;
    setRegions((rs) => rs.map((r) => (selectedSet.has(r.id) ? { ...r, category: cat } : r)));
  };
  const setName = (name: string) => {
    if (!selIds.length) return;
    const nm = name.trim();
    setRegions((rs) => rs.map((r) => (selectedSet.has(r.id) ? { ...r, name: nm || undefined } : r)));
  };

  // ---- vertex / move dragging ----
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!drag) return;
    movedRef.current = true;
    const n = toNative(e.clientX, e.clientY);
    if (!n) return;
    if (drag.kind === 'vertex') {
      dragPosRef.current = n;
      setRegions((rs) => rs.map((r) => (r.id === drag.id ? { ...r, exterior: r.exterior.map((p, i) => (i === drag.index ? n : p)) } : r)));
    } else {
      const dx = n[0] - drag.last[0], dy = n[1] - drag.last[1];
      setRegions((rs) => rs.map((r) => (r.id === drag.id ? { ...r, exterior: r.exterior.map(([x, y]) => [x + dx, y + dy] as [number, number]) } : r)));
      setDrag({ ...drag, last: n });
    }
  };

  const MERGE_THR2 = (22 * INV_SCALE) ** 2;
  const mergeTargetFor = useCallback((ext: [number, number][], i: number): number => {
    const vi = ext[i]!; let best = -1, bd = MERGE_THR2;
    for (let k = 0; k < ext.length; k++) { if (k === i) continue; const ek = ext[k]!; const dx = ek[0] - vi[0], dy = ek[1] - vi[1]; const d = dx * dx + dy * dy; if (d < bd) { bd = d; best = k; } }
    return best;
  }, [MERGE_THR2]);

  const dragRef = useRef<Drag>(null); useEffect(() => { dragRef.current = drag; }, [drag]);
  const regionsRef = useRef<TerritoryRegion[]>([]); useEffect(() => { regionsRef.current = regions; }, [regions]);
  const dragPosRef = useRef<[number, number] | null>(null);
  useEffect(() => {
    const up = () => {
      const d = dragRef.current; dragRef.current = null;
      const p = dragPosRef.current; dragPosRef.current = null;
      const moved = movedRef.current; movedRef.current = false;
      setDrag(null);
      if (!d) return;
      // A vertex dropped onto another vertex of the same cell pinches it into two.
      let didSplit = false;
      if (d.kind === 'vertex' && p) {
        const r = regionsRef.current.find((x) => x.id === d.id);
        if (r) { const ext = r.exterior; let j = -1, bd = MERGE_THR2;
          for (let k = 0; k < ext.length; k++) { if (k === d.index) continue; const ek = ext[k]!; const dx = ek[0] - p[0], dy = ek[1] - p[1]; const dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; j = k; } }
          if (j >= 0) { const a = Math.min(d.index, j), b = Math.max(d.index, j); const P = ext[j]!;
            const poly1: [number, number][] = [P, ...ext.slice(a + 1, b)];
            const poly2: [number, number][] = [P, ...ext.slice(b + 1), ...ext.slice(0, a)];
            if (poly1.length >= 3 && poly2.length >= 3) {
              didSplit = true;
              setRegions((rs) => { const others = rs.filter((x) => x.id !== d.id);
                const mk = (id: number, e: [number, number][]): TerritoryRegion => ({ id, panel: r.panel, category: r.category, name: r.name, area_px: polygonArea(e), centroid: polygonCentroid(e), exterior: e });
                return [...others, mk(r.id, poly1), mk(nextId(rs), poly2)]; });
              setSelectedVertex(null);
            } } }
      }
      // Reshaping/moving a cell can grow it over neighbours — re-establish the partition.
      if (moved && !didSplit) setRegions((rs) => enforcePartition(rs, d.id));
    };
    document.addEventListener('mouseup', up);
    return () => document.removeEventListener('mouseup', up);
  }, [MERGE_THR2]);

  const insertVertexAt = (id: number, p: [number, number]) => {
    setRegions((rs) => rs.map((r) => {
      if (r.id !== id || r.exterior.length < 2) return r;
      let bestI = 0, bestD = Infinity;
      for (let i = 0; i < r.exterior.length; i++) { const d = distToSeg(p, r.exterior[i]!, r.exterior[(i + 1) % r.exterior.length]!); if (d < bestD) { bestD = d; bestI = i; } }
      const ext = r.exterior.slice(); ext.splice(bestI + 1, 0, p);
      return { ...r, exterior: ext };
    }));
  };

  const deleteVertex = () => {
    if (primaryId === null || selectedVertex === null) return;
    setRegions((rs) => rs.map((r) => (r.id === primaryId && r.exterior.length > 3 ? { ...r, exterior: r.exterior.filter((_, i) => i !== selectedVertex) } : r)));
    setSelectedVertex(null);
  };

  const deleteSelected = () => {
    if (!selIds.length) return;
    if (!confirm(`Delete ${selIds.length} cell(s)?`)) return;
    setRegions((rs) => rs.filter((r) => !selectedSet.has(r.id)));
    setSelIds([]); setSelectedVertex(null);
  };

  // ---- split a cell with a drawn line (the natural "divide in two") ----------
  const startCut = () => { if (primaryId === null) return; setCut({ id: primaryId, pts: [] }); setDraft(null); setSelectedVertex(null); };
  const cancelCut = () => setCut(null);
  const undoCutPoint = () => setCut((c) => (c && c.pts.length ? { ...c, pts: c.pts.slice(0, -1) } : c));
  const addCutPoint = (p: [number, number]) => setCut((c) => (c ? { ...c, pts: [...c.pts, p] } : c));
  const finishCut = () => {
    if (!cut || cut.pts.length < 2) return;
    const r = regions.find((x) => x.id === cut.id);
    if (!r) { setCut(null); return; }
    const comps = cutRegion(r, cut.pts);
    if (!comps) { alert("The line didn't divide the cell — draw it all the way across, from one side to the other."); return; }
    comps.sort((a, b) => polyAbsArea(b.exterior) - polyAbsArea(a.exterior));
    setRegions((rs) => { let maxId = rs.reduce((m, x) => Math.max(m, x.id), 0); const others = rs.filter((x) => x.id !== r.id);
      const mk = (id: number, c: { exterior: Ring; holes: Ring[] }): TerritoryRegion => ({ ...r, id, exterior: c.exterior, holes: c.holes.length ? c.holes : undefined, area_px: netArea(c.exterior, c.holes), centroid: polygonCentroid(c.exterior) });
      return [...others, ...comps.map((c, i) => mk(i === 0 ? r.id : ++maxId, c))]; });
    setSelIds([cut.id]); setCut(null);
  };

  // Merge the selected (adjacent) cells into one: rasterise them, OR together,
  // re-trace the combined outline. The new cell inherits the primary's category/name.
  const mergeSelected = () => {
    if (selIds.length < 2) return;
    const sel = regions.filter((r) => selectedSet.has(r.id));
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const r of sel) for (const p of r.exterior) { minx = Math.min(minx, p[0]); miny = Math.min(miny, p[1]); maxx = Math.max(maxx, p[0]); maxy = Math.max(maxy, p[1]); }
    const pad = 3, bw = maxx - minx + 2 * pad, bh = maxy - miny + 2 * pad;
    const s = Math.min(2, 1600 / Math.max(bw, bh));
    const cw = Math.max(2, Math.round(bw * s)), ch = Math.max(2, Math.round(bh * s));
    const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(2, s * 2.5); ctx.lineJoin = 'round';
    for (const r of sel) { ctx.beginPath(); r.exterior.forEach((p, i) => { const px = (p[0] - minx + pad) * s, py = (p[1] - miny + pad) * s; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }); ctx.closePath(); ctx.fill(); ctx.stroke(); }
    const data = ctx.getImageData(0, 0, cw, ch).data;
    const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < cw && y < ch && data[(y * cw + x) * 4]! > 128;
    if (componentCount(inside, cw, ch) > 1) { alert("Those cells don't all touch — Merge only joins adjacent cells. Select cells that share a border."); return; }
    const loop = traceOutline(inside, cw, ch);
    if (!loop) { alert('Could not trace a merged outline.'); return; }
    const back = loop.map(([x, y]) => [+(minx - pad + x / s).toFixed(1), +(miny - pad + y / s).toFixed(1)] as [number, number]);
    const ext = dpRing(back, 1.5);
    if (ext.length < 3) return;
    const prim = sel.find((r) => r.id === primaryId) ?? sel[0]!;
    const nid = nextId(regions);
    setRegions((rs) => enforcePartition([...rs.filter((r) => !selectedSet.has(r.id)), { id: nid, panel: prim.panel, category: prim.category, name: prim.name, area_px: polygonArea(ext), centroid: polygonCentroid(ext), exterior: ext }], nid));
    setSelIds([nid]); setSelectedVertex(null);
  };

  // ---- draw a new cell ----
  const startDraw = () => { setDraft([]); setSelIds([]); setSelectedVertex(null); };
  const cancelDraw = () => setDraft(null);
  const undoDraftPoint = () => setDraft((d) => (d && d.length ? d.slice(0, -1) : d));
  const commitDraft = (pts: [number, number][]) => {
    const id = nextId(regions);
    setRegions((rs) => enforcePartition([...rs, { id, panel: '', category: '' as Category, area_px: polygonArea(pts), centroid: polygonCentroid(pts), exterior: pts }], id));
    setSelIds([id]);
  };
  const finishDraft = () => { if (draft && draft.length >= 3) { commitDraft(draft.slice()); setDraft(null); } };
  const addDraftPoint = (p: [number, number]) => {
    setDraft((d) => {
      if (!d) return d;
      if (d.length >= 3) { const d0 = d[0]!; const dx = p[0] - d0[0], dy = p[1] - d0[1]; if (dx * dx + dy * dy < (18 * INV_SCALE) ** 2) { commitDraft(d.slice()); return null; } }
      return [...d, p];
    });
  };

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (cut !== null) {
        if (e.key === 'Enter') { e.preventDefault(); finishCut(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancelCut(); }
        else if (e.key === 'Backspace') { e.preventDefault(); undoCutPoint(); }
        return;
      }
      if (draft !== null) {
        if (e.key === 'Enter') { e.preventDefault(); finishDraft(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancelDraw(); }
        else if (e.key === 'Backspace') { e.preventDefault(); undoDraftPoint(); }
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedVertex !== null) { e.preventDefault(); deleteVertex(); }
      else if (e.key === 'Escape') { setSelIds([]); setSelectedVertex(null); }
      else if (e.key === 'o') setCategory('openSea');
      else if (e.key === 'c') setCategory('coastal');
      else if (e.key === 'l') setCategory('land');
      else if (e.key === 'k') setCategory('cosmetic');
      else if (e.key === 'u') setCategory('');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const handleReset = () => {
    if (!confirm('Discard all local territory edits and revert to the saved file?')) return;
    setRegions(cloneRegions(base)); setSelIds([]); setSelectedVertex(null);
  };

  const buildExport = () => ({
    _meta: { ...(TERRITORIES._meta ?? { schema: 'territory-polygons-v1', provenance: '', source: '', notes: [] }), provenance: 'owner-corrected', notes: [...(TERRITORIES._meta?.notes ?? []), `Edited via dev Territories tab at ${new Date().toISOString()}.`] },
    image: { width: NATIVE_W, height: NATIVE_H },
    count: regions.length,
    regions: regions.map((r) => ({ id: r.id, ...(r.name ? { name: r.name } : {}), panel: r.panel, category: r.category, area_px: netArea(r.exterior, r.holes || []), centroid: polygonCentroid(r.exterior), exterior: r.exterior, ...(r.holes && r.holes.length ? { holes: r.holes } : {}) })),
  });
  const handleExport = () => {
    const blob = new Blob([JSON.stringify(buildExport())], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = 'territories.json'; link.click();
    URL.revokeObjectURL(url);
  };
  // Writes straight to src/data/territories.json via the dev-server middleware —
  // no download/paste round-trip (and no hand-transcription errors).
  const handleSaveRepo = async () => {
    try {
      const res = await fetch('/__save-territories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildExport()) });
      const j = await res.json();
      alert(j.ok ? `Saved ${j.count} territories to src/data/territories.json` : `Save failed: ${j.error}`);
    } catch (e) { alert('Save failed: ' + e); }
  };

  const primary = primaryId !== null ? regions.find((r) => r.id === primaryId) : null;
  const btn: React.CSSProperties = { padding: '4px 10px', background: '#2a2d34', color: '#e8e8ea', border: '1px solid #3a3d44', borderRadius: 4, cursor: 'pointer', fontSize: 13 };

  return (
    <div style={{ color: '#e8e8ea', fontFamily: 'system-ui, sans-serif', padding: 12 }}>
      <h2 style={{ marginTop: 0 }}>Territories editor</h2>
      <div style={{ fontSize: 13, color: '#b8bcc4', marginBottom: 10, maxWidth: 1100, lineHeight: 1.5 }}>
        Click a cell to select it. <strong>Category:</strong> press <kbd>o</kbd> open sea, <kbd>c</kbd> coastal, <kbd>l</kbd> land, <kbd>u</kbd> unset (or the buttons).
        <strong> Shift-click</strong> to select several cells and categorise/name them together — give a split-up sea (e.g. the Adriatic fragments) the same name to reunify it.
        <strong> Reshape:</strong> drag a pink vertex; double-click an edge to add a point; select a vertex and press <kbd>Delete</kbd>; drag the cyan centroid to move the whole cell.
        <strong> Split a cell in two:</strong> select it, click <strong>✂ Split by line</strong>, and click a line all the way across it (Enter to finish). Edits reflow neighbours so cells never overlap.
      </div>

      <div style={{ marginBottom: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button style={{ ...btn, color: '#80dc78', borderColor: '#3a5a3a' }} onClick={handleSaveRepo}>💾 Save to repo</button>
        <button style={{ ...btn, opacity: isDirty ? 1 : 0.5 }} onClick={handleExport} disabled={!isDirty}>⤓ Export</button>
        <button style={{ ...btn, opacity: isDirty ? 1 : 0.5 }} onClick={handleReset} disabled={!isDirty}>Reset</button>
        {cut !== null
          ? <>
              <span style={{ fontSize: 13, color: '#ff8f5a' }}>✂ Cutting #{cut.id}:</span>
              <button style={{ ...btn, color: '#80dc78' }} onClick={finishCut} disabled={cut.pts.length < 2}>Finish cut ({cut.pts.length})</button>
              <button style={btn} onClick={undoCutPoint} disabled={cut.pts.length === 0}>Undo point</button>
              <button style={{ ...btn, color: '#ff8866' }} onClick={cancelCut}>Cancel</button>
            </>
          : draft === null
          ? <button style={{ ...btn, color: '#80dc78' }} onClick={startDraw}>✏️ Draw cell</button>
          : <>
              <button style={{ ...btn, color: '#80dc78' }} onClick={finishDraft} disabled={draft.length < 3}>Finish cell ({draft.length})</button>
              <button style={btn} onClick={undoDraftPoint} disabled={draft.length === 0}>Undo point</button>
              <button style={{ ...btn, color: '#ff8866' }} onClick={cancelDraw}>Cancel</button>
            </>}
        <label style={{ fontSize: 12, color: '#aaa', marginLeft: 8 }}>
          <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> dim categorised
        </label>
        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', marginLeft: 8 }}>
          <button style={{ ...btn, padding: '4px 9px' }} title="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, +(z / 1.25).toFixed(3)))}>−</button>
          <button style={{ ...btn, padding: '4px 9px' }} title="Reset zoom" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button style={{ ...btn, padding: '4px 9px' }} title="Zoom in" onClick={() => setZoom((z) => Math.min(6, +(z * 1.25).toFixed(3)))}>+</button>
        </span>
        <button style={{ ...btn, color: '#c9a0ff', borderColor: '#4a3a6a', marginLeft: 8 }} onClick={assignAreas} title="Set each 1:1 territory's name to its game area (from geometry)">🏷 Assign areas</button>
        <span style={{ fontSize: 12, color: '#9aa0a8' }}>
          <span style={{ color: '#80dc78' }}>{nameSummary.ok} ok</span> · <span style={{ color: '#ffb454' }}>{nameSummary.merged} merge</span> · <span style={{ color: '#9aa0a8' }}>{nameSummary.empty} empty</span> · <span style={{ color: '#ff6b6b' }}>{nameSummary.mismatch} mismatch</span>
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9aa0a8' }}>
          {regions.length} cells · <span style={{ color: categoryMeta('openSea').stroke }}>{counts.openSea} sea</span> · <span style={{ color: categoryMeta('coastal').stroke }}>{counts.coastal} coastal</span> · <span style={{ color: categoryMeta('land').stroke }}>{counts.land} land</span> · <span style={{ color: categoryMeta('cosmetic').stroke }}>{counts.cosmetic} cosmetic</span> · <span style={{ color: '#ffd54a' }}>{counts.unset} unset</span>
        </span>
      </div>

      {/* Selection action bar */}
      <div style={{ marginBottom: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minHeight: 30 }}>
        {selIds.length > 0 ? (
          <>
            <span style={{ fontSize: 13, color: '#ffd54a' }}>{selIds.length === 1 ? `#${primaryId}${primary?.name ? ' ' + primary.name : ''}` : `${selIds.length} cells`}:</span>
            {CATS.map((c) => (
              <button key={c} style={{ ...btn, borderColor: categoryMeta(c).stroke, color: categoryMeta(c).stroke }} onClick={() => setCategory(c)}>{categoryMeta(c).label}</button>
            ))}
            <button style={btn} onClick={() => setCategory('')}>Unset</button>
            <input placeholder="name (shared = one area)" defaultValue={selIds.length === 1 ? (primary?.name ?? '') : ''} key={selIds.join(',')}
              onBlur={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              style={{ padding: '4px 8px', background: '#15171c', color: '#e8e8ea', border: '1px solid #3a3d44', borderRadius: 4, fontSize: 13, width: 220 }} />
            {selIds.length >= 2 && <button style={{ ...btn, color: '#8fd0ff', borderColor: '#3a5a72' }} onClick={mergeSelected}>⨝ Merge {selIds.length}</button>}
            {selIds.length === 1 && cut === null && draft === null && <button style={{ ...btn, color: '#ff8f5a', borderColor: '#6a4230' }} onClick={startCut}>✂ Split by line</button>}
            {selectedVertex !== null && <button style={btn} onClick={deleteVertex}>Delete vertex</button>}
            <button style={{ ...btn, color: '#ff8866' }} onClick={deleteSelected}>Delete {selIds.length > 1 ? selIds.length : `#${primaryId}`}</button>
          </>
        ) : <span style={{ fontSize: 12, color: '#777' }}>No selection — click a cell (Shift-click to add more).</span>}
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      {/* Territory list — click a row to select + jump the board to it. */}
      <div style={{ flex: '0 0 190px', height: DISPLAY_H, display: 'flex', flexDirection: 'column', background: '#15171c', border: '1px solid #2a2d34', borderRadius: 4 }}>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter id / name…"
          style={{ margin: 6, padding: '4px 8px', background: '#0e0f13', color: '#e8e8ea', border: '1px solid #3a3d44', borderRadius: 4, fontSize: 12 }} />
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {regions
            .filter((r) => { const f = filter.trim().toLowerCase(); if (!f) return true;
              if (['merged', 'merge', 'empty', 'mismatch', 'ok'].includes(f)) return nameStatus(r).kind === (f === 'merge' ? 'merged' : f);
              return String(r.id) === f || String(r.id).startsWith(f) || (r.name ?? '').toLowerCase().includes(f) || (f === 'unset' && !r.category); })
            .sort((a, b) => a.id - b.id)
            .map((r) => {
              const sel = selectedSet.has(r.id); const m = categoryMeta(r.category);
              const st = nameStatus(r);
              const badge = st.kind === 'merged' ? { t: `⚠${st.areas.length}`, c: '#ffb454' } : st.kind === 'empty' ? { t: '∅', c: '#9aa0a8' } : st.kind === 'mismatch' ? { t: '✗', c: '#ff6b6b' } : null;
              return (
                <div key={r.id} onClick={(e) => { selectCell(r.id, e.shiftKey); scrollToCell(r); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px', cursor: 'pointer', background: sel ? '#2a2030' : 'transparent', borderLeft: `3px solid ${r.category ? m.fill : 'transparent'}` }}>
                  <span style={{ fontSize: 12, color: sel ? '#ffd54a' : '#cfcfd4', fontWeight: sel ? 700 : 400, minWidth: 30 }}>#{r.id}</span>
                  <span style={{ fontSize: 11, color: '#9aa0a8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{r.name ?? (r.category ? m.label : '')}</span>
                  {badge && <span title={st.kind === 'merged' ? st.areas.map((a) => a.id).join(', ') : st.kind} style={{ fontSize: 10, color: badge.c, flexShrink: 0 }}>{badge.t}</span>}
                </div>
              );
            })}
        </div>
      </div>

      <div ref={boardScrollRef} style={{ position: 'relative', width: DISPLAY_W, height: DISPLAY_H, userSelect: 'none', overflow: 'auto', border: '1px solid #2a2d34' }}>
        <div style={{ position: 'relative', width: W2, height: H2 }}>
        <img src={BOARD_SRC} width={W2} height={H2} alt="Board" draggable={false} style={{ display: 'block' }} />
        <svg ref={svgRef} width={W2} height={H2}
          onMouseMove={handleMouseMove}
          onDoubleClick={(e) => {
            if (draft !== null) return;
            const n = toNative(e.clientX, e.clientY); if (!n) return;
            let target = primaryId;
            if (target === null) { const hit = regions.find((r) => regionContains(r, n)); if (hit) { setSelIds([hit.id]); target = hit.id; } }
            if (target !== null) insertVertexAt(target, n);
          }}
          style={{ position: 'absolute', top: 0, left: 0, cursor: 'default' }}>
          <rect x={0} y={0} width={W2} height={H2} fill="transparent" />
          {regions.map((r) => {
            const sel = selectedSet.has(r.id);
            const m = categoryMeta(r.category);
            const ringD = (ring: [number, number][]) => 'M' + ring.map(([x, y]) => `${(x * dScale).toFixed(1)},${(y * dScale).toFixed(1)}`).join('L') + 'Z';
            const d = ringD(r.exterior) + (r.holes || []).map(ringD).join('');
            const dim = hideDone && r.category !== '';
            const c = polygonCentroid(r.exterior);
            return (
              <g key={r.id} opacity={dim ? 0.25 : 1}>
                <path d={d} fillRule="evenodd"
                  onMouseDown={(e) => { e.stopPropagation(); selectCell(r.id, e.shiftKey); }}
                  style={{ fill: r.category ? `${m.fill}55` : (sel ? '#ffd54a22' : 'rgba(0,0,0,0.001)'), stroke: sel ? '#ffd54a' : m.stroke, strokeWidth: sel ? 2.5 : (r.category ? 1.3 : 1), strokeLinejoin: 'round', cursor: 'pointer', pointerEvents: 'all' }} />
                <text x={c[0] * dScale} y={c[1] * dScale} textAnchor="middle" dominantBaseline="middle"
                  style={{ fill: sel ? '#fff' : '#e8e8ea', fontSize: 11, fontWeight: 700, pointerEvents: 'none', paintOrder: 'stroke', stroke: '#000', strokeWidth: 2.5 } as React.CSSProperties}>{r.id}</text>
              </g>
            );
          })}

          {/* handles for the single primary selection */}
          {selIds.length === 1 && primary && (() => {
            const c = polygonCentroid(primary.exterior);
            const mergeTarget = (drag?.kind === 'vertex' && drag.id === primary.id) ? mergeTargetFor(primary.exterior, drag.index) : -1;
            return (
              <g>
                {primary.exterior.map((p, i) => {
                  const vsel = selectedVertex === i, isMT = i === mergeTarget;
                  return (
                    <circle key={i} cx={p[0] * dScale} cy={p[1] * dScale} r={isMT ? 9 : vsel ? 7 : 5}
                      onMouseDown={(e) => { e.stopPropagation(); setSelectedVertex(i); dragPosRef.current = null; movedRef.current = false; setDrag({ kind: 'vertex', id: primary.id, index: i }); }}
                      style={{ fill: isMT ? '#ff5a3a' : vsel ? '#ffd54a' : '#ff7ab8', stroke: isMT ? '#fff' : '#1a1a1a', strokeWidth: isMT ? 2 : 1, cursor: 'grab' }} />
                  );
                })}
                <circle cx={c[0] * dScale} cy={c[1] * dScale} r={6}
                  onMouseDown={(e) => { e.stopPropagation(); movedRef.current = false; const n = toNative(e.clientX, e.clientY); if (n) setDrag({ kind: 'move', id: primary.id, last: n }); }}
                  style={{ fill: '#3ad6e0', stroke: '#0a2a2c', strokeWidth: 1.5, cursor: 'move' }} />
              </g>
            );
          })()}

          {draft !== null && (
            <g>
              <rect x={0} y={0} width={W2} height={H2} fill="rgba(0,0,0,0.18)" style={{ cursor: 'crosshair' }}
                onMouseDown={(e) => { e.stopPropagation(); const n = toNative(e.clientX, e.clientY); if (n) addDraftPoint(n); }} />
              {draft.length > 0 && <polyline points={[...draft, ...(draft.length >= 3 ? [draft[0]!] : [])].map(([x, y]) => `${x * dScale},${y * dScale}`).join(' ')} style={{ fill: draft.length >= 3 ? 'rgba(128,220,120,0.18)' : 'none', stroke: '#80dc78', strokeWidth: 2, strokeDasharray: '5,3', pointerEvents: 'none' }} />}
              {draft.map((p, i) => <circle key={i} cx={p[0] * dScale} cy={p[1] * dScale} r={i === 0 ? 6 : 4} style={{ fill: i === 0 ? '#ffd54a' : '#80dc78', stroke: '#1a1a1a', strokeWidth: 1, pointerEvents: 'none' }} />)}
            </g>
          )}

          {cut !== null && (
            <g>
              <rect x={0} y={0} width={W2} height={H2} fill="rgba(0,0,0,0.12)" style={{ cursor: 'crosshair' }}
                onMouseDown={(e) => { e.stopPropagation(); const n = toNative(e.clientX, e.clientY); if (n) addCutPoint(n); }} />
              {cut.pts.length > 0 && <polyline points={cut.pts.map(([x, y]) => `${x * dScale},${y * dScale}`).join(' ')} style={{ fill: 'none', stroke: '#ff8f5a', strokeWidth: 2.5, strokeDasharray: '6,4', pointerEvents: 'none' }} />}
              {cut.pts.map((p, i) => <circle key={i} cx={p[0] * dScale} cy={p[1] * dScale} r={4} style={{ fill: '#ff8f5a', stroke: '#1a1a1a', strokeWidth: 1, pointerEvents: 'none' }} />)}
            </g>
          )}
        </svg>
        </div>
      </div>
      </div>
    </div>
  );
}
