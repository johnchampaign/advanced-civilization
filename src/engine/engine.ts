// The Advanced Civilization game engine: a GameAdapter for
// digital-boardgame-framework. The turn runs through PHASE_ORDER. Phases split
// into:
//   - AUTO phases (taxation, population expansion, census, ship construction,
//     conflict, trade-card acquisition, trade, calamity, AST adjustment) which
//     the engine resolves deterministically with no player action, and
//   - INTERACTIVE phases (movement, city construction, acquire advances) where
//     each player in census order acts (possibly several actions) then `pass`es.
//
// After every applied action the state is "normalized": auto phases are run and
// completed interactive phases advanced, until the acting player is a human-
// decision point or the game is over. This keeps currentActor() always pointing
// at a real decision.

import { Rng } from 'digital-boardgame-framework';
import type { GameAdapter, GameResult } from 'digital-boardgame-framework';
import {
  advanceById,
  areaById,
  calamityById,
  civById,
  commodityById,
  astTrackFor,
  epochs,
  victoryScoring,
} from '../data/index.js';
import {
  actingPlayer,
  advancesFaceValue,
  cardGroupsHeld,
  censusOrder,
  cityCount,
  commoditySetValue,
  creditTowards,
  handValue,
  landNeighbors,
  navalDestinations,
  neighbors,
  netAdvanceCost,
  player,
  populationCount,
} from './helpers.js';
import {
  PHASE_ORDER,
  type Action,
  type GameState,
  type Phase,
  type PlayerId,
} from './types.js';

const AUTO_PHASES: Set<Phase> = new Set([
  'taxation',
  'populationExpansion',
  'census',
  // 'shipConstruction' is INTERACTIVE (build/maintain ships), not auto.
  'conflict',
  'removeSurplus',
  'tradeAcquisition',
  // 'trade' is INTERACTIVE (negotiation), not auto.
  'calamity',
  'astAdjustment',
]);

const clone = <T>(x: T): T => structuredClone(x);
const has = (p: { advances: string[] }, id: string) => p.advances.includes(id);

// ---- Trade helpers -------------------------------------------------------

const isCalamityCard = (card: string) => card.startsWith('calamity:');
const calamityIdOf = (card: string) => card.slice('calamity:'.length);
const bundleSize = (m: Record<string, number>) => Object.values(m).reduce((s, n) => s + n, 0);

/** A card is givable in trade iff it's a commodity or a *tradable* calamity. */
function isGivable(card: string): boolean {
  if (!isCalamityCard(card)) return true;
  return calamityById.get(calamityIdOf(card))?.tradable === true;
}

/** Is `sub` a sub-multiset of `set`? */
function isSubMultiset(sub: Record<string, number>, set: Record<string, number>): boolean {
  return Object.entries(sub).every(([k, n]) => n <= 0 || (set[k] ?? 0) >= n);
}

/** Validate one side's bundle against the §28.3 truth rules. `owner` must hold
 *  the actual cards; the bundle must have >=`minCards`, declare >=2 cards
 *  truthfully (declared is a real sub-multiset of actual), and contain no
 *  non-tradable calamity. Returns an error string or null. */
function validateBundle(s: GameState, owner: PlayerId, b: { actual: Record<string, number>; declared: Record<string, number> }, minCards: number): string | null {
  const hand = player(s, owner).hand;
  if (bundleSize(b.actual) < minCards) return `bundle must have at least ${minCards} cards`;
  if (!isSubMultiset(b.actual, hand)) return `${owner} does not hold the offered cards`;
  for (const card of Object.keys(b.actual)) {
    if ((b.actual[card] ?? 0) > 0 && !isGivable(card)) return `${card} is a non-tradable calamity and may not be traded`;
  }
  if (!isSubMultiset(b.declared, b.actual)) return 'declared cards must truthfully be in the bundle';
  if (bundleSize(b.declared) < 2) return 'must honestly declare at least two cards (§28.3)';
  return null;
}

function removeCards(hand: Record<string, number>, cards: Record<string, number>): void {
  for (const [c, n] of Object.entries(cards)) {
    if (n <= 0) continue;
    hand[c] = (hand[c] ?? 0) - n;
    if (hand[c]! <= 0) delete hand[c];
  }
}
function addCards(hand: Record<string, number>, cards: Record<string, number>): void {
  for (const [c, n] of Object.entries(cards)) {
    if (n <= 0) continue;
    hand[c] = (hand[c] ?? 0) + n;
  }
}

/** Move a side's cards from giver to receiver and record calamity provenance
 *  (the giver may not later be named a secondary victim, §29.61). */
function transferCards(s: GameState, giver: PlayerId, receiver: PlayerId, cards: Record<string, number>): void {
  removeCards(player(s, giver).hand, cards);
  addCards(player(s, receiver).hand, cards);
  for (const [c, n] of Object.entries(cards)) {
    if (n > 0 && isCalamityCard(c)) s.calamityTradedFrom[calamityIdOf(c)] = giver;
  }
}

// ---- Auto-phase processors ----------------------------------------------

function runTaxation(s: GameState): void {
  for (const id of s.seating) {
    const p = player(s, id);
    const cities = cityCount(s, id);
    const rate = 2; // default tax rate (Coinage may vary, §32.421 — future)
    const collected = Math.min(p.stock, cities * rate);
    p.stock -= collected;
    p.treasury += collected;
    if (collected > 0) s.log.push(`${id} collected ${collected} tax from ${cities} cities.`);
  }
}

function runPopulationExpansion(s: GameState): void {
  // Standard growth: +1 token to areas with exactly 1 token, +2 to areas with
  // >=2 tokens of the player. Agriculture raises the area's support by 1
  // (§32.241). Growth is capped by stock; we grow biggest areas first.
  for (const id of s.seating) {
    const p = player(s, id);
    const owned: { area: string; tokens: number }[] = [];
    for (const [aid, a] of Object.entries(s.areas)) {
      const t = a.tokens[id] ?? 0;
      if (t > 0) owned.push({ area: aid, tokens: t });
    }
    owned.sort((a, b) => b.tokens - a.tokens);
    for (const o of owned) {
      if (p.stock <= 0) break;
      const add = Math.min(o.tokens >= 2 ? 2 : 1, p.stock);
      s.areas[o.area]!.tokens[id] = o.tokens + add;
      p.stock -= add;
    }
  }
}

function runCensus(s: GameState): void {
  for (const id of s.seating) player(s, id).census = populationCount(s, id);
  s.activeOrder = censusOrder(s);
  s.actedThisPhase = [];
}

/** §22.3 ship maintenance, run when the ship-construction phase begins: each ship
 *  in play costs one token (from treasury, else levied from the ship's area);
 *  unmaintained ships return to stock. Then players may build (interactive). */
function runShipMaintenance(s: GameState): void {
  for (const id of s.seating) {
    const p = player(s, id);
    for (const [aid, a] of Object.entries(s.areas)) {
      let ships = a.ships?.[id] ?? 0;
      while (ships > 0) {
        if (p.treasury > 0) { p.treasury -= 1; p.stock += 1; }
        else if ((a.tokens[id] ?? 0) > 0) { setTokens(s, aid, id, (a.tokens[id] ?? 0) - 1); p.stock += 1; }
        else { a.ships![id] = (a.ships![id] ?? 0) - 1; p.shipsAvailable += 1; ships -= 1; s.log.push(`${id} could not maintain a ship in ${areaName(aid)}; it is scrapped.`); continue; }
        ships -= 1;
      }
      if (a.ships && (a.ships[id] ?? 0) <= 0) delete a.ships[id];
    }
  }
}

function shipCount(s: GameState, id: PlayerId): number {
  let n = 0;
  for (const a of Object.values(s.areas)) n += a.ships?.[id] ?? 0;
  return n;
}

