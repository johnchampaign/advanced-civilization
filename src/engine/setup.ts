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

/** Build the trade-card stacks (rules §15.2): each commodity goes into its
 *  stack; each tradable calamity is shuffled into the commodity stack of its
 *  level. Non-tradable calamities are NOT in the stacks here — they are added to
 *  the draw during the acquisition phase as the rules direct, but for the
 *  digital model. Arrays are bottom→top: cards are drawn from the END (top).
 *
 *  Per §15.2: for each stack 2-9, set aside `numPlayers` commodity cards as a
 *  top buffer (so no calamity is drawn until play is underway), shuffle the
 *  tradable calamity of that value into the rest, put the buffer back on top,
 *  and place the non-tradable calamity at the very bottom. The first stack gets
 *  no calamity. */
export function buildTradeStacks(rng: Rng, numPlayers: number): TradeStacks {
  const stacks: Record<number, string[]> = {};
  const commodities: Record<number, string[]> = {};
  for (let s = 1; s <= 9; s++) commodities[s] = [];
  for (const c of ALL_COMMODITIES) for (let i = 0; i < c.count; i++) commodities[c.stack]!.push(c.id);

  for (let s = 1; s <= 9; s++) {
    const shuffled = rng.shuffle(commodities[s]!);
    if (s === 1) { stacks[1] = shuffled; continue; } // first stack: no calamity, no buffer
    const buffer = shuffled.slice(0, numPlayers); // drawn first (kept on top)
    const rest = shuffled.slice(numPlayers);
    const tradable = ALL_CALAMITIES.filter((c) => c.tradable && c.level === s).map((c) => `calamity:${c.id}`);
    const middle = rng.shuffle([...rest, ...tradable]);
    const nonTradable = ALL_CALAMITIES.filter((c) => !c.tradable && c.level === s).map((c) => `calamity:${c.id}`);
    // bottom (index 0) → top (end): non-tradable, middle (with tradable), buffer.
    stacks[s] = [...nonTradable, ...middle, ...buffer];
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
    actedThisPhase: [],
    players,
    seating,
    areas,
    trade,
    pendingCalamities: [],
    negotiation: { turnPointer: 0, passStreak: 0, actions: 0, nextOfferId: 0, offers: [], completed: [] },
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
