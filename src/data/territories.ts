// Territory boundary polygons traced from the printed board's WHITE/BLACK border
// lines (scripts/trace-territories.mjs). NO VASSAL polygon geometry is used.
// Coordinates are in the combined board.png space (image.width x image.height).
// Each region's `exterior` is a closed ring (first point implicitly joins last).
//
// Consumed by the dev "Territories" editor (src/ui/dev/TerritoriesTab.tsx), which
// overlays them on public/dev-assets/board.png so the owner can fix borders and
// assign each cell a category. Edits persist to localStorage under LS_TERRITORIES.

import territoriesJson from './territories.json' with { type: 'json' };

export type Category = 'openSea' | 'coastal' | 'land' | 'cosmetic' | '';

export type TerritoryRegion = {
  id: number;
  name?: string;
  /** western | main | eastern — which board panel this cell came from. */
  panel: string;
  /** owner-assigned classification; '' = not yet categorised. */
  category: Category;
  area_px: number;
  centroid: [number, number];
  exterior: [number, number][];
  /** Inner rings cut out of the exterior (e.g. an island enclosed by a sea).
   *  A point is in the territory iff it is inside `exterior` and inside none of
   *  these. Maintained automatically by the editor's partition enforcement. */
  holes?: [number, number][][];
};

export type TerritoriesFile = {
  _meta?: { schema: string; provenance: string; source: string; notes: string[] };
  image: { width: number; height: number };
  count: number;
  regions: TerritoryRegion[];
};

export const TERRITORIES = territoriesJson as unknown as TerritoriesFile;

// Bump this key whenever the tracer renumbers, so stale localStorage edits keyed
// to old ids don't shadow the freshly-generated base.
export const LS_TERRITORIES = 'advciv-dev-territories-edits-v3';

export function cloneRegions(regions: TerritoryRegion[]): TerritoryRegion[] {
  return regions.map((r) => ({
    ...r,
    centroid: [r.centroid[0], r.centroid[1]] as [number, number],
    exterior: r.exterior.map((p) => [p[0], p[1]] as [number, number]),
  }));
}

export function loadTerritoryEdits(): TerritoryRegion[] | null {
  try {
    const s = localStorage.getItem(LS_TERRITORIES);
    if (!s) return null;
    const parsed = JSON.parse(s);
    if (!Array.isArray(parsed)) return null;
    return parsed as TerritoryRegion[];
  } catch {
    return null;
  }
}

export function saveTerritoryEdits(regions: TerritoryRegion[], base: TerritoryRegion[]): void {
  if (JSON.stringify(regions) === JSON.stringify(base)) {
    localStorage.removeItem(LS_TERRITORIES);
  } else {
    localStorage.setItem(LS_TERRITORIES, JSON.stringify(regions));
  }
}

export function effectiveRegions(): TerritoryRegion[] {
  return loadTerritoryEdits() ?? cloneRegions(TERRITORIES.regions);
}

/** Signed-area centroid of a polygon. */
export function polygonCentroid(pts: [number, number][]): [number, number] {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[(i + 1) % pts.length]!;
    const cross = x0 * y1 - x1 * y0;
    a += cross; cx += (x0 + x1) * cross; cy += (y0 + y1) * cross;
  }
  if (Math.abs(a) < 1e-6) {
    const sx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const sy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    return [Math.round(sx * 10) / 10, Math.round(sy * 10) / 10];
  }
  a *= 0.5;
  return [Math.round((cx / (6 * a)) * 10) / 10, Math.round((cy / (6 * a)) * 10) / 10];
}

/** Absolute polygon area in px². */
export function polygonArea(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[(i + 1) % pts.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return Math.round(Math.abs(a) / 2);
}

export const CATEGORY_META: Record<Exclude<Category, ''> | 'unset', { label: string; fill: string; stroke: string }> = {
  openSea:  { label: 'Open sea', fill: '#1b3a8f', stroke: '#5b7fd6' },
  coastal:  { label: 'Coastal', fill: '#2f9fb5', stroke: '#7fd6e6' },
  land:     { label: 'Land', fill: '#b5893f', stroke: '#e6c07f' },
  cosmetic: { label: 'Cosmetic', fill: '#5a5140', stroke: '#8a7e63' },
  unset:    { label: 'Unset', fill: '#666a72', stroke: '#9aa0a8' },
};

export function categoryMeta(c: Category) {
  return CATEGORY_META[(c || 'unset') as keyof typeof CATEGORY_META];
}