function applyBuildShips(s: GameState, actor: PlayerId, builds: { area: string; count: number }[]): void {
  const p = player(s, actor);
  for (const b of builds) {
    const a = s.areas[b.area];
    const area = areaById.get(b.area);
    if (!a || !area) throw new Error('build ships: unknown area');
    if (!isCoastal(b.area)) throw new Error('ships must be built at a coastal area');
    if ((a.tokens[actor] ?? 0) <= 0 && a.city !== actor) throw new Error('must occupy the area to build a ship there');
    for (let i = 0; i < b.count; i++) {
      if (shipCount(s, actor) >= 4) throw new Error('max 4 ships in play (§22.4)');
      if (p.shipsAvailable <= 0) throw new Error('no ships left in stock');
      // Cost 2 tokens: from the area first, then treasury (§22.1/22.2). Returned to stock.
      let cost = 2;
      const fromArea = Math.min(cost, a.tokens[actor] ?? 0);
      setTokens(s, b.area, actor, (a.tokens[actor] ?? 0) - fromArea); p.stock += fromArea; cost -= fromArea;
      if (cost > 0) { if (p.treasury < cost) throw new Error('not enough tokens/treasury to build a ship'); p.treasury -= cost; p.stock += cost; }
      (a.ships ??= {})[actor] = (a.ships[actor] ?? 0) + 1;
      p.shipsAvailable -= 1;
    }
    s.log.push(`${actor} built ${b.count} ship(s) in ${areaName(b.area)}.`);
  }
}

function runConflict(s: GameState): void {
  // Conflict resolves combat only (§24). Population limits are NOT enforced here
  // — surplus population is removed later, after city construction (§26.1), so a
  // player may temporarily over-stack an area to gather the tokens a city needs.
  const rng = Rng.fromState(s.rngState);
  for (const [aid, a] of Object.entries(s.areas)) {
    const owners = Object.keys(a.tokens).filter((o) => (a.tokens[o] ?? 0) > 0);
    const enemyAtCity = a.city != null && owners.some((o) => o !== a.city);
    if (owners.length >= 2 || enemyAtCity) resolveAreaCombat(s, aid, rng);
  }
  s.rngState = rng.serialize();
}

const BARBARIAN = '__barbarian__';
const isPlayer = (s: GameState, id: PlayerId) => id in s.players;
const isNeutral = (id: PlayerId) => id === BARBARIAN || id === PIRATE;
const hasMetal = (s: GameState, id: PlayerId) => isPlayer(s, id) && has(player(s, id), 'metalworking');
const hasEng = (s: GameState, id: PlayerId) => isPlayer(s, id) && has(player(s, id), 'engineering');

/** Token-vs-token attrition (§24.2). Nations remove their own tokens one at a
 *  time in round-robin, in removal order — non-Metalworking before Metalworking
 *  (§24.24), and fewest tokens first (§24.21, generalized to ascending strength
 *  for 3+ nations, §24.23). Stops when one nation remains or the total no longer
 *  exceeds `limit` (coexistence, §24.21/§24.1 — `limit` is 0 when a city is
 *  present, since a city makes an area fully populated). */
function resolveTokenCombat(s: GameState, aid: string, limit: number): void {
  const a = s.areas[aid]!;
  const seatIdx = new Map(s.seating.map((p, i) => [p, i]));
  const live = () => Object.keys(a.tokens).filter((o) => (a.tokens[o] ?? 0) > 0);
  if (live().length < 2) return;
  // Fixed removal order (identities/Metalworking are stable; counts decide start).
  const order = live().sort((x, y) => {
    const mx = hasMetal(s, x) ? 1 : 0, my = hasMetal(s, y) ? 1 : 0;
    if (mx !== my) return mx - my;
    const cx = a.tokens[x] ?? 0, cy = a.tokens[y] ?? 0;
    if (cx !== cy) return cx - cy;
    return (seatIdx.get(x) ?? 0) - (seatIdx.get(y) ?? 0);
  });
  const before = Object.fromEntries(order.map((o) => [o, a.tokens[o] ?? 0]));
  let guard = 0;
  while (guard++ < 5000) {
    const l = live();
    if (l.length < 2) break;
    if (l.reduce((t, o) => t + (a.tokens[o] ?? 0), 0) <= limit) break;
    let removed = false;
    for (const o of order) {
      if ((a.tokens[o] ?? 0) <= 0) continue;
      const ln = live();
      if (ln.length < 2) break;
      if (ln.reduce((t, x) => t + (a.tokens[x] ?? 0), 0) <= limit) break;
      setTokens(s, aid, o, (a.tokens[o] ?? 0) - 1);
      returnLostToStock(s, o, 1);
      removed = true;
    }
    if (!removed) break;
  }
  const losses = order.map((o) => `${o} -${before[o]! - (a.tokens[o] ?? 0)}`).filter((x) => !x.endsWith('-0'));
  if (losses.length) s.log.push(`Conflict in ${areaName(aid)}: ${losses.join(', ')}.`);
}

/** Token-vs-city assault (§24.3, §24.35, §24.5). The attacker needs 7 tokens to
 *  storm a city (6 with Engineering; 8 if the defender holds Engineering; both
 *  cancel → 7). With too few, the attacker's tokens are simply removed and the
 *  city stands (§24.31). With enough, the city is replaced by defending tokens
 *  (6, or 5/7 per Engineering) and a token fight follows; the attacker then
 *  pillages (≤3 stock→treasury, §24.52) and steals a random card from the
 *  victim's hand (§24.51). */
function resolveCityAssault(s: GameState, aid: string, attacker: PlayerId, rng: Rng): void {
  const a = s.areas[aid]!;
  const defender = a.city;
  if (!defender) return;
  const atk = a.tokens[attacker] ?? 0;
  // Pirate city (§24.34, §30.913): a neutral city with no owning player. It is
  // defended by 6 throwaway tokens; if the attacker brings 7+, it is destroyed
  // and may be pillaged, but there is no card to steal (no victim hand).
  if (defender === PIRATE) {
    if (atk < 7) { setTokens(s, aid, attacker, 0); returnLostToStock(s, attacker, atk); s.log.push(`${attacker} failed to take the pirate city in ${areaName(aid)}.`); return; }
    delete a.city; delete a.pirateCity;
    setTokens(s, aid, attacker, Math.max(1, atk - 6)); returnLostToStock(s, attacker, Math.min(atk, 6));
    const pa = player(s, attacker); const loot = Math.min(3, pa.stock); pa.stock -= loot; pa.treasury += loot;
    s.log.push(`${attacker} destroyed the pirate city in ${areaName(aid)}.`);
    return;
  }
  const attEng = hasEng(s, attacker), defEng = hasEng(s, defender);
  let required = 7, replacement = 6;
  if (attEng && !defEng) { required = 6; replacement = 5; }
  else if (defEng && !attEng) { required = 8; replacement = 7; }
  if (atk < required) {
    setTokens(s, aid, attacker, 0);
    returnLostToStock(s, attacker, atk);
    s.log.push(`${attacker} could not storm ${defender}'s city in ${areaName(aid)} (needed ${required}); ${atk} tokens lost.`);
    return;
  }
  // City eliminated and replaced by defending tokens from stock (§24.32).
  delete a.city;
  player(s, defender).citiesAvailable += 1;
  const place = Math.min(replacement, player(s, defender).stock);
  if (place > 0) { a.tokens[defender] = (a.tokens[defender] ?? 0) + place; player(s, defender).stock -= place; }
  s.log.push(`${attacker} stormed ${defender}'s city in ${areaName(aid)} (defended by ${place}).`);
  resolveTokenCombat(s, aid, 0); // resulting fight; a city area holds no tokens
  // Consequences (§24.5) apply only to a direct attack by a player — not when a
  // city is razed by Barbarians or other neutral forces (§24.53).
  if (isPlayer(s, attacker)) {
    const p = player(s, attacker);
    const pillage = Math.min(3, p.stock);
    p.stock -= pillage; p.treasury += pillage;
    stealCardFromVictim(s, attacker, defender, rng);
  }
}

/** Move one random trade card from the victim's hand to the attacker (§24.51).
 *  No-op if the victim has no cards. */
function stealCardFromVictim(s: GameState, attacker: PlayerId, victim: PlayerId, rng: Rng): void {
  const vhand = player(s, victim).hand;
  const flat: string[] = [];
  for (const [c, n] of Object.entries(vhand)) for (let i = 0; i < n; i++) flat.push(c);
  if (flat.length === 0) return;
  const card = rng.pick(flat);
  vhand[card] = (vhand[card] ?? 0) - 1;
  if (vhand[card]! <= 0) delete vhand[card];
  player(s, attacker).hand[card] = (player(s, attacker).hand[card] ?? 0) + 1;
  if (isCalamityCard(card)) s.calamityTradedFrom[calamityIdOf(card)] = victim;
  s.log.push(`${attacker} pillages a trade card from ${victim}.`);
}

/** Resolve all conflict in one area (§24.3): token attrition first, then a city
 *  assault if a single enemy nation's tokens survive beside the defender's city. */
