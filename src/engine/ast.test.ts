import { describe, expect, it } from 'vitest';
import { createGame, normalize } from './index.js';
import { areas, astTrack, astTrackFor } from '../data/index.js';
import type { GameState } from './types.js';

const land = areas.filter((a) => !a.isWater);

/** Build a state poised at the AST-adjustment phase: the test civ sits on
 *  `astSpace` in `epoch` with `cities` (each given 2 support tokens) and the
 *  given advances. normalize() then runs one AST adjustment (and rolls into the
 *  next turn, stopping at movement). */
function astScenario(opts: { astSpace: number; epoch: string; cities: number; advances?: string[]; civ?: string }): GameState {
  const civ = opts.civ ?? 'egypt';
  const s = createGame({ players: [civ, 'babylon'], seed: 1, maxTurns: 9999 });
  s.areas = {};
  let li = 0;
  for (let i = 0; i < opts.cities; i++) s.areas[land[li++]!.id] = { tokens: {}, city: civ };
  for (let i = 0; i < opts.cities * 2; i++) s.areas[land[li++]!.id] = { tokens: { [civ]: 1 } };
  const p = s.players[civ]!;
  p.advances = opts.advances ?? [];
  p.astSpace = opts.astSpace; p.epoch = opts.epoch; p.hand = {}; p.treasury = 0;
  let board = 0, c = 0;
  for (const a of Object.values(s.areas)) { board += a.tokens[civ] ?? 0; if (a.city === civ) c++; }
  p.stock = 55 - board; p.citiesAvailable = 9 - c;
  s.players['babylon']!.hand = {};
  s.phase = 'astAdjustment';
  s.activeOrder = [civ, 'babylon'];
  s.actedThisPhase = [];
  normalize(s);
  return s;
}

describe('AST track (read from the board)', () => {
  it('is a 16-space track worth 100 points each, finishing at 1600', () => {
    expect(astTrack.spaces).toBe(16);
    expect(astTrack.finishSpace).toBe(16);
    expect(astTrack.pointsPerSpace).toBe(100);
  });
  it('has per-civ Late Iron Age thresholds for all 13 nations (from the VASSAL AST strips)', () => {
    const expected: Record<string, number[]> = {
      africa: [1300, 1600], asia: [1200, 1500, 1800], assyria: [1500, 1800], babylon: [1600, 1900],
      crete: [1300, 1600], egypt: [1300, 1600, 1900], iberia: [1200], illyria: [1200, 1500, 1800],
      indus: [1100, 1300], persia: [1200, 1400], semites: [1100, 1300],
      sumeria: [1100, 1300], thrace: [1200, 1400, 1700],
    };
    const gapNations = new Set(['iberia', 'persia', 'sumeria', 'semites', 'indus']); // strips draw EI grey 1 cell short
    for (const [civ, thr] of Object.entries(expected)) {
      expect(astTrackFor(civ).lateIronThresholds, civ).toEqual(thr);
      // Late Iron begins at the end of the Early-Iron grey block; printed values
      // fill the LAST cells (up to space 15, finish = 16). The 5 extended strips
      // leave one leading entry space (5 cities, no points) — the rest none.
      const liaSpaces = 16 - astTrackFor(civ).epochStart['lateIron']!;
      expect(liaSpaces, civ).toBe(thr.length + (gapNations.has(civ) ? 1 : 0));
    }
  });

  it('matches the 1995 computer version where the two sources overlap', () => {
    // Cross-check: Africa/Illyria/Thrace appear on both the computer game's AST
    // screen and the VASSAL strips and agree exactly.
    expect(astTrackFor('africa').lateIronThresholds).toEqual([1300, 1600]);
    expect(astTrackFor('illyria').lateIronThresholds).toEqual([1200, 1500, 1800]);
    expect(astTrackFor('thrace').lateIronThresholds).toEqual([1200, 1400, 1700]);
    // Strip geometry is the ground truth: Iberia uses its OWN strip (lone 1200),
    // not Italy's track, even though the 1995 computer game gives it Italy's.
    expect(astTrackFor('iberia').lateIronThresholds).toEqual([1200]);
  });

  it('has per-civ earlier-epoch boundaries read from the AST strips', () => {
    // The grey blocks place Early Bronze / Late Bronze / Early Iron differently
    // per nation: Egypt develops fast, Thrace/Persia start slower.
    expect(astTrackFor('egypt').epochStart).toEqual({ stone: 1, earlyBronze: 4, lateBronze: 7, earlyIron: 10, lateIron: 13 });
    expect(astTrackFor('thrace').epochStart).toEqual({ stone: 1, earlyBronze: 6, lateBronze: 9, earlyIron: 11, lateIron: 13 });
    expect(astTrackFor('crete').epochStart).toEqual({ stone: 1, earlyBronze: 5, lateBronze: 9, earlyIron: 11, lateIron: 14 });
  });
});

