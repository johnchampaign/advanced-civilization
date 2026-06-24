// Per-area anchor points for placing token/city markers, plus the layout that
// stitches the three VASSAL map panels (West Extension · Main · East Extension)
// side by side into one scrollable canvas. Each board's zone polygons live in its
// own image coordinate space (origin 0,0; all three are 1587.4 tall), so we just
// offset the western/eastern panels to the right of one another.
import { poleOfInaccessibilityWithClearance, toPolygon } from 'digital-boardgame-framework';
import { areas } from '../data/index.js';

export interface Anchor { x: number; y: number; r: number; }

// Native dimensions of each map artwork (from the VASSAL module SVG viewBoxes).
export const MAIN_VIEWBOX = { w: 2323.12, h: 1587.4 };
const WEST = { w: 782.177, h: 1587.4 };
const EAST = { w: 1189.066, h: 1587.4 };
const GAP = 0; // the panels are drawn to abut at the same latitude

// X offset added to each board's native coordinates to place it in the canvas.
const mainX = WEST.w + GAP;
const eastX = mainX + MAIN_VIEWBOX.w + GAP;
export const BOARD_OFFSET: Record<string, { x: number; y: number }> = {
  western: { x: 0, y: 0 },
  main: { x: mainX, y: 0 },
  eastern: { x: eastX, y: 0 },
};
export const BOARD_VIEWBOX = { w: eastX + EAST.w, h: MAIN_VIEWBOX.h };

/** Where each map panel sits in the combined canvas. The artwork itself is
 *  bring-your-own (see mapArt.ts) — `key` selects the loaded image for a panel. */
export const MAP_PANELS: { key: 'western' | 'main' | 'eastern'; x: number; y: number; w: number; h: number }[] = [
  { key: 'western', x: BOARD_OFFSET.western!.x, y: 0, w: WEST.w, h: WEST.h },
  { key: 'main', x: BOARD_OFFSET.main!.x, y: 0, w: MAIN_VIEWBOX.w, h: MAIN_VIEWBOX.h },
  { key: 'eastern', x: BOARD_OFFSET.eastern!.x, y: 0, w: EAST.w, h: EAST.h },
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
