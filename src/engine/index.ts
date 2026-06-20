import { jsonCodec } from 'digital-boardgame-framework';
import { CivAdapter, normalize, victoryScore } from './engine.js';
import { createInitialState, type NewGameOptions } from './setup.js';
import type { GameState } from './types.js';

export * from './types.js';
export { CivAdapter, victoryScore, normalize } from './engine.js';
export { createInitialState } from './setup.js';
export type { NewGameOptions } from './setup.js';

/** Create a ready-to-play, normalized initial state (auto phases advanced to the
 *  first interactive decision). */
export function createGame(opts: NewGameOptions): GameState {
  const s = createInitialState(opts);
  normalize(s);
  return s;
}

export const adapter = new CivAdapter();
export const codec = jsonCodec<GameState>();
