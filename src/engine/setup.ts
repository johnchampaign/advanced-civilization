import { Rng } from 'digital-boardgame-framework';
import {
  calamities as ALL_CALAMITIES,
  civById,
  commodities as ALL_COMMODITIES,
  pieceCounts,
} from '../data/index.js';
import type { GameState, PlayerId, PlayerState, TradeStacks } from './types.js';

export interface NewGameOptions {
  /** Civilization ids to seat, in seating order (2-14). */
  players: PlayerId[];
  seed?: number;
  maxTurns?: number;
}

/** Build the trade-card stacks (rules §15.2). Arrays are bottom→top: cards are
 *  drawn from the END (top, via pop()).
 *
 *  Per §15.2: for each stack 2-9, set aside `numPlayers` commodity cards as a
 *  top buffer (so no calamity can be drawn on the first round), place that
 *  level's calamities (tradable AND non-tradable) directly beneath the buffer,
 *  then the buffer back on top — so a calamity surfaces on the (numPlayers+1)th
 *  draw rather than being buried. The first stack gets no calamity. Resolved or
 *  spent cards later return to the bottom and re-circulate. */
export function buildTradeStacks(rng: Rng, numPlayers: number): TradeStacks {
  const stacks: Record<number, string[]> = {};
  const commodities: Record<number, string[]> = {};
  for (let s = 1; s <= 9; s++) commodities[s] = [];
  for (const c of ALL_COMMODITIES) for (let i = 0; i < c.count; i++) commodities[c.stack]!.push(c.id);

  for (let s = 1; s <= 9; s++) {
    const shuffled = rng.shuffle(commodities[s]!);
    if (s === 1) { stacks[1] = shuffled; continue; } // first stack: no calamity, no buffer
    // §15.2: deal `numPlayers` commodities off the top as a buffer, place the
    // stack's calamities directly beneath it, then the buffer back on top — so
    // the calamity surfaces on the (numPlayers+1)th draw, not buried at the
    // bottom. Both tradable and non-tradable calamities sit in this band.
    const buffer = shuffled.slice(0, numPlayers); // drawn first (kept on top)
    const rest = shuffled.slice(numPlayers);
    const cals = rng.shuffle(ALL_CALAMITIES.filter((c) => c.level === s).map((c) => `calamity:${c.id}`));
    // bottom (index 0) → top (end): rest, calamities, buffer.  pop() draws from
    // the end: buffer first, then the calamities, then the remaining commodities.
    stacks[s] = [...rest, ...cals, ...buffer];
  }
  return { stacks };
}

function newPlayer(id: PlayerId, startArea: string): PlayerState {
  return {
    id,
    stock: pieceCounts.tokens - 1, // one token placed at start
    treasury: 0,
    citiesAvailable: pieceCounts.cities,
    shipsAvailable: pieceCounts.ships,
    census: 1,
    advances: [],
    hand: {},
    calamities: [],
    astSpace: 0,
    epoch: 'stone',
  };
}

export function createInitialState(opts: NewGameOptions): GameState {
  const seed = opts.seed ?? 12345;
  const rng = new Rng(seed);
  if (opts.players.length < 2) throw new Error('need at least 2 players');

  const players: Record<PlayerId, PlayerState> = {};
  const areas: Record<string, ReturnType<typeof emptyArea>> = {};
  const seating = [...opts.players];

  for (const id of seating) {
    const civ = civById.get(id);
    if (!civ) throw new Error(`unknown civilization ${id}`);
    players[id] = newPlayer(id, civ.start);
    // Place one starting token in the civ's start area.
    const a = (areas[civ.start] ??= emptyArea());
    a.tokens[id] = (a.tokens[id] ?? 0) + 1;
  }

  const trade = buildTradeStacks(rng, seating.length);

  return {
    schemaVersion: 1,
    turn: 1,
    phase: 'taxation',
    activeOrder: censusSeed(seating),
    censusOrder: censusSeed(seating),
    actedThisPhase: [],
    players,
    seating,
    areas,
    trade,
    pendingCalamities: [],
    negotiation: { turnPointer: 0, passStreak: 0, actions: 0, nextOfferId: 0, done: [], offers: [], completed: [] },
    calamityTradedFrom: {},
    rngState: rng.serialize(),
    log: [`Game started with ${seating.length} players (seed ${seed}).`],
    ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
  };
}

function emptyArea() {
  return { tokens: {} as Record<PlayerId, number> };
}

// Turn 1 census order is just seating order (everyone has population 1).
function censusSeed(seating: PlayerId[]): PlayerId[] {
  return [...seating];
}
