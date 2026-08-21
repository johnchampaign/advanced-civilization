// The §16 out-of-play VEIL must land on the same part of the board the engine
// actually removed from play. `playAreas.coverPolygons` are still in the native
// VASSAL main-panel space while every area `path` was rebuilt into the combined
// 3800x1405 canvas (scripts/build-board.mjs), so the veil needs a real transform.
// Shipping it with a (0,0) shift drew the veil far left of the territories it
// was meant to cover — visible to players as shading that ignores the borders.
import { describe, expect, it } from 'vitest';
import { playAreas, areas } from '../data/index.js';
import { mainToCombined, BOARD_VIEWBOX, MAP_PANELS } from './anchors.js';

const centroid = (pts: readonly (readonly [number, number])[]): [number, number] => {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const cr = pts[j]![0] * pts[i]![1] - pts[i]![0] * pts[j]![1];
    a += cr; cx += (pts[j]![0] + pts[i]![0]) * cr; cy += (pts[j]![1] + pts[i]![1]) * cr;
  }
  if (!a) return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  a *= 0.5;
  return [cx / (6 * a), cy / (6 * a)];
};

const inside = (p: readonly [number, number], poly: readonly [number, number][]) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};

const mainAreas = areas.filter((a) => a.board === 'main' && !a.coastalWater && a.path.length >= 3);
const crops = Object.keys(playAreas.coverPolygons) as (keyof typeof playAreas.coverPolygons)[];

describe('§16 out-of-play veil registration', () => {
  it.each(crops)('%s veil covers the areas the engine took out of play', (crop) => {
    const cover = playAreas.coverPolygons[crop].map(mainToCombined);
    const out = new Set(playAreas.outOfPlay[crop]);
    const agree = mainAreas.filter((a) => inside(centroid(a.path), cover) === out.has(a.id)).length;
    // Not 100%: §16.6-16.8 keep open-sea areas that straddle the dividing line in
    // play, and an island's printed number can sit off its polygon's centroid.
    // With the transform dropped this collapses to ~55%, so the gap is decisive.
    expect(agree / mainAreas.length).toBeGreaterThan(0.95);
  });

  it.each(crops)('%s veil stays inside the main panel of the canvas', (crop) => {
    const main = MAP_PANELS.find((m) => m.key === 'main')!;
    const xs = playAreas.coverPolygons[crop].map((p) => mainToCombined(p)[0]);
    // A few px of bleed past the panel edge is the printed cover's own overhang.
    expect(Math.min(...xs)).toBeGreaterThan(main.x - 30);
    expect(Math.max(...xs)).toBeLessThan(main.x + main.w + 30);
    expect(Math.max(...xs)).toBeLessThan(BOARD_VIEWBOX.w);
  });
});
