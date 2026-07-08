// Coast sub-areas per territory (scripts/build-coasts.mjs). Each coastal territory
// is split by its black coast into land + sea (coastal-water) connected components;
// open-sea/land territories carry one sub-area. Consumed by the dev Coasts review
// tab (src/ui/dev/CoastsTab.tsx). Later feeds coastal-water adjacency + ship routing.
import coastlinesJson from './coastlines.json' with { type: 'json' };

export type SubKind = 'sea' | 'land';
export type SubArea = { subId: string; kind: SubKind; area_px: number; centroid: [number, number]; exterior: [number, number][] };
export type CoastTerritory = { id: number; name?: string; category: string; sub: SubArea[] };
export type CoastlinesFile = { image: { width: number; height: number }; count: number; territories: CoastTerritory[] };

export const COASTLINES = coastlinesJson as unknown as CoastlinesFile;
export const LS_COASTS = 'advciv-dev-coastlines-edits-v1';

export function cloneCoasts(ts: CoastTerritory[]): CoastTerritory[] {
  return ts.map((t) => ({ ...t, sub: t.sub.map((s) => ({ ...s, centroid: [s.centroid[0], s.centroid[1]] as [number, number], exterior: s.exterior.map((p) => [p[0], p[1]] as [number, number]) })) }));
}
export function loadCoastEdits(): CoastTerritory[] | null {
  try { const s = localStorage.getItem(LS_COASTS); if (!s) return null; const p = JSON.parse(s); return Array.isArray(p) ? p as CoastTerritory[] : null; } catch { return null; }
}
export function saveCoastEdits(ts: CoastTerritory[], base: CoastTerritory[]): void {
  if (JSON.stringify(ts) === JSON.stringify(base)) localStorage.removeItem(LS_COASTS);
  else localStorage.setItem(LS_COASTS, JSON.stringify(ts));
}
