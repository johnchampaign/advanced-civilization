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
  CALAMITY_DESC,
  civById,
  commodityById,
  astTrackFor,
  epochs,
  victoryScoring,
} from '../data/index.js';
import {
  actingPlayer,
  advancesFaceValue,
  astOrder,
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
  type CalamityEvent,
  type CalamityStep,
  type CombatEvent,
  type CombatForce,
  type GameState,
  type PendingAllocation,
  type PendingCityChoice,
  type PendingCivilWar,
  type PendingPick,
  type PendingSecondary,
  type PendingUnitLoss,
  type Phase,
  type PlayerId,
  type SecondaryLoss,
  type UnitSet,
} from './types.js';

const AUTO_PHASES: Set<Phase> = new Set([
  // 'taxation' is INTERACTIVE only for Coinage holders with cities (they pick
  // their rate 1-3); everyone else is auto-collected at rate 2 on phase entry.
  // 'populationExpansion' is INTERACTIVE only when stock can't cover all growth
  // (the player then places their limited tokens); otherwise auto on phase entry.
  'census',
  // 'shipConstruction' is INTERACTIVE (build/maintain ships), not auto.
  'conflict',
  'removeSurplus',
  'tradeAcquisition',
  // 'trade' is INTERACTIVE (negotiation), not auto.
  // 'calamity' resolves automatically on entry, then is INTERACTIVE only for
  // Monotheism holders choosing a conversion (§29 / §32.941).
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

/** How many announced cards are truthful (present in actual), counting multiplicity. */
function truthfulCount(declared: Record<string, number>, actual: Record<string, number>): number {
  let t = 0;
  for (const [c, n] of Object.entries(declared)) t += Math.min(n, actual[c] ?? 0);
  return t;
}

/** Validate one side's bundle against the §28.3 truth rules. `owner` must hold
 *  the actual cards; the bundle must have >=`minCards`, announce a name for every
 *  card (honest count), name >=2 of them truthfully, and never give (or announce)
 *  a non-tradable calamity. Bluffs — announced names not actually given — are
 *  legal for the remaining cards. Returns an error string or null. */
function validateBundle(s: GameState, owner: PlayerId, b: { actual: Record<string, number>; declared: Record<string, number> }, minCards: number): string | null {
  const hand = player(s, owner).hand;
  if (bundleSize(b.actual) < minCards) return `bundle must have at least ${minCards} cards`;
  if (!isSubMultiset(b.actual, hand)) return `${owner} does not hold the offered cards`;
  for (const card of Object.keys(b.actual)) {
    if ((b.actual[card] ?? 0) > 0 && !isGivable(card)) return `${card} is a non-tradable calamity and may not be traded`;
  }
  // Announced names must be real tradable card ids (commodities or tradable calamities).
  for (const card of Object.keys(b.declared)) {
    if ((b.declared[card] ?? 0) > 0 && !commodityById.get(card) && !isGivable(card)) return `cannot announce ${card}`;
  }
  if (bundleSize(b.declared) !== bundleSize(b.actual)) return 'must announce a name for every card you give (honest count, §28.3)';
  if (truthfulCount(b.declared, b.actual) < 2) return 'at least two announced cards must be truthful (§28.3)';
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

/** Collect one player's tax: each city costs `rate` tokens from stock → treasury
 *  (§19.1). If stock can't cover every city, the unpayable cities revolt (§19.31)
 *  — unless the player holds Democracy, whose cities never revolt (§19.34). */
function collectTax(s: GameState, id: PlayerId, rate: number): void {
  const p = player(s, id);
  const cities = cityCount(s, id);
  const r = Math.max(1, Math.min(3, Math.trunc(rate)));
  p.taxRate = r; // remembered as the default for next turn's prompt
  const cost = cities * r;
  if (p.stock >= cost || has(p, 'democracy')) {
    const collected = Math.min(p.stock, cost);
    p.stock -= collected; p.treasury += collected;
    if (collected > 0) s.log.push(`${id} collected ${collected} tax (rate ${r}) from ${cities} cities.`);
    return;
  }
  // §19.31: pay for as many cities as stock allows; the remainder revolt — but
  // revolts are resolved only AFTER every player has paid, so record them now.
  const payable = Math.floor(p.stock / r);
  const collected = payable * r;
  p.stock -= collected; p.treasury += collected;
  const revolting = cities - payable;
  (s.pendingRevolts ??= {})[id] = revolting;
  s.log.push(`${id} could only pay tax for ${payable}/${cities} cities (rate ${r}) — ${revolting} will revolt (§19.31).`);
}

/** §19.31-.33: resolve all recorded tax revolts once every player has paid, in
 *  A.S.T. order. Each revolting city is taken over by the highest-reserve rival
 *  with a city to spare, else it collapses to tokens. */
function resolvePendingRevolts(s: GameState): void {
  const pending = s.pendingRevolts;
  if (!pending) return;
  for (const id of astOrder(s)) {
    const n = pending[id] ?? 0;
    if (n > 0) resolveTaxRevolt(s, id, n);
  }
  s.pendingRevolts = {};
}

/** §19.32-.34: revolting cities are taken over by the player with the most units
 *  in stock (cities ×5, tokens ×1) who has a city available; if none can, the
 *  city is reduced to tokens (§19.33). */
function resolveTaxRevolt(s: GameState, owner: PlayerId, n: number): void {
  const reserves = (x: PlayerId) => player(s, x).stock + 5 * player(s, x).citiesAvailable;
  let remaining = n;
  for (const aid of Object.keys(s.areas)) {
    if (remaining <= 0) break;
    if (s.areas[aid]!.city !== owner) continue;
    const taker = s.seating
      .filter((o) => o !== owner && isPlayer(s, o) && player(s, o).citiesAvailable > 0)
      .sort((x, y) => reserves(y) - reserves(x))[0];
    delete s.areas[aid]!.city; player(s, owner).citiesAvailable += 1;
    if (taker) {
      s.areas[aid]!.city = taker; player(s, taker).citiesAvailable -= 1;
      s.log.push(`The revolting city in ${areaName(aid)} is taken over by ${taker} (§19.32).`);
    } else {
      const place = Math.min(areaLimitFor(s, aid, owner), player(s, owner).stock);
      if (place > 0) { s.areas[aid]!.tokens[owner] = (s.areas[aid]!.tokens[owner] ?? 0) + place; player(s, owner).stock -= place; }
      s.log.push(`The revolting city in ${areaName(aid)} collapses — no one could take it over (§19.33).`);
    }
    remaining -= 1;
  }
}

/** §19 taxation. Coinage holders WITH cities choose their rate (1-3) — they're
 *  left to act; everyone else is auto-taxed at rate 2 on phase entry. */
export function setupTaxation(s: GameState): void {
  s.pendingRevolts = {}; // revolts this phase accumulate here, resolved once all have paid
  for (const id of astOrder(s)) {
    const p = player(s, id);
    if (has(p, 'coinage') && cityCount(s, id) > 0) continue; // interactive — they pick the rate
    collectTax(s, id, 2);
    if (!s.actedThisPhase.includes(id)) s.actedThisPhase.push(id);
  }
}

/** Eligible growth per area for `id`: +1 where it has exactly 1 token, +2 where
 *  it has >=2 (§13). */
function growthCaps(s: GameState, id: PlayerId): Record<string, number> {
  const caps: Record<string, number> = {};
  for (const [aid, a] of Object.entries(s.areas)) {
    const t = a.tokens[id] ?? 0;
    if (t > 0) caps[aid] = t >= 2 ? 2 : 1;
  }
  return caps;
}

/** §13 population growth. If a player has enough stock, all growth is applied
 *  automatically. If not, the growth is left for the player to *place* their
 *  limited stock where they choose (interactive), via `placeTokens`. */
function setupPopulationExpansion(s: GameState): void {
  s.expansion = { remaining: {}, caps: {} };
  for (const id of s.seating) {
    const p = player(s, id);
    const caps = growthCaps(s, id);
    const needed = Object.values(caps).reduce((a, b) => a + b, 0);
    if (p.stock >= needed) {
      for (const [aid, cap] of Object.entries(caps)) { s.areas[aid]!.tokens[id] = (s.areas[aid]!.tokens[id] ?? 0) + cap; p.stock -= cap; }
      if (!s.actedThisPhase.includes(id)) s.actedThisPhase.push(id);
    } else if (p.stock <= 0) {
      if (!s.actedThisPhase.includes(id)) s.actedThisPhase.push(id); // nothing to place
    } else {
      s.expansion.remaining[id] = p.stock;
      s.expansion.caps[id] = caps;
    }
  }
}

function applyPlaceTokens(s: GameState, actor: PlayerId, placements: Record<string, number>): void {
  const exp = s.expansion;
  const caps = exp?.caps[actor];
  let rem = exp?.remaining[actor] ?? 0;
  const p = player(s, actor);
  if (!caps) throw new Error('no growth to place');
  for (const [aid, n] of Object.entries(placements)) {
    if (n <= 0) continue;
    if ((caps[aid] ?? 0) < n) throw new Error(`exceeds growth capacity in ${aid}`);
    if (n > rem || n > p.stock) throw new Error('not enough stock to place');
    s.areas[aid]!.tokens[actor] = (s.areas[aid]!.tokens[actor] ?? 0) + n;
    p.stock -= n; caps[aid] = (caps[aid] ?? 0) - n; rem -= n;
  }
  exp!.remaining[actor] = rem;
  if (rem <= 0 || Object.values(caps).every((c) => c <= 0)) { if (!s.actedThisPhase.includes(actor)) s.actedThisPhase.push(actor); }
}

function runCensus(s: GameState): void {
  for (const id of s.seating) player(s, id).census = populationCount(s, id);
  s.censusOrder = s.activeOrder = censusOrder(s);
  s.actedThisPhase = [];
}

const hasMil = (s: GameState, id: PlayerId) => isPlayer(s, id) && has(player(s, id), 'military');

/** §32.831: Military holders move (and build ships) AFTER non-Military players;
 *  within each group the census order is preserved (Array#sort is stable). */
export function militaryLast(s: GameState, order: PlayerId[]): PlayerId[] {
  return [...order].sort((a, b) => (hasMil(s, a) ? 1 : 0) - (hasMil(s, b) ? 1 : 0));
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
  const combats: CombatEvent[] = [];
  for (const [aid, a] of Object.entries(s.areas)) {
    const owners = Object.keys(a.tokens).filter((o) => (a.tokens[o] ?? 0) > 0);
    const enemyAtCity = a.city != null && owners.some((o) => o !== a.city);
    if (owners.length >= 2 || enemyAtCity) resolveAreaCombat(s, aid, rng, combats);
  }
  s.lastCombats = combats; // surfaced for the step-through combat modal
  s.rngState = rng.serialize();
}

/** Forces present in an area (token owners + the city owner), for combat display. */
function forcesIn(s: GameState, aid: string): CombatForce[] {
  const a = s.areas[aid];
  if (!a) return [];
  const ids = new Set<string>();
  for (const [o, n] of Object.entries(a.tokens)) if (n > 0) ids.add(o);
  if (a.city) ids.add(a.city);
  return [...ids].map((id) => ({ id, tokens: a.tokens[id] ?? 0, city: a.city === id }));
}

const pname = (s: GameState, id: PlayerId) => id === BARBARIAN ? 'Barbarians' : id === PIRATE ? 'Pirates' : civById.get(id)?.name ?? id;

/** Rules that shape an area's combat (Metalworking removal order, Engineering
 *  city-assault thresholds), as human-readable strings. */
function combatModifiers(s: GameState, aid: string): string[] {
  const a = s.areas[aid]!;
  const out: string[] = [];
  const owners = Object.keys(a.tokens).filter((o) => (a.tokens[o] ?? 0) > 0);
  const metal = owners.filter((o) => hasMetal(s, o));
  if (metal.length && metal.length < owners.length) {
    out.push(`Metalworking — ${metal.map((o) => pname(s, o)).join(', ')} lose tokens last (§32.231)`);
  }
  if (a.city) {
    const attackers = owners.filter((o) => o !== a.city);
    if (attackers.length === 1) {
      const atk = attackers[0]!, def = a.city;
      const ae = hasEng(s, atk), de = hasEng(s, def);
      const thr = ae && !de ? 6 : de && !ae ? 8 : 7;
      out.push(`City assault — ${thr} tokens needed to take ${pname(s, def)}’s city${ae ? ', attacker has Engineering' : ''}${de ? ', defender has Engineering' : ''} (§24.35)`);
    } else if (a.pirateCity) {
      out.push('Pirate city — 7 tokens needed to storm it (§24.34)');
    }
  }
  return out;
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
function resolveAreaCombat(s: GameState, aid: string, rng: Rng, combats?: CombatEvent[]): void {
  const a = s.areas[aid]!;
  const area = areaById.get(aid);
  const limit = a.city ? 0 : (area?.sustains ?? 0);
  const before = forcesIn(s, aid);
  const modifiers = combatModifiers(s, aid);
  const logLen = s.log.length;
  if (Object.keys(a.tokens).filter((o) => (a.tokens[o] ?? 0) > 0).length >= 2) {
    resolveTokenCombat(s, aid, limit);
  }
  if (a.city) {
    const attackers = Object.keys(a.tokens).filter((o) => o !== a.city && (a.tokens[o] ?? 0) > 0);
    if (attackers.length === 1) resolveCityAssault(s, aid, attackers[0]!, rng);
  }
  combats?.push({ area: aid, before, after: forcesIn(s, aid), modifiers, note: s.log.slice(logLen).join(' ') });
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
  // your first city is what starts the flow of trade cards. The player with the
  // FEWEST cities draws first (it matters once a stack runs dry), ties by the
  // turn's census order.
  const drawOrder = [...s.activeOrder].sort((a, b) => cityCount(s, a) - cityCount(s, b));
  for (const id of drawOrder) {
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
/** Snapshot each area's city owner + token counts, for diffing calamity effects. */
function snapAreas(s: GameState): Record<string, { city?: PlayerId; tokens: Record<string, number> }> {
  const o: Record<string, { city?: PlayerId; tokens: Record<string, number> }> = {};
  for (const [aid, a] of Object.entries(s.areas)) o[aid] = { city: a.city, tokens: { ...a.tokens } };
  return o;
}
/** Human-readable, area-by-area account of what a calamity did to `holder`
 *  (cities lost/seized, tokens removed, defections, barbarians/pirates). */
/** Per-player board summary (cities / tokens), for the calamity start/end overview. */
function boardOverview(s: GameState): string {
  return s.seating.map((id) => `${pname(s, id)}: ${cityCount(s, id)} cit, ${populationCount(s, id)} tok`).join(' · ');
}

/** Diff the board before/after a calamity into attributed steps — primary victim
 *  first, then secondary victims (player !== holder), so the modal can show who
 *  is affected and why. */
function calamitySteps(s: GameState, before: ReturnType<typeof snapAreas>, holder: PlayerId): CalamityStep[] {
  const nm = (aid: string) => areaById.get(aid)?.name ?? aid;
  const steps: CalamityStep[] = [];
  for (const aid of new Set([...Object.keys(before), ...Object.keys(s.areas)])) {
    const b = before[aid] ?? { tokens: {} as Record<string, number> };
    const a = s.areas[aid] ?? { tokens: {} as Record<string, number> };
    if (b.city && isPlayer(s, b.city) && a.city !== b.city) {
      const owner = b.city;
      const text = a.city && a.city !== BARBARIAN && a.city !== PIRATE ? `City in ${nm(aid)} seized by ${pname(s, a.city)}`
        : a.city === PIRATE ? `City in ${nm(aid)} fell to pirates`
        : `Lost the city in ${nm(aid)}`;
      steps.push({ text, player: owner, secondary: owner !== holder });
    }
    for (const o of new Set([...Object.keys(b.tokens), ...Object.keys(a.tokens)])) {
      const d = (b.tokens[o] ?? 0) - (a.tokens[o] ?? 0);
      if (isPlayer(s, o)) {
        if (d > 0) steps.push({ text: `${pname(s, o)} loses ${d} token${d === 1 ? '' : 's'} in ${nm(aid)}`, player: o, secondary: o !== holder });
      } else if (o === BARBARIAN && -d > 0 && b.city !== holder) {
        steps.push({ text: `Barbarians (${-d}) appear in ${nm(aid)}` });
      }
    }
  }
  return steps.sort((x, y) => Number(x.secondary ?? false) - Number(y.secondary ?? false)).slice(0, 40);
}

/** The next held calamity to resolve, in ascending severity (§29.6). Resolved
 *  cards are removed from hands, so this naturally advances. */
function nextHeldCalamity(s: GameState): { calamityId: string; holder: PlayerId } | null {
  let best: { calamityId: string; holder: PlayerId; sev: number } | null = null;
  for (const id of s.seating) {
    for (const card of Object.keys(player(s, id).hand)) {
      if (!card.startsWith('calamity:') || (player(s, id).hand[card] ?? 0) <= 0) continue;
      const calamityId = card.slice('calamity:'.length);
      const sev = calamityById.get(calamityId)?.severity ?? 0;
      if (!best || sev < best.sev) best = { calamityId, holder: id, sev };
    }
  }
  return best ? { calamityId: best.calamityId, holder: best.holder } : null;
}

/** Record one calamity's outcome (before→now diff) for the step-through modal. */
function pushCalamityEvent(s: GameState, calamityId: string, holder: PlayerId, before: ReturnType<typeof snapAreas>, overviewBefore: string, interactive = false): void {
  (s.lastCalamities ??= []).push({
    calamity: calamityById.get(calamityId)?.name ?? calamityId,
    calamityId,
    description: CALAMITY_DESC[calamityId] ?? '',
    holder,
    steps: calamitySteps(s, before, holder),
    overviewBefore,
    overviewAfter: boardOverview(s),
    interactive,
  });
}

/** Resolve held calamities in severity order (§29.6). Each one's primary effect
 *  applies immediately; if it then needs the primary victim to direct secondary
 *  losses (§29.64), resolution PAUSES with a pendingAllocation for an
 *  `allocateLoss` action and resumes afterwards. Re-entrant. */
/** Resolve a calamity's PRIMARY effect. Returns true if it paused for a player
 *  choice (city reduction §30.321 or unit loss/cede §29.63), false if it applied
 *  immediately (fully-auto calamities, or no effect). */
function startPrimary(s: GameState, calId: string, holder: PlayerId, before: ReturnType<typeof snapAreas>, overviewBefore: string, rng: Rng): boolean {
  // City-reduction calamities — the victim picks which cities (§30.321/.711/.811).
  const cityCut = primaryCityCount(s, calId, holder);
  if (cityCut !== null) {
    const n = Math.min(cityCut, cityCount(s, holder));
    if (n > 0) { s.pendingCityChoice = { calamityId: calId, holder, count: n, before, overviewBefore }; return true; }
    return false;
  }
  const p = player(s, holder);
  // Unit-loss calamities — the victim picks which units (§29.63).
  if (calId === 'famine' || calId === 'epidemic') {
    let points: number;
    if (calId === 'famine') {
      // §30.312: Pottery commits 1 Grain card per 4 points to soften the 10-point
      // loss; only as many as needed are used, and they lock until next turn.
      const grainUsed = has(p, 'pottery') ? Math.min(grainCards(p), Math.ceil(10 / 4)) : 0;
      if (grainUsed > 0) { p.grainLockedThisTurn = (p.grainLockedThisTurn ?? 0) + grainUsed; s.log.push(`${holder} commits ${grainUsed} Grain card${grainUsed === 1 ? '' : 's'} against Famine (locked until next turn, §30.312).`); }
      points = Math.max(0, 10 - 4 * grainUsed);
    } else {
      points = Math.max(0, 16 - (has(p, 'medicine') ? 8 : 0) + (has(p, 'roadbuilding') ? 5 : 0));
    }
    if (points > 0 && boardUnitPoints(s, holder) > 0) {
      s.pendingUnitLoss = { calamityId: calId, holder, points: Math.min(points, boardUnitPoints(s, holder)), cityWorth: calId === 'epidemic' ? 4 : 5, mode: 'remove', before, overviewBefore };
      return true;
    }
    return false;
  }
  if (calId === 'flood') {
    const region = bestFloodRegion(s, holder);
    if (region) {
      const pts = Math.min(has(p, 'engineering') ? 7 : 17, unitPointsInAreas(s, holder, region));
      if (pts > 0) { s.pendingUnitLoss = { calamityId: 'flood', holder, points: pts, cityWorth: 5, mode: 'remove', areas: region, before, overviewBefore }; return true; }
      return false;
    }
    return startFloodCity(s, holder, before, overviewBefore); // §30.514: the victim picks a coastal city
  }
  if (calId === 'civilwar') {
    return startCivilWar(s, holder, before, overviewBefore); // §30.41 multi-step split (pauses if a war occurs)
  }
  if (calId === 'treachery') return startTreachery(s, holder, before, overviewBefore); // §30.22: the trader picks the city
  if (calId === 'piracy') return startPiracy(s, holder, before, overviewBefore); // §30.91: trader/primary pick coastal cities
  applyCalamity(s, calId, holder, rng); // fully-auto calamities (Volcano, Slave Revolt, Barbarians)
  return false;
}

/** After a calamity's primary effect is settled, either pause for the secondary
 *  allocation (§29.64) or finalize the event and move on. Returns true if paused. */
function finishPrimary(s: GameState, calId: string, holder: PlayerId, before: ReturnType<typeof snapAreas>, overviewBefore: string, interactive: boolean): boolean {
  const alloc = secondaryAllocationFor(s, calId, holder);
  if (alloc) { s.pendingAllocation = { ...alloc, before, overviewBefore }; return true; }
  pushCalamityEvent(s, calId, holder, before, overviewBefore, interactive);
  return false;
}

/** After an interactive primary choice (city or unit), continue the calamity
 *  phase: pause for any secondary allocation, else resolve the rest. */
function resumeAfterChoice(s: GameState, calId: string, holder: PlayerId, before: ReturnType<typeof snapAreas>, overviewBefore: string): void {
  if (finishPrimary(s, calId, holder, before, overviewBefore, true)) return; // paused for allocation
  runCalamity(s);
  if (!s.calamityActive) setupCalamityConversion(s);
}

function runCalamity(s: GameState): void {
  const rng = Rng.fromState(s.rngState);
  if (!s.calamityActive) { s.calamityActive = true; s.lastCalamities = []; }
  let next: ReturnType<typeof nextHeldCalamity>;
  while ((next = nextHeldCalamity(s))) {
    const { calamityId, holder } = next;
    const before = snapAreas(s);
    const overviewBefore = boardOverview(s);
    // §29.7: the card leaves the hand and returns to the bottom of its stack.
    delete player(s, holder).hand[`calamity:${calamityId}`];
    const lvl = calamityById.get(calamityId)?.level;
    if (lvl && s.trade.stacks[lvl]) s.trade.stacks[lvl]!.unshift(`calamity:${calamityId}`);
    if (startPrimary(s, calamityId, holder, before, overviewBefore, rng)) { s.rngState = rng.serialize(); return; }
    if (finishPrimary(s, calamityId, holder, before, overviewBefore, false)) { s.rngState = rng.serialize(); return; }
  }
  // All calamities resolved.
  s.calamityActive = false;
  s.pendingCalamities = [];
  s.calamityTradedFrom = {};
  s.rngState = rng.serialize();
  checkCitySupport(s); // §26.5
}

/** Commodity-card count in a hand (calamities don't count toward the limit). */
function commodityCardCount(hand: Record<string, number>): number {
  return Object.entries(hand).reduce((t, [c, n]) => t + (!isCalamityCard(c) && n > 0 ? n : 0), 0);
}

/** §31.71 default: the lowest-value `count` commodity cards (cheapest to lose). */
function suggestDiscard(s: GameState, holder: PlayerId, count: number): string[] {
  const hand = player(s, holder).hand;
  const cards = Object.entries(hand)
    .filter(([c, n]) => !isCalamityCard(c) && n > 0)
    .flatMap(([c, n]) => Array<string>(n).fill(c))
    .sort((a, b) => (commodityById.get(a)?.value ?? 0) - (commodityById.get(b)?.value ?? 0));
  return cards.slice(0, count);
}

/** Surrender the chosen commodity cards to the bottom of their stacks. */
function applyDiscard(s: GameState, holder: PlayerId, cards: string[]): void {
  const p = player(s, holder);
  for (const c of cards) {
    p.hand[c] = (p.hand[c] ?? 0) - 1;
    if ((p.hand[c] ?? 0) <= 0) delete p.hand[c];
    const stack = commodityById.get(c)?.stack;
    if (stack && s.trade.stacks[stack]) s.trade.stacks[stack]!.unshift(c);
  }
  s.log.push(`${holder} discards ${cards.length} surplus commodity card${cards.length === 1 ? '' : 's'}, keeping 8 (§31.71).`);
}

/** §31.71: after buying advances, each player may keep at most 8 commodity cards;
 *  the excess (the player's choice) is surrendered to the bottom of its stack.
 *  Pauses for the first over-limit player via `pendingDiscard`; returns true when
 *  it paused so the caller stops and waits for the choice. */
function enforceHandLimit(s: GameState): boolean {
  for (const id of s.seating) {
    const over = commodityCardCount(player(s, id).hand) - 8;
    if (over > 0) { s.pendingDiscard = { holder: id, count: over }; return true; }
  }
  return false;
}

function runAstAdjustment(s: GameState): void {
  if (enforceHandLimit(s)) return; // §31.71: pause for any over-limit discard choice first
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

/** Order `pool` unit points of loss among the primary's rivals (§29.64), at most
 *  `perCap` from any one player, never the trader (§29.6). Targets the strongest
 *  rivals first. */
/** §29.64: build the secondary-victim allocation a primary victim must direct —
 *  Famine (20 unit pts, ≤8 each), Epidemic (25, ≤10), Iconoclasm (2 cities, ≤1 for
 *  Philosophy holders, Theology immune). Returns null if there's nothing to order. */
type AllocationSpec = Omit<PendingAllocation, 'before' | 'overviewBefore'>;
function secondaryAllocationFor(s: GameState, calId: string, holder: PlayerId): AllocationSpec | null {
  const trader = s.calamityTradedFrom[calId];
  const rivals = s.seating.filter((o) => o !== holder && o !== trader);
  if (calId === 'famine' || calId === 'epidemic') {
    const pool = calId === 'famine' ? 20 : 25;
    const per = calId === 'famine' ? 8 : 10;
    const cityWorth = calId === 'epidemic' ? 4 : 5;
    const caps: Record<PlayerId, number> = {};
    for (const v of rivals) { const c = Math.min(per, boardUnitPoints(s, v)); if (c > 0) caps[v] = c; }
    return Object.keys(caps).length ? { calamityId: calId, holder, kind: 'unitPoints', pool, caps, cityWorth } : null;
  }
  if (calId === 'iconoclasm') {
    const caps: Record<PlayerId, number> = {};
    for (const v of rivals) {
      if (has(player(s, v), 'theology')) continue; // §30.819 immune
      const c = Math.min(has(player(s, v), 'philosophy') ? 1 : 2, cityCount(s, v));
      if (c > 0) caps[v] = c;
    }
    return Object.keys(caps).length ? { calamityId: calId, holder, kind: 'cities', pool: 2, caps, cityWorth: 5 } : null;
  }
  return null;
}

/** The most a primary victim can actually distribute (pool, capped by total caps). */
function maxAllocatable(a: PendingAllocation): number {
  return Math.min(a.pool, Object.values(a.caps).reduce((t, c) => t + c, 0));
}

/** A sensible default allocation: hit the current leader(s) first, fill to the max. */
function suggestAllocation(s: GameState, a: PendingAllocation): Record<PlayerId, number> {
  const out: Record<PlayerId, number> = {};
  let left = maxAllocatable(a);
  const order = Object.keys(a.caps).sort((x, y) => victoryScore(s, y) - victoryScore(s, x));
  for (const v of order) { if (left <= 0) break; const take = Math.min(a.caps[v]!, left); if (take > 0) { out[v] = take; left -= take; } }
  return out;
}

/** §29.64: the allocation must distribute the full required amount (pool, capped
 *  by total caps), with each rival within its cap and eligible. */
function validateAllocation(a: PendingAllocation, allocation: Record<PlayerId, number>): void {
  let sum = 0;
  for (const [v, amt] of Object.entries(allocation)) {
    if (!Number.isInteger(amt) || amt < 0) throw new Error(`bad allocation amount for ${v}`);
    if (amt === 0) continue;
    if (!(v in a.caps)) throw new Error(`${v} is not an eligible secondary victim`);
    if (amt > a.caps[v]!) throw new Error(`${v} can lose at most ${a.caps[v]} (§30)`);
    sum += amt;
  }
  if (sum !== maxAllocatable(a)) throw new Error(`must direct ${maxAllocatable(a)} (got ${sum}) — §29.64`);
}

/** Turn a primary's directed allocation into a queue of per-victim losses. The
 *  Epidemic per-victim Medicine/Roadbuilding adjustment (§30.613-.614) is folded
 *  into each amount here. Each victim then chooses their OWN units (§30.311/.512/
 *  .611/.818) — they are not auto-removed. */
function secondaryLossesFromAllocation(s: GameState, a: PendingAllocation, allocation: Record<PlayerId, number>): SecondaryLoss[] {
  const out: SecondaryLoss[] = [];
  for (const [v, amt] of Object.entries(allocation)) {
    if (amt <= 0) continue;
    if (a.kind === 'cities') {
      out.push({ victim: v, kind: 'cities', amount: amt, cityWorth: a.cityWorth });
    } else {
      let actual = amt;
      if (a.calamityId === 'epidemic') { if (has(player(s, v), 'medicine')) actual -= 5; if (has(player(s, v), 'roadbuilding')) actual += 5; }
      out.push({ victim: v, kind: 'unitPoints', amount: Math.max(0, actual), cityWorth: a.cityWorth, areas: a.areas });
    }
  }
  return out;
}

/** Drive the secondary-victim queue: pause for the next victim's own which-units
 *  choice (§30.311/.512/.611/.818), skipping any with nothing to lose. When the
 *  queue is empty, finalize the calamity event and resume the calamity phase. */
function startNextSecondary(s: GameState): void {
  const ps = s.pendingSecondary!;
  while (ps.queue.length) {
    const head = ps.queue[0]!;
    if (head.kind === 'cities') {
      const n = Math.min(head.amount, cityCount(s, head.victim));
      if (n > 0) { s.pendingCityChoice = { calamityId: ps.calamityId, holder: head.victim, count: n, before: ps.before, overviewBefore: ps.overviewBefore }; return; }
    } else {
      const avail = head.areas ? unitPointsInAreas(s, head.victim, head.areas) : boardUnitPoints(s, head.victim);
      const points = Math.min(head.amount, avail);
      if (points > 0) { s.pendingUnitLoss = { calamityId: ps.calamityId, holder: head.victim, points, cityWorth: head.cityWorth, mode: 'remove', areas: head.areas, before: ps.before, overviewBefore: ps.overviewBefore }; return; }
    }
    ps.queue.shift(); // this victim has nothing to lose — skip
  }
  // All secondary victims resolved — finalize and resume.
  const { calamityId, primary, before, overviewBefore } = ps;
  s.pendingSecondary = undefined;
  pushCalamityEvent(s, calamityId, primary, before, overviewBefore, true);
  runCalamity(s);
  if (!s.calamityActive) setupCalamityConversion(s);
}

const grainCards = (p: { hand: Record<string, number> }) => p.hand['grain'] ?? 0;

/** Famine (§30.31): primary loses 10 unit points (Pottery −4 per Grain card held,
 *  §30.312), then orders 20 among rivals, ≤8 each (§30.311). */
/** A player's units available to give up, optionally confined to `areas`. */
function unitInventory(s: GameState, holder: PlayerId, areas?: string[]): { tokens: Record<string, number>; cities: string[] } {
  const ids = areas ?? Object.keys(s.areas);
  const tokens: Record<string, number> = {};
  const cities: string[] = [];
  for (const aid of ids) { const a = s.areas[aid]; if (!a) continue; if ((a.tokens[holder] ?? 0) > 0) tokens[aid] = a.tokens[holder]!; if (a.city === holder) cities.push(aid); }
  return { tokens, cities };
}

/** §30.612: Epidemic must leave at least one token in each area it removes from,
 *  so an area's removable tokens are one fewer than it holds. */
function removableTokens(n: number, epidemic: boolean): number {
  return epidemic ? Math.max(0, n - 1) : n;
}

/** Max unit points a player can shed (capped by what they have in scope). */
function maxUnitLoss(s: GameState, u: PendingUnitLoss): number {
  const inv = unitInventory(s, u.holder, u.areas);
  const epi = u.calamityId === 'epidemic';
  const tok = Object.values(inv.tokens).reduce((t, n) => t + removableTokens(n, epi), 0);
  return Math.min(u.points, tok + inv.cities.length * u.cityWorth);
}

/** Default unit sacrifice (AI & suggestion): give up the cheapest units first —
 *  tokens before cities — so cities are preserved. Epidemic leaves one token per
 *  area (§30.612). */
function suggestUnits(s: GameState, u: PendingUnitLoss): { tokens: Record<string, number>; cities: string[] } {
  const inv = unitInventory(s, u.holder, u.areas);
  const epi = u.calamityId === 'epidemic';
  let need = maxUnitLoss(s, u);
  const tokens: Record<string, number> = {};
  for (const [aid, n] of Object.entries(inv.tokens).sort((a, b) => a[1] - b[1])) { if (need <= 0) break; const take = Math.min(removableTokens(n, epi), need); if (take > 0) { tokens[aid] = take; need -= take; } }
  const cities: string[] = [];
  for (const aid of inv.cities) { if (need <= 0) break; cities.push(aid); need -= u.cityWorth; }
  return { tokens, cities };
}

/** §29.63: the chosen sacrifice must cover the required loss with no needless
 *  excess (overshoot smaller than a city's worth) and stay within what's owned. */
function validateUnits(s: GameState, u: PendingUnitLoss, choice: { tokens: Record<string, number>; cities: string[] }): void {
  const inv = unitInventory(s, u.holder, u.areas);
  const epi = u.calamityId === 'epidemic';
  let sum = 0;
  for (const [aid, n] of Object.entries(choice.tokens)) {
    if (n <= 0) continue;
    if (!(aid in inv.tokens)) throw new Error(`no tokens of yours in ${areaName(aid)}`);
    if (n > inv.tokens[aid]!) throw new Error(`only ${inv.tokens[aid]} tokens in ${areaName(aid)}`);
    if (epi && n > inv.tokens[aid]! - 1) throw new Error(`Epidemic must leave at least one token in ${areaName(aid)} (§30.612)`);
    sum += n;
  }
  for (const aid of choice.cities) { if (!inv.cities.includes(aid)) throw new Error(`no city of yours in ${areaName(aid)}`); sum += u.cityWorth; }
  const need = maxUnitLoss(s, u);
  if (sum < need) throw new Error(`give up ${need} unit points (got ${sum}) — §29.63`);
  if (sum - need >= u.cityWorth) throw new Error(`giving up more than required — §29.63`);
}

/** Apply the chosen sacrifice: remove (→ stock, cities reduced/substituted) or
 *  cede (→ beneficiary), then the per-calamity follow-up (Flood secondary,
 *  Military Civil-War bloodshed). */
function applyChosenUnits(s: GameState, u: PendingUnitLoss, choice: { tokens: Record<string, number>; cities: string[] }): void {
  if (u.mode === 'remove') {
    for (const [aid, n] of Object.entries(choice.tokens)) { if (n > 0) { setTokens(s, aid, u.holder, (s.areas[aid]!.tokens[u.holder] ?? 0) - n); player(s, u.holder).stock += n; } }
    // §30.612: an Epidemic-eliminated city is replaced by exactly ONE token (so it
    // counts as 4 points); other calamities replace it up to the area's limit.
    for (const aid of choice.cities) {
      if (u.calamityId === 'epidemic') {
        delete s.areas[aid]!.city; player(s, u.holder).citiesAvailable += 1;
        if (player(s, u.holder).stock > 0) { s.areas[aid]!.tokens[u.holder] = (s.areas[aid]!.tokens[u.holder] ?? 0) + 1; player(s, u.holder).stock -= 1; }
      } else reduceSpecificCity(s, u.holder, aid);
    }
    s.log.push(`${u.holder} suffers ${calamityById.get(u.calamityId)?.name ?? u.calamityId} (-${u.points} unit point${u.points === 1 ? '' : 's'}).`);
    // Flood's secondary loss (§30.512) is directed by the primary — set up as an
    // interactive allocation in the chooseUnits handler, not applied here.
  } else {
    const ben = u.beneficiary!;
    for (const [aid, n] of Object.entries(choice.tokens)) {
      for (let i = 0; i < n; i++) {
        setTokens(s, aid, u.holder, (s.areas[aid]!.tokens[u.holder] ?? 0) - 1); player(s, u.holder).stock += 1;
        if (player(s, ben).stock > 0) { s.areas[aid]!.tokens[ben] = (s.areas[aid]!.tokens[ben] ?? 0) + 1; player(s, ben).stock -= 1; }
      }
    }
    for (const aid of choice.cities) {
      delete s.areas[aid]!.city; player(s, u.holder).citiesAvailable += 1;
      if (player(s, ben).citiesAvailable > 0) { s.areas[aid]!.city = ben; player(s, ben).citiesAvailable -= 1; }
    }
    s.log.push(`${u.holder} suffers Civil War: a faction worth ${u.points} defects to ${ben}.`);
    if (has(player(s, u.holder), 'military')) {
      removeTokensFromBoard(s, u.holder, 5); removeTokensFromBoard(s, ben, 5);
      s.log.push(`Military makes the Civil War bloodier — both factions lose 5 (§30.414).`);
    }
  }
}

/** Superstition (§30.32): 3 cities reduced — but the highest Religion card held
 *  governs: Mysticism → 2, Deism → 1, Enlightenment → 0 (not cumulative). */
/** Cities the primary victim must reduce, where the rules let them CHOOSE which:
 *  Superstition (§30.321), Civil Disorder (§30.711), Iconoclasm (§30.811). Returns
 *  null for calamities that aren't a free-choice city reduction. */
function primaryCityCount(s: GameState, calId: string, holder: PlayerId): number | null {
  const p = player(s, holder);
  if (calId === 'superstition') {
    if (has(p, 'enlightenment')) return 0;
    if (has(p, 'deism')) return 1;
    if (has(p, 'mysticism')) return 2;
    return 3;
  }
  if (calId === 'civildisorder') {
    const cities = cityCount(s, holder);
    let r = Math.max(0, cities - 3);
    r -= (has(p, 'music') ? 1 : 0) + (has(p, 'drama') ? 1 : 0) + (has(p, 'law') ? 1 : 0) + (has(p, 'democracy') ? 1 : 0);
    r += (has(p, 'military') ? 1 : 0) + (has(p, 'roadbuilding') ? 1 : 0);
    return Math.max(0, Math.min(r, cities));
  }
  if (calId === 'iconoclasm') {
    let n = 4;
    if (has(p, 'law')) n -= 1;
    if (has(p, 'philosophy')) n -= 1;
    if (has(p, 'theology')) n -= 3;
    if (has(p, 'monotheism')) n += 1;
    if (has(p, 'roadbuilding')) n += 1;
    return Math.max(0, n);
  }
  return null;
}

/** A sensible default city sacrifice: give up city-site cities first (cheapest to
 *  rebuild, 6 vs 12 tokens), then by area. */
function suggestCities(s: GameState, holder: PlayerId, count: number): string[] {
  return Object.keys(s.areas)
    .filter((aid) => s.areas[aid]!.city === holder)
    .sort((x, y) => (areaById.get(x)?.isCitySite ? 0 : 1) - (areaById.get(y)?.isCitySite ? 0 : 1))
    .slice(0, count);
}

/** Reduce the specific cities the primary victim chose (§26.41 substitution). */
function reduceChosenCities(s: GameState, holder: PlayerId, areas: string[]): void {
  for (const aid of areas) reduceSpecificCity(s, holder, aid);
}

/** Volcano / Earthquake (§30.21): destroys the largest area; but a holder of
 *  Engineering suffers an earthquake that merely reduces one city (§30.213). */
/** §4.41: the three volcanoes — Vesuvius and Etna each touch two areas, the
 *  Aegean volcano (Thera) one. (Adjacency can't distinguish the two Sicilian/
 *  mainland pairs, so the grouping is fixed here.) */
const VOLCANO_GROUPS: readonly (readonly string[])[] = [
  ['campania', 'neapolis'], // Vesuvius
  ['milazzo', 'syracus'],   // Etna
  ['thera'],                // Aegean (§4.41)
];

/** Contiguous flood-plain regions (§4.42): connected components of floodplain
 *  areas. Computed once — the map is static. */
let _floodRegions: string[][] | null = null;
function floodRegions(): string[][] {
  if (_floodRegions) return _floodRegions;
  const fp = [...areaById.values()].filter((a) => a.isFloodplain).map((a) => a.id);
  const set = new Set(fp), seen = new Set<string>(), out: string[][] = [];
  for (const id of fp) {
    if (seen.has(id)) continue;
    const stack = [id], comp: string[] = []; seen.add(id);
    while (stack.length) { const x = stack.pop()!; comp.push(x); for (const n of neighbors(x)) if (set.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); } }
    out.push(comp);
  }
  _floodRegions = out;
  return out;
}

/** Unit points a player has across the given areas (token = 1, city = 5). */
function unitPointsInAreas(s: GameState, owner: PlayerId, areaIds: readonly string[]): number {
  let pts = 0;
  for (const aid of areaIds) { const a = s.areas[aid]; if (!a) continue; pts += a.tokens[owner] ?? 0; if (a.city === owner) pts += 5; }
  return pts;
}

/** Remove up to `points` of a player's unit points confined to `areaIds` (tokens
 *  first, then cities eliminated — no token substitution). Returns points removed. */
function removeUnitPointsInAreas(s: GameState, owner: PlayerId, areaIds: readonly string[], points: number, cityWorth = 5): number {
  const before = unitPointsInAreas(s, owner, areaIds);
  let remaining = points;
  for (const aid of areaIds) {
    if (remaining <= 0) break;
    const t = s.areas[aid]?.tokens[owner] ?? 0;
    const take = Math.min(t, remaining);
    if (take > 0) { setTokens(s, aid, owner, t - take); player(s, owner).stock += take; remaining -= take; }
  }
  for (const aid of areaIds) {
    if (remaining <= 0) break;
    if (s.areas[aid]?.city === owner) { delete s.areas[aid]!.city; player(s, owner).citiesAvailable += 1; remaining -= cityWorth; }
  }
  return before - unitPointsInAreas(s, owner, areaIds);
}

/** Eliminate one of a player's coastal cities (no token substitution). */
function eliminateOneCoastalCity(s: GameState, owner: PlayerId): boolean {
  for (const [aid, a] of Object.entries(s.areas)) {
    if (a.city === owner && isCoastal(aid)) { delete a.city; player(s, owner).citiesAvailable += 1; return true; }
  }
  return false;
}

/** Reduce one specific city to tokens (§26.41 substitution, Agriculture +1). */
function reduceSpecificCity(s: GameState, owner: PlayerId, aid: string): void {
  const a = s.areas[aid];
  if (!a || a.city !== owner) return;
  delete a.city; player(s, owner).citiesAvailable += 1;
  const place = Math.min(areaLimitFor(s, aid, owner), player(s, owner).stock);
  if (place > 0) { a.tokens[owner] = (a.tokens[owner] ?? 0) + place; player(s, owner).stock -= place; }
}

/** Destroy every unit (any owner) in the given areas — players' pieces return to
 *  stock; neutral (Barbarian/Pirate) pieces vanish (§30.211). */
function destroyAllInAreas(s: GameState, areaIds: readonly string[]): void {
  for (const aid of areaIds) {
    const a = s.areas[aid];
    if (!a) continue;
    for (const [o, n] of Object.entries(a.tokens)) { if (n > 0 && isPlayer(s, o)) player(s, o).stock += n; delete a.tokens[o]; }
    if (a.city) { if (isPlayer(s, a.city)) player(s, a.city).citiesAvailable += 1; delete a.city; delete a.pirateCity; }
  }
}

/** Volcanic Eruption / Earthquake (§30.21). A city in a volcano's area triggers
 *  an eruption that wipes every unit in that volcano's areas (§30.211). Otherwise
 *  it's an earthquake: one of the victim's cities is destroyed (Engineering merely
 *  reduces it, §30.213) and one adjacent enemy city is reduced (§30.212). */
function applyVolcanoEarthquake(s: GameState, holder: PlayerId): void {
  const eng = has(player(s, holder), 'engineering');
  const erupting = VOLCANO_GROUPS.filter((g) => g.some((aid) => s.areas[aid]?.city === holder));
  if (erupting.length) {
    // §30.211: choose the site causing the greatest damage to the primary and
    // secondary victims — count only players' pieces (neutral Barbarians/Pirates
    // don't count toward "damage").
    const damage = (g: readonly string[]) => g.reduce((m, aid) => {
      const a = s.areas[aid]; if (!a) return m;
      let pts = 0;
      for (const [o, n] of Object.entries(a.tokens)) if (isPlayer(s, o)) pts += n;
      if (a.city && isPlayer(s, a.city)) pts += 5;
      return m + pts;
    }, 0);
    const g = erupting.slice().sort((x, y) => damage(y) - damage(x))[0]!;
    destroyAllInAreas(s, g);
    s.log.push(`${holder} suffers a Volcanic Eruption — all units in ${g.map(areaName).join(' & ')} are destroyed (§30.211).`);
    return;
  }
  // Earthquake: destroy one of the holder's cities (prefer one with an adjacent
  // enemy city to maximise the §30.212 secondary effect).
  const myCities = Object.keys(s.areas).filter((aid) => s.areas[aid]!.city === holder);
  if (myCities.length === 0) { s.log.push(`${holder} suffers an Earthquake but holds no city to damage.`); return; }
  const enemyCityNear = (aid: string) => neighbors(aid).find((n) => { const c = s.areas[n]?.city; return !!c && c !== holder && isPlayer(s, c) && !has(player(s, c), 'engineering'); });
  const target = myCities.find((aid) => enemyCityNear(aid)) ?? myCities[0]!;
  if (eng) { reduceSpecificCity(s, holder, target); s.log.push(`${holder} suffers an Earthquake — Engineering reduces the city in ${areaName(target)} (§30.213).`); }
  else { delete s.areas[target]!.city; player(s, holder).citiesAvailable += 1; s.log.push(`${holder} suffers an Earthquake — the city in ${areaName(target)} is destroyed (§30.212).`); }
  const victimArea = enemyCityNear(target); // §30.213: an Engineering holder is never a secondary
  if (victimArea) { const o = s.areas[victimArea]!.city!; reduceSpecificCity(s, o, victimArea); s.log.push(`${o}'s city in ${areaName(victimArea)} is reduced by the Earthquake (§30.212).`); }
}

/** The flood plain (§30.51) where the victim has the most unit points, or null. */
function bestFloodRegion(s: GameState, holder: PlayerId): string[] | null {
  let best: string[] | null = null, bestPts = 0;
  for (const region of floodRegions()) { const pts = unitPointsInAreas(s, holder, region); if (pts > bestPts) { bestPts = pts; best = region; } }
  return best;
}

/** §30.512: the primary victim divides 10 unit points of secondary loss among
 *  rivals on the SAME flood plain (each rival capped at its points there, or 7
 *  with Engineering §30.515; the trader is exempt §29.61). Returns the directable
 *  allocation, or null if no rival has units on the flood plain. */
function floodAllocationSpec(s: GameState, holder: PlayerId, region: string[]): AllocationSpec | null {
  const trader = s.calamityTradedFrom['flood'];
  const caps: Record<PlayerId, number> = {};
  for (const v of s.seating) {
    if (v === holder || v === trader) continue;
    const onPlain = unitPointsInAreas(s, v, region);
    if (onPlain <= 0) continue;
    caps[v] = Math.min(onPlain, has(player(s, v), 'engineering') ? 7 : 10);
  }
  return Object.keys(caps).length ? { calamityId: 'flood', holder, kind: 'unitPoints', pool: 10, caps, cityWorth: 5 } : null;
}

/** Slave Revolt (§30.42): 15 tokens can't support cities (Mining +5, Enlightenment
 *  −5, cancelling if both, §30.423); cities are reduced one at a time until the
 *  rest are supportable by the remaining (unlocked) tokens. */
function applySlaveRevolt(s: GameState, holder: PlayerId): void {
  const p = player(s, holder);
  let lock = 15 + (has(p, 'mining') ? 5 : 0) - (has(p, 'enlightenment') ? 5 : 0);
  lock = Math.max(0, lock);
  let reduced = 0, guard = 0;
  while (guard++ < 100) {
    const cities = cityCount(s, holder);
    if (cities === 0) break;
    const supportable = Math.max(0, populationCount(s, holder) - lock);
    if (supportable >= 2 * cities) break;
    reduceCities(s, holder, 1, false);
    reduced += 1;
  }
  s.log.push(`${holder} suffers Slave Revolt: ${lock} tokens withheld from city support → ${reduced} cit${reduced === 1 ? 'y' : 'ies'} reduced.`);
}

/** Civil Disorder (§30.71): all but three cities reduced; the count drops by one
 *  for each of Music / Drama / Law / Democracy (§30.712) and rises by one for each
 *  of Military / Roadbuilding (§30.713/.714), cumulative. */

function applyCalamity(s: GameState, calId: string, holder: PlayerId, rng: Rng): void {
  const cal = calamityById.get(calId);
  if (!cal) return;
  // City-reduction (Superstition/Civil Disorder/Iconoclasm) and unit-loss
  // (Famine/Epidemic/Flood/Civil War) primaries are handled interactively in
  // runCalamity (the victim chooses which to lose). Only the fully-auto calamities
  // are applied here.
  switch (calId) {
    case 'volcano': return applyVolcanoEarthquake(s, holder);
    case 'slaverevolt': return applySlaveRevolt(s, holder);
    case 'barbarianhordes': return applyBarbarians(s, holder, rng);
    default: s.log.push(`${holder} suffers ${cal.name} (effect not modeled).`);
  }
}

/** Treachery (§30.22): one of the primary's cities is taken over by the player who
 *  traded the card to them (§30.221); if it was drawn (not traded), the city is
 *  instead reduced (§30.222). */
function applyTreachery(s: GameState, holder: PlayerId): void {
  const trader = s.calamityTradedFrom['treachery'];
  const aid = Object.keys(s.areas).find((a) => s.areas[a]!.city === holder);
  if (!aid) { s.log.push(`${holder} suffers Treachery but holds no city.`); return; }
  const a = s.areas[aid]!;
  const traded = !!(trader && trader !== holder && isPlayer(s, trader));
  delete a.city; player(s, holder).citiesAvailable += 1;
  if (traded && player(s, trader!).citiesAvailable > 0) {
    // §30.221: the city defects to the player who traded the card.
    a.city = trader!; player(s, trader!).citiesAvailable -= 1;
    s.log.push(`${holder} suffers Treachery: the city in ${areaName(aid)} defects to ${trader} (§30.221).`);
  } else if (traded) {
    // §30.221: traded, but the beneficiary has no spare city — the city is
    // ELIMINATED (removed from play, no tokens left in its place).
    s.log.push(`${holder} suffers Treachery: the city in ${areaName(aid)} is destroyed — ${trader} had no city to install (§30.221).`);
  } else {
    // §30.222: drawn and not traded — the city is merely REDUCED to tokens.
    const place = Math.min(areaLimitFor(s, aid, holder), player(s, holder).stock);
    if (place > 0) { a.tokens[holder] = (a.tokens[holder] ?? 0) + place; player(s, holder).stock -= place; }
    s.log.push(`${holder} suffers Treachery: the city in ${areaName(aid)} is reduced (§30.222).`);
  }
}

// ---- Calamity special cases ----------------------------------------------

/** Unit points a player has on the board (token = 1, city = 5). */
function boardUnitPoints(s: GameState, id: PlayerId): number {
  let pts = 0;
  for (const a of Object.values(s.areas)) { pts += a.tokens[id] ?? 0; if (a.city === id) pts += 5; }
  return pts;
}


// ---- Civil War (§30.41) --------------------------------------------------
// The victim's nation splits into two factions. The FIRST faction is selected
// jointly: the victim picks 15 (+Music/Drama/Democracy) unit points (§30.4121-2),
// then the beneficiary adds 20 of the victim's units (§30.4123) — or, under
// Philosophy, the beneficiary alone picks the whole 15-point first faction
// (§30.4124). The rest is the second faction (§30.413). Military removes 5 from
// each (§30.414). Finally the victim chooses which faction to keep; the
// beneficiary annexes the other, overflowing to the next player with the most
// stock if it runs out of pieces (§30.415).

const cwReserves = (s: GameState, id: PlayerId) => player(s, id).stock + 5 * player(s, id).citiesAvailable;

/** §30.411: the beneficiary is the rival with the most unit points in stock
 *  (token = 1, unplaced city = 5). Returns null if the victim holds the most
 *  (no Civil War). */
function civilWarBeneficiary(s: GameState, victim: PlayerId): PlayerId | null {
  let beneficiary: PlayerId | null = null, best = -1;
  for (const o of s.seating) { if (o === victim) continue; const v = cwReserves(s, o); if (v > best) { best = v; beneficiary = o; } }
  if (beneficiary == null || cwReserves(s, victim) >= best) return null;
  return beneficiary;
}

const unitSetPoints = (set: UnitSet) => Object.values(set.tokens).reduce((t, n) => t + n, 0) + set.cities.length * 5;

/** Pick ~`points` unit points from `inv`. `valuable` grabs cities first (the
 *  beneficiary wants the victim's best); otherwise tokens first (cheapest). */
function pickUnits(inv: UnitSet, points: number, valuable: boolean): UnitSet {
  const tokens: Record<string, number> = {}; const cities: string[] = []; let got = 0;
  const takeCities = () => { for (const aid of inv.cities) { if (got >= points) break; cities.push(aid); got += 5; } };
  const takeTokens = () => { for (const aid of Object.keys(inv.tokens)) { let n = inv.tokens[aid]!; while (n > 0 && got < points) { tokens[aid] = (tokens[aid] ?? 0) + 1; n--; got++; } } };
  if (valuable) { takeCities(); takeTokens(); } else { takeTokens(); takeCities(); }
  return { tokens, cities };
}

/** The victim's board units NOT already in `set`. */
function subtractSet(inv: UnitSet, set: UnitSet): UnitSet {
  const tokens: Record<string, number> = {};
  for (const [aid, n] of Object.entries(inv.tokens)) { const rem = n - (set.tokens[aid] ?? 0); if (rem > 0) tokens[aid] = rem; }
  const taken = new Set(set.cities);
  return { tokens, cities: inv.cities.filter((aid) => !taken.has(aid)) };
}

/** §30.414: Military removes `points` unit points from a faction (cheapest-first:
 *  tokens before cities), returning the victim's pieces to stock and shrinking
 *  the faction set accordingly. */
function militaryReduceFaction(s: GameState, victim: PlayerId, set: UnitSet, points: number): void {
  let need = points;
  for (const aid of Object.keys(set.tokens)) {
    while (need > 0 && (set.tokens[aid] ?? 0) > 0) {
      setTokens(s, aid, victim, (s.areas[aid]!.tokens[victim] ?? 0) - 1);
      player(s, victim).stock += 1; set.tokens[aid]! -= 1; need -= 1;
      if (set.tokens[aid] === 0) delete set.tokens[aid];
    }
  }
  while (need > 0 && set.cities.length) {
    const aid = set.cities.shift()!;
    if (s.areas[aid]?.city === victim) { delete s.areas[aid]!.city; player(s, victim).citiesAvailable += 1; }
    need -= 5;
  }
}

/** §30.415: the beneficiary replaces the victim's units in `set` with its own,
 *  overflowing to the next player with the most stock if it runs out. */
function annexFaction(s: GameState, victim: PlayerId, beneficiary: PlayerId, set: UnitSet): void {
  const takerForToken = () => [beneficiary, ...s.seating.filter((o) => o !== victim && o !== beneficiary).sort((a, b) => player(s, b).stock - player(s, a).stock)].find((o) => player(s, o).stock > 0) ?? null;
  const takerForCity = () => [beneficiary, ...s.seating.filter((o) => o !== victim && o !== beneficiary).sort((a, b) => player(s, b).citiesAvailable - player(s, a).citiesAvailable)].find((o) => player(s, o).citiesAvailable > 0) ?? null;
  for (const [aid, n] of Object.entries(set.tokens)) {
    for (let i = 0; i < n; i++) {
      setTokens(s, aid, victim, (s.areas[aid]!.tokens[victim] ?? 0) - 1); player(s, victim).stock += 1;
      const taker = takerForToken();
      if (taker) { s.areas[aid]!.tokens[taker] = (s.areas[aid]!.tokens[taker] ?? 0) + 1; player(s, taker).stock -= 1; }
    }
  }
  for (const aid of set.cities) {
    if (s.areas[aid]?.city !== victim) continue;
    delete s.areas[aid]!.city; player(s, victim).citiesAvailable += 1;
    const taker = takerForCity();
    if (taker) { s.areas[aid]!.city = taker; player(s, taker).citiesAvailable -= 1; }
  }
}

/** Begin a Civil War (§30.41): determine the beneficiary and faction sizes, then
 *  pause for the first selection step. Returns true if it paused, false if it
 *  fizzles (victim richest in stock §30.411, or no second faction §30.413). */
function startCivilWar(s: GameState, victim: PlayerId, before: ReturnType<typeof snapAreas>, overviewBefore: string): boolean {
  const beneficiary = civilWarBeneficiary(s, victim);
  if (beneficiary == null) { s.log.push(`${victim}'s Civil War fizzles — it holds the most reserves (§30.411).`); return false; }
  const pp = player(s, victim);
  const philosophy = has(pp, 'philosophy');
  const victimPoints = philosophy ? 0 : 15 + (has(pp, 'music') ? 5 : 0) + (has(pp, 'drama') ? 5 : 0) + (has(pp, 'democracy') ? 10 : 0);
  const beneficiaryPoints = philosophy ? 15 : 20;
  const board = boardUnitPoints(s, victim);
  // §30.413: the first faction can't be the whole nation — there must be a second.
  if (board <= victimPoints + beneficiaryPoints) { s.log.push(`${victim}'s Civil War: nation too small to leave a second faction — no effect (§30.413).`); return false; }
  s.pendingCivilWar = {
    victim, beneficiary, stage: philosophy ? 'beneficiarySelect' : 'victimSelect',
    victimPoints, beneficiaryPoints, philosophy, military: has(pp, 'military'),
    faction1: { tokens: {}, cities: [] }, before, overviewBefore,
  };
  return true;
}

/** The default/suggested selection for the current Civil War step. */
function suggestCivilWarSelect(s: GameState): UnitSet {
  const cw = s.pendingCivilWar!;
  if (cw.stage === 'victimSelect') return pickUnits(unitInventory(s, cw.victim), cw.victimPoints, false); // victim offers cheapest
  // beneficiarySelect: grab the victim's best from what the victim hasn't already put up.
  const remaining = subtractSet(unitInventory(s, cw.victim), cw.faction1);
  return pickUnits(remaining, cw.beneficiaryPoints, true);
}

/** The actor whose decision the Civil War is waiting on. */
function civilWarActor(cw: PendingCivilWar): PlayerId {
  return cw.stage === 'beneficiarySelect' ? cw.beneficiary : cw.victim;
}

/** Validate a Civil War faction selection: only the victim's available units, and
 *  totalling the step's target (a city's worth of overshoot allowed when a token
 *  selection can't land exactly). */
function validateCivilWarSelect(s: GameState, cw: PendingCivilWar, sel: UnitSet, target: number): void {
  const avail = cw.stage === 'victimSelect' ? unitInventory(s, cw.victim) : subtractSet(unitInventory(s, cw.victim), cw.faction1);
  for (const [aid, n] of Object.entries(sel.tokens)) {
    if (n < 0) throw new Error('negative token count');
    if (n > (avail.tokens[aid] ?? 0)) throw new Error(`${cw.victim} has no such units to select in ${areaName(aid)}`);
  }
  for (const aid of sel.cities) if (!avail.cities.includes(aid)) throw new Error(`${areaName(aid)} is not an available city to select`);
  const pts = unitSetPoints(sel);
  if (pts < target || pts - target >= 5) throw new Error(`select ${target} unit points for this faction (§30.412)`);
}

// ---- Player-directed city picks (Treachery §30.22 / Flood §30.514 / Piracy §30.91)
// The rules name a specific chooser for these city selections; we pause for that
// player (human-prompted, else AI heuristic) rather than auto-picking.

const citiesOf = (s: GameState, owner: PlayerId) => Object.keys(s.areas).filter((a) => s.areas[a]!.city === owner);
const coastalCitiesOf = (s: GameState, owner: PlayerId) => citiesOf(s, owner).filter((a) => isCoastal2(a));

/** Turn one specific city into a neutral pirate city (§30.91). */
function razeCityToPirate(s: GameState, aid: string): void {
  const a = s.areas[aid]; if (!a || !a.city || !isPlayer(s, a.city)) return;
  player(s, a.city).citiesAvailable += 1;
  delete a.city; a.city = PIRATE; a.pirateCity = true;
  s.log.push(`The city in ${areaName(aid)} is taken by pirates (§30.91).`);
}

/** §30.22 Treachery: the trader (or the victim, if drawn) picks one of the
 *  victim's cities. */
function startTreachery(s: GameState, victim: PlayerId, before: ReturnType<typeof snapAreas>, overviewBefore: string): boolean {
  const cities = citiesOf(s, victim);
  if (!cities.length) { s.log.push(`${victim} suffers Treachery but holds no city.`); return false; }
  const t = s.calamityTradedFrom['treachery'];
  const trader = t && t !== victim && isPlayer(s, t) ? t : undefined;
  s.pendingPick = { chooser: trader ?? victim, stage: 'treachery', victim, trader, count: 1, candidates: cities, before, overviewBefore };
  return true;
}

/** §30.514 Flood with no flood-plain units: the primary picks a coastal city. */
function startFloodCity(s: GameState, victim: PlayerId, before: ReturnType<typeof snapAreas>, overviewBefore: string): boolean {
  const cities = coastalCitiesOf(s, victim);
  if (!cities.length) { s.log.push(`${victim} is unaffected by Flood (no units on a flood plain).`); return false; }
  s.pendingPick = { chooser: victim, stage: 'floodCity', victim, count: 1, candidates: cities, before, overviewBefore };
  return true;
}

/** §30.911 Piracy: the trader (or victim, if drawn) picks the victim's coastal
 *  cities; then the secondary step (§30.912). */
function startPiracy(s: GameState, victim: PlayerId, before: ReturnType<typeof snapAreas>, overviewBefore: string): boolean {
  const t = s.calamityTradedFrom['piracy'];
  const trader = t && t !== victim && isPlayer(s, t) ? t : undefined;
  const cities = coastalCitiesOf(s, victim);
  if (cities.length) {
    s.pendingPick = { chooser: trader ?? victim, stage: 'piracyPrimary', victim, trader, count: Math.min(2, cities.length), candidates: cities, before, overviewBefore };
    return true;
  }
  return setupPiracySecondary(s, victim, trader, before, overviewBefore);
}

/** §30.912 Piracy: the primary victim picks up to two OTHER players' coastal
 *  cities (≤1 each). Returns false (no pick) if none are available. */
function setupPiracySecondary(s: GameState, victim: PlayerId, trader: PlayerId | undefined, before: ReturnType<typeof snapAreas>, overviewBefore: string): boolean {
  const candidates: string[] = [];
  for (const o of s.seating) { if (o === victim || o === trader) continue; candidates.push(...coastalCitiesOf(s, o)); }
  if (!candidates.length) return false;
  const owners = new Set(candidates.map((a) => s.areas[a]!.city));
  s.pendingPick = { chooser: victim, stage: 'piracySecondary', victim, trader, count: Math.min(2, owners.size), candidates, before, overviewBefore };
  return true;
}

/** How many cities the chooser must select for the current pick. */
function requiredPickCount(s: GameState, pk: PendingPick): number {
  if (pk.stage === 'piracySecondary') return Math.min(pk.count, new Set(pk.candidates.map((a) => s.areas[a]!.city)).size);
  return Math.min(pk.count, pk.candidates.length);
}

/** Sensible default selection (AI & UI suggestion): a self-loss picks the cheapest
 *  city (a city-site rebuilds for 6, not 12); an adversarial pick takes the most
 *  damaging — non-site cities, and for the Piracy secondary the leaders' cities. */
function suggestPick(s: GameState, pk: PendingPick): string[] {
  const need = requiredPickCount(s, pk);
  const selfLoss = pk.chooser === pk.victim && pk.stage !== 'piracySecondary';
  if (pk.stage === 'piracySecondary') {
    const byOwner = new Map<PlayerId, string[]>();
    for (const a of pk.candidates) { const o = s.areas[a]!.city as PlayerId; (byOwner.get(o) ?? byOwner.set(o, []).get(o)!).push(a); }
    const owners = [...byOwner.keys()].sort((x, y) => victoryScore(s, y) - victoryScore(s, x));
    return owners.slice(0, need).map((o) => byOwner.get(o)![0]!);
  }
  const ranked = [...pk.candidates].sort((x, y) => {
    const sx = areaById.get(x)?.isCitySite ? 0 : 1, sy = areaById.get(y)?.isCitySite ? 0 : 1;
    return selfLoss ? sx - sy : sy - sx; // self: city-sites first (cheapest); adversarial: non-sites first
  });
  return ranked.slice(0, need);
}

function validatePick(s: GameState, pk: PendingPick, areas: string[]): void {
  const need = requiredPickCount(s, pk);
  if (areas.length !== need) throw new Error(`pick exactly ${need} cit${need === 1 ? 'y' : 'ies'} (§30)`);
  for (const aid of areas) if (!pk.candidates.includes(aid)) throw new Error(`${areaName(aid)} is not a valid choice here`);
  if (pk.stage === 'piracySecondary') {
    const owners = areas.map((a) => s.areas[a]!.city);
    if (new Set(owners).size !== owners.length) throw new Error('each secondary victim may lose only one city (§30.912)');
  }
}

/** Finalize a calamity resolved via a pick: record the event and resume. */
function finalizePick(s: GameState, calamityId: string, victim: PlayerId, before: ReturnType<typeof snapAreas>, overviewBefore: string): void {
  s.pendingPick = undefined;
  pushCalamityEvent(s, calamityId, victim, before, overviewBefore, true);
  runCalamity(s);
  if (!s.calamityActive) setupCalamityConversion(s);
}

/** Apply a validated city pick and chain/finalize the calamity. */
function applyPick(s: GameState, pk: PendingPick, areas: string[]): void {
  const { victim, trader, before, overviewBefore } = pk;
  if (pk.stage === 'treachery') {
    const aid = areas[0]!; const a = s.areas[aid]!;
    delete a.city; player(s, victim).citiesAvailable += 1;
    if (trader && player(s, trader).citiesAvailable > 0) {
      a.city = trader; player(s, trader).citiesAvailable -= 1;
      s.log.push(`${victim} suffers Treachery: the city in ${areaName(aid)} defects to ${trader} (§30.221).`);
    } else if (trader) {
      s.log.push(`${victim} suffers Treachery: the city in ${areaName(aid)} is destroyed — ${trader} had no city to install (§30.221).`);
    } else {
      const place = Math.min(areaLimitFor(s, aid, victim), player(s, victim).stock);
      if (place > 0) { a.tokens[victim] = (a.tokens[victim] ?? 0) + place; player(s, victim).stock -= place; }
      s.log.push(`${victim} suffers Treachery: the city in ${areaName(aid)} is reduced (§30.222).`);
    }
    finalizePick(s, 'treachery', victim, before, overviewBefore);
    return;
  }
  if (pk.stage === 'floodCity') {
    const aid = areas[0]!;
    if (has(player(s, victim), 'engineering')) { reduceSpecificCity(s, victim, aid); s.log.push(`${victim}'s Flood reduces the coastal city in ${areaName(aid)} (Engineering, §30.515).`); }
    else { delete s.areas[aid]!.city; player(s, victim).citiesAvailable += 1; s.log.push(`${victim} loses the coastal city in ${areaName(aid)} to Flood (§30.514).`); }
    finalizePick(s, 'flood', victim, before, overviewBefore);
    return;
  }
  if (pk.stage === 'piracyPrimary') {
    for (const aid of areas) razeCityToPirate(s, aid);
    s.pendingPick = undefined;
    if (!setupPiracySecondary(s, victim, trader, before, overviewBefore)) finalizePick(s, 'piracy', victim, before, overviewBefore);
    return;
  }
  // piracySecondary
  for (const aid of areas) razeCityToPirate(s, aid);
  finalizePick(s, 'piracy', victim, before, overviewBefore);
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

/** Epidemic (§30.61): primary loses 16 (Medicine -8, Roadbuilding +5) and orders
 *  25 unit points of loss among the other players (Medicine -5, Roadbuilding +5;
 *  the trader is exempt). The primary concentrates the order on its strongest
 *  rivals. */

/** Iconoclasm & Heresy (§30.81): primary reduces 4 cities (Law/Philosophy -1,
 *  Theology -3, Monotheism/Roadbuilding +1, cumulative), then orders 2 cities
 *  reduced among rivals — not the trader, never a Theology-holder, and at most 1
 *  from a Philosophy-holder (§30.818-819). */

const isCoastal2 = (aid: string) => neighbors(aid).some((n) => areaById.get(n)?.isWater);

const PIRATE = '__pirate__';

// ---- Mutation primitives -------------------------------------------------

function setTokens(s: GameState, aid: string, owner: PlayerId, n: number): void {
  const a = s.areas[aid]!;
  if (n <= 0) delete a.tokens[owner];
  else a.tokens[owner] = n;
}

// ---- Monotheism conversion (§32.94) --------------------------------------

/** §32.952: a player holding Monotheism or Theology is immune to conversion. */
function conversionImmune(s: GameState, id: PlayerId): boolean {
  return isPlayer(s, id) && (has(player(s, id), 'monotheism') || has(player(s, id), 'theology'));
}

/** The single real-player occupant of an area (city owner or the token owner),
 *  or null if empty / neutral (barbarians, pirates) / mixed. */
function soleOccupant(s: GameState, aid: string): PlayerId | null {
  const a = s.areas[aid];
  if (!a) return null;
  if (a.pirateCity) return null;
  const tokenOwners = Object.entries(a.tokens).filter(([, n]) => n > 0).map(([o]) => o);
  if (a.city && isPlayer(s, a.city)) {
    if (tokenOwners.length === 0 || (tokenOwners.length === 1 && tokenOwners[0] === a.city)) return a.city;
    return null;
  }
  if (tokenOwners.length === 1 && isPlayer(s, tokenOwners[0]!) && tokenOwners[0] !== BARBARIAN) return tokenOwners[0]!;
  return null;
}

/** Areas a Monotheism holder may convert this turn (§32.941/.942): land-adjacent
 *  to one of his own occupied areas, held by a single convertible enemy, and
 *  affordable from his stock/cities. */
export function monotheismTargets(s: GameState, holder: PlayerId): string[] {
  if (!isPlayer(s, holder) || !has(player(s, holder), 'monotheism')) return [];
  const mine = player(s, holder);
  const ownsTokens = (aid: string) => (s.areas[aid]?.tokens[holder] ?? 0) > 0 || s.areas[aid]?.city === holder;
  const out: string[] = [];
  for (const [aid, a] of Object.entries(s.areas)) {
    const victim = soleOccupant(s, aid);
    if (!victim || victim === holder) continue;
    if (conversionImmune(s, victim)) continue; // §32.942
    if (!landNeighbors(aid).some(ownsTokens)) continue; // adjacent by land to my units
    const tokens = a.tokens[victim] ?? 0;
    const needsCity = a.city === victim;
    if (tokens > mine.stock) continue; // §32.942: must be able to replace the tokens
    if (needsCity && mine.citiesAvailable < 1) continue; // must have a city to place
    out.push(aid);
  }
  return out;
}

/** Execute a Monotheism conversion: the victim's pieces in `aid` return to them,
 *  replaced one-for-one by the holder's own units (§32.941). */
function applyConvert(s: GameState, holder: PlayerId, aid: string): void {
  if (player(s, holder).convertedThisTurn) throw new Error('Monotheism may convert only one area per turn (§32.941)');
  if (!monotheismTargets(s, holder).includes(aid)) throw new Error(`cannot convert ${areaName(aid)} (§32.94)`);
  const a = s.areas[aid]!;
  const victim = soleOccupant(s, aid)!;
  const tokens = a.tokens[victim] ?? 0;
  const hadCity = a.city === victim;
  // Return the victim's pieces.
  if (tokens > 0) { setTokens(s, aid, victim, 0); player(s, victim).stock += tokens; }
  if (hadCity) { delete a.city; player(s, victim).citiesAvailable += 1; }
  // Replace with the holder's own units.
  if (tokens > 0) { setTokens(s, aid, holder, tokens); player(s, holder).stock -= tokens; }
  if (hadCity) { a.city = holder; player(s, holder).citiesAvailable -= 1; }
  player(s, holder).convertedThisTurn = true;
  s.log.push(`${holder} converts ${areaName(aid)} from ${victim} by Monotheism (§32.94)${hadCity ? ' (city)' : ''}${tokens > 0 ? ` (${tokens} tokens)` : ''}.`);
}

/** §29/§32.941: after calamities resolve, only Monotheism holders who can still
 *  convert an area get to act this (calamity) phase; everyone else is marked done. */
function setupCalamityConversion(s: GameState): void {
  for (const id of s.seating) {
    const eligible = has(player(s, id), 'monotheism') && !player(s, id).convertedThisTurn && monotheismTargets(s, id).length > 0;
    if (!eligible && !s.actedThisPhase.includes(id)) s.actedThisPhase.push(id);
  }
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

/** §26.41: reduce up to `n` of a player's cities. A reduced city is REPLACED by
 *  the maximum tokens its area allows (Agriculture §32.241 gives +1), drawn from
 *  stock — those tokens can then support the player's remaining cities. */
function reduceCities(s: GameState, owner: PlayerId, n: number, coastalOnly: boolean): void {
  let remaining = n;
  const p = player(s, owner);
  for (const [aid, a] of Object.entries(s.areas)) {
    if (remaining <= 0) break;
    if (a.city !== owner) continue;
    if (coastalOnly && !isCoastal(aid)) continue;
    delete a.city;
    p.citiesAvailable += 1;
    const place = Math.min(areaLimitFor(s, aid, owner), p.stock);
    if (place > 0) { a.tokens[owner] = (a.tokens[owner] ?? 0) + place; p.stock -= place; }
    remaining -= 1;
  }
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
    const thr = track.lateIronThresholds;
    // §33.25: printed point values fill the LAST spaces of the Late Iron Age.
    // Any leading Late Iron space (the 5 extended nations have one) needs only the
    // age entry of 5 cities — i.e. no extra card value. With no per-civ data, fall
    // back to the generic space*100.
    const idx = thr ? nextSpace - (track.finishSpace - thr.length) : 0;
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
    case 'census': return runCensus(s);
    case 'conflict': return runConflict(s);
    case 'removeSurplus': return runRemoveSurplus(s);
    case 'tradeAcquisition': return runTradeAcquisition(s);
    case 'astAdjustment': return runAstAdjustment(s);
  }
}

function enterPhase(s: GameState, phase: Phase): void {
  s.phase = phase;
  if (phase === 'astAdjustment') return; // order handled per-phase
  if (!AUTO_PHASES.has(phase)) {
    // Interactive phase actor order (§18 / §17.4):
    //  - movement & ship construction: census order, Military holders last (§32.831);
    //  - taxation, population expansion, calamity (Monotheism), advances: A.S.T. order;
    //  - everything else: the turn's census order.
    const census = s.censusOrder?.length ? s.censusOrder : (s.activeOrder.length ? s.activeOrder : censusOrder(s));
    const astPhases = phase === 'taxation' || phase === 'populationExpansion' || phase === 'calamity' || phase === 'acquireAdvances';
    s.activeOrder = (phase === 'movement' || phase === 'shipConstruction') ? militaryLast(s, census)
      : astPhases ? astOrder(s)
      : [...census];
    s.actedThisPhase = [];
    if (phase === 'trade') {
      s.negotiation = { turnPointer: 0, passStreak: 0, actions: 0, nextOfferId: 0, done: [], offers: [], completed: [] };
    }
    if (phase === 'shipConstruction') runShipMaintenance(s); // §22.3, before building
    if (phase === 'taxation') setupTaxation(s); // §19: auto-tax non-Coinage; Coinage holders pick
    if (phase === 'populationExpansion') resolvePendingRevolts(s); // §19.31: revolts settle after all paid
    if (phase === 'calamity') { runCalamity(s); if (!s.calamityActive) setupCalamityConversion(s); } // §29: resolve (may pause for allocation), then Monotheism converts
    if (phase === 'acquireAdvances') checkCitySupport(s); // §29.8: support rechecked after any conversion
    // §13: apply growth now (auto when stock allows); constrained players are
    // left to place their limited tokens interactively.
    if (phase === 'populationExpansion') setupPopulationExpansion(s);
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
      if (s.pendingDiscard) return; // §31.71: paused for a hand-limit discard choice
      const np = nextPhase(s.phase);
      if (np === 'taxation') {
        // Turn rollover.
        if (s.finished || (s.maxTurns && s.turn >= s.maxTurns)) { s.phase = 'taxation'; return; }
        s.turn += 1;
        s.censusOrder = s.activeOrder = censusOrder(s);
        s.actedThisPhase = [];
        for (const id of s.seating) { player(s, id).convertedThisTurn = false; player(s, id).builtWithTreasuryThisTurn = false; player(s, id).grainLockedThisTurn = 0; } // §32.941/.631/.312 once-per-turn
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
  // §32.251: tokens that arrived via a road move may not then board a ship this
  // phase. Track the areas a road move deposited tokens into.
  const roadDest = new Set<string>();
  for (const m of moves) {
    const from = s.areas[m.from];
    if (!from || (from.tokens[actor] ?? 0) < m.count) throw new Error(`illegal move: not enough tokens in ${m.from}`);
    if (m.byShip) {
      if (roadDest.has(m.from)) throw new Error(`illegal move: cannot road into ${m.from} then board a ship there (§32.251)`);
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
    // §32.251: the pass-through area must be land and may not contain another
    // player's units (tokens OR a city) or a Pirate city.
    const roadReachable = !!(road && via && neighbors(m.from).includes(via) && neighbors(via).includes(m.to)
      && !areaById.get(via)?.isWater
      && (!viaArea || (Object.keys(viaArea.tokens).every((o) => o === actor || (viaArea.tokens[o] ?? 0) === 0)
        && (!viaArea.city || viaArea.city === actor))));
    if (!adjacent && !roadReachable) throw new Error(`illegal move ${m.from}->${m.to}: not reachable`);
    setTokens(s, m.from, actor, (from.tokens[actor] ?? 0) - m.count);
    const to = (s.areas[m.to] ??= { tokens: {} });
    to.tokens[actor] = (to.tokens[actor] ?? 0) + m.count;
    if (!adjacent && roadReachable) roadDest.add(m.to); // §32.251: no ship from here after
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
  // §32.631: Architecture may assist the building of only ONE city per turn, and
  // at least half the tokens must be on-board (so treasury covers at most half).
  const architecture = has(p, 'architecture') && !p.builtWithTreasuryThisTurn;
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
  if (treasuryUsed > 0) p.builtWithTreasuryThisTurn = true; // §32.631 one per turn
  a.city = actor;
  p.citiesAvailable -= 1;
  s.log.push(`${actor} built a city in ${areaName(area)}${treasuryUsed > 0 ? ` (Architecture: ${treasuryUsed} from treasury)` : ''}.`);
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
    // §30.312: Grain locked against Famine this turn can't be spent until next turn.
    if (cid === 'grain' && (p.hand['grain'] ?? 0) - (p.grainLockedThisTurn ?? 0) < n) throw new Error(`${p.grainLockedThisTurn} Grain card(s) are locked against Famine until next turn (§30.312)`);
  }
  if (spendTreasury > p.treasury) throw new Error('not enough treasury');
  // Compute payment value: commodity set values of spent cards + treasury + credits.
  const spentHand: Record<string, number> = {};
  for (const [cid, n] of Object.entries(spendCommodities)) if (n > 0) spentHand[cid] = n;
  const cardValue = handValue(spentHand, { mining: has(p, 'mining') });
  const credit = creditTowards(p.advances, advanceId);
  // Treasury is paid in single tokens, so you pay EXACTLY the remaining cost from
  // it — never overpay. (Commodity sets are indivisible, so card value may exceed
  // the cost; that excess is unavoidable, but treasury must not be wasted.)
  spendTreasury = Math.min(spendTreasury, Math.max(0, adv.cost - cardValue - credit));
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
  const cap = 12 * Math.max(1, s.activeOrder.length);
  // Phase ends once every player has passed ("Done trading"), or the cap is hit.
  const done = n.done ?? [];
  return s.activeOrder.every((p) => done.includes(p)) || (n.actions ?? 0) >= cap;
}

const commodityName = (c: string) => (isCalamityCard(c) ? calamityById.get(calamityIdOf(c))?.name ?? c : commodityById.get(c)?.name ?? c);

/** Post or replace the actor's standing open offer (§28). Bluffs allowed; the
 *  announced count and ≥2 announced cards must be truthful. */
function applyPostOffer(s: GameState, actor: PlayerId, a: { give: { actual: Record<string, number>; declared: Record<string, number> }; wants: string[] }): void {
  const err = validateBundle(s, actor, a.give, 3);
  if (err) throw new Error(`postOffer: ${err}`);
  const wants = [...new Set((a.wants ?? []).filter((w) => commodityById.get(w)))];
  if (wants.length < 1 || wants.length > 5) throw new Error('name 1–5 commodities you want in return (§28)');
  const n = s.negotiation;
  n.offers = n.offers.filter((o) => o.from !== actor); // one standing offer per player
  n.nextOfferId = (n.nextOfferId ?? 0) + 1;
  n.offers.push({ id: n.nextOfferId, from: actor, give: a.give, wants, responses: [] });
  n.actions = (n.actions ?? 0) + 1;
  n.passStreak = 0;
  s.log.push(`${actor} posts a trade offer (gives ${bundleSize(a.give.actual)}, wants ${wants.map(commodityName).join(' or ')}).`);
}

/** Attach or replace the actor's counter-give to another player's open offer. */
function applyRespondOffer(s: GameState, actor: PlayerId, a: { offerId: number; give: { actual: Record<string, number>; declared: Record<string, number> } }): void {
  const o = s.negotiation.offers.find((x) => x.id === a.offerId);
  if (!o) throw new Error('that offer is no longer on the board');
  if (o.from === actor) throw new Error('cannot respond to your own offer');
  const err = validateBundle(s, actor, a.give, 3);
  if (err) throw new Error(`respondOffer: ${err}`);
  o.responses = o.responses.filter((r) => r.from !== actor);
  o.responses.push({ from: actor, give: a.give });
  s.negotiation.actions = (s.negotiation.actions ?? 0) + 1;
  s.negotiation.passStreak = 0;
  s.log.push(`${actor} responds to ${o.from}'s offer.`);
}

/** The offer's owner accepts one responder's counter — executes the §28.2 deal. */
function applyAcceptResponse(s: GameState, actor: PlayerId, a: { offerId: number; responder: PlayerId }): void {
  const o = s.negotiation.offers.find((x) => x.id === a.offerId);
  if (!o) throw new Error('that offer is no longer on the board');
  if (o.from !== actor) throw new Error('only the offer owner may accept a response');
  const r = o.responses.find((x) => x.from === a.responder);
  if (!r) throw new Error('no such response');
  // A side may have traded away its pledged cards since. Don't crash the deal —
  // void the stale offer/response gracefully so negotiation can continue.
  if (!isSubMultiset(o.give.actual, player(s, actor).hand)) {
    s.negotiation.offers = s.negotiation.offers.filter((x) => x.id !== o.id);
    s.negotiation.actions = (s.negotiation.actions ?? 0) + 1;
    s.log.push(`${actor}'s trade offer expired (cards no longer held).`);
    return;
  }
  if (!isSubMultiset(r.give.actual, player(s, r.from).hand)) {
    o.responses = o.responses.filter((x) => x.from !== r.from);
    s.negotiation.actions = (s.negotiation.actions ?? 0) + 1;
    s.log.push(`${r.from}'s trade response expired (cards no longer held).`);
    return;
  }
  transferCards(s, actor, r.from, o.give.actual);
  transferCards(s, r.from, actor, r.give.actual);
  (s.negotiation.completed ??= []).push({ a: actor, b: r.from, aGave: o.give, bGave: r.give });
  // Both players' standing offers are consumed by the deal.
  s.negotiation.offers = s.negotiation.offers.filter((x) => x.from !== actor && x.from !== r.from);
  s.negotiation.actions = (s.negotiation.actions ?? 0) + 1;
  s.negotiation.passStreak = 0;
  // §28 keeps the actual cards/bluffs private to the two traders — log only the counts.
  s.log.push(`${actor} and ${r.from} completed a trade (${bundleSize(o.give.actual)}↔${bundleSize(r.give.actual)} cards).`);
}

function applyWithdrawOffer(s: GameState, actor: PlayerId): void {
  s.negotiation.offers = s.negotiation.offers.filter((o) => o.from !== actor);
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
    // A pending hand-limit discard can arise during the auto astAdjustment phase,
    // so it must be checked before the auto-phase short-circuit.
    if (state.pendingDiscard) return state.pendingDiscard.holder;
    if (AUTO_PHASES.has(state.phase)) return null;
    // A pending city-choice / unit-loss / secondary allocation is the victim's.
    if (state.pendingCityChoice) return state.pendingCityChoice.holder;
    if (state.pendingUnitLoss) return state.pendingUnitLoss.holder;
    if (state.pendingAllocation) return state.pendingAllocation.holder;
    // A Civil War step is the victim's, except the beneficiary's selection (§30.4123).
    if (state.pendingCivilWar) return civilWarActor(state.pendingCivilWar);
    // A Treachery/Flood/Piracy city pick is its named chooser's (§30.221/.514/.91).
    if (state.pendingPick) return state.pendingPick.chooser;
    if (state.phase === 'trade') {
      const n = state.negotiation;
      if (tradePhaseEnded(state)) return null;
      const done = n.done ?? [];
      const order = state.activeOrder;
      for (let i = 0; i < order.length; i++) {
        const cand = order[(n.turnPointer + i) % order.length];
        if (cand && !done.includes(cand)) return cand; // skip players who are done trading
      }
      return null;
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
          // "Done trading": don't prompt this player again; phase ends when all
          // are done. (Other players' offers no longer force you back in.)
          s.negotiation.done = [...(s.negotiation.done ?? []), actor].filter((p, i, a) => a.indexOf(p) === i);
          s.negotiation.passStreak += 1;
          s.negotiation.turnPointer += 1;
        } else if (!s.actedThisPhase.includes(actor)) {
          // Passing taxation = accept the default rate 2 (still collect the tax).
          if (s.phase === 'taxation') collectTax(s, actor, 2);
          s.actedThisPhase.push(actor);
        }
        break;
      // Trade actions are round-robin: each advances the turn to the next player
      // who isn't done. Players accumulate offers/responses across rounds and
      // get later turns to accept; only `pass` marks you done.
      case 'postOffer':
        if (s.phase !== 'trade') throw new Error('postOffer only in trade phase');
        applyPostOffer(s, actor, action);
        s.negotiation.turnPointer += 1;
        break;
      case 'respondOffer':
        if (s.phase !== 'trade') throw new Error('respondOffer only in trade phase');
        applyRespondOffer(s, actor, action);
        s.negotiation.turnPointer += 1;
        break;
      case 'acceptResponse':
        if (s.phase !== 'trade') throw new Error('acceptResponse only in trade phase');
        applyAcceptResponse(s, actor, action);
        s.negotiation.turnPointer += 1;
        break;
      case 'withdrawOffer':
        if (s.phase !== 'trade') throw new Error('withdrawOffer only in trade phase');
        applyWithdrawOffer(s, actor);
        s.negotiation.turnPointer += 1;
        break;
      case 'buyTradeCard':
        if (s.phase !== 'trade') throw new Error('buyTradeCard only in trade phase');
        applyBuyTradeCard(s, actor, action.count);
        s.negotiation.turnPointer += 1;
        break;
      case 'setTaxRate': {
        if (s.phase !== 'taxation') throw new Error('the tax rate is chosen during taxation');
        if (!has(player(s, actor), 'coinage')) throw new Error('only a player with Coinage may set the tax rate (§32.421)');
        collectTax(s, actor, action.rate); // collect immediately at the chosen rate
        if (!s.actedThisPhase.includes(actor)) s.actedThisPhase.push(actor);
        break;
      }
      case 'placeTokens':
        if (s.phase !== 'populationExpansion') throw new Error('placeTokens only in population expansion');
        applyPlaceTokens(s, actor, action.placements);
        break;
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
      case 'convertArea':
        if (s.phase !== 'calamity') throw new Error('Monotheism conversion happens at the end of the calamity phase (§29/§32.941)');
        applyConvert(s, actor, action.area);
        if (!s.actedThisPhase.includes(actor)) s.actedThisPhase.push(actor); // one conversion per turn
        break;
      case 'allocateLoss': {
        const a = s.pendingAllocation;
        if (!a) throw new Error('no secondary-victim allocation is pending');
        if (actor !== a.holder) throw new Error('only the primary victim directs these losses (§29.64)');
        validateAllocation(a, action.allocation);
        // §30.311/.512/.611/.818: the primary directed the amounts; each secondary
        // victim now chooses which of their own units/cities to surrender.
        s.pendingSecondary = { calamityId: a.calamityId, primary: a.holder, queue: secondaryLossesFromAllocation(s, a, action.allocation), before: a.before, overviewBefore: a.overviewBefore };
        s.pendingAllocation = undefined;
        startNextSecondary(s); // pause for the first secondary victim's choice (or finalize)
        break;
      }
      case 'chooseCities': {
        const c = s.pendingCityChoice;
        if (!c) throw new Error('no city reduction is pending');
        if (actor !== c.holder) throw new Error('only the primary victim chooses which cities to reduce (§30)');
        const areas = [...new Set(action.areas)];
        if (areas.length !== c.count) throw new Error(`choose exactly ${c.count} cit${c.count === 1 ? 'y' : 'ies'} (§30.321)`);
        if (areas.some((aid) => s.areas[aid]?.city !== actor)) throw new Error('you may only reduce your own cities');
        reduceChosenCities(s, actor, areas);
        s.log.push(`${actor} reduces ${areas.map(areaName).join(', ')} (${calamityById.get(c.calamityId)?.name ?? c.calamityId}).`);
        s.pendingCityChoice = undefined;
        // A secondary victim (Iconoclasm §30.818) just chose — advance the queue.
        if (s.pendingSecondary && s.pendingSecondary.queue[0]?.victim === actor) {
          s.pendingSecondary.queue.shift();
          startNextSecondary(s);
        } else {
          resumeAfterChoice(s, c.calamityId, c.holder, c.before, c.overviewBefore);
        }
        break;
      }
      case 'chooseUnits': {
        const u = s.pendingUnitLoss;
        if (!u) throw new Error('no unit loss is pending');
        if (actor !== u.holder) throw new Error('only the affected player chooses which units to give up (§29.63)');
        validateUnits(s, u, action);
        applyChosenUnits(s, u, action);
        const { calamityId, holder, before, overviewBefore, areas } = u;
        s.pendingUnitLoss = undefined;
        // A secondary victim (Famine/Epidemic/Flood §30.311/.611/.512) just chose
        // which of their own units to lose — advance the queue.
        if (s.pendingSecondary && s.pendingSecondary.queue[0]?.victim === holder) {
          s.pendingSecondary.queue.shift();
          startNextSecondary(s);
          break;
        }
        // §30.512: after the primary's Flood loss, the primary directs 10 points of
        // secondary loss on the same flood plain — pause for that allocation.
        if (calamityId === 'flood' && areas) {
          const spec = floodAllocationSpec(s, holder, areas);
          if (spec) { s.pendingAllocation = { ...spec, areas, before, overviewBefore }; break; }
        }
        resumeAfterChoice(s, calamityId, holder, before, overviewBefore);
        break;
      }
      case 'civilWarSelect': {
        const cw = s.pendingCivilWar;
        if (!cw) throw new Error('no Civil War is pending');
        if (cw.stage === 'victimKeep') throw new Error('the Civil War factions are already selected');
        if (actor !== civilWarActor(cw)) throw new Error(`it is not ${actor}'s Civil War selection`);
        const target = cw.stage === 'victimSelect' ? cw.victimPoints : cw.beneficiaryPoints;
        const sel: UnitSet = { tokens: { ...action.tokens }, cities: [...new Set(action.cities)] };
        validateCivilWarSelect(s, cw, sel, target);
        if (cw.stage === 'victimSelect') {
          cw.faction1 = sel;
          cw.stage = 'beneficiarySelect';
          s.log.push(`${cw.victim} chooses ${unitSetPoints(sel)} unit points for the first Civil War faction (§30.4121).`);
        } else {
          for (const [aid, n] of Object.entries(sel.tokens)) cw.faction1.tokens[aid] = (cw.faction1.tokens[aid] ?? 0) + n;
          cw.faction1.cities.push(...sel.cities);
          cw.faction2 = subtractSet(unitInventory(s, cw.victim), cw.faction1);
          s.log.push(`${cw.beneficiary} adds ${unitSetPoints(sel)} of ${cw.victim}'s units to the first faction (§30.4123).`);
          if (cw.military) {
            militaryReduceFaction(s, cw.victim, cw.faction1, 5);
            militaryReduceFaction(s, cw.victim, cw.faction2, 5);
            s.log.push(`Military makes ${cw.victim}'s Civil War bloodier — 5 unit points removed from each faction (§30.414).`);
          }
          cw.stage = 'victimKeep';
        }
        break; // pause continues for the next step's actor
      }
      case 'civilWarKeep': {
        const cw = s.pendingCivilWar;
        if (!cw) throw new Error('no Civil War is pending');
        if (cw.stage !== 'victimKeep') throw new Error('the Civil War factions are not yet selected');
        if (actor !== cw.victim) throw new Error('only the victim chooses which faction to keep (§30.415)');
        if (action.faction !== 1 && action.faction !== 2) throw new Error('choose faction 1 or 2');
        const annexed = action.faction === 1 ? cw.faction2! : cw.faction1;
        const kept = action.faction === 1 ? cw.faction1 : cw.faction2!;
        annexFaction(s, cw.victim, cw.beneficiary, annexed);
        s.log.push(`${cw.victim} keeps the ${action.faction === 1 ? 'first' : 'second'} faction (${unitSetPoints(kept)} pts); ${cw.beneficiary} annexes the other (${unitSetPoints(annexed)} pts) (§30.415).`);
        const { victim, before, overviewBefore } = cw;
        s.pendingCivilWar = undefined;
        resumeAfterChoice(s, 'civilwar', victim, before, overviewBefore);
        break;
      }
      case 'pickAreas': {
        const pk = s.pendingPick;
        if (!pk) throw new Error('no city selection is pending');
        if (actor !== pk.chooser) throw new Error(`it is not ${actor}'s city selection (§30)`);
        const areas = [...new Set(action.areas)];
        validatePick(s, pk, areas);
        applyPick(s, pk, areas); // applies the effect, then chains or finalizes
        break;
      }
      case 'chooseDiscard': {
        const d = s.pendingDiscard;
        if (!d) throw new Error('no hand-limit discard is pending');
        if (actor !== d.holder) throw new Error('only the over-limit player chooses what to discard (§31.71)');
        const cards = action.cards;
        if (cards.length !== d.count) throw new Error(`discard exactly ${d.count} surplus card${d.count === 1 ? '' : 's'} (§31.71)`);
        const have: Record<string, number> = {};
        for (const c of cards) {
          if (isCalamityCard(c)) throw new Error('calamity cards do not count toward the hand limit');
          have[c] = (have[c] ?? 0) + 1;
          if (have[c] > (player(s, actor).hand[c] ?? 0)) throw new Error(`you do not hold that many ${c}`);
        }
        applyDiscard(s, actor, cards);
        s.pendingDiscard = undefined;
        // Continue trimming any further over-limit players, then resume the phase.
        break;
      }
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
    // §31.71: a pending hand-limit discard (during the auto astAdjustment phase)
    // is the over-limit player's; offer the cheapest-first default. Not a 'pass'.
    if (state.pendingDiscard && state.pendingDiscard.holder === actor) {
      return [{ type: 'chooseDiscard', cards: suggestDiscard(state, actor, state.pendingDiscard.count) }];
    }
    const out: Action[] = [{ type: 'pass' }];
    switch (state.phase) {
      case 'taxation': {
        // A Coinage holder (with cities) picks their rate 1-3, which collects now.
        for (const rate of [1, 2, 3]) out.push({ type: 'setTaxRate', rate });
        break;
      }
      case 'populationExpansion': {
        // Constrained growth: offer placing one token into each area that can
        // still grow (the UI/AI repeat as desired). 'pass' forfeits the rest.
        const caps = state.expansion?.caps[actor] ?? {};
        if ((state.expansion?.remaining[actor] ?? 0) > 0) {
          for (const [aid, cap] of Object.entries(caps)) if (cap > 0) out.push({ type: 'placeTokens', placements: { [aid]: 1 } });
        }
        break;
      }
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
      case 'calamity': {
        // §30.321/.711/.811: a pending city choice is the primary victim's; offer
        // a sensible default (sacrifice city-site cities first). UI may pick others.
        if (state.pendingCityChoice && state.pendingCityChoice.holder === actor) {
          return [{ type: 'chooseCities', areas: suggestCities(state, actor, state.pendingCityChoice.count) }];
        }
        // §29.63: a pending unit loss/cede is the victim's; offer the cheapest-first default.
        if (state.pendingUnitLoss && state.pendingUnitLoss.holder === actor) {
          return [{ type: 'chooseUnits', ...suggestUnits(state, state.pendingUnitLoss) }];
        }
        // §29.64: a pending secondary allocation is the primary victim's to direct.
        // Offer the leader-targeting default; the UI may submit a custom split.
        if (state.pendingAllocation && state.pendingAllocation.holder === actor) {
          return [{ type: 'allocateLoss', allocation: suggestAllocation(state, state.pendingAllocation) }];
        }
        // §30.41 Civil War: each step is its actor's; offer a sensible default.
        if (state.pendingCivilWar && civilWarActor(state.pendingCivilWar) === actor) {
          const cw = state.pendingCivilWar;
          if (cw.stage === 'victimKeep') {
            return [{ type: 'civilWarKeep', faction: unitSetPoints(cw.faction1) >= unitSetPoints(cw.faction2!) ? 1 : 2 }];
          }
          const sel = suggestCivilWarSelect(state);
          return [{ type: 'civilWarSelect', tokens: sel.tokens, cities: sel.cities }];
        }
        // §30.221/.514/.91: a named chooser selects cities — offer the default pick.
        if (state.pendingPick && state.pendingPick.chooser === actor) {
          return [{ type: 'pickAreas', areas: suggestPick(state, state.pendingPick) }];
        }
        // §29/§32.941: a Monotheism holder may convert one adjacent enemy area.
        if (has(p, 'monotheism') && !p.convertedThisTurn) {
          for (const area of monotheismTargets(state, actor)) out.push({ type: 'convertArea', area });
        }
        break;
      }
      case 'trade': {
        // Trade actions are parameterized (postOffer / respondOffer /
        // acceptResponse) and are constructed by the UI/AI, not enumerated. We
        // expose the safe exits so legalActions consumers (and random play) can
        // always progress: pass (already added) and buying a ninth-stack card.
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
    // Open offers & responses: ACTUAL cards are secret (§28.3) — everyone sees
    // the announced `declared` (incl. bluffs) but not the real cards until a deal
    // executes. Completed deals are private to the two traders (§28).
    for (const o of v.negotiation.offers) {
      if (o.from !== _viewer) o.give = { actual: {}, declared: o.give.declared };
      for (const r of o.responses) if (r.from !== _viewer) r.give = { actual: {}, declared: r.give.declared };
    }
    v.negotiation.completed = (v.negotiation.completed ?? []).filter((d) => d.a === _viewer || d.b === _viewer);
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
    // §32.261: Mining lets the holder value one mineable set as one card larger
    // "for Victory condition purposes" too (handValue treats calamity cards as 0).
    score += handValue(p.hand, { mining: has(p, 'mining') });
    score += p.treasury;
    score += p.astSpace * victoryScoring.pointsPerAstSpace;
    score += cityCount(state, id) * victoryScoring.pointsPerCity;
  }
  return score;
}