describe('AST advancement & epoch gating (§33)', () => {
  it('advances freely through the Stone Age (no requirements)', () => {
    const s = astScenario({ astSpace: 0, epoch: 'stone', cities: 0 });
    expect(s.players['egypt']!.astSpace).toBe(1);
  });

  it('freezes at the Early Bronze Age boundary without 2 cities', () => {
    const s = astScenario({ astSpace: 3, epoch: 'stone', cities: 0 });
    expect(s.players['egypt']!.astSpace).toBe(3); // frozen
  });

  it('enters the Early Bronze Age with 2 cities', () => {
    const s = astScenario({ astSpace: 3, epoch: 'stone', cities: 2 });
    expect(s.players['egypt']!.astSpace).toBe(4);
    expect(s.players['egypt']!.epoch).toBe('earlyBronze');
  });

  it('Late Iron Age entry needs civ-card value >= the space point value (§33.25)', () => {
    // Egypt's Late Iron Age begins at space 13; entering it needs 1300 card points.
    const lowValue = ['pottery', 'clothmaking']; // ~90 face value
    const frozen = astScenario({ astSpace: 12, epoch: 'earlyIron', cities: 5, advances: lowValue });
    expect(frozen.players['egypt']!.astSpace).toBe(12); // frozen — not enough card value

    const richValue = ['theology', 'monotheism', 'philosophy', 'democracy', 'law', 'military', 'enlightenment']; // 1410
    const moved = astScenario({ astSpace: 12, epoch: 'earlyIron', cities: 5, advances: richValue });
    expect(moved.players['egypt']!.astSpace).toBe(13);
    expect(moved.players['egypt']!.epoch).toBe('lateIron');
  });

  it('a gap nation (Persia) enters Late Iron on cities alone; later spaces gate on points', () => {
    // Persia's Early Iron is one space shorter than the base nations; its Late Iron
    // Age begins at space 13 with a leading entry space needing only 5 cities, then
    // 1200 at space 14 and 1400 at space 15 (the strip's two printed values).
    const entry = astScenario({ civ: 'persia', astSpace: 12, epoch: 'earlyIron', cities: 5, advances: ['pottery'] });
    expect(entry.players['persia']!.astSpace).toBe(13); // entered Late Iron on 5 cities, no card value
    expect(entry.players['persia']!.epoch).toBe('lateIron');
    const frozen = astScenario({ civ: 'persia', astSpace: 13, epoch: 'lateIron', cities: 5, advances: ['pottery'] });
    expect(frozen.players['persia']!.astSpace).toBe(13); // space 14 needs 1200 — frozen
    const rich = astScenario({ civ: 'persia', astSpace: 13, epoch: 'lateIron', cities: 5, advances: ['theology', 'monotheism', 'philosophy', 'democracy', 'law', 'military', 'enlightenment'] });
    expect(rich.players['persia']!.astSpace).toBe(14); // 1410 ≥ 1200
  });

  it('ends the game at the finish square (space 16), which carries no card threshold', () => {
    // Egypt's numbered Late Iron Age spaces (13-15) gate on cards; the finish (16)
    // just needs the 5-city Late Iron Age requirement.
    const s = astScenario({ astSpace: 15, epoch: 'lateIron', cities: 5, advances: ['pottery'] });
    expect(s.players['egypt']!.astSpace).toBe(16);
    expect(s.finished).toBe(true);
  });

  it('slides a city-less nation back one space (§33.4)', () => {
    const s = astScenario({ astSpace: 5, epoch: 'earlyBronze', cities: 0 });
    expect(s.players['egypt']!.astSpace).toBe(4); // slid back
  });
});
