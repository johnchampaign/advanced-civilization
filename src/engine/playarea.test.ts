// Rules §16 — THE NUMBER OF PLAYERS: board configurations, play areas, token
// counts and nation availability.
import { describe, expect, it } from 'vitest';
import { adapter, createGame } from './index.js';
import { adjacency, areaById, civById, playAreas } from '../data/index.js';
import {
  availableNations,
  boardPresets,
  outOfPlaySet,
  startAreasFor,
  type BoardConfig,
} from './boards.js';
import { inPlay, neighbors, pieceConservationProblems } from './helpers.js';
import { HeuristicAI } from '../ai/heuristic.js';
import { Rng } from 'digital-boardgame-framework';
import type { GameState } from './types.js';

const sorted = (xs: string[]) => [...xs].sort();

describe('§16 board presets', () => {
  it('gives each player count its rules token count (§16.2-16.8)', () => {
    const expected: Record<number, number> = { 2: 55, 3: 47, 4: 55, 5: 47, 6: 55, 7: 55, 8: 47 };
    for (const [n, tokens] of Object.entries(expected)) {
      const presets = boardPresets(Number(n)).filter((b) => b.rule !== 'house');
      expect(presets.length).toBeGreaterThan(0);
      for (const b of presets) expect(b.tokensPerPlayer).toBe(tokens);
    }
  });

  it('reproduces the §16 nation lists', () => {
    const at = (n: number, id: string) => availableNations(boardPresets(n).find((b) => b.id === id)!.config);
    expect(sorted(at(2, 'raw-2p'))).toEqual(sorted(['italy', 'africa', 'illyria', 'thrace'])); // §16.8
    expect(sorted(at(3, 'raw-3p'))).toEqual(sorted(['italy', 'africa', 'illyria', 'thrace', 'crete'])); // §16.7
    expect(sorted(at(4, 'raw-4p-east'))).toEqual(sorted(['egypt', 'babylon', 'assyria', 'asia'])); // §16.6
    // §16.6 west scenario: the extension's rules field Iberia as the red
    // player-race in place of the "Italy" §16.6 prints.
    expect(sorted(at(4, 'raw-4p-west'))).toEqual(sorted(['iberia', 'africa', 'illyria', 'thrace', 'crete'])); // §16.6
  });

  it('fields Iberia in place of Italy whenever the Western Extension is in play', () => {
    // "Iberia now starts from any of the three areas on the western edge of
    // the peninsula (replacing Italy as a player-race)" — West Extension Map
    // rules. One red race: never both in a game, under any configuration.
    for (let n = 2; n <= 8; n++) {
      for (const preset of boardPresets(n)) {
        const nations = availableNations(preset.config);
        expect(nations.includes('italy') && nations.includes('iberia'), `${preset.id} (${n}p) fields both`).toBe(false);
        if (preset.config.west) expect(nations, `${preset.id} (${n}p)`).not.toContain('italy');
      }
    }
    const withExt = availableNations({ west: true, east: false, crops: [] });
    const withoutExt = availableNations({ west: false, east: false, crops: [] });
    expect(withExt).toContain('iberia');
    expect(withExt).not.toContain('italy');
    expect(withoutExt).toContain('italy');
    expect(withoutExt).not.toContain('iberia');
    // And setup enforces it.
    expect(() => createGame({ players: ['italy', 'iberia', 'africa'], board: { west: true, east: false, crops: [] }, seed: 1 })).toThrow(/not available/);
  });

  it('keeps every preset board one connected component', () => {
    for (let n = 2; n <= 8; n++) {
      for (const preset of boardPresets(n)) {
        const out = outOfPlaySet(preset.config);
        const all = [...areaById.keys()].filter((id) => !out.has(id));
        const seen = new Set<string>([all[0]!]);
        const stack = [all[0]!];
        while (stack.length) {
          const x = stack.pop()!;
          for (const nb of adjacency[x] ?? []) if (!out.has(nb) && !seen.has(nb)) { seen.add(nb); stack.push(nb); }
        }
        expect(seen.size, `${preset.id} (${n}p) splits the board`).toBe(all.length);
      }
    }
  });

  it('leaves enough selectable nations for the player count', () => {
    for (let n = 2; n <= 8; n++) {
      for (const preset of boardPresets(n)) {
        expect(availableNations(preset.config).length, `${preset.id} (${n}p)`).toBeGreaterThanOrEqual(n);
      }
    }
  });
});

describe('§16 game setup', () => {
  it('seats rules-legal nations with the preset token count and rejects others', () => {
    const s = createGame({ players: ['italy', 'africa', 'crete'], boardPreset: 'raw-3p', seed: 7 });
    expect(s.tokensPerPlayer).toBe(47);
    expect(s.board?.crops).toEqual(['eastOfDotted']);
    expect(pieceConservationProblems(s, { tokens: 47, cities: 9, ships: 4 })).toEqual([]);
    // Egypt's starts are east of the dotted line — not selectable (§16.12/§16.7).
    expect(() => createGame({ players: ['italy', 'egypt', 'crete'], boardPreset: 'raw-3p', seed: 7 })).toThrow(/not available/);
    // Crete is not one of §16.8's four two-player nations.
    expect(() => createGame({ players: ['italy', 'crete'], boardPreset: 'raw-2p', seed: 7 })).toThrow(/not available/);
  });

  it('defaults to the full stitched map when no preset is named (back-compat)', () => {
    const s = createGame({ players: ['egypt', 'babylon'], seed: 1 });
    expect(s.tokensPerPlayer).toBe(55);
    expect(s.board).toEqual({ west: true, east: true, crops: [] });
    expect(inPlay(s, 'nisa')).toBe(true); // eastern extension in play
  });

  it('starts a nation at its alternate start when a crop removes the normal one (§16.12)', () => {
    // Panels 1+2 out with the Western Extension: Africa's main-board starts are
    // gone but the module gives it Cirta on the western board.
    const board: BoardConfig = { west: true, east: false, crops: ['panel12'] };
    expect(startAreasFor(board, 'africa')).toEqual(['cirta']);
    const s = createGame({ players: ['africa', 'iberia'], board, tokensPerPlayer: 47, seed: 3 });
    expect(s.areas['cirta']!.tokens['africa']).toBeGreaterThanOrEqual(1); // grown by turn-1 expansion
    // Italy has no start outside the main board's panel 1 — not selectable here.
    expect(availableNations(board)).not.toContain('italy');
  });
});