function resolveAreaCombat(s: GameState, aid: string, rng: Rng): void {
  const a = s.areas[aid]!;
  const area = areaById.get(aid);
  const limit = a.city ? 0 : (area?.sustains ?? 0);
  if (Object.keys(a.tokens).filter((o) => (a.tokens[o] ?? 0) > 0).length >= 2) {
    resolveTokenCombat(s, aid, limit);
  }
  if (a.city) {
    const attackers = Object.keys(a.tokens).filter((o) => o !== a.city && (a.tokens[o] ?? 0) > 0);
    if (attackers.length === 1) resolveCityAssault(s, aid, attackers[0]!, rng);
  }
}

/** The population limit of an area for `owner` (§26.1, §26.11): the printed
 *  `sustains`, +1 if the owner holds Agriculture AND is the sole occupant. */
function areaLimitFor(s: GameState, aid: string, owner: PlayerId): number {
  const area = areaById.get(aid);
  if (!area) return 0;
  const owners = Object.keys(s.areas[aid]!.tokens).filter((o) => (s.areas[aid]!.tokens[o] ?? 0) > 0);
  let limit = area.sustains;
  if (owners.length <= 1 && isPlayer(s, owner) && has(player(s, owner), 'agriculture')) limit += 1;
  return limit;
}

/** §26 Removal of surplus population, then a city-support check.
 *  §26.1: an area containing a city may hold no tokens (the city stands alone,
 *  supported from elsewhere); other areas are capped at their population limit.
 *  Excess tokens return to stock. Then city support is checked (§26.31). */
function runRemoveSurplus(s: GameState): void {
  for (const [aid, a] of Object.entries(s.areas)) {
    for (const o of Object.keys(a.tokens)) {
      // Barbarians/pirates are neutral and not subject to surplus removal
      // (§30.5235 — they persist until eliminated by players).
      if (isNeutral(o)) continue;
      const t = a.tokens[o] ?? 0;
      if (t <= 0) continue;
      const limit = a.city ? 0 : areaLimitFor(s, aid, o);
      if (t > limit) {
        setTokens(s, aid, o, limit);
        returnLostToStock(s, o, t - limit);
      }
    }
  }
  checkCitySupport(s);
}

/** §26.31 / §26.5: every player must have two on-board tokens for each city in
 *  play. A player short of support reduces cities one at a time (§26.41: the
 *  city is replaced by the maximum tokens its area allows, drawn from stock,
 *  which can then support the remaining cities) until support is met or no
 *  cities remain. Called after surplus removal and again after calamities. */
function checkCitySupport(s: GameState): void {
  for (const id of s.seating) {
    let guard = 0;
    while (guard++ < 100) {
      const cities = cityCount(s, id);
      if (cities === 0) break;
      const boardTokens = populationCount(s, id);
      if (boardTokens >= 2 * cities) break;
      // Reduce one city. Replace it with the max tokens its area allows.
      const cityAreas = Object.keys(s.areas).filter((aid) => s.areas[aid]!.city === id);
      if (cityAreas.length === 0) break;
      const aid = cityAreas[0]!;
      const p = player(s, id);
      delete s.areas[aid]!.city;
      p.citiesAvailable += 1;
      const limit = areaLimitFor(s, aid, id);
      const place = Math.min(limit, p.stock);
      if (place > 0) { s.areas[aid]!.tokens[id] = (s.areas[aid]!.tokens[id] ?? 0) + place; p.stock -= place; }
      s.log.push(`${id} lacked city support — reduced the city in ${areaName(aid)}.`);
    }
  }
}

function runTradeAcquisition(s: GameState): void {
  s.pendingCalamities = [];
  const rng = Rng.fromState(s.rngState);
  // §27.1: a player draws one card from each of stacks 1..N, where N is the
  // number of cities on the board. A city-less player draws nothing — building
  // your first city is what starts the flow of trade cards.
  for (const id of s.activeOrder) {
    const p = player(s, id);
    const cities = Math.min(9, cityCount(s, id));
    let drawn = 0;
    for (let stack = 1; stack <= cities; stack++) {
      const pile = s.trade.stacks[stack];
      if (!pile || pile.length === 0) continue;
      const card = pile.pop()!;
      // Both commodity and calamity cards go into the hand; calamities as
      // `calamity:<id>` so tradable ones can be passed during the trade phase
      // and non-tradable ones are simply retained (§27.3).
      p.hand[card] = (p.hand[card] ?? 0) + 1;
      drawn += 1;
      if (card.startsWith('calamity:')) {
        const calId = card.slice('calamity:'.length);
        s.calamityTradedFrom[calId] = id; // drawer is the original holder
        // Do NOT log the specific calamity here: a drawn card is secret until
        // trading ends (§27.3/§27.4) — naming it publicly would leak which player
        // holds it. Its effect is logged at resolution instead.
      }
    }
    // Safe public summary: the count equals city count, which is already visible.
    if (drawn > 0) s.log.push(`${id} collected ${drawn} trade card${drawn === 1 ? '' : 's'} (1 per city, from stacks 1–${cities}).`);
  }
  s.rngState = rng.serialize();
}

/** Resolve all held calamities after trading (§29). Whoever holds a
 *  `calamity:<id>` card at the end of trading is its primary victim; resolution
 *  is in ascending severity (non-tradable before tradable of the same level,
 *  §29.6 — encoded in the severity ranks). */
function runCalamity(s: GameState): void {
  const rng = Rng.fromState(s.rngState);
  const held: { calamityId: string; holder: PlayerId }[] = [];
  for (const id of s.seating) {
    for (const card of Object.keys(player(s, id).hand)) {
      if (card.startsWith('calamity:') && (player(s, id).hand[card] ?? 0) > 0) {
        held.push({ calamityId: card.slice('calamity:'.length), holder: id });
      }
    }
  }
  held.sort((a, b) => (calamityById.get(a.calamityId)?.severity ?? 0) - (calamityById.get(b.calamityId)?.severity ?? 0));
  for (const { calamityId, holder } of held) {
    // Reveal and remove the card from the holder's hand, then resolve.
    const key = `calamity:${calamityId}`;
    const h = player(s, holder).hand;
    delete h[key];
    applyCalamity(s, calamityId, holder, rng);
    // §29.7: calamities are never removed from the game — return the card to the
    // bottom of the stack of its value so it circulates back into play.
    const lvl = calamityById.get(calamityId)?.level;
    if (lvl && s.trade.stacks[lvl]) s.trade.stacks[lvl]!.unshift(key);
  }
  s.rngState = rng.serialize();
  s.pendingCalamities = [];
  s.calamityTradedFrom = {};
  // §26.5: city support is re-checked after all calamities are resolved.
  checkCitySupport(s);
}

function runAstAdjustment(s: GameState): void {
  for (const id of s.seating) {
    const p = player(s, id);
    const cities = cityCount(s, id);
    if (cities === 0 && p.epoch !== 'stone') {
      // Slide back one space (§33.4).
      p.astSpace = Math.max(0, p.astSpace - 1);
      s.log.push(`${id} has no cities — AST marker slides back to ${p.astSpace}.`);
      continue;
    }
    const nextSpace = p.astSpace + 1;
    const nextEpoch = epochAfterSpace(id, nextSpace);
    if (canEnterEpoch(s, id, nextEpoch, nextSpace)) {
      p.astSpace = nextSpace;
      p.epoch = nextEpoch.id;
      if (isFinishSpace(id, p.astSpace)) {
        s.finished = true;
        s.log.push(`${id} reached the finish square at AST space ${p.astSpace}!`);
      }
    } else {
      s.log.push(`${id} is frozen on the AST (epoch entry requirements unmet).`);
    }
  }
}

// ---- Calamity effects ----------------------------------------------------

