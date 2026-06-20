// Per-area anchor points (in the main-map SVG coordinate space, which matches
// the VASSAL zone polygon coordinates) for placing token/city markers.
import { poleOfInaccessibilityWithClearance, toPolygon } from 'digital-boardgame-framework';
import { areas } from '../data/index.js';

export interface Anchor { x: number; y: number; r: number; }

export const anchors: Record<string, Anchor> = {};
for (const a of areas) {
  if (a.board !== 'main' || a.path.length < 3) continue;
  try {
    const { point, clearance } = poleOfInaccessibilityWithClearance(toPolygon(a.path));
    anchors[a.id] = { x: point.x, y: point.y, r: Math.max(8, Math.min(28, clearance * 0.5)) };
  } catch {
    // Fallback: centroid average.
    const n = a.path.length;
    const cx = a.path.reduce((s, p) => s + p[0], 0) / n;
    const cy = a.path.reduce((s, p) => s + p[1], 0) / n;
    anchors[a.id] = { x: cx, y: cy, r: 12 };
  }
}

export const MAIN_VIEWBOX = { w: 2323.12, h: 1587.4 };