describe('§16 play-area enforcement', () => {
  /** A 3-player rules game (board west of the dotted line). */
  const game = () => createGame({ players: ['italy', 'africa', 'thrace'], boardPreset: 'raw-3p', seed: 11 });

  it('treats out-of-play areas as nonexistent for adjacency', () => {
    const s = game();
    const out = outOfPlaySet(s.board!);
    for (const id of [...areaById.keys()].filter((x) => !out.has(x))) {
      for (const nb of neighbors(s, id)) expect(out.has(nb), `${id} -> ${nb} crosses the board edge`).toBe(false);
    }
    expect(neighbors(s, 'jerusalem')).toEqual([]); // out-of-play area has no edges
  });

  it('rejects a move into an out-of-play area', () => {
    const s = game();
    // Knossos (in play) is adjacent on the full map to Kydonia?? — instead find
    // any in-play land area with a full-map neighbour that is out of play.
    const out = outOfPlaySet(s.board!);
    let from = '', to = '';
    for (const id of Object.keys(adjacency)) {
      if (out.has(id) || areaById.get(id)!.isWater) continue;
      const cross = (adjacency[id] ?? []).find((n) => out.has(n) && !areaById.get(n)!.isWater);
      if (cross) { from = id; to = cross; break; }
    }
    expect(from).not.toBe('');
    s.phase = 'movement';
    s.activeOrder = [...s.seating];
    s.actedThisPhase = [];
    (s.areas[from] ??= { tokens: {} }).tokens['italy'] = 2;
    s.players['italy']!.stock -= 2;
    expect(() => adapter.applyAction(s, { type: 'move', moves: [{ from, to, count: 1 }] }, 'italy')).toThrow(/not reachable/);
  });

  it('never offers an out-of-play destination in legalActions', () => {
    const s = game();
    const out = outOfPlaySet(s.board!);
    s.phase = 'movement';
    s.activeOrder = [...s.seating];
    s.actedThisPhase = [];
    const actor = adapter.currentActor(s)!;
    for (const a of adapter.legalActions(s, actor)) {
      if (a.type !== 'move') continue;
      for (const m of a.moves) expect(out.has(m.to), `${m.from}->${m.to}`).toBe(false);
    }
  });
});

describe('§16.8 island city sites (two players)', () => {
  const setupBuild = (s: GameState, area: string, tokens: number) => {
    s.phase = 'cityConstruction';
    s.activeOrder = [...s.seating];
    s.actedThisPhase = [];
    (s.areas[area] ??= { tokens: {} }).tokens['italy'] = tokens;
    s.players['italy']!.stock -= tokens;
  };

  it('disregards island sites — 12 tokens build there, and 6 do not', () => {
    expect(playAreas.islandCitySites).toContain('knossos');
    const s = createGame({ players: ['italy', 'africa'], boardPreset: 'raw-2p', seed: 5 });
    setupBuild(s, 'knossos', 6);
    expect(() => adapter.applyAction(s, { type: 'buildCity', area: 'knossos' }, 'italy')).toThrow(/12 tokens/);
    const s2 = createGame({ players: ['italy', 'africa'], boardPreset: 'raw-2p', seed: 5 });
    setupBuild(s2, 'knossos', 12);
    const out = adapter.applyAction(s2, { type: 'buildCity', area: 'knossos' }, 'italy');
    expect(out.areas['knossos']!.city).toBe('italy');
  });

  it('keeps island sites normal in a 3-player game (§16.7)', () => {
    const s = createGame({ players: ['italy', 'africa', 'crete'], boardPreset: 'raw-3p', seed: 5 });
    setupBuild(s, 'knossos', 6);
    const out = adapter.applyAction(s, { type: 'buildCity', area: 'knossos' }, 'italy');
    expect(out.areas['knossos']!.city).toBe('italy');
  });
});

describe('§16 full game', () => {
  it('a 2-player rules game plays to completion with conserved pieces', async () => {
    let s = createGame({ players: ['italy', 'thrace'], boardPreset: 'raw-2p', seed: 42, maxTurns: 8 });
    const ai = new HeuristicAI();
    const rng = new Rng(42);
    const out = outOfPlaySet(s.board!);
    let guard = 0;
    while (!adapter.result(s) && guard++ < 4000) {
      const actor = adapter.currentActor(s);
      if (!actor) break;
      const action = await ai.selectAction({ state: s, actor, adapter, rng });
      s = adapter.applyAction(s, action, actor);
      // No unit may ever appear out of play.
      for (const [aid, a] of Object.entries(s.areas)) {
        const occupied = Object.values(a.tokens).some((n) => n > 0) || a.city || Object.values(a.ships ?? {}).some((n) => n > 0);
        if (occupied) expect(out.has(aid), `units in out-of-play ${aid}`).toBe(false);
      }
      expect(pieceConservationProblems(s, { tokens: 55, cities: 9, ships: 4 })).toEqual([]);
    }
    expect(adapter.result(s)).not.toBeNull();
  }, 30000);
});