function applyCalamity(s: GameState, calId: string, holder: PlayerId, rng: Rng): void {
  const cal = calamityById.get(calId);
  if (!cal) return;
  const p = player(s, holder);
  // Advance modifiers reduce/aggravate the magnitude.
  const reduce = (cal.reducedBy ?? []).filter((id) => has(p, id)).length;
  const worsen = (cal.worsenedBy ?? []).filter((id) => has(p, id)).length;
  const nullified = (cal.nullifiedBy ?? []).some((id) => has(p, id));
  if (nullified) {
    s.log.push(`${holder}'s ${cal.name} is nullified by an advance.`);
    return;
  }
  const eff = cal.effect as { kind: string; unitPoints?: number; cities?: number; keepCities?: number; tokens?: number };
  const mod = (base: number) => Math.max(0, base - reduce * Math.ceil(base / 4) + worsen * Math.ceil(base / 4));
  switch (eff.kind) {
    case 'unitLoss': {
      const loss = mod(eff.unitPoints ?? 0);
      removeTokensFromBoard(s, holder, loss);
      s.log.push(`${holder} suffers ${cal.name}: lost ${loss} unit points.`);
      break;
    }
    case 'cityLoss': {
      const n = mod(eff.cities ?? 1);
      reduceCities(s, holder, n, false);
      s.log.push(`${holder} suffers ${cal.name}: lost up to ${n} cities.`);
      break;
    }
    case 'piracy':
      applyPiracy(s, holder);
      break;
    case 'epidemic':
      applyEpidemic(s, holder);
      break;
    case 'iconoclasm':
      applyIconoclasm(s, holder);
      break;
    case 'reduceToCities': {
      const keep = (eff.keepCities ?? 3);
      const total = cityCount(s, holder);
      reduceCities(s, holder, Math.max(0, total - keep), false);
      s.log.push(`${holder} suffers ${cal.name}: reduced to ${keep} cities.`);
      break;
    }
    case 'areaDestruction': {
      destroyOneArea(s, holder);
      s.log.push(`${holder} suffers ${cal.name}.`);
      break;
    }
    case 'civilWar':
      applyCivilWar(s, holder);
      break;
    case 'barbarians':
      applyBarbarians(s, holder, rng);
      break;
    default:
      s.log.push(`${holder} suffers ${cal.name} (effect not modeled).`);
  }
}

// ---- Calamity special cases ----------------------------------------------

/** Unit points a player has on the board (token = 1, city = 5). */
function boardUnitPoints(s: GameState, id: PlayerId): number {
  let pts = 0;
  for (const a of Object.values(s.areas)) { pts += a.tokens[id] ?? 0; if (a.city === id) pts += 5; }
  return pts;
}

/** Transfer up to `points` unit points of `from`'s on-board units to `to`,
 *  swapping piece ownership in place (the loser's piece returns to its stock,
 *  the gainer deploys one of its own — conserving each nation's fixed supply).
 *  `preferCities` picks high-value units first. Returns points actually moved. */
function transferUnits(s: GameState, from: PlayerId, to: PlayerId, points: number, preferCities: boolean): number {
  const pf = player(s, from), pt = player(s, to);
  const units: { aid: string; kind: 'token' | 'city'; pts: number }[] = [];
  for (const [aid, a] of Object.entries(s.areas)) {
    if (a.city === from) units.push({ aid, kind: 'city', pts: 5 });
    for (let i = 0; i < (a.tokens[from] ?? 0); i++) units.push({ aid, kind: 'token', pts: 1 });
  }
  units.sort((x, y) => (preferCities ? y.pts - x.pts : x.pts - y.pts));
  let moved = 0;
  for (const u of units) {
    if (moved >= points) break;
    const a = s.areas[u.aid]!;
    if (u.kind === 'token') {
      if ((a.tokens[from] ?? 0) <= 0) continue;
      setTokens(s, u.aid, from, (a.tokens[from] ?? 0) - 1); pf.stock += 1;
      if (pt.stock > 0) { a.tokens[to] = (a.tokens[to] ?? 0) + 1; pt.stock -= 1; }
      moved += 1;
    } else {
      if (a.city !== from) continue;
      delete a.city; pf.citiesAvailable += 1;
      if (pt.citiesAvailable > 0) { a.city = to; pt.citiesAvailable -= 1; }
      moved += 5;
    }
  }
  return moved;
}

/** Civil War (§30.41): the primary victim's nation splits; the first faction
 *  defects to the player with the most reserve unit points (stock token = 1,
 *  unplaced city = 5). No war if the victim holds the most reserves (§30.411) or
 *  the nation is too small to leave a second faction (§30.413). Faction size is
 *  15 + Music/Drama (5 each) + Democracy (10) + the beneficiary's 20, or 15 if
 *  the victim holds Philosophy (§30.4121-4124). Military removes 5 from each
 *  faction (§30.414). */
function applyCivilWar(s: GameState, primary: PlayerId): void {
  const pp = player(s, primary);
  const reserves = (id: PlayerId) => player(s, id).stock + 5 * player(s, id).citiesAvailable;
  let beneficiary: PlayerId | null = null, best = -1;
  for (const o of s.seating) {
    if (o === primary) continue;
    const v = reserves(o);
    if (v > best) { best = v; beneficiary = o; }
  }
  if (beneficiary == null || reserves(primary) >= best) {
    s.log.push(`${primary}'s Civil War fizzles — it holds the most reserves (§30.411).`);
    return;
  }
  const size = has(pp, 'philosophy')
    ? 15
    : 15 + (has(pp, 'music') ? 5 : 0) + (has(pp, 'drama') ? 5 : 0) + (has(pp, 'democracy') ? 10 : 0) + 20;
  if (boardUnitPoints(s, primary) <= size) {
    s.log.push(`${primary}'s Civil War: nation too small to split — no effect (§30.413).`);
    return;
  }
  const moved = transferUnits(s, primary, beneficiary, size, true);
  s.log.push(`${primary} suffers Civil War: a faction worth ${moved} defects to ${beneficiary}.`);
  if (has(pp, 'military')) {
    removeTokensFromBoard(s, primary, 5);
    removeTokensFromBoard(s, beneficiary, 5);
    s.log.push(`Military makes the Civil War bloodier — both factions lose 5 (§30.414).`);
  }
}

/** Damage a horde could inflict on `primary` by entering `aid` (§30.5231 — tokens
 *  worth 1, a city worth 5). */
function damageTo(s: GameState, aid: string, primary: PlayerId): number {
  const a = s.areas[aid];
  if (!a) return 0;
  return (a.tokens[primary] ?? 0) + (a.city === primary ? 5 : 0);
}

/** Barbarian Hordes (§30.52): 15 neutral tokens land in the primary victim's
 *  most damaging start area (Crete is immune, §30.527), fight, then the surplus
 *  over the area limit marches to the adjacent area that hurts the victim most,
 *  fighting each step, until no surplus remains. Survivors persist on the board
 *  (§30.5235). Razing a city by Barbarians yields no pillage/card (§24.53). */
function applyBarbarians(s: GameState, primary: PlayerId, rng: Rng): void {
  if (primary === 'crete') { s.log.push(`Crete is immune to Barbarian Hordes (§30.527).`); return; }
  const civ = civById.get(primary);
  const startAreas = (civ?.startAreas ?? []).filter((aid) => areaById.has(aid));
  if (startAreas.length === 0) { s.log.push(`${primary} has no start area for Barbarians to land.`); return; }
  // Land where they damage the victim most; else an empty start area (§30.5211).
  const occupied = startAreas.filter((aid) => damageTo(s, aid, primary) > 0);
  let here = (occupied.length ? occupied : startAreas)
    .sort((x, y) => damageTo(s, y, primary) - damageTo(s, x, primary))[0]!;
  (s.areas[here] ??= { tokens: {} }).tokens[BARBARIAN] = (s.areas[here]!.tokens[BARBARIAN] ?? 0) + 15;
  s.log.push(`Barbarian Hordes (15) descend on ${areaName(here)}.`);
  resolveAreaCombat(s, here, rng);

  const visited = new Set<string>([here]);
  let guard = 0;
  while (guard++ < 30) {
    const a = s.areas[here]!;
    const barbs = a.tokens[BARBARIAN] ?? 0;
    const limit = areaById.get(here)?.sustains ?? 0;
    const surplus = barbs - limit;
    if (surplus <= 0 || barbs <= 0) break;
    // March the surplus to the adjacent area that damages the victim most
    // (§30.5241 — prefer the victim's own areas), avoiding re-treading.
    const dests = neighbors(here)
      .filter((n) => !areaById.get(n)?.isWater && !visited.has(n))
      .sort((x, y) => damageTo(s, y, primary) - damageTo(s, x, primary));
    const next = dests[0];
    if (next == null || damageTo(s, next, primary) === 0) break; // nowhere worth going
    a.tokens[BARBARIAN] = limit; // the rest stay behind (settle)
    (s.areas[next] ??= { tokens: {} }).tokens[BARBARIAN] = (s.areas[next]!.tokens[BARBARIAN] ?? 0) + surplus;
    s.log.push(`Barbarians march from ${areaName(here)} to ${areaName(next)} (${surplus}).`);
    here = next;
    visited.add(here);
    resolveAreaCombat(s, here, rng);
  }
  s.log.push(`${primary} is ravaged by Barbarian Hordes.`);
}

