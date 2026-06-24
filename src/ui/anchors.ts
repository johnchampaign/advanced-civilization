// Per-area anchor points for placing token/city markers, plus the layout that
// stitches the three map panels (West Extension · Main · East Extension) into one
// scrollable canvas. Each board uses its own VASSAL coordinate space starting near
// 0, so we translate the western and eastern panels to sit beside the main map.
import { poleOfInaccessibilityWithClearance, toPolygon } from 'digital-boardgame-framework';
import { areas } from '../data/index.js';

export interface Anchor { x: number; y: number; r: number; }

/** The main map's SVG/image dimensions (its coordinate origin is 0,0). */
export const MAIN_VIEWBOX = { w: 2323.12, h: 1587.4 };

const GAP = 140; // gutter between map panels

/** Bounding box of a board's area polygons. */
function extent(board: string): { minx: number; miny: number; w: number; h: number } {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const a of areas) if (a.board === board) for (const [x, y] of a.path) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
  if (!Number.isFinite(minx)) return { minx: 0, miny: 0, w: 0, h: 0 };
  return { minx, miny, w: maxx - minx, h: maxy - miny };
}

const W = extent('western');
const E = extent('eastern');

// Translate added to each board's raw coordinates. Western is normalized to start
// at 0; the main map's image is placed after it (its own origin is already 0);
// eastern follows the main map.
const mainStart = W.w + GAP;
const eastStart = mainStart + MAIN_VIEWBOX.w + GAP;
export const BOARD_OFFSET: Record<string, { x: number; y: number }> = {
  western: { x: -W.minx, y: -W.miny },
  main: { x: mainStart, y: 0 },
  eastern: { x: eastStart - E.minx, y: -E.miny },
};
/** Where the main-map artwork image sits in the combined canvas. */
export const MAIN_ORIGIN = BOARD_OFFSET.main!;
/** The combined canvas dimensions (all three panels side by side). */
export const BOARD_VIEWBOX = { w: eastStart + E.w, h: Math.max(W.h, MAIN_VIEWBOX.h, E.h) };

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

/** Extension-map areas drawn as polygons (the main map has its own artwork). Each
 *  is the area's path translated into the combined canvas. */
export const EXTENSION_SHAPES: { id: string; isWater: boolean; points: string; cx: number; cy: number }[] = [];
for (const a of areas) {
  if (a.board === 'main' || a.path.length < 3) continue;
  const off = BOARD_OFFSET[a.board] ?? { x: 0, y: 0 };
  const pts = a.path.map(([x, y]) => `${(x + off.x).toFixed(1)},${(y + off.y).toFixed(1)}`).join(' ');
  const an = anchors[a.id];
  EXTENSION_SHAPES.push({ id: a.id, isWater: !!a.isWater, points: pts, cx: an?.x ?? 0, cy: an?.y ?? 0 });
}
