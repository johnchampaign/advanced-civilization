// A simple heuristic AI controller for Advanced Civilization. It implements the
// framework's PlayerController. Strategy per interactive phase:
//   - movement: one order set per turn — ferry by ship to empty land, gather 6
//     tokens onto every city site population can support, and spread surplus
//     into fresh land so it isn't lost.
//   - cityConstruction: always build a city when able (cities drive everything).
//   - acquireAdvances: buy a basket of advances in one pooled payment, new card
//     groups first, then best value per point paid; pay with whole commodity
//     sets chosen to overpay least, the rest exactly from treasury.
//   - trade: seek mutually-beneficial set-building swaps (give a partner the
//     commodity they collect for the commodity we collect), opportunistically
//     dumping a tradable calamity among the undeclared cards; accept incoming
//     offers that grow our sets or let us offload a calamity.
// It is deliberately greedy and fast, good enough for solo play and as a
// baseline opponent. It is multiplayer-fair: it only ever reads its OWN hand
// (the trade planner proposes blind, never inspecting opponents' cards).

import type { PlayerController, ControllerContext } from 'digital-boardgame-framework';
import { advanceById, areaById, calamityById, civById, commodityById } from '../data/index.js';
import { bundleFace, cardGroupsHeld, cityCount, citySiteIn, commoditySetValue, creditTowards, handValue, landNeighbors, navalDestinations, neighbors, populationCount } from '../engine/helpers.js';
import type { Action, GameState, PlayerId, TradeBundle } from '../engine/types.js';

export class HeuristicAI implements PlayerController<GameState, Action, PlayerId> {
  /** `aggressive: false` turns off attacking rivals and `defensive: false`
   *  defending cities (both kept for comparison runs). */
  constructor(private readonly opts: { aggressive?: boolean; defensive?: boolean } = {}) {}