/** Remove up to `points` unit points from a player (tokens = 1; then cities,
 *  each worth 4 under Epidemic §30.612 / up to 5 generally). Cities are reduced
 *  last. Returns points actually removed. */
function removeUnitPoints(s: GameState, id: PlayerId, points: number, cityWorth = 5): number {
  const before = boardUnitPoints(s, id);
  const tokens = populationCount(s, id);
  const tokenLoss = Math.min(tokens, points);
  removeTokensFromBoard(s, id, tokenLoss);
  let remaining = points - tokenLoss;
  while (remaining > 0 && cityCount(s, id) > 0) { reduceCities(s, id, 1, false); remaining -= cityWorth; }
  return before - boardUnitPoints(s, id);
}

/** Epidemic (§30.61): primary loses 16 (Medicine -8, Roadbuilding +5) and orders
 *  25 unit points of loss among the other players (Medicine -5, Roadbuilding +5;
 *  the trader is exempt). The primary concentrates the order on its strongest
 *  rivals. */
function applyEpidemic(s: GameState, primary: PlayerId): void {
  const pp = player(s, primary);
  let loss = 16;
  if (has(pp, 'medicine')) loss -= 8;
  if (has(pp, 'roadbuilding')) loss += 5;
  removeUnitPoints(s, primary, Math.max(0, loss), 4);
  s.log.push(`${primary} suffers Epidemic (-${Math.max(0, loss)} unit points).`);
  // Secondary: order 25 unit points of loss among eligible rivals.
  const trader = s.calamityTradedFrom['epidemic'];
  let pool = 25;
  const victims = s.seating
    .filter((o) => o !== primary && o !== trader && boardUnitPoints(s, o) > 0)
    .sort((x, y) => boardUnitPoints(s, y) - boardUnitPoints(s, x));
  for (const v of victims) {
    if (pool <= 0) break;
    const ordered = Math.min(pool, boardUnitPoints(s, v));
    pool -= ordered;
    const vp = player(s, v);
    let actual = ordered;
    if (has(vp, 'medicine')) actual -= 5;
    if (has(vp, 'roadbuilding')) actual += 5;
    const removed = removeUnitPoints(s, v, Math.max(0, actual), 4);
    if (removed > 0) s.log.push(`${v} is a secondary victim of Epidemic (-${removed}).`);
  }
}

/** Iconoclasm & Heresy (§30.81): primary reduces 4 cities (Law/Philosophy -1,
 *  Theology -3, Monotheism/Roadbuilding +1, cumulative), then orders 2 cities
 *  reduced among rivals — not the trader, never a Theology-holder, and at most 1
 *  from a Philosophy-holder (§30.818-819). */
function applyIconoclasm(s: GameState, primary: PlayerId): void {
  const pp = player(s, primary);
  let n = 4;
  if (has(pp, 'law')) n -= 1;
  if (has(pp, 'philosophy')) n -= 1;
  if (has(pp, 'theology')) n -= 3;
  if (has(pp, 'monotheism')) n += 1;
  if (has(pp, 'roadbuilding')) n += 1;
  n = Math.max(0, n);
  reduceCities(s, primary, n, false);
  s.log.push(`${primary} suffers Iconoclasm & Heresy (-${n} cities).`);
  // Secondary: 2 cities total among eligible rivals.
  const trader = s.calamityTradedFrom['iconoclasm'];
  let remaining = 2;
  const victims = s.seating
    .filter((o) => o !== primary && o !== trader && !has(player(s, o), 'theology') && cityCount(s, o) > 0)
    .sort((x, y) => cityCount(s, y) - cityCount(s, x));
  for (const v of victims) {
    if (remaining <= 0) break;
    const cap = has(player(s, v), 'philosophy') ? 1 : remaining;
    const take = Math.min(remaining, cap, cityCount(s, v));
    if (take > 0) { reduceCities(s, v, take, false); remaining -= take; s.log.push(`${v} loses ${take} city(ies) to Iconoclasm (secondary).`); }
  }
}

const isCoastal2 = (aid: string) => neighbors(aid).some((n) => areaById.get(n)?.isWater);

/** Turn up to `n` of a player's coastal cities into pirate cities (§30.911/.913):
 *  the player's piece returns to stock and a neutral pirate city stands there. */
function razeCoastalCitiesToPirate(s: GameState, owner: PlayerId, n: number): number {
  let done = 0;
  for (const [aid, a] of Object.entries(s.areas)) {
    if (done >= n) break;
    if (a.city !== owner || !isCoastal2(aid)) continue;
    delete a.city; player(s, owner).citiesAvailable += 1;
    a.city = PIRATE; a.pirateCity = true;
    done += 1;
    s.log.push(`A coastal city of ${owner} in ${areaName(aid)} becomes a pirate city.`);
  }
  return done;
}

const PIRATE = '__pirate__';

/** Piracy (§30.91): the primary victim loses two coastal cities and up to two
 *  other players lose one coastal city each (secondary victims); the player who
 *  traded Piracy to the victim may not be a secondary victim (§30.912). Lost
 *  cities become neutral pirate cities. */
function applyPiracy(s: GameState, primary: PlayerId): void {
  razeCoastalCitiesToPirate(s, primary, 2);
  const trader = s.calamityTradedFrom['piracy'];
  const eligible = s.seating
    .filter((o) => o !== primary && o !== trader)
    .sort((x, y) => coastalCityCount(s, y) - coastalCityCount(s, x));
  for (const o of eligible.slice(0, 2)) razeCoastalCitiesToPirate(s, o, 1);
  s.log.push(`${primary} suffers Piracy along the coasts.`);
}

function coastalCityCount(s: GameState, id: PlayerId): number {
  let n = 0;
  for (const [aid, a] of Object.entries(s.areas)) if (a.city === id && isCoastal2(aid)) n++;
  return n;
}

// ---- Mutation primitives -------------------------------------------------

function setTokens(s: GameState, aid: string, owner: PlayerId, n: number): void {
  const a = s.areas[aid]!;
  if (n <= 0) delete a.tokens[owner];
  else a.tokens[owner] = n;
}

function returnLostToStock(s: GameState, owner: PlayerId, n: number): void {
  // Neutral forces (Barbarians, pirates) have no stock — their pieces just vanish.
  if (isPlayer(s, owner)) player(s, owner).stock += n;
}

/** Remove up to `unitPoints` of a player's tokens from the board (smallest
 *  areas first), returning them to stock. Cities are not removed here. */
function removeTokensFromBoard(s: GameState, owner: PlayerId, unitPoints: number): void {
  let remaining = unitPoints;
  const areas = Object.entries(s.areas)
    .filter(([, a]) => (a.tokens[owner] ?? 0) > 0)
    .sort(([, a], [, b]) => (a.tokens[owner] ?? 0) - (b.tokens[owner] ?? 0));
  for (const [aid, a] of areas) {
    if (remaining <= 0) break;
    const t = a.tokens[owner] ?? 0;
    const take = Math.min(t, remaining);
    setTokens(s, aid, owner, t - take);
    returnLostToStock(s, owner, take);
    remaining -= take;
  }
}

/** Reduce `n` of a player's cities (each city -> tokens removed; rules model a
 *  reduced city becoming tokens, but for losses we return the city + its
 *  notional support to stock). `coastalOnly` restricts to coastal areas. */
function reduceCities(s: GameState, owner: PlayerId, n: number, coastalOnly: boolean): void {
  let remaining = n;
  for (const [aid, a] of Object.entries(s.areas)) {
    if (remaining <= 0) break;
    if (a.city !== owner) continue;
    if (coastalOnly && !isCoastal(aid)) continue;
    delete a.city;
    player(s, owner).citiesAvailable += 1;
    remaining -= 1;
  }
}

function destroyOneArea(s: GameState, owner: PlayerId): void {
  // Remove the largest stack (and any city there) of the owner.
  let best: string | null = null;
  let bestN = -1;
  for (const [aid, a] of Object.entries(s.areas)) {
    const t = (a.tokens[owner] ?? 0) + (a.city === owner ? 6 : 0);
    if (t > bestN) { bestN = t; best = aid; }
  }
  if (!best) return;
  const a = s.areas[best]!;
  const t = a.tokens[owner] ?? 0;
  setTokens(s, best, owner, 0);
  returnLostToStock(s, owner, t);
  if (a.city === owner) { delete a.city; player(s, owner).citiesAvailable += 1; }
}

