// Per-area anchor points for placing token/city markers, plus the layout that
// stitches the three VASSAL map panels (West Extension · Main · East Extension)
// side by side into one scrollable canvas. Each board's zone polygons live in its
// own image coordinate space (origin 0,0; all three are 1587.4 tall), so we just
// offset the western/eastern panels to the right of one another.
import { poleOfInaccessibilityWithClearance, toPolygon } from 'digital-boardgame-framework';
import { areas } from '../data/index.js';
import coastlinesJson from '../data/coastlines.json' with { type: 'json' };

export interface Anchor { x: number; y: number; r: number; }

// Native VASSAL main-panel size (kept for any legacy consumer).
export const MAIN_VIEWBOX = { w: 2323.12, h: 1587.4 };

// Area geometry now lives in ONE combined image space — the owner-authored
// territory polygons (see scripts/build-board.mjs), 3800×1405 — so each area's
// `path` is already positioned and needs NO per-board offset.
export const BOARD_VIEWBOX = { w: 3800, h: 1405 };
export const BOARD_OFFSET: Record<string, { x: number; y: number }> = {
  western: { x: 0, y: 0 },
  main: { x: 0, y: 0 },
  eastern: { x: 0, y: 0 },
};

/** Where each VASSAL art panel sits in the combined canvas (bring-your-own art,
 *  see mapArt.ts). Scaled from the 4294-wide panel layout into the 3800-wide
 *  polygon space so a loaded image still roughly registers with the vector board. */
const _SX = 3800 / (782.177 + 2323.12 + 1189.066), _SY = 1405 / 1587.4;
export const MAP_PANELS: { key: 'western' | 'main' | 'eastern'; x: number; y: number; w: number; h: number }[] = [
  { key: 'western', x: 0, y: 0, w: 782.177 * _SX, h: 1587.4 * _SY },
  { key: 'main', x: 782.177 * _SX, y: 0, w: 2323.12 * _SX, h: 1587.4 * _SY },
  { key: 'eastern', x: (782.177 + 2323.12) * _SX, y: 0, w: 1189.066 * _SX, h: 1587.4 * _SY },
];

/** Every area as a filled polygon in the combined canvas — the board we draw
 *  from our own geometry when no map artwork has been loaded. */
export interface Shape { id: string; isWater: boolean; points: string; cx: number; cy: number; }
export const ALL_SHAPES: Shape[] = [];
for (const a of areas) {
  if (a.path.length < 3) continue;
  const off = BOARD_OFFSET[a.board] ?? { x: 0, y: 0 };
  const pts = a.path.map(([x, y]) => `${(x + off.x).toFixed(1)},${(y + off.y).toFixed(1)}`).join(' ');
  const an = anchorsTmp(a);
  ALL_SHAPES.push({ id: a.id, isWater: a.isWater, points: pts, cx: an.x, cy: an.y });
}
function anchorsTmp(a: typeof areas[number]) {
  const off = BOARD_OFFSET[a.board] ?? { x: 0, y: 0 };
  const n = a.path.length;
  return { x: a.path.reduce((s, p) => s + p[0], 0) / n + off.x, y: a.path.reduce((s, p) => s + p[1], 0) / n + off.y };
}

/** Coast sub-areas per area id — the land/sea split inside coastal territories
 *  (scripts/build-coasts.mjs), keyed by the area id (coastlines `name`). Used to
 *  paint coastal territories with their coast (sea vs land) on the vector board.
 *  Same combined image space as the polygons, so no offset. */
export interface CoastSub { kind: 'sea' | 'land'; points: string; }
export const COAST_SUBS: Record<string, CoastSub[]> = {};
for (const t of (coastlinesJson as unknown as { territories: { name?: string; sub: { kind: 'sea' | 'land'; exterior: number[][] }[] }[] }).territories) {
  if (!t.name || t.sub.length < 2) continue; // only where the coast actually splits it
  COAST_SUBS[t.name] = t.sub.map((s) => ({ kind: s.kind, points: s.exterior.map(([x, y]) => `${x},${y}`).join(' ') }));
}

export const anchors: Record<string, Anchor> = {};
for (const a of areas) {
  if (a.path.length < 3) continue;
  const off = BOARD_OFFSET[a.board] ?? { x: 0, y: 0 };
  let x: number, y: number, r: number;
  try {
    const { point, clearance } = poleOfInaccessibilityWithClearance(toPolygon(a.path));
    x = point.x; y = point.y; r = Math.max(8, Math.min(28, clearance * 0.5));
  } catch {
    const n = a.path.length;
    x = a.path.reduce((s, p) => s + p[0], 0) / n;
    y = a.path.reduce((s, p) => s + p[1], 0) / n;
    r = 12;
  }
  anchors[a.id] = { x: x + off.x, y: y + off.y, r };
}
