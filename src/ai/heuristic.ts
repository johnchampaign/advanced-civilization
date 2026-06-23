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
import type { Action, GameState, PlayerId, TradeBundle } from '../engine/types.js';

export class HeuristicAI implements PlayerController<GameState, Action, PlayerId> {
  async selectAction(ctx: ControllerContext<GameState, Action, PlayerId>): Promise<Action> {
    const { state, actor, adapter } = ctx;
    const actions = adapter.legalActions(state, actor);
    if (actions.length === 0) return { type: 'pass' };

    // §31.71: a pending hand-limit discard can surface in the auto astAdjustment
    // phase — take the engine's cheapest-first suggestion.
    const discard = actions.find((a) => a.type === 'chooseDiscard');
    if (discard) return discard;

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
      case 'calamity': {
        // §30: choosing which of your own cities to reduce — take the engine's
        // suggestion (sacrifice the cheapest-to-rebuild city-site cities first).
        const cityChoice = actions.find((a) => a.type === 'chooseCities');
        if (cityChoice) return cityChoice;
        // §29.63: choosing which units to lose/cede — take the cheapest-first default.
        const unitChoice = actions.find((a) => a.type === 'chooseUnits');
        if (unitChoice) return unitChoice;
        // §29.64: directing secondary losses — take the engine's leader-targeting
        // suggestion (the strategic choice: hit the current front-runner).
        const alloc = actions.find((a) => a.type === 'allocateLoss');
        if (alloc) return alloc;
        // §29/§32.94: Monotheism conversion — grab the richest target (a city
        // beats tokens; otherwise the most tokens).
        const converts = actions.filter((a) => a.type === 'convertArea') as Extract<Action, { type: 'convertArea' }>[];
        if (converts.length > 0) return converts.slice().sort((x, y) => convertValue(state, y.area) - convertValue(state, x.area))[0]!;
        return { type: 'pass' };
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
      case 'taxation': {
        // Coinage holder: tax higher (3) when treasury is low and stock can cover
        // it, to fund advances; otherwise the standard rate 2.
        const me = state.players[actor]!;
        const cities = Object.values(state.areas).filter((a) => a.city === actor).length;
        const rate = me.treasury < 40 && me.stock >= cities * 3 ? 3 : 2;
        return { type: 'setTaxRate', rate };
      }
      case 'trade':
        return planTradeTurn(state, actor, ctx.rng) ?? { type: 'pass' };
      case 'populationExpansion': {
        // Place limited growth biggest-area-first (highest cap), one at a time.
        const caps = state.expansion?.caps[actor] ?? {};
        if ((state.expansion?.remaining[actor] ?? 0) > 0) {
          const best = Object.entries(caps).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1])[0];
          if (best) return { type: 'placeTokens', placements: { [best[0]]: 1 } };
        }
        return { type: 'pass' };
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

/** Worth of a Monotheism conversion target: a city is worth a lot; otherwise the
 *  token count. */
function convertValue(state: GameState, aid: string): number {
  const a = state.areas[aid];
  if (!a) return 0;
  const cityBonus = a.city && a.city in state.players ? 12 : 0;
  const tokens = Object.entries(a.tokens).filter(([o]) => o in state.players).reduce((m, [, n]) => Math.max(m, n), 0);
  return cityBonus + tokens;
}

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

/** Build a {actual, declared} bundle from a list of card ids. Calamities are
 *  bluffed as 'ochre' so opponents don't see them; commodities are announced
 *  truthfully. Honest count is preserved (declared total == actual total). */
function buildBundle(cards: string[]): TradeBundle {
  const actual: Record<string, number> = {};
  const declared: Record<string, number> = {};
  for (const c of cards) {
    actual[c] = (actual[c] ?? 0) + 1;
    const name = isCal(c) ? 'ochre' : c;
    declared[name] = (declared[name] ?? 0) + 1;
  }
  return { actual, declared };
}

/** Three+ cards to give away: a tradable calamity to offload (if held) plus the
 *  cheapest spares we aren't collecting, and optionally a wanted commodity. */
function buildGive(me: { hand: Record<string, number> }, collect: string, wantToInclude?: string): TradeBundle | null {
  const cards: string[] = [];
  const committed: Record<string, number> = {};
  const take = (c: string) => { committed[c] = (committed[c] ?? 0) + 1; cards.push(c); };
  const cal = givable(me.hand).map(([c]) => c).find(isTradableCal);
  if (cal) take(cal);
  if (wantToInclude && !isCal(wantToInclude) && wantToInclude !== collect && (me.hand[wantToInclude] ?? 0) > (committed[wantToInclude] ?? 0)) take(wantToInclude);
  for (const c of cheapCommodities(me.hand, new Set([collect]))) {
    if (cards.length >= 3) break;
    if ((me.hand[c] ?? 0) <= (committed[c] ?? 0)) continue;
    take(c);
  }
  if (cards.length < 3 || cards.filter((c) => !isCal(c)).length < 2) return null; // need ≥3 & ≥2 truthful
  return buildBundle(cards);
}

/** One trade action per turn (multiplayer-fair — only our own hand is read):
 *  accept a good response to our offer, else post one offer, else respond to an
 *  offer that grows our set / lets us offload a calamity, else pass. */
function planTradeTurn(state: GameState, actor: PlayerId, _rng: { pick<T>(a: readonly T[]): T }): Action | null {
  const me = state.players[actor]!;
  const n = state.negotiation;
  const myWant = topCommodity(me.hand);

  // (a) Accept a response to our own offer (judged on its declared cards).
  const mine = n.offers.find((o) => o.from === actor);
  if (mine && mine.responses.length) {
    const good = mine.responses.find((r) => Object.keys(r.give.declared).some((c) => !isCal(c) && (myWant === c || (me.hand[c] ?? 0) >= 1))) ?? mine.responses[0];
    if (good) return { type: 'acceptResponse', offerId: mine.id, responder: good.from };
  }

  // (b) Post one standing offer if we have none.
  if (!mine && totalGivable(me.hand) >= 3 && myWant) {
    const give = buildGive(me, myWant);
    if (give) return { type: 'postOffer', give, wants: [myWant] };
  }

  // (c) Respond to another player's offer that benefits us and we haven't answered.
  for (const o of n.offers) {
    if (o.from === actor || o.responses.some((r) => r.from === actor)) continue;
    const grows = Object.keys(o.give.declared).some((c) => !isCal(c) && (me.hand[c] ?? 0) >= 1);
    const haveCal = givable(me.hand).some(([c]) => isTradableCal(c));
    if (!grows && !haveCal) continue;
    const give = buildGive(me, myWant ?? '', o.wants.find((w) => (me.hand[w] ?? 0) >= 1));
    if (give) return { type: 'respondOffer', offerId: o.id, give };
  }

  return { type: 'pass' };
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