function isCoastal(aid: string): boolean {
  return neighbors(aid).some((n) => areaById.get(n)?.isWater);
}
function areaName(aid: string): string {
  return areaById.get(aid)?.name ?? aid;
}

// ---- AST helpers ---------------------------------------------------------

/** Epoch a given (1-based) AST space belongs to, per the nation's track. */
function epochAfterSpace(civId: PlayerId, space: number): typeof epochs[number] {
  const track = astTrackFor(civId);
  let chosen = epochs[0]!;
  for (const e of epochs) {
    const start = track.epochStart[e.id];
    if (start != null && space >= start) chosen = e;
  }
  return chosen;
}

function isFinishSpace(civId: PlayerId, space: number): boolean {
  return space >= astTrackFor(civId).finishSpace;
}

function canEnterEpoch(s: GameState, id: PlayerId, epoch: typeof epochs[number], nextSpace: number): boolean {
  const p = player(s, id);
  const req = epoch.requirements;
  const cities = cityCount(s, id);
  if (req.cities && cities < req.cities) return false;
  if (req.cards && p.advances.length < req.cards) return false;
  if (req.cardGroups && cardGroupsHeld(p.advances).size < req.cardGroups) return false;
  if (req.perSpaceCardValue) {
    // §33.25: card face value must at least equal the space's printed point value.
    // Use this nation's per-space Late Iron Age thresholds when known, else the
    // generic space*100.
    const track = astTrackFor(id);
    const liaStart = track.epochStart['lateIron'] ?? track.finishSpace;
    const idx = nextSpace - liaStart;
    const thr = track.lateIronThresholds;
    // A space beyond the listed thresholds (the finish square) needs no card
    // value; with no per-civ data, fall back to the generic space*100.
    const need = thr ? (idx >= 0 && idx < thr.length ? thr[idx]! : 0) : nextSpace * track.pointsPerSpace;
    if (advancesFaceValue(p.advances) < need) return false;
  }
  return true;
}

// ---- Normalization: run auto phases until an interactive decision ---------

function nextPhase(phase: Phase): Phase {
  const i = PHASE_ORDER.indexOf(phase);
  return PHASE_ORDER[(i + 1) % PHASE_ORDER.length]!;
}

function runAutoPhase(s: GameState): void {
  switch (s.phase) {
    case 'taxation': return runTaxation(s);
    case 'populationExpansion': return runPopulationExpansion(s);
    case 'census': return runCensus(s);
    case 'conflict': return runConflict(s);
    case 'removeSurplus': return runRemoveSurplus(s);
    case 'tradeAcquisition': return runTradeAcquisition(s);
    case 'calamity': return runCalamity(s);
    case 'astAdjustment': return runAstAdjustment(s);
  }
}

function enterPhase(s: GameState, phase: Phase): void {
  s.phase = phase;
  if (phase === 'astAdjustment') return; // order handled per-phase
  if (!AUTO_PHASES.has(phase)) {
    // Interactive phase: act in census order, nobody has acted yet.
    s.activeOrder = s.activeOrder.length ? s.activeOrder : censusOrder(s);
    s.actedThisPhase = [];
    if (phase === 'trade') {
      s.negotiation = { turnPointer: 0, passStreak: 0, proposals: 0, pendingOffer: null };
    }
    if (phase === 'shipConstruction') runShipMaintenance(s); // §22.3, before building
  }
}

/** Advance through auto phases and turn rollovers until the game is over or an
 *  interactive phase has a waiting actor. Mutates `s` in place. */
export function normalize(s: GameState): void {
  let guard = 0;
  while (guard++ < 1000) {
    if (s.finished && s.phase === 'taxation') return; // game over at turn boundary
    if (AUTO_PHASES.has(s.phase)) {
      runAutoPhase(s);
      const np = nextPhase(s.phase);
      if (np === 'taxation') {
        // Turn rollover.
        if (s.finished || (s.maxTurns && s.turn >= s.maxTurns)) { s.phase = 'taxation'; return; }
        s.turn += 1;
        s.activeOrder = censusOrder(s);
        s.actedThisPhase = [];
      }
      enterPhase(s, np);
      continue;
    }
    // Interactive trade phase: ends when every player has passed in a row with
    // no offer outstanding (§28), or the per-phase proposal cap is reached.
    if (s.phase === 'trade') {
      if (tradePhaseEnded(s)) { enterPhase(s, nextPhase(s.phase)); continue; }
      return; // waiting on a proposer or a responder
    }
    // Other interactive phases.
    if (actingPlayer(s) == null) {
      // Everyone acted; move on.
      enterPhase(s, nextPhase(s.phase));
      continue;
    }
    return; // waiting on a real player decision
  }
  throw new Error('normalize: phase loop did not converge');
}

// ---- Action application for interactive phases ----------------------------

function applyMovement(s: GameState, actor: PlayerId, moves: { from: string; to: string; count: number; via?: string; byShip?: boolean }[]): void {
  const p = player(s, actor);
  const road = has(p, 'roadbuilding');
  for (const m of moves) {
    const from = s.areas[m.from];
    if (!from || (from.tokens[actor] ?? 0) < m.count) throw new Error(`illegal move: not enough tokens in ${m.from}`);
    if (m.byShip) {
      // Naval transport (§23.5): a ship at `from` carries up to 5 tokens to a
      // coastal `to` within range, then relocates there.
      if ((from.ships?.[actor] ?? 0) <= 0) throw new Error(`no ship in ${m.from} to embark`);
      if (m.count > 5) throw new Error('a ship carries at most 5 tokens (§23.51)');
      const range = 4 + (has(p, 'clothmaking') ? 1 : 0);
      if (!navalDestinations(m.from, range, has(p, 'astronomy')).has(m.to)) throw new Error(`illegal sea move ${m.from}->${m.to}: out of range`);
      setTokens(s, m.from, actor, (from.tokens[actor] ?? 0) - m.count);
      const dest = (s.areas[m.to] ??= { tokens: {} });
      dest.tokens[actor] = (dest.tokens[actor] ?? 0) + m.count;
      from.ships![actor] = (from.ships![actor] ?? 0) - 1; if (from.ships![actor]! <= 0) delete from.ships![actor];
      (dest.ships ??= {})[actor] = (dest.ships[actor] ?? 0) + 1;
      continue;
    }
    const adjacent = neighbors(m.from).includes(m.to);
    const via = m.via;
    const viaArea = via ? s.areas[via] : undefined;
    const roadReachable = !!(road && via && neighbors(m.from).includes(via) && neighbors(via).includes(m.to)
      && !areaById.get(via)?.isWater
      && (!viaArea || Object.keys(viaArea.tokens).every((o) => o === actor || (viaArea.tokens[o] ?? 0) === 0)));
    if (!adjacent && !roadReachable) throw new Error(`illegal move ${m.from}->${m.to}: not reachable`);
    setTokens(s, m.from, actor, (from.tokens[actor] ?? 0) - m.count);
    const to = (s.areas[m.to] ??= { tokens: {} });
    to.tokens[actor] = (to.tokens[actor] ?? 0) + m.count;
  }
}

function applyBuildCity(s: GameState, actor: PlayerId, area: string, useTreasury = 0): void {
  const p = player(s, actor);
  const a = s.areas[area];
  if (!a) throw new Error('build city: empty area');
  if (a.city) throw new Error('build city: area already has a city');
  if (p.citiesAvailable <= 0) throw new Error('no cities available');
  if (areaById.get(area)?.isWater) throw new Error('cannot build a city at sea');
  const onBoard = a.tokens[actor] ?? 0;
  // 6 tokens build a city on a printed city site; 12 elsewhere (§25.2).
  const required = areaById.get(area)?.isCitySite ? 6 : 12;
  const architecture = has(p, 'architecture');
  const treasuryUsed = architecture ? Math.min(useTreasury, Math.floor(required / 2), p.treasury) : 0;
  if (onBoard + treasuryUsed < required) throw new Error(`build city: need ${required} tokens in ${area}`);
  // Consume tokens: prefer on-board, then treasury (architecture). All 6 tokens
  // that form the city return to stock — no piece is ever removed (§11.1); only
  // a city piece is added to the board.
  const fromBoard = Math.min(onBoard, required - treasuryUsed);
  setTokens(s, area, actor, onBoard - fromBoard);
  p.stock += fromBoard;
  p.treasury -= treasuryUsed;
  p.stock += treasuryUsed;
  a.city = actor;
  p.citiesAvailable -= 1;
  s.log.push(`${actor} built a city in ${areaName(area)}.`);
}

