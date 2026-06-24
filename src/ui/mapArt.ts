// Bring-your-own board artwork.
//
// This build ships NO map images. The board renders fine from our own area
// geometry (see ALL_SHAPES in anchors.ts). A player who owns the Advanced
// Civilization VASSAL module can load it once; we extract the three map SVGs
// from it entirely in the browser and cache them on this device (IndexedDB).
// Nothing is uploaded and nothing copyrighted is distributed by the app.
import { useEffect, useState } from 'react';

export type MapKey = 'western' | 'main' | 'eastern';
export type MapArt = Record<MapKey, string>; // object-URLs for the three SVGs

const VMOD_PATHS: Record<MapKey, string> = {
  western: 'images/map-western.svg',
  main: 'images/map-main.svg',
  eastern: 'images/map-eastern.svg',
};

// ---- minimal ZIP reader (deflate entries) --------------------------------
// A .vmod is a ZIP. We scan its central directory for the three map entries
// and inflate them with the browser's built-in DecompressionStream — no deps.
async function inflateRaw(comp: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([comp as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function extractFromZip(ab: ArrayBuffer, names: Record<MapKey, string>): Promise<MapArt> {
  const dv = new DataView(ab);
  const u16 = (o: number) => dv.getUint16(o, true);
  const u32 = (o: number) => dv.getUint32(o, true);
  // End of central directory record (scan backwards; no zip comment expected).
  let eo = -1;
  for (let i = ab.byteLength - 22; i >= 0; i--) { if (u32(i) === 0x06054b50) { eo = i; break; } }
  if (eo < 0) throw new Error('not a valid .vmod (no ZIP directory found)');
  const cdOff = u32(eo + 16), cnt = u16(eo + 10);
  const wanted = new Map(Object.entries(names).map(([k, v]) => [v, k as MapKey]));
  const found: Partial<Record<MapKey, { method: number; compSize: number; lo: number }>> = {};
  let p = cdOff;
  for (let i = 0; i < cnt && p + 46 <= ab.byteLength; i++) {
    if (u32(p) !== 0x02014b50) break;
    const method = u16(p + 10), compSize = u32(p + 20);
    const fnLen = u16(p + 28), exLen = u16(p + 30), cmLen = u16(p + 32), lo = u32(p + 42);
    const name = new TextDecoder().decode(new Uint8Array(ab, p + 46, fnLen));
    const key = wanted.get(name);
    if (key) found[key] = { method, compSize, lo };
    p += 46 + fnLen + exLen + cmLen;
  }
  const out: Partial<MapArt> = {};
  for (const key of Object.keys(names) as MapKey[]) {
    const e = found[key];
    if (!e) throw new Error(`${names[key]} not found in the module — is this the Advanced Civilization .vmod?`);
    const lfnLen = u16(e.lo + 26), lexLen = u16(e.lo + 28);
    const dataStart = e.lo + 30 + lfnLen + lexLen;
    const comp = new Uint8Array(ab, dataStart, e.compSize);
    const bytes = e.method === 0 ? comp : await inflateRaw(comp);
    out[key] = new TextDecoder().decode(bytes);
  }
  return out as MapArt; // SVG text, not yet object-URLs
}

// ---- IndexedDB cache ------------------------------------------------------
const DB = 'civ-map-art', STORE = 'svg';
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGetAll(): Promise<Partial<Record<MapKey, string>>> {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly').objectStore(STORE);
    const out: Partial<Record<MapKey, string>> = {};
    const keys: MapKey[] = ['western', 'main', 'eastern'];
    let n = 0;
    for (const k of keys) {
      const g = tx.get(k);
      g.onsuccess = () => { if (typeof g.result === 'string') out[k] = g.result; if (++n === keys.length) res(out); };
      g.onerror = () => rej(g.error);
    }
  });
}
async function idbPutAll(svgs: MapArt): Promise<void> {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const k of Object.keys(svgs) as MapKey[]) store.put(svgs[k], k);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function idbClear(): Promise<void> {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

function toUrls(svgs: MapArt): MapArt {
  const url = (s: string) => URL.createObjectURL(new Blob([s], { type: 'image/svg+xml' }));
  return { western: url(svgs.western), main: url(svgs.main), eastern: url(svgs.eastern) };
}

// ---- React hook -----------------------------------------------------------
export type ArtStatus = 'loading' | 'absent' | 'ready' | 'importing' | 'error';

export function useMapArt() {
  const [art, setArt] = useState<MapArt | null>(null);
  const [status, setStatus] = useState<ArtStatus>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    idbGetAll().then((cached) => {
      if (cancelled) return;
      if (cached.western && cached.main && cached.eastern) {
        setArt(toUrls(cached as MapArt)); setStatus('ready');
      } else setStatus('absent');
    }).catch(() => !cancelled && setStatus('absent'));
    return () => { cancelled = true; };
  }, []);

  async function importVmod(file: File) {
    setStatus('importing'); setError(null);
    try {
      const ab = await file.arrayBuffer();
      const svgs = await extractFromZip(ab, VMOD_PATHS);
      await idbPutAll(svgs);
      setArt((prev) => { if (prev) Object.values(prev).forEach(URL.revokeObjectURL); return toUrls(svgs); });
      setStatus('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }

  async function clearArt() {
    await idbClear();
    setArt((prev) => { if (prev) Object.values(prev).forEach(URL.revokeObjectURL); return null; });
    setStatus('absent');
  }

  return { art, status, error, importVmod, clearArt };
}
