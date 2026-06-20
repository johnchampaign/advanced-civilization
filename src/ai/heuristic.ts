// A simple heuristic AI controller for Advanced Civilization. It implements the
// framework's PlayerController. Strategy per interactive phase:
//   - movement: spread into adjacent empty/fertile land to grow population and
//     reach city sites; otherwise hold (pass).
//   - cityConstruction: always build a city when able (cities drive everything).
//   - acquireAdvances: buy the most valuable advance affordable, preferring the
//     best cost-per-point after credits and progress toward new card groups.
//   - trade: seek mutually-beneficial set-building swaps (give a partner the
//     commodity they collect for the commodity we collect), opportunistically
//     dumping a tradable calamity among the undeclared cards; accept incoming
//     offers that grow our sets or let us offload a calamity.
// It is deliberately greedy and fast, good enough for solo play and as a
// baseline opponent. It is multiplayer-fair: it only ever reads its OWN hand
// (the trade planner proposes blind, never inspecting opponents' cards).

import type { PlayerController, ControllerContext } from 'digital-boardgame-framework';
import { advanceById, areaById, calamityById, commodityById } from '../data/index.js';
import { cardGroupsHeld, cityCount, handValue, navalDestinations, neighbors, netAdvanceCost, populationCount } from '../engine/helpers.js';
import type { Action, GameState, PlayerId } from '../engine/types.js';

export class HeuristicAI implements PlayerController<GameState, Action, PlayerId> {
  async selectAction(ctx: ControllerContext<GameState, Action, PlayerId>): Promise<Action> {
    const { state, actor, adapter } = ctx;
    const actions = adapter.legalActions(state, actor);
    if (actions.length === 0) return { type: 'pass' };

    switch (state.phase) {
      case 'cityConstruction': {
        // Only build a city we can actually support: after building, an area
        // with a city holds no tokens (§26.1), so support comes from tokens
        // elsewhere — need >=2 per city across all cities (§26.31). Building in
        // area A removes all of A's tokens from the board.
        const builds = actions.filter((a) => a.type === 'buildCity') as Extract<Action, { type: 'buildCity' }>[];
        const pop = populationCount(state, actor);
        const cities = cityCount(state, actor);
        const supported = builds.find((b) => {
          const inArea = state.areas[b.area]?.tokens[actor] ?? 0;
          return pop - inArea >= 2 * (cities + 1);
        });
        return supported ?? { type: 'pass' };
      }
      case 'acquireAdvances': {
        const buys = actions.filter((a) => a.type === 'buyAdvance') as Extract<Action, { type: 'buyAdvance' }>[];
        if (buys.length === 0) return { type: 'pass' };
        const p = state.players[actor]!;
        const owned = p.advances;
        const groups = cardGroupsHeld(owned);
        // Score: prefer advances that add a new color group, then highest face
        // value per net cost.
        const scored = buys.map((b) => {
          const adv = advanceById.get(b.advance)!;
          const addsGroup = adv.groups.some((g) => !groups.has(g)) ? 1 : 0;
          const net = Math.max(1, netAdvanceCost(owned, b.advance));
          return { b, score: addsGroup * 1000 + adv.cost / net };
        });
        scored.sort((x, y) => y.score - x.score);
        // Only buy if it doesn't drain the entire hand for a marginal card late
        // game; here simply buy the top pick.
        return scored[0]!.b;
      }
      case 'shipConstruction': {
        // Build one ship when it has a coastal foothold with spare tokens and no
        // fleet yet — enough to start ferrying, without over-investing.
        const builds = actions.filter((a) => a.type === 'buildShips') as Extract<Action, { type: 'buildShips' }>[];
        if (builds.length === 0 || shipCount(state, actor) >= 1) return { type: 'pass' };
        const best = builds.find((b) => (state.areas[b.builds[0]!.area]?.tokens[actor] ?? 0) >= 4);
        return best ?? { type: 'pass' };
      }
      case 'movement': {
        // Ferry tokens to a fresh coast if we have a ship and somewhere worth going.
        const naval = planNaval(state, actor);
        if (naval) return naval;

        // Top priority: if we can afford a *supported* city (6 to build + 2 per
        // city to support, §26), consolidate 6 tokens onto a city site this turn
        // — areas are capped at their limit after city construction, so the only
        // way to assemble 6 is to gather them during movement.
        const consolidate = planCityConsolidation(state, actor);
        if (consolidate) return consolidate;

        // Otherwise grow: spread the EXCESS over each area's limit into adjacent
        // empty land, occupying new areas (more areas = more sustainable
        // population, since each is capped at its limit after surplus removal).
        const spread = planExpansionSpread(state, actor);
        if (spread) return spread;

        const moves = actions.filter((a) => a.type === 'move') as Extract<Action, { type: 'move' }>[];
        if (moves.length === 0) return { type: 'pass' };
        // Otherwise spread into empty, higher-sustains land to grow population
        // (which both feeds future cities and provides their support).
        const scored = moves.map((m) => {
          const dest = m.moves[0]!.to;
          const da = state.areas[dest];
          const area = areaById.get(dest);
          const empty = !da || Object.values(da.tokens).every((n) => n === 0) ? 1 : 0;
          const sustain = area?.sustains ?? 0;
          const site = area?.isCitySite ? 2 : 0;
          return { m, score: empty * 3 + sustain + site };
        });
        scored.sort((x, y) => y.score - x.score);
        return scored[0]!.score >= 3 ? scored[0]!.m : { type: 'pass' };
      }
      case 'trade': {
        const offer = state.negotiation.pendingOffer;
        if (offer && offer.to === actor) return respondToOffer(state, actor);
        return planTrade(state, actor, ctx.rng) ?? { type: 'pass' };
      }
      default:
        return { type: 'pass' };
    }
  }
}