function applyBuyAdvance(s: GameState, actor: PlayerId, advanceId: string, spendCommodities: Record<string, number> = {}, spendTreasury = 0): void {
  const p = player(s, actor);
  const adv = advanceById.get(advanceId);
  if (!adv) throw new Error(`unknown advance ${advanceId}`);
  if (has(p, advanceId)) throw new Error('already owned');
  for (const pre of adv.prerequisites ?? []) if (!has(p, pre)) throw new Error(`missing prerequisite ${pre}`);
  // Validate the player owns the commodity cards being spent (calamity cards
  // are never spendable currency).
  for (const [cid, n] of Object.entries(spendCommodities)) {
    if (n <= 0) continue;
    if (isCalamityCard(cid)) throw new Error('calamity cards cannot be spent on advances');
    if ((p.hand[cid] ?? 0) < n) throw new Error(`not enough ${cid} cards`);
  }
  if (spendTreasury > p.treasury) throw new Error('not enough treasury');
  // Compute payment value: commodity set values of spent cards + treasury + credits.
  const spentHand: Record<string, number> = {};
  for (const [cid, n] of Object.entries(spendCommodities)) if (n > 0) spentHand[cid] = n;
  const cardValue = handValue(spentHand, { mining: has(p, 'mining') });
  const credit = creditTowards(p.advances, advanceId);
  const paid = cardValue + spendTreasury + credit;
  if (paid < adv.cost) throw new Error(`insufficient payment: ${paid} < ${adv.cost}`);
  // Deduct, returning spent commodity cards to the bottom of their stack (§31 —
  // they are placed face down at the bottom, not removed from the game).
  for (const [cid, n] of Object.entries(spendCommodities)) {
    if (n <= 0) continue;
    p.hand[cid] = (p.hand[cid] ?? 0) - n;
    if (p.hand[cid]! <= 0) delete p.hand[cid];
    const stack = commodityById.get(cid)?.stack;
    if (stack) for (let i = 0; i < n; i++) s.trade.stacks[stack]!.unshift(cid);
  }
  // Treasury tokens spent on advances return to stock (§11.1: no piece is ever
  // permanently removed from the game).
  p.treasury -= spendTreasury;
  p.stock += spendTreasury;
  p.advances.push(advanceId);
  s.log.push(`${actor} acquired ${adv.name} (paid ${paid} for ${adv.cost}).`);
}

// ---- Trade action handlers ----------------------------------------------

/** The trade phase is over (no pending offer) once everyone has passed in a row,
 *  or the generous per-phase proposal cap is hit (bounds an eager AI). */
function tradePhaseEnded(s: GameState): boolean {
  const n = s.negotiation;
  if (n.pendingOffer) return false;
  const cap = 8 * Math.max(1, s.activeOrder.length);
  return n.passStreak >= s.activeOrder.length || (n.proposals ?? 0) >= cap;
}

function applyProposeTrade(s: GameState, actor: PlayerId, a: { to: PlayerId; offer: { actual: Record<string, number>; declared: Record<string, number> }; request: { count: number; declared: Record<string, number> } }): void {
  if (s.negotiation.pendingOffer) throw new Error('an offer is already pending');
  if (a.to === actor) throw new Error('cannot trade with yourself');
  if (!s.players[a.to]) throw new Error(`unknown trade partner ${a.to}`);
  // Proposer's offered bundle must satisfy the truth rules (>=3 cards, >=2 declared).
  const err = validateBundle(s, actor, a.offer, 3);
  if (err) throw new Error(`proposeTrade: ${err}`);
  // The request must be honest about count (>=3) and declare >=2 cards.
  if (a.request.count < 3) throw new Error('each side must trade at least 3 cards (§28.3)');
  if (bundleSize(a.request.declared) < 2) throw new Error('must request at least two declared cards (§28.3)');
  if (bundleSize(a.request.declared) > a.request.count) throw new Error('declared exceeds requested count');
  s.negotiation.proposals = (s.negotiation.proposals ?? 0) + 1;
  s.negotiation.pendingOffer = { from: actor, to: a.to, offer: a.offer, request: a.request };
  s.log.push(`${actor} proposes a trade to ${a.to} (${bundleSize(a.offer.actual)} cards for ${a.request.count}).`);
}

function applyRespondTrade(s: GameState, actor: PlayerId, a: { accept: boolean; give?: { actual: Record<string, number>; declared: Record<string, number> } }): void {
  const offer = s.negotiation.pendingOffer;
  if (!offer || offer.to !== actor) throw new Error('no offer to respond to');
  // Either outcome ends the proposer's turn; advance the pointer past them.
  const advance = () => { s.negotiation.pendingOffer = null; s.negotiation.turnPointer += 1; };
  if (!a.accept) {
    advance();
    s.negotiation.passStreak += 1;
    s.log.push(`${actor} declines ${offer.from}'s trade.`);
    return;
  }
  const give = a.give;
  if (!give) throw new Error('accept requires a give bundle');
  // Responder's bundle must be valid and honor the requested count + declared cards.
  const err = validateBundle(s, actor, give, 3);
  if (err) throw new Error(`respondTrade: ${err}`);
  if (bundleSize(give.actual) !== offer.request.count) throw new Error(`must give exactly ${offer.request.count} cards`);
  if (!isSubMultiset(offer.request.declared, give.actual)) throw new Error('give must include the requested declared cards');
  // Execute the swap (cards only; never treasury/civ cards, §28.2).
  transferCards(s, offer.from, actor, offer.offer.actual);
  transferCards(s, actor, offer.from, give.actual);
  advance();
  s.negotiation.passStreak = 0; // a deal was made — keep trading
  s.log.push(`${offer.from} and ${actor} completed a trade.`);
}

function applyBuyTradeCard(s: GameState, actor: PlayerId, count: number): void {
  // §27.5: buy Gold/Ivory from the ninth stack at 18 treasury tokens each
  // (tokens returned to stock). Draws from the top of stack 9.
  if (count <= 0) throw new Error('count must be positive');
  const p = player(s, actor);
  const cost = 18 * count;
  if (p.treasury < cost) throw new Error(`need ${cost} treasury to buy ${count} card(s)`);
  const pile = s.trade.stacks[9] ?? [];
  if (pile.length < count) throw new Error('not enough cards in the ninth stack');
  for (let i = 0; i < count; i++) {
    const card = pile.pop()!;
    p.hand[card] = (p.hand[card] ?? 0) + 1;
    if (isCalamityCard(card)) s.calamityTradedFrom[calamityIdOf(card)] = actor;
  }
  p.treasury -= cost;
  p.stock += cost; // spent tokens return to stock (§27.51)
  s.log.push(`${actor} bought ${count} card(s) from the ninth stack for ${cost} treasury.`);
}

// ---- The adapter ---------------------------------------------------------

export class CivAdapter implements GameAdapter<GameState, Action, PlayerId> {
  schemaVersion = 1;

  currentActor(state: GameState): PlayerId | null {
    if (state.finished && state.phase === 'taxation') return null;
    if (AUTO_PHASES.has(state.phase)) return null;
    if (state.phase === 'trade') {
      const n = state.negotiation;
      if (n.pendingOffer) return n.pendingOffer.to; // target must respond
      if (tradePhaseEnded(state)) return null;
      return state.activeOrder[n.turnPointer % state.activeOrder.length] ?? null;
    }
    return actingPlayer(state);
  }

  /** Engine-decided legality (the GameServer prefers this over exact-matching
   *  legalActions). Essential for parameterized actions — movement orders with a
   *  chosen subset count, trade proposals — that legalActions() can't enumerate. */
  tryApplyAction(state: GameState, action: Action, actor: PlayerId): { state: GameState; ok: boolean; reason?: string } {
    try {
      return { state: this.applyAction(state, action, actor), ok: true };
    } catch (e) {
      return { state, ok: false, reason: (e as Error).message };
    }
  }