  async selectAction(ctx: ControllerContext<GameState, Action, PlayerId>): Promise<Action> {
    const { state, actor, adapter } = ctx;
    const actions = adapter.legalActions(state, actor);
    if (actions.length === 0) return { type: 'pass' };

    // §27.51: a ninth-stack (Gold/Ivory) window right after drawing — 18 treasury
    // a card, the tokens returning to stock.
    if (state.ninthStack?.awaiting) return planNinthStack(state, actor, actions);

    // §16.3: choose where the first token goes (before turn 1).
    if (state.pendingStart) {
      const starts = actions.filter((a) => a.type === 'placeStart') as Extract<Action, { type: 'placeStart' }>[];
      if (starts.length) return bestStart(state, actor, starts);
    }

    // §31.71: a pending hand-limit discard can surface in the auto astAdjustment
    // phase — take the engine's cheapest-first suggestion.
    const discard = actions.find((a) => a.type === 'chooseDiscard');
    if (discard) return discard;
    // §24.52: a stormed city may be pillaged for up to three tokens — take the
    // lot (treasury pays for cities and ships; the AI is never short of stock).
    if (state.pendingPillage?.length) {
      const pill = (actions.filter((a) => a.type === 'pillage') as Extract<Action, { type: 'pillage' }>[])
        .sort((a, b) => b.count - a.count)[0];
      if (pill) return pill;
    }
    // §26.32: a city-support reduction (can surface in the auto removeSurplus phase
    // or during Slave Revolt) — take the engine's cheapest-city suggestion.
    if (state.pendingSupport) { const c = actions.find((a) => a.type === 'chooseCities'); if (c) return c; }
    // §19.32/§30.x: a city-selection pick (e.g. tax-revolt beneficiary) can surface
    // outside the calamity phase — take the engine's suggested pick.
    if (state.pendingPick) { const pk = actions.find((a) => a.type === 'pickAreas'); if (pk) return pk; }

    switch (state.phase) {
      case 'cityConstruction': {
        // Only build a city we can actually support: an area with a city holds
        // no tokens (§26.1), so support comes from tokens elsewhere — 2 per city
        // across all cities (§26.31) — counted after the surplus removal that
        // follows straight on (each area keeps only its population limit).
        const builds = actions.filter((a) => a.type === 'buildCity') as Extract<Action, { type: 'buildCity' }>[];
        const cities = cityCount(state, actor);
        const tokens = Object.fromEntries(Object.entries(state.areas).map(([aid, a]) => [aid, a.tokens[actor] ?? 0]));
        const supported = builds.find((b) => supportAfter(state, actor, tokens, new Set([b.area])) >= 2 * (cities + 1));
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
        // §30.41 Civil War: faction selection (victim offers cheapest / beneficiary
        // grabs strongest) and which faction to keep — take the engine's suggestion.
        const cwSelect = actions.find((a) => a.type === 'civilWarSelect');
        if (cwSelect) return cwSelect;
        const cwKeep = actions.find((a) => a.type === 'civilWarKeep');
        if (cwKeep) return cwKeep;
        // §30.221/.514/.91: city selections (Treachery/Flood/Piracy) — take the
        // engine's suggested pick (self-loss = cheapest; adversarial = leaders).
        const pick = actions.find((a) => a.type === 'pickAreas');
        if (pick) return pick;
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
        // Next turn's tax comes out of stock, 2 a city (§19.1), and nothing
        // refills stock before then except treasury spent here; any shortfall
        // means revolting cities, handed to a rival (§19.31-.32).
        const me = state.players[actor]!;
        const taxShort = Math.max(0, 2 * cityCount(state, actor) - me.stock);
        return planAdvancePurchase(me, buys.map((b) => b.advance ?? b.advances?.[0] ?? ''), taxShort) ?? buys[0]!;
      }
      case 'shipConstruction': {
        // §22.3: every ship costs upkeep each turn, so decline it (scrap) for a
        // ship that can't be used — too few of our tokens beside it to ferry, or
        // no unoccupied land in reach, e.g. on Nineveh's lake (report c2fa4b00).
        const scrap = (actions.filter((a) => a.type === 'scrapShip') as Extract<Action, { type: 'scrapShip' }>[])
          .find((a) => !shipUseful(state, actor, a.area, state.areas[a.area]?.tokens[actor] ?? 0));
        if (scrap) return scrap;
        // Build one ship when it has no fleet yet, where it can carry at least 3
        // tokens straight away (movement follows directly) to land worth settling.
        // Paying from treasury keeps the tokens on the shore to sail.
        const builds = actions.filter((a) => a.type === 'buildShips') as Extract<Action, { type: 'buildShips' }>[];
        if (builds.length === 0 || shipCount(state, actor) >= 1) return { type: 'pass' };
        const levy = { treasury: 0, split: 1, area: 2 } as const;
        const best = builds
          .filter((b) => { const { area, payFrom } = b.builds[0]!; return shipUseful(state, actor, area, (state.areas[area]?.tokens[actor] ?? 0) - levy[payFrom ?? 'area']); })
          .sort((x, y) => levy[x.builds[0]!.payFrom ?? 'area'] - levy[y.builds[0]!.payFrom ?? 'area'])[0];
        return best ?? { type: 'pass' };
      }
      case 'movement': {
        // A nation moves once per phase (§23), so everything worth doing this
        // turn goes into ONE order set: ferrying, gathering 6 tokens onto city
        // sites, and spreading surplus into fresh land.
        const plan = planMovement(state, actor, this.opts.aggressive ?? true, this.opts.defensive ?? true);
        if (plan) return plan;

        const moves = actions.filter((a) => a.type === 'move') as Extract<Action, { type: 'move' }>[];
        if (moves.length === 0) return { type: 'pass' };
        // Otherwise spread into empty, higher-sustains land to grow population
        // (which both feeds future cities and provides their support).
        // Never walk into a rival's city or tokens this way: it moves the whole
        // stack, and an unguarded city is not "empty" — the tokens die (§24.31).
        const scored = moves.filter((m) => !rivalsIn(state, actor, m.moves[0]!.to)).map((m) => {
          const dest = m.moves[0]!.to;
          const da = state.areas[dest];
          const area = areaById.get(dest);
          const empty = !da || Object.values(da.tokens).every((n) => n === 0) ? 1 : 0;
          const sustain = area?.sustains ?? 0;
          const site = citySiteIn(state, dest) ? 2 : 0;
          return { m, score: empty * 3 + sustain + site };
        });
        scored.sort((x, y) => y.score - x.score);
        return scored[0] && scored[0].score >= 3 ? scored[0].m : { type: 'pass' };
      }
      case 'taxation': {
        // Coinage holder (§19.2): tax higher (3) when treasury is low and stock
        // can cover it, to fund advances; otherwise the standard rate 2 — or 1
        // when stock can't pay 2 a city, since unpaid cities revolt (§19.31).
        const me = state.players[actor]!;
        const cities = Object.values(state.areas).filter((a) => a.city === actor).length;
        const rate = me.treasury < 40 && me.stock >= cities * 3 ? 3 : me.stock >= cities * 2 ? 2 : 1;
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

type Move = Extract<Action, { type: 'move' }>['moves'][number];

/** Tokens left to support cities once surplus is removed (§26.31): every area
 *  without a city keeps at most its population limit (one more with
 *  Agriculture where we're alone, §32.241). `skip` are areas about
 *  to become cities (their tokens go into the city). */
function supportAfter(state: GameState, actor: PlayerId, tokens: Record<string, number>, skip: ReadonlySet<string>): number {
  const agri = !!state.players[actor]?.advances.includes('agriculture');
  let n = 0;
  for (const [aid, t] of Object.entries(tokens)) {
    if (t <= 0 || skip.has(aid) || state.areas[aid]?.city) continue;
    const limit = (areaById.get(aid)?.sustains ?? 0) + (agri && !rivalsIn(state, actor, aid) ? 1 : 0); // §32.241
    n += Math.min(t, limit);
  }
  return n;
}

/** Two-sided token fight as the engine resolves it (§24.2): alternate removals,
 *  fewest first, a Metalworking holder last (§24.24), equal sides together,
 *  until one side is gone or the total fits the limit (0 at a city). Returns
 *  the [attacker, defender] survivors. */
function fight(att: number, def: number, limit: number, attMetal: boolean, defMetal: boolean): [number, number] {
  let a = att, d = def;
  while (a > 0 && d > 0 && a + d > limit) {
    const aFirst = attMetal !== defMetal ? defMetal : a < d;
    if (attMetal === defMetal && a === d) { a--; d--; continue; }
    if (aFirst) { a--; if (a > 0 && a + d > limit) d--; }
    else { d--; if (d > 0 && a + d > limit) a--; }
  }
  return [a, d];
}

const BARBARIAN = '__barbarian__';

const rivalsIn = (state: GameState, actor: PlayerId, aid: string) => {
  const a = state.areas[aid];
  return !!a && ((!!a.city && a.city !== actor) || Object.entries(a.tokens).some(([o, n]) => o !== actor && n > 0));
};

/** The whole movement turn as one order set. Each token moves once, so the plan
 *  only ever moves tokens that started the phase in an area (`free`), while
 *  `after` tracks where everything ends up.
 *   1. Ferry spare tokens by ship to unoccupied land (ship moves go first:
 *      tokens that arrived overland may not embark, §23.51).
 *   2. Defend (when defensive) any city a rival could storm this turn.
 *   3. Gather 6 tokens onto as many city sites as population can support
 *      (6 per city + 2 per city in play, §25.2/§26.31), or 12 onto open land
 *      when there is no site to use and population is large.
 *   4. Attack (when aggressive): storm rival cities we can take while our own
 *      cities stay supported, throw surplus — tokens surplus removal would
 *      take anyway (§26.1) — at rival tokens on land we can clear, and clear
 *      Barbarians off land with regular tokens too.
 *   5. Spread the remaining surplus into empty land, toward city sites further
 *      off, then into our own areas with room. */
function planMovement(state: GameState, actor: PlayerId, aggressive: boolean, defensive: boolean): Action | null {
  const free: Record<string, number> = {};
  for (const [aid, a] of Object.entries(state.areas)) {
    const t = a.tokens[actor] ?? 0;
    if (t > 0 && !areaById.get(aid)?.isWater) free[aid] = t;
  }
  const after: Record<string, number> = { ...free };
  const moves: Move[] = [];
  const shift = (from: string, to: string, count: number, byShip = false) => {
    if (count <= 0) return;
    free[from] = (free[from] ?? 0) - count;
    after[from] = (after[from] ?? 0) - count;
    after[to] = (after[to] ?? 0) + count;
    const last = moves[moves.length - 1];
    if (!byShip && last && !last.byShip && last.from === from && last.to === to) last.count += count;
    else moves.push(byShip ? { from, to, count, byShip: true } : { from, to, count });
  };
  // Population limits as surplus removal applies them: Agriculture adds one
  // where we're alone (§32.241) — and a contested area, the only place a fight
  // happens, keeps its printed limit, as the rule says for conflicts.
  const agri = state.players[actor]!.advances.includes('agriculture');
  const sustains = (aid: string) => (areaById.get(aid)?.sustains ?? 0) + (agri && !rivalsIn(state, actor, aid) ? 1 : 0);
  const land = (aid: string) => neighbors(state, aid).filter((n) => !areaById.get(n)?.isWater);
  const targets = new Set<string>(); // city sites being filled this turn

  // 1. Ships.
  const sailed = new Set<string>(); // areas whose ship has made its voyage this turn
  const p = state.players[actor]!;
  const range = 4 + (p.advances.includes('clothmaking') ? 1 : 0);
  const astro = p.advances.includes('astronomy');
  for (const [aid, a] of Object.entries(state.areas)) {
    if ((a.ships?.[actor] ?? 0) <= 0 || (free[aid] ?? 0) < 3) continue;
    let best: string | null = null, bestScore = 0;
    for (const to of overseas(state, aid, range, astro)) {
      const area = areaById.get(to);
      if (!area || area.isWater || (after[to] ?? 0) > 0 || rivalsIn(state, actor, to)) continue;
      const score = area.sustains + (citySiteIn(state, to) ? 3 : 0);
      if (score > bestScore) { bestScore = score; best = to; }
    }
    if (best) { shift(aid, best, Math.min(5, free[aid]! - 2), true); sailed.add(aid); }
  }

  const metal = (id: string) => !!state.players[id]?.advances.includes('metalworking');
  const eng = (id: string) => !!state.players[id]?.advances.includes('engineering');
  /** Tokens a nation needs to storm a city of `def` (§24.31/§24.35). */
  const toStorm = (att: string, def: string) => (eng(att) && !eng(def) ? 6 : eng(def) && !eng(att) ? 8 : 7);

  // 2. Defence (§24.41: defenders must be beaten before a city can be stormed).
  // A city a rival could storm this turn gets just enough defenders that too
  // few attackers would survive to assault it. Defenders are lost to surplus
  // removal afterwards (a city area holds no tokens, §26.1), so only the
  // cheapest sufficient defence goes in, from neighbours that keep a token.
  if (defensive) {
    const acted = new Set(state.actedThisPhase);
    for (const [aid, a] of Object.entries(state.areas)) {
      if (a.city !== actor) continue;
      const donors = land(aid).filter((n) => !state.areas[n]?.city && (free[n] ?? 0) > 1);
      let need = 0;
      for (const foe of Object.keys(state.players)) {
        if (foe === actor) continue;
        // Tokens already in the city, plus — if the rival has yet to move —
        // what it could bring from next door (keeping one in each area).
        const threat = (a.tokens[foe] ?? 0) + (acted.has(foe) ? 0
          : land(aid).reduce((t, n) => t + Math.max(0, (state.areas[n]?.tokens[foe] ?? 0) - 1), 0));
        const req = toStorm(foe, actor);
        if (threat < req) continue;
        let d = after[aid] ?? 0;
        while (d < 8 && fight(threat, d, 0, metal(foe), metal(actor))[0] >= req) d++;
        need = Math.max(need, d - (after[aid] ?? 0));
      }
      const spare = donors.reduce((t, n) => t + free[n]! - 1, 0);
      if (need <= 0 || need > 5 || spare < need) continue;
      const snapFree = { ...free }, snapAfter = { ...after }, snapMoves = moves.map((m) => ({ ...m }));
      donors.sort((x, y) => ((after[y] ?? 0) - sustains(y)) - ((after[x] ?? 0) - sustains(x)));
      let left = need;
      for (const n of donors) { if (left <= 0) break; const k = Math.min(left, free[n]! - 1); shift(n, aid, k); left -= k; }
      if (supportAfter(state, actor, after, targets) >= 2 * cityCount(state, actor)) { free[aid] = 0; continue; }
      Object.assign(free, snapFree); for (const k of Object.keys(after)) after[k] = snapAfter[k] ?? 0;
      moves.length = 0; moves.push(...snapMoves);
    }
  }

  // 3. Cities: gather 6 tokens onto as many printed city sites as population can
  // support (6 to build + 2 support per city), from the site and its neighbours.
  // Failing any site, a large population may build on open land with 12 (§25.2).
  const pop = populationCount(state, actor);
  const cities = cityCount(state, actor);
  const open = (aid: string) => !targets.has(aid) && !areaById.get(aid)?.isWater && !state.areas[aid]?.city && !rivalsIn(state, actor, aid);
  const gatherable = (site: string) => (after[site] ?? 0) + land(site).reduce((t, n) => t + (targets.has(n) ? 0 : Math.max(0, free[n] ?? 0)), 0);
  const areaIds = [...new Set([...Object.keys(state.areas), ...Object.keys(after)])];
  /** Tentatively gather `need` tokens onto `site`; keep it only if the cities
   *  planned so far stay supported, else roll back. */
  const tryGather = (site: string, need: number): boolean => {
    const snapFree = { ...free }, snapAfter = { ...after }, snapMoves = moves.map((m) => ({ ...m }));
    const donors = land(site).filter((n) => !targets.has(n) && (free[n] ?? 0) > 0)
      .sort((x, y) => ((after[y] ?? 0) - sustains(y)) - ((after[x] ?? 0) - sustains(x)));
    for (const n of donors) {
      const short = need - (after[site] ?? 0);
      if (short <= 0) break;
      shift(n, site, Math.min(short, free[n]!));
    }
    if ((after[site] ?? 0) >= need && supportAfter(state, actor, after, new Set([...targets, site])) >= 2 * (cities + targets.size + 1)) {
      targets.add(site); free[site] = 0; // its tokens stay to build the city
      return true;
    }
    Object.assign(free, snapFree); for (const k of Object.keys(after)) after[k] = snapAfter[k] ?? 0;
    moves.length = 0; moves.push(...snapMoves);
    return false;
  };
  while (targets.size < p.citiesAvailable && pop >= 8 * (targets.size + 1) + 2 * cities) {
    const sites = areaIds.filter((aid) => open(aid) && citySiteIn(state, aid) && gatherable(aid) >= 6)
      .sort((x, y) => (after[y] ?? 0) - (after[x] ?? 0));
    if (!sites.some((site) => tryGather(site, 6))) break;
  }
  if (targets.size === 0 && p.citiesAvailable > 0 && pop >= 30 + 2 * cities) {
    const fields = areaIds.filter((aid) => open(aid) && !citySiteIn(state, aid) && gatherable(aid) >= 12)
      .sort((x, y) => (after[y] ?? 0) - (after[x] ?? 0));
    fields.some((aid) => tryGather(aid, 12));
  }

  // 4. Attacks. Rivals are everyone else — other nations, human or AI, plus
  // Barbarians and Pirates.
  if (aggressive) {
    const stormed = new Set<string>();
    const leader = (id: string) => (state.players[id] ? cityCount(state, id) * 10 + state.players[id]!.astSpace : 0);
    // City storms (§24.3): the cheapest force that still takes the city, drawn
    // from neighbours that each keep a token (and from ships in range), while
    // our own cities stay supported.
    const rivalCities = areaIds.filter((aid) => {
      const a = state.areas[aid];
      return !!a?.city && a.city !== actor && Object.entries(a.tokens).every(([o, n]) => o === a.city || n <= 0);
    }).sort((x, y) => leader(state.areas[y]!.city!) - leader(state.areas[x]!.city!));
    for (const aid of rivalCities) {
      if (stormed.size >= 2) break;
      const def = state.areas[aid]!.city!;
      const pirate = !state.players[def];
      const required = pirate ? (eng(actor) ? 6 : 7) : toStorm(actor, def);
      const defenders = state.areas[aid]!.tokens[def] ?? 0;
      // Defending tokens fight first (§24.41); enough must survive to assault.
      let force = required;
      while (force < 20 && fight(force, defenders, 0, metal(actor), metal(def))[0] < required) force++;
      const donors = land(aid).filter((n) => !targets.has(n) && !state.areas[n]?.city && (free[n] ?? 0) > 1);
      // Ships within range can land up to 5 more each (§23.51) to make up the force.
      const fleets = Object.keys(state.areas).filter((x) => (state.areas[x]!.ships?.[actor] ?? 0) > 0 && !sailed.has(x)
        && !donors.includes(x) && (free[x] ?? 0) > 1 && navalDestinations(state, x, range, astro).has(aid));
      const landSpare = donors.reduce((t, n) => t + free[n]! - 1, 0);
      const spare = landSpare + fleets.reduce((t, x) => t + Math.min(5, free[x]! - 1), 0);
      if (spare < force || pop < force + 4 + 2 * (cities + targets.size)) continue;
      const snapFree = { ...free }, snapAfter = { ...after }, snapMoves = moves.map((m) => ({ ...m }));
      const snapSailed = new Set(sailed);
      donors.sort((x, y) => ((after[y] ?? 0) - sustains(y)) - ((after[x] ?? 0) - sustains(x)));
      for (const n of donors) { const short = force - (after[aid] ?? 0); if (short <= 0) break; shift(n, aid, Math.min(short, free[n]! - 1)); }
      for (const x of fleets) { const short = force - (after[aid] ?? 0); if (short <= 0) break; shift(x, aid, Math.min(short, 5, free[x]! - 1), true); sailed.add(x); }
      if (supportAfter(state, actor, after, targets) >= 2 * (cities + targets.size)) { stormed.add(aid); free[aid] = 0; continue; }
      sailed.clear(); for (const x of snapSailed) sailed.add(x);
      Object.assign(free, snapFree); for (const k of Object.keys(after)) after[k] = snapAfter[k] ?? 0;
      moves.length = 0; moves.push(...snapMoves);
    }
    // Land fights (§24.2): clear a rival's tokens off land worth holding.
    // Against nations, only with surplus — tokens surplus removal would take
    // anyway (§26.1). Barbarians stay put until someone clears them, blocking
    // the land, so against them regular tokens go in too (each donor keeps
    // one) while our cities stay supported (report 39184c86).
    let barbFights = 0;
    for (const aid of areaIds) {
      const a = state.areas[aid];
      if (!a || a.city || areaById.get(aid)?.isWater || sustains(aid) < 1) continue;
      const foes = Object.entries(a.tokens).filter(([o, n]) => o !== actor && n > 0);
      if (foes.length !== 1) continue;
      const [foe, r] = foes[0]!;
      const barbarian = foe === BARBARIAN;
      if (barbarian && barbFights >= 2) continue;
      const surplus = (n: string) => Math.max(0, Math.min(free[n] ?? 0, (after[n] ?? 0) - sustains(n)));
      const usable = (n: string) => (barbarian ? Math.max(0, (free[n] ?? 0) - 1, surplus(n)) : surplus(n));
      const donors = land(aid).filter((n) => !targets.has(n) && !stormed.has(n) && !state.areas[n]?.city && usable(n) > 0)
        .sort((x, y) => surplus(y) - surplus(x));
      const pool = donors.reduce((t, n) => t + usable(n), 0);
      let force = 0;
      for (let f = 1; f <= pool; f++) { const [mine, theirs] = fight(f, r, sustains(aid), metal(actor), metal(foe)); if (theirs === 0 && mine > 0) { force = f; break; } }
      if (!force) continue;
      const snapFree = { ...free }, snapAfter = { ...after }, snapMoves = moves.map((m) => ({ ...m }));
      for (const n of donors) { const short = force - (after[aid] ?? 0); if (short <= 0) break; shift(n, aid, Math.min(short, usable(n))); }
      if (!barbarian || supportAfter(state, actor, after, targets) >= 2 * (cities + targets.size)) {
        free[aid] = 0; if (barbarian) barbFights++;
        continue;
      }
      Object.assign(free, snapFree); for (const k of Object.keys(after)) after[k] = snapAfter[k] ?? 0;
      moves.length = 0; moves.push(...snapMoves);
    }
  }

  // March surplus toward an open city site that is out of reach this turn, so
  // the tokens can be gathered onto it next turn — and, when aggressive, toward
  // rival cities, massing in our areas beside them for a later storm.
  const dist = new Map<string, number>();
  let ring = areaIds.filter((aid) => (open(aid) && citySiteIn(state, aid))
    || (aggressive && !!state.areas[aid]?.city && state.areas[aid]!.city !== actor));
  for (const aid of ring) dist.set(aid, 0);
  for (let d = 1; d <= 3 && ring.length; d++) {
    const next: string[] = [];
    for (const aid of ring) for (const n of land(aid)) if (!dist.has(n) && !rivalsIn(state, actor, n)) { dist.set(n, d); next.push(n); }
    ring = next;
  }

  // 5. Surplus: seed empty land (one token each), march toward city sites, then
  // top up our own areas that are below their limit. Surplus left where it is
  // goes back to stock at surplus removal (§26.1), and next turn's tax is paid
  // from stock, 2 a city (§19.1), before anything else refills it — unpaid
  // cities revolt to a rival (§19.31). So spread only what stock can spare.
  const surplusNow = Object.keys(after).reduce((t, aid) =>
    t + (targets.has(aid) || state.areas[aid]?.city ? 0 : Math.max(0, (after[aid] ?? 0) - sustains(aid))), 0);
  let spreadable = Math.max(0, p.stock + 6 * targets.size + p.treasury + surplusNow - 2 * (cities + targets.size) - 2);
  const spread = (from: string, to: string, k: number) => { const n = Math.min(k, spreadable); if (n > 0) { shift(from, to, n); spreadable -= n; } };
  for (const pass of ['seed', 'march', 'fill'] as const) {
    for (const aid of Object.keys(free)) {
      if (targets.has(aid) || state.areas[aid]?.city) continue;
      for (const n of land(aid)) {
        const excess = Math.min(free[aid] ?? 0, (after[aid] ?? 0) - sustains(aid));
        if (excess <= 0) break;
        if (targets.has(n) || state.areas[n]?.city || rivalsIn(state, actor, n) || sustains(n) <= 0) continue;
        if (pass === 'seed' && (after[n] ?? 0) === 0) spread(aid, n, 1);
        else if (pass === 'march' && (dist.get(aid) ?? 0) >= 2 && dist.get(n) === dist.get(aid)! - 1) spread(aid, n, excess);
        else if (pass === 'fill' && (after[n] ?? 0) > 0) spread(aid, n, Math.min(excess, sustains(n) - (after[n] ?? 0)));
      }
    }
  }

  return moves.length ? { type: 'move', moves } : null;
}

// ---- Ninth stack -----------------------------------------------------------

/** Buy Gold/Ivory from the ninth stack (§27.51). Treasury piles up once the
 *  cheap advances are bought, and with 55 tokens in all a big treasury starves
 *  stock — next turn's tax (2 a city from stock, §19.1) then falls short and
 *  cities revolt to a rival (§19.31-.32). Each card bought puts 18 tokens back
 *  in stock. So buy enough to cover that tax, and otherwise one card to grow a
 *  Gold or Ivory set already in hand (sets score n² × 9; a lone random card is
 *  worth only 9 of the 18 paid) — never past the 8-card hand limit (§31.71). */
function planNinthStack(state: GameState, actor: PlayerId, actions: Action[]): Action {
  const p = state.players[actor]!;
  const offered = actions.filter((a) => a.type === 'buyTradeCard') as Extract<Action, { type: 'buyTradeCard' }>[];
  const most = offered.reduce((m, a) => Math.max(m, a.count), 0);
  const held = Object.entries(p.hand).reduce((t, [c, k]) => t + (isCal(c) ? 0 : k), 0);
  const room = Math.max(0, 8 - held);
  const taxShort = Math.max(0, 2 * cityCount(state, actor) - p.stock);
  const growing = (p.hand['gold'] ?? 0) + (p.hand['ivory'] ?? 0) > 0;
  const want = taxShort > 0 ? Math.ceil(taxShort / 18) : growing && p.treasury >= 18 ? 1 : 0;
  const count = Math.min(want, most, room);
  return count > 0 ? { type: 'buyTradeCard', count } : { type: 'pass' };
}

// ---- Advances --------------------------------------------------------------// ---- Advances --------------------------------------------------------------

/** Extra weight for advances whose effect is worth more than their price:
 *  Agriculture's +1 population limit in every area held alone (§32.241) feeds
 *  every city and trade card after it — "the most important card" for a
 *  nation short of land, per the rulebook's strategy notes. */
const ADVANCE_BONUS: Record<string, number> = { agriculture: 3 };

/** One pooled purchase (§31): a basket of advances and the cheapest way to pay.
 *  Excess card value is lost (§31.58) and a commodity set is worth n² × value,
 *  so the AI pays with whole sets — splitting one throws value away — choosing
 *  the sets that overpay least, and makes up the rest exactly from treasury. */
function planAdvancePurchase(p: { advances: string[]; advancesThisTurn?: string[]; hand: Record<string, number>; treasury: number; grainLockedThisTurn?: number }, candidates: string[], taxShort = 0): Action | null {
  // Spendable cards: commodities only, minus Grain locked against Famine (§30.312).
  const hand: Record<string, number> = {};
  for (const [c, n] of Object.entries(p.hand)) if (!isCal(c) && n > 0) hand[c] = n;
  if (hand['grain']) { hand['grain'] -= p.grainLockedThisTurn ?? 0; if (hand['grain'] <= 0) delete hand['grain']; }
  // §31.53: cards bought earlier this turn give no credit yet.
  const eligible = p.advances.filter((a) => !(p.advancesThisTurn ?? []).includes(a));
  const net = (id: string) => Math.max(0, (advanceById.get(id)?.cost ?? Infinity) - creditTowards(eligible, id));
  const budget = handValue(hand) + p.treasury;

  // Basket: best first — a new colour group (A.S.T. entry needs them, §33),
  // then the most face value per point actually paid — while the budget lasts.
  const basket: string[] = [];
  const groups = cardGroupsHeld(p.advances);
  let need = 0;
  const pool = candidates.filter((id) => advanceById.has(id));
  while (pool.length) {
    pool.sort((x, y) => score(y) - score(x));
    const pick = pool.shift()!;
    if (need + net(pick) > budget) continue;
    basket.push(pick); need += net(pick);
    for (const g of advanceById.get(pick)!.groups) groups.add(g);
  }
  function score(id: string): number {
    const adv = advanceById.get(id)!;
    return (adv.groups.some((g) => !groups.has(g)) ? 1000 : 0) + adv.cost / Math.max(1, net(id)) + (ADVANCE_BONUS[id] ?? 0);
  }
  if (basket.length === 0) return null;

  // Payment: the subset of whole sets that, with treasury, covers `need` while
  // overpaying least; ties keep more treasury — unless stock is short for next
  // turn's tax, when spending treasury (which returns to stock) comes first.
  const sets = Object.keys(hand).map((c) => ({ c, v: commoditySetValue(c, hand[c]!) }));
  const refill = Math.min(taxShort, need, p.treasury);
  let best: { mask: number; short: number; waste: number; treasury: number } | null = null;
  for (let mask = 0; mask < 1 << sets.length; mask++) {
    let v = 0;
    sets.forEach((x, i) => { if (mask & (1 << i)) v += x.v; });
    const treasury = Math.max(0, need - v);
    if (treasury > p.treasury) continue;
    const short = Math.max(0, refill - treasury);
    const waste = Math.max(0, v - need);
    if (!best || short < best.short || (short === best.short && (waste < best.waste || (waste === best.waste && treasury < best.treasury)))) best = { mask, short, waste, treasury };
  }
  if (!best) return null;
  const spendCommodities: Record<string, number> = {};
  sets.forEach((x, i) => { if (best!.mask & (1 << i)) spendCommodities[x.c] = hand[x.c]!; });
  return basket.length === 1
    ? { type: 'buyAdvance', advance: basket[0]!, spendCommodities, spendTreasury: best.treasury }
    : { type: 'buyAdvance', advances: basket, spendCommodities, spendTreasury: best.treasury };
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
/** The commodity the player most wants more of: the one whose set value grows the
 *  most from one more card (§28.51 — a set is n²×value, so the marginal gain is
 *  (2n+1)×value). This favours valuable commodities and near-complete sets, rather
 *  than just whatever you hold the most cheap cards of (e.g. ochre/hides). */
function topCommodity(hand: Record<string, number>): string | null {
  let best: string | null = null, bestGain = 0;
  for (const [c, n] of Object.entries(hand)) {
    if (isCal(c) || n <= 0) continue;
    const gain = commoditySetValue(c, n + 1) - commoditySetValue(c, n);
    if (gain > bestGain) { bestGain = gain; best = c; }
  }
  return best;
}
/** Cheapest commodity cards (as ids, with repeats), excluding `except`. */
function cheapCommodities(hand: Record<string, number>, except: Set<string>): string[] {
  const out: string[] = [];
  for (const [c, n] of Object.entries(hand)) if (!isCal(c) && !except.has(c)) for (let i = 0; i < n; i++) out.push(c);
  return out.sort((a, b) => commValue(a) - commValue(b));
}

/** Build a §28.3 bundle from a list of card ids: an honest count, two real
 *  commodities NAMED (binding), and claims about the rest — truthful for
 *  commodities, while a slipped-in calamity is claimed as 'ochre' so opponents
 *  don't see it (claims are non-binding, so that bluff is legal). */
function buildBundle(cards: string[]): TradeBundle {
  const actual: Record<string, number> = {};
  const declared: Record<string, number> = {};
  const claimed: Record<string, number> = {};
  let named = 0;
  for (const c of cards) {
    actual[c] = (actual[c] ?? 0) + 1;
    if (!isCal(c) && named < 2) { declared[c] = (declared[c] ?? 0) + 1; named += 1; continue; }
    const name = isCal(c) ? 'ochre' : c;
    claimed[name] = (claimed[name] ?? 0) + 1;
  }
  return { actual, declared, count: cards.length, claimed };
}

/** Every card name a bundle mentions — guaranteed or merely claimed. */
const mentioned = (b: TradeBundle) => Object.keys({ ...bundleFace(b).guaranteed, ...bundleFace(b).claimed });

/** Three+ cards to give away: a tradable calamity to offload (if held) plus the
 *  cheapest spares we aren't collecting, and optionally a wanted commodity. */
function buildGive(me: { hand: Record<string, number> }, collect: string, wantToInclude?: string, allowCollect = false): TradeBundle | null {
  const cards: string[] = [];
  const committed: Record<string, number> = {};
  const take = (c: string) => { committed[c] = (committed[c] ?? 0) + 1; cards.push(c); };
  const cal = givable(me.hand).map(([c]) => c).find(isTradableCal);
  if (cal) take(cal);
  if (wantToInclude && !isCal(wantToInclude) && (allowCollect || wantToInclude !== collect) && (me.hand[wantToInclude] ?? 0) > (committed[wantToInclude] ?? 0)) take(wantToInclude);
  for (const c of cheapCommodities(me.hand, new Set([collect]))) {
    if (cards.length >= 3) break;
    if ((me.hand[c] ?? 0) <= (committed[c] ?? 0)) continue;
    take(c);
  }
  if (cards.length < 3 || cards.filter((c) => !isCal(c)).length < 2) return null; // need ≥3 & ≥2 truthful
  return buildBundle(cards);
}

/** Commodities we'd like more of, best set-value gain first (see topCommodity). */
function wantsByGain(hand: Record<string, number>): string[] {
  const gain = (c: string) => commoditySetValue(c, (hand[c] ?? 0) + 1) - commoditySetValue(c, hand[c] ?? 0);
  return Object.keys(hand).filter((c) => !isCal(c) && (hand[c] ?? 0) > 0).sort((a, b) => gain(b) - gain(a));
}

/** A bundle to post when asking for `want`, worth at least what we ask in return:
 *  the answer is `want` plus two more cards, so we offer face value ≥ its value
 *  + 2, from our cheapest spares — never the set we're collecting most — (and a tradable calamity, if held — it counts
 *  for nothing). The best two cards are the named, binding ones. Null if our
 *  spares can't make a fair offer. */
function buildFairGive(me: { hand: Record<string, number> }, want: string, collect: string): TradeBundle | null {
  const target = commValue(want) + 2;
  const cards: string[] = [];
  const cal = givable(me.hand).map(([c]) => c).find(isTradableCal);
  if (cal) cards.push(cal);
  let worth = 0;
  for (const c of cheapCommodities(me.hand, new Set([want, collect]))) {
    if (cards.length >= 3 && worth >= target) break;
    if (commValue(c) > commValue(want)) break; // never pay a better card for a worse one
    cards.push(c);
    worth += commValue(c);
  }
  if (worth < target || cards.length < 3 || cards.filter((c) => !isCal(c)).length < 2) return null;
  return buildBundle(cards.sort((a, b) => commValue(b) - commValue(a)));
}

/** Set value we'd gain from an offer's NAMED (binding) cards — the claimed rest
 *  may be bluffs, so it counts for nothing. */
function guaranteedGain(hand: Record<string, number>, b: TradeBundle): number {
  let gain = 0;
  for (const [c, k] of Object.entries(bundleFace(b).guaranteed)) {
    if (isCal(c) || k <= 0) continue;
    const n = hand[c] ?? 0;
    gain += commoditySetValue(c, n + k) - commoditySetValue(c, n);
  }
  return gain;
}
/** Set value lost by parting with one card of `c`. */
const partingCost = (hand: Record<string, number>, c: string) => commoditySetValue(c, hand[c] ?? 0) - commoditySetValue(c, (hand[c] ?? 0) - 1);
/** A card the offer asks for that we'd hand over even though it's a good one:
 *  the cheapest-to-lose wanted card whose loss the offer's named cards repay. */
function wantedWorthGiving(hand: Record<string, number>, o: { wants: string[]; give: TradeBundle }): string | undefined {
  const gain = guaranteedGain(hand, o.give);
  return o.wants
    .filter((w) => !isCal(w) && (hand[w] ?? 0) >= 1 && partingCost(hand, w) <= gain)
    .sort((a, b) => partingCost(hand, a) - partingCost(hand, b))[0];
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
    const good = mine.responses.find((r) => mentioned(r.give).some((c) => !isCal(c) && (mine.wants.includes(c) || (me.hand[c] ?? 0) >= 1))) ?? mine.responses[0];
    if (good) return { type: 'acceptResponse', offerId: mine.id, responder: good.from };
  }

  // (b) Post one standing offer if we have none — a fair one: asking for a
  // valuable card with a handful of ochre and hides just gets declined.
  if (!mine && totalGivable(me.hand) >= 3) {
    for (const want of wantsByGain(me.hand)) {
      const give = buildFairGive(me, want, myWant ?? want);
      if (give) return { type: 'postOffer', give, wants: [want] };
    }
    // No fair offer, but a calamity to offload: still put up the cheap bundle.
    if (myWant && givable(me.hand).some(([c]) => isTradableCal(c))) {
      const give = buildGive(me, myWant);
      if (give) return { type: 'postOffer', give, wants: [myWant] };
    }
  }

  // (c) Respond to another player's offer that benefits us and we haven't answered.
  for (const o of n.offers) {
    if (o.from === actor || o.responses.some((r) => r.from === actor)) continue;
    const grows = mentioned(o.give).some((c) => !isCal(c) && (me.hand[c] ?? 0) >= 1);
    const haveCal = givable(me.hand).some(([c]) => isTradableCal(c));
    // A wanted card we'll part with even if it's one we're collecting, when the
    // offer's named cards are worth more to us than it is (so asking for a good
    // card with a fair offer gets a real answer, not just ochre and hides).
    const worthIt = wantedWorthGiving(me.hand, o);
    if (!grows && !haveCal && !worthIt) continue;
    const give = worthIt
      ? buildGive(me, myWant ?? '', worthIt, true)
      : buildGive(me, myWant ?? '', o.wants.find((w) => w !== myWant && (me.hand[w] ?? 0) >= 1));
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

/** Land a ship at `aid` can carry tokens to that they couldn't walk to in the
 *  same move — a hop to an area `aid` borders by land is a wasted ship (e.g.
 *  Elam to Nineveh across their shared lake, report 03a70fab). */
function overseas(state: GameState, aid: string, range: number, astro: boolean): Set<string> {
  const walk = new Set(landNeighbors(state, aid));
  return new Set([...navalDestinations(state, aid, range, astro)].filter((to) => !walk.has(to)));
}

/** Whether a ship in `aid` earns its upkeep: at least 3 of our tokens there to
 *  carry (two stay behind, see planMovement) and unoccupied land within range
 *  that can't be reached on foot. */
function shipUseful(state: GameState, actor: PlayerId, aid: string, tokensThere: number): boolean {
  if (tokensThere < 3) return false;
  const p = state.players[actor]!;
  const range = 4 + (p.advances.includes('clothmaking') ? 1 : 0);
  return [...overseas(state, aid, range, p.advances.includes('astronomy'))].some((to) => {
    const area = areaById.get(to);
    return !!area && !area.isWater && area.sustains > 0 && !Object.values(state.areas[to]?.tokens ?? {}).some((n) => n > 0) && !state.areas[to]?.city;
  });
}

/** §16.3 start-area choice: favour a fertile area with fertile land to grow into,
 *  steer clear of rivals who have already placed next door (early conflict only
 *  costs tokens), and lean slightly toward the nation's customary start. */
function bestStart(state: GameState, actor: PlayerId, starts: Extract<Action, { type: 'placeStart' }>[]): Action {
  const rivalNear = (aid: string) => [aid, ...neighbors(state, aid)].some((n) =>
    Object.entries(state.areas[n]?.tokens ?? {}).some(([owner, k]) => owner !== actor && k > 0));
  const score = (aid: string) => {
    const room = neighbors(state, aid).filter((n) => !areaById.get(n)?.isWater).reduce((t, n) => t + (areaById.get(n)?.sustains ?? 0), 0);
    return 2 * (areaById.get(aid)?.sustains ?? 0) + 0.5 * room - (rivalNear(aid) ? 6 : 0) + (civById.get(actor)?.start === aid ? 1 : 0);
  };
  return starts.reduce((best, a) => (score(a.area) > score(best.area) ? a : best));
}