/** Plan a single movement that gathers 6 tokens onto an empty city site from its
 *  neighbours, so a supported city can be built this turn. Returns a move action
 *  or null if no worthwhile consolidation exists. Only gathers up to 6 (so the
 *  rest of the population stays spread out to support the city, §26.31). */
function planCityConsolidation(state: GameState, actor: PlayerId): Action | null {
  const pop = populationCount(state, actor);
  const cities = cityCount(state, actor);
  // Need 6 to build + 2 per city (including the new one) to support.
  if (pop < 6 + 2 * (cities + 1)) return null;

  // Candidate city sites: empty of a city, where this player can muster >=6
  // tokens from the site itself plus its immediate neighbours.
  const candidates = Object.keys(state.areas).filter((aid) => {
    const area = areaById.get(aid);
    const a = state.areas[aid];
    if (!area || area.isWater || !area.isCitySite || a?.city) return false;
    const here = a?.tokens[actor] ?? 0;
    const adj = neighbors(aid).reduce((s, n) => s + (state.areas[n]?.tokens[actor] ?? 0), 0);
    return here + adj >= 6;
  });
  if (candidates.length === 0) return null;
  // Prefer the site where we already have the most tokens (least to move).
  candidates.sort((x, y) => (state.areas[y]!.tokens[actor] ?? 0) - (state.areas[x]!.tokens[actor] ?? 0));
  const target = candidates[0]!;

  let onTarget = state.areas[target]!.tokens[actor] ?? 0;
  const moves: { from: string; to: string; count: number }[] = [];
  for (const n of neighbors(target)) {
    if (onTarget >= 6) break;
    if (areaById.get(n)?.isWater) continue;
    const have = state.areas[n]?.tokens[actor] ?? 0;
    if (have <= 0) continue;
    const take = Math.min(have, 6 - onTarget);
    moves.push({ from: n, to: target, count: take });
    onTarget += take;
  }
  // If the site already holds >=6, no move is needed (build phase will handle it).
  if (moves.length === 0 || onTarget < 6) return null;
  return { type: 'move', moves };
}

/** Spread tokens above each area's limit into adjacent empty land, seeding new
 *  areas so total population can grow (§20.1 over-fills areas; movement spreads
 *  the surplus before it is removed). Leaves each source at its limit. */