  applyAction(state: GameState, action: Action, actor: PlayerId): GameState {
    const s = clone(state);
    const expected = this.currentActor(s);
    if (expected !== actor) throw new Error(`not ${actor}'s turn (expected ${expected})`);

    switch (action.type) {
      case 'pass':
        if (s.phase === 'trade') {
          // A pass while an offer is pending means the target declines it.
          if (s.negotiation.pendingOffer && s.negotiation.pendingOffer.to === actor) {
            applyRespondTrade(s, actor, { accept: false });
          } else {
            s.negotiation.passStreak += 1;
            s.negotiation.turnPointer += 1;
          }
        } else if (!s.actedThisPhase.includes(actor)) {
          s.actedThisPhase.push(actor);
        }
        break;
      case 'proposeTrade':
        if (s.phase !== 'trade') throw new Error('proposeTrade only in trade phase');
        applyProposeTrade(s, actor, action);
        break; // target now responds
      case 'respondTrade':
        if (s.phase !== 'trade') throw new Error('respondTrade only in trade phase');
        applyRespondTrade(s, actor, action);
        break;
      case 'buyTradeCard':
        if (s.phase !== 'trade') throw new Error('buyTradeCard only in trade phase');
        applyBuyTradeCard(s, actor, action.count);
        break; // stays this player's turn; may propose/pass next
      case 'move':
        if (s.phase !== 'movement') throw new Error('move only in movement phase');
        applyMovement(s, actor, action.moves);
        // A player may move once, then is done for the phase.
        if (!s.actedThisPhase.includes(actor)) s.actedThisPhase.push(actor);
        break;
      case 'buildShips':
        if (s.phase !== 'shipConstruction') throw new Error('buildShips only in shipConstruction phase');
        applyBuildShips(s, actor, action.builds);
        break; // stays acting; may build more or pass
      case 'buildCity':
        if (s.phase !== 'cityConstruction') throw new Error('buildCity only in cityConstruction phase');
        applyBuildCity(s, actor, action.area, action.useTreasury);
        break; // stays acting; may build again or pass
      case 'buyAdvance':
        if (s.phase !== 'acquireAdvances') throw new Error('buyAdvance only in acquireAdvances phase');
        applyBuyAdvance(s, actor, action.advance, action.spendCommodities, action.spendTreasury);
        break; // stays acting; may buy again or pass
      default:
        throw new Error(`action ${(action as Action).type} not valid here`);
    }

    normalize(s);
    s.rngState = s.rngState; // (kept; RNG advanced inside auto phases)
    return s;
  }

  legalActions(state: GameState, actor: PlayerId): Action[] {
    if (this.currentActor(state) !== actor) return [];
    const p = player(state, actor);
    const out: Action[] = [{ type: 'pass' }];
    switch (state.phase) {
      case 'shipConstruction': {
        const inPlay = shipCount(state, actor);
        if (p.shipsAvailable > 0 && inPlay < 4) {
          for (const [aid, a] of Object.entries(state.areas)) {
            if (!isCoastal(aid)) continue;
            const occupies = (a.tokens[actor] ?? 0) > 0 || a.city === actor;
            if (occupies && (a.tokens[actor] ?? 0) + p.treasury >= 2) {
              out.push({ type: 'buildShips', builds: [{ area: aid, count: 1 }] });
            }
          }
        }
        break;
      }
      case 'movement': {
        // Offer single-step land moves from each owned area as discrete options.
        for (const [aid, a] of Object.entries(state.areas)) {
          const t = a.tokens[actor] ?? 0;
          if (t > 0) {
            for (const nb of neighbors(aid)) {
              if (areaById.get(nb)?.isWater) continue;
              out.push({ type: 'move', moves: [{ from: aid, to: nb, count: t }] });
            }
          }
          // Naval moves from areas where this player has a ship and tokens.
          if ((a.ships?.[actor] ?? 0) > 0 && t > 0) {
            const range = 4 + (has(p, 'clothmaking') ? 1 : 0);
            for (const to of navalDestinations(aid, range, has(p, 'astronomy'))) {
              out.push({ type: 'move', moves: [{ from: aid, to, count: Math.min(5, t), byShip: true }] });
            }
          }
        }
        break;
      }
      case 'cityConstruction': {
        for (const [aid, a] of Object.entries(state.areas)) {
          if (a.city) continue;
          const area = areaById.get(aid);
          if (!area || area.isWater) continue;
          const required = area.isCitySite ? 6 : 12;
          const onBoard = a.tokens[actor] ?? 0;
          const arch = has(p, 'architecture');
          const maxTreasury = arch ? Math.min(Math.floor(required / 2), p.treasury) : 0;
          const reachable = onBoard + maxTreasury >= required;
          if (reachable && p.citiesAvailable > 0) {
            out.push({ type: 'buildCity', area: aid, useTreasury: Math.max(0, Math.min(maxTreasury, required - onBoard)) });
          }
        }
        break;
      }
      case 'acquireAdvances': {
        // Only commodity cards are spendable currency (not calamity cards).
        const commHand: Record<string, number> = {};
        for (const [c, n] of Object.entries(p.hand)) if (!isCalamityCard(c) && n > 0) commHand[c] = n;
        for (const adv of advanceById.values()) {
          if (has(p, adv.id)) continue;
          if ((adv.prerequisites ?? []).some((pre) => !has(p, pre))) continue;
          const maxPay = handValue(commHand, { mining: has(p, 'mining') }) + p.treasury + creditTowards(p.advances, adv.id);
          if (maxPay >= adv.cost) {
            // Suggest a concrete payment: spend whole commodity hand + needed treasury.
            out.push({ type: 'buyAdvance', advance: adv.id, spendCommodities: { ...commHand }, spendTreasury: Math.max(0, Math.min(p.treasury, netAdvanceCost(p.advances, adv.id) - handValue(commHand, { mining: has(p, 'mining') }))) });
          }
        }
        break;
      }
      case 'trade': {
        // Trade proposals are parameterized (choose partner, cards, declarations)
        // and are not enumerated here — the UI/AI construct proposeTrade /
        // respondTrade / buyTradeCard explicitly. We always offer the safe exits
        // so legalActions consumers (and random play) can progress: a responder
        // may accept-less decline, a proposer may pass. Buying a ninth-stack card
        // is offered when affordable.
        if (state.negotiation.pendingOffer) {
          // The acting player is the responder; declining is always legal.
          return [{ type: 'respondTrade', accept: false }];
        }
        if (p.treasury >= 18 && (state.trade.stacks[9]?.length ?? 0) > 0) {
          out.push({ type: 'buyTradeCard', count: 1 });
        }
        break;
      }
    }
    return out;
  }

  viewFor(state: GameState, _viewer: PlayerId | null): GameState {
    // Hidden info (§27.4): trade-card hands are secret; only the holder sees them.
    if (_viewer == null) return state;
    const v = clone(state);
    for (const [id, p] of Object.entries(v.players)) {
      if (id !== _viewer) {
        p.hand = {} as Record<string, number>;
        p.calamities = [];
      }
    }
    // A pending offer's ACTUAL cards are secret (§28.3 — only the declared count
    // and >=2 declared cards are public); the responder accepts on the
    // declaration and learns the rest only once cards change hands. Keep the
    // actual cards visible only to the proposer.
    const offer = v.negotiation.pendingOffer;
    if (offer && offer.from !== _viewer) {
      offer.offer = { actual: {}, declared: offer.offer.declared };
    }
    return v;
  }

  result(state: GameState): GameResult<PlayerId> | null {
    const over = state.finished || (state.maxTurns != null && state.turn >= state.maxTurns && state.phase === 'taxation');
    if (!over) return null;
    let best: PlayerId[] = [];
    let bestScore = -Infinity;
    for (const id of state.seating) {
      const sc = victoryScore(state, id);
      if (sc > bestScore) { bestScore = sc; best = [id]; }
      else if (sc === bestScore) best.push(id);
    }
    return { winners: best, reason: `final score ${bestScore}` };
  }
}

/** Victory score (rules §35.1). */
export function victoryScore(state: GameState, id: PlayerId): number {
  const p = player(state, id);
  let score = 0;
  if (victoryScoring) {
    score += advancesFaceValue(p.advances);
    let comm = 0;
    for (const [cid, n] of Object.entries(p.hand)) comm += commoditySetValue(cid, n);
    score += comm;
    score += p.treasury;
    score += p.astSpace * victoryScoring.pointsPerAstSpace;
    score += cityCount(state, id) * victoryScoring.pointsPerCity;
  }
  return score;
}