function planExpansionSpread(state: GameState, actor: PlayerId): Action | null {
  const moves: { from: string; to: string; count: number }[] = [];
  for (const [aid, a] of Object.entries(state.areas)) {
    const t = a.tokens[actor] ?? 0;
    const area = areaById.get(aid);
    if (!area || area.isWater || a.city || t <= 0) continue;
    let excess = t - area.sustains;
    if (excess <= 0) continue;
    for (const n of neighbors(aid)) {
      if (excess <= 0) break;
      const nb = areaById.get(n);
      if (!nb || nb.isWater) continue;
      const na = state.areas[n];
      // Only seed empty land (no other nation, no city) to avoid picking fights.
      const contested = na && Object.entries(na.tokens).some(([o, c]) => o !== actor && c > 0);
      if (contested || na?.city) continue;
      if ((na?.tokens[actor] ?? 0) > 0) continue; // already ours — seed fresh land
      moves.push({ from: aid, to: n, count: 1 });
      excess -= 1;
    }
  }
  return moves.length ? { type: 'move', moves } : null;
}

// ---- Trade ----------------------------------------------------------------

const isCal = (c: string) => c.startsWith('calamity:');
const isTradableCal = (c: string) => isCal(c) && calamityById.get(c.slice(9))?.tradable === true;
const commValue = (c: string) => commodityById.get(c)?.value ?? 0;

/** Hand entries that may be offered in trade (commodities + tradable calamities). */
function givable(hand: Record<string, number>): [string, number][] {
  return Object.entries(hand).filter(([c, n]) => n > 0 && (!isCal(c) || isTradableCal(c)));
}
function totalGivable(hand: Record<string, number>): number {
  return givable(hand).reduce((s, [, n]) => s + n, 0);
}
/** The commodity the player most wants more of (largest set in hand). */
function topCommodity(hand: Record<string, number>): string | null {
  let best: string | null = null, bestN = 0;
  for (const [c, n] of Object.entries(hand)) if (!isCal(c) && n > bestN) { best = c; bestN = n; }
  return best;
}
/** Cheapest commodity cards (as ids, with repeats), excluding `except`. */
function cheapCommodities(hand: Record<string, number>, except: Set<string>): string[] {
  const out: string[] = [];
  for (const [c, n] of Object.entries(hand)) if (!isCal(c) && !except.has(c)) for (let i = 0; i < n; i++) out.push(c);
  return out.sort((a, b) => commValue(a) - commValue(b));
}

/** Propose a set-building swap WITHOUT peeking at opponents' hands (multiplayer-
 *  fair — the AI only ever sees its own cards). We offer spare cards we aren't
 *  collecting (two distinct types, declared, for variety so they're more likely
 *  to grow *someone's* set), slip in a tradable calamity if we hold one, and ask
 *  for two of the commodity we are collecting. The partner is chosen at random
 *  (we have no information to choose better); they accept only if it suits them. */
function planTrade(state: GameState, actor: PlayerId, rng: { pick<T>(a: readonly T[]): T }): Action | null {
  const me = state.players[actor]!;
  if (totalGivable(me.hand) < 3) return null;
  const myWant = topCommodity(me.hand);
  if (!myWant) return null;
  const myCal = givable(me.hand).map(([c]) => c).find(isTradableCal);

  // Distinct spare commodity types (not the one we collect), cheapest first.
  const spareTypes = Object.entries(me.hand)
    .filter(([c, n]) => !isCal(c) && c !== myWant && n > 0)
    .map(([c]) => c)
    .sort((a, b) => commValue(a) - commValue(b));

  const declared: Record<string, number> = {};
  const actual: Record<string, number> = {};
  for (const c of spareTypes) { if (Object.keys(declared).length >= 2) break; declared[c] = 1; actual[c] = 1; }
  if (Object.values(declared).reduce((s, n) => s + n, 0) < 2) {
    // Not enough distinct spares — declare two of the cheapest spare if we can.
    const c0 = spareTypes[0];
    if (c0 && (me.hand[c0] ?? 0) >= 2) { declared[c0] = 2; actual[c0] = 2; } else return null;
  }
  // Third card: a tradable calamity to offload, else one more spare we hold.
  if (myCal) actual[myCal] = (actual[myCal] ?? 0) + 1;
  else {
    const extra = spareTypes.find((c) => (me.hand[c] ?? 0) > (actual[c] ?? 0));
    if (!extra) return null;
    actual[extra] = (actual[extra] ?? 0) + 1;
  }
  if (Object.values(actual).reduce((s, n) => s + n, 0) < 3) return null;

  const others = state.seating.filter((o) => o !== actor);
  if (others.length === 0) return null;
  const to = rng.pick(others);
  return { type: 'proposeTrade', to, offer: { actual, declared }, request: { count: 3, declared: { [myWant]: 2 } } };
}

/** Accept an offer when it grows one of our sets or lets us offload a calamity,
 *  and we can honestly fulfil the request; otherwise decline. */
function respondToOffer(state: GameState, actor: PlayerId): Action {
  const decline = { type: 'respondTrade' as const, accept: false };
  const offer = state.negotiation.pendingOffer;
  if (!offer || offer.to !== actor) return decline;
  const me = state.players[actor]!;
  const need = offer.request.count;
  const reqDeclared = offer.request.declared;
  // Must hold the requested declared cards truthfully.
  for (const [c, n] of Object.entries(reqDeclared)) if ((me.hand[c] ?? 0) < n) return decline;
  if (totalGivable(me.hand) < need) return decline;

  const incomingGrowsSet = Object.keys(offer.offer.declared).some((c) => !isCal(c) && (me.hand[c] ?? 0) >= 1);
  const myCal = givable(me.hand).map(([c]) => c).find(isTradableCal);
  if (!incomingGrowsSet && !myCal) return decline; // no benefit

  // Build the give: the requested declared cards, then fill — our calamity first
  // (offload it), then cheapest spare commodities — up to the requested count.
  const actual: Record<string, number> = { ...reqDeclared };
  let remaining = need - Object.values(reqDeclared).reduce((s, n) => s + n, 0);
  const used = new Set(Object.keys(reqDeclared));
  if (remaining > 0 && myCal && !used.has(myCal)) { actual[myCal] = 1; used.add(myCal); remaining--; }
  for (const c of cheapCommodities(me.hand, used)) {
    if (remaining <= 0) break;
    // don't over-spend a card we don't have enough of after reqDeclared
    const already = actual[c] ?? 0;
    if ((me.hand[c] ?? 0) <= already) continue;
    actual[c] = already + 1; remaining--;
  }
  if (remaining > 0) return decline; // couldn't fulfil
  return { type: 'respondTrade', accept: true, give: { actual, declared: reqDeclared } };
}

// ---- Ships ----------------------------------------------------------------

function shipCount(state: GameState, actor: PlayerId): number {
  let n = 0;
  for (const a of Object.values(state.areas)) n += a.ships?.[actor] ?? 0;
  return n;
}

/** Ferry tokens with a ship to the best empty, fertile coast within range,
 *  keeping a couple of tokens behind. Returns a byShip move or null. */
function planNaval(state: GameState, actor: PlayerId): Action | null {
  const p = state.players[actor]!;
  const range = 4 + (p.advances.includes('clothmaking') ? 1 : 0);
  const astro = p.advances.includes('astronomy');
  for (const [aid, a] of Object.entries(state.areas)) {
    if ((a.ships?.[actor] ?? 0) <= 0) continue;
    const have = a.tokens[actor] ?? 0;
    if (have < 3) continue; // keep some behind; nothing worth ferrying
    let best: string | null = null, bestScore = 0;
    for (const to of navalDestinations(aid, range, astro)) {
      const da = state.areas[to];
      const area = areaById.get(to);
      if (!area || area.isWater) continue;
      const empty = !da || Object.values(da.tokens).every((n) => n === 0);
      const enemy = da && Object.entries(da.tokens).some(([o, n]) => o !== actor && n > 0);
      if (!empty || enemy) continue; // colonize unoccupied land
      const score = (area.sustains ?? 0) + (area.isCitySite ? 3 : 0);
      if (score > bestScore) { bestScore = score; best = to; }
    }
    if (best) return { type: 'move', moves: [{ from: aid, to: best, count: Math.min(5, have - 2), byShip: true }] };
  }
  return null;
}
