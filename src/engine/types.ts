// Core state and action types for Advanced Civilization.
//
// Design notes:
// - State is a plain serializable object (the framework's codec round-trips it
//   at turn boundaries), so no class instances / Maps live in GameState — we use
//   plain records keyed by id.
// - PlayerId is the civilization id (e.g. "egypt").
// - The turn runs through an ordered list of phases (rules §18). Most phases are
//   per-player; `currentActor` is derived from `phase` + `activeOrder` + `actedThisPhase`.

export type PlayerId = string; // civilization id

/** Rules §18 sequence of play, modeled as discrete phases. */
export type Phase =
  | 'taxation' //  collect tax, resolve tax-driven city revolts
  | 'populationExpansion' // add tokens to occupied areas
  | 'census' // recount, set play order for the rest of the turn
  | 'shipConstruction'
  | 'movement'
  | 'conflict'
  | 'cityConstruction'
  | 'removeSurplus' // §26: remove surplus population, then check city support
  | 'tradeAcquisition' // draw trade cards from stacks
  | 'trade' // negotiate/exchange (simplified: collect/keep)
  | 'calamity' // resolve calamities in severity order
  | 'acquireAdvances' // buy civilization advances
  | 'astAdjustment'; // advance AST markers, check win

export const PHASE_ORDER: Phase[] = [
  'taxation',
  'populationExpansion',
  'census',
  'shipConstruction',
  'movement',
  'conflict',
  'cityConstruction',
  'removeSurplus',
  'tradeAcquisition',
  'trade',
  'calamity',
  'acquireAdvances',
  'astAdjustment',
];

/** A card bundle in a trade: the cards actually handed over, plus the subset the
 *  player openly declares. Rules §28.3: the count and at least two declared cards
 *  must be truthful; any remaining cards may be other commodities or *tradable*
 *  calamities, regardless of what was said. Card ids are commodity ids or
 *  `calamity:<id>`. */
export interface TradeBundle {
  actual: Record<string, number>;
  declared: Record<string, number>;
}

/** An outstanding trade offer awaiting the target's response. */
export interface TradeOffer {
  from: PlayerId;
  to: PlayerId;
  /** Cards the proposer is giving. */
  offer: TradeBundle;
  /** What the proposer asks the target to give: an honest total count and the
   *  declared (truthful, >=2) cards the proposer insists on. */
  request: { count: number; declared: Record<string, number> };
}

/** Per-player mutable state. */
export interface PlayerState {
  id: PlayerId;
  /** Tokens available off-board (the "stock"). */
  stock: number;
  /** Tokens in treasury (currency for buying advances). */
  treasury: number;
  /** Cities available to place. */
  citiesAvailable: number;
  /** Ships available to place. */
  shipsAvailable: number;
  /** Census count recorded this turn (population on board). */
  census: number;
  /** Owned civilization advance ids. */
  advances: string[];
  /** Trade-card hand: card id -> count. Keys are commodity ids OR `calamity:<id>`
   *  for held calamity cards (tradable ones can be passed in trade; non-tradable
   *  must be retained). Only commodity cards count toward set values. */
  hand: Record<string, number>;
  /** Deprecated: calamities now live in `hand` as `calamity:<id>`. Kept for
   *  back-compat of older snapshots; always empty in new games. */
  calamities: string[];
  /** AST position (space index; 0 = start). */
  astSpace: number;
  /** Current epoch id. */
  epoch: string;
  /** Whether the nation has been knocked to zero board presence this turn. */
  eliminatedFromBoard?: boolean;
}

/** Contents of a single map area. An area is held by at most one nation's
 *  tokens (plus possibly a city), except transiently during conflict. */
export interface AreaState {
  /** Token count per owner (owner id -> tokens). Usually one owner. */
  tokens: Record<PlayerId, number>;
  /** City owner, if a city stands here. */
  city?: PlayerId;
  /** True for a pirate city (no support needed). */
  pirateCity?: boolean;
  /** Ships present, owner -> count. */
  ships?: Record<PlayerId, number>;
}

export interface TradeStacks {
  /** Stack number (1-9) -> ordered list of card refs (commodity id or
   *  "calamity:<id>"). Drawn from the top (end of array). */
  stacks: Record<number, string[]>;
}

export interface GameState {
  schemaVersion: number;
  turn: number;
  phase: Phase;
  /** Player order for the current turn (census order). Acting player = first
   *  in `activeOrder` not yet in `actedThisPhase`. */
  activeOrder: PlayerId[];
  actedThisPhase: PlayerId[];
  players: Record<PlayerId, PlayerState>;
  /** All players in seating order (stable). */
  seating: PlayerId[];
  areas: Record<string, AreaState>;
  trade: TradeStacks;
  /** Calamities drawn this turn awaiting resolution: { calamityId, holder }. */
  pendingCalamities: { calamityId: string; holder: PlayerId }[];
  /** Trade-phase negotiation sub-state. */
  negotiation: {
    /** Index into activeOrder of whose turn it is to propose. */
    turnPointer: number;
    /** Consecutive pass/decline count; phase ends when it reaches player count. */
    passStreak: number;
    /** Proposals made this trade phase; a generous cap bounds the phase so an
     *  eager AI (whose accepted trades reset passStreak) can't loop forever. */
    proposals?: number;
    /** Outstanding offer awaiting the target's response, if any. */
    pendingOffer: TradeOffer | null;
  };
  /** Who handed each calamity to its current holder (calamityId -> giver). The
   *  giver may not be named a secondary victim (§29.61). */
  calamityTradedFrom: Record<string, PlayerId>;
  rngState: number;
  /** Append-only human-readable log of notable events. */
  log: string[];
  /** Set once a finish square is reached; game ends after the turn completes. */
  finished?: boolean;
  /** Optional turn cap (time-limit analogue, §34.1B). */
  maxTurns?: number;
}

// ---- Actions -------------------------------------------------------------

export interface PlaceTokensAction {
  type: 'placeTokens';
  /** area id -> tokens to add (population expansion / placement). */
  placements: Record<string, number>;
}

export interface MoveAction {
  type: 'move';
  /** Ordered moves: from area, to area, count, optional via for roadbuilding. */
  moves: { from: string; to: string; count: number; via?: string; byShip?: boolean }[];
}

export interface BuildCityAction {
  type: 'buildCity';
  area: string;
  /** Use treasury tokens to help (Architecture, §32.631). */
  useTreasury?: number;
}

export interface ResolveConflictAction {
  type: 'resolveConflict';
  area: string;
}

export interface BuildShipsAction {
  type: 'buildShips';
  builds: { area: string; count: number }[];
}

export interface TradeAcquisitionAction {
  type: 'drawTradeCards';
}

/** Propose a bilateral trade to another player (rules §28). The proposer gives
 *  `offer` and asks the target to give `request.count` cards including the
 *  `request.declared` cards. Validated against §28.3 truth rules. */
export interface ProposeTradeAction {
  type: 'proposeTrade';
  to: PlayerId;
  offer: TradeBundle;
  request: { count: number; declared: Record<string, number> };
}

/** Respond to the outstanding offer. Accepting requires `give` (the target's
 *  actual + declared cards) to satisfy the proposer's request. */
export interface RespondTradeAction {
  type: 'respondTrade';
  accept: boolean;
  give?: TradeBundle;
}

/** Buy a Gold/Ivory card from stack 9 at 18 treasury tokens (§27.5). */
export interface BuyTradeCardAction {
  type: 'buyTradeCard';
  /** How many ninth-stack cards to buy (each costs 18 treasury). */
  count: number;
}

export interface BuyAdvanceAction {
  type: 'buyAdvance';
  advance: string;
  /** Commodity cards spent (id -> count). */
  spendCommodities?: Record<string, number>;
  /** Treasury tokens spent. */
  spendTreasury?: number;
}

export interface SetTaxRateAction {
  type: 'setTaxRate';
  rate: number; // 1-3 (Coinage allows variation, §32.421)
}

export interface ResolveCalamityAction {
  type: 'resolveCalamity';
  calamityId: string;
  /** Optional victim choices (e.g. which cities/areas to reduce). */
  choices?: Record<string, unknown>;
}

/** Advance the current phase for the acting player without taking an optional
 *  action (e.g. choose not to expand/build/buy). */
export interface PassAction {
  type: 'pass';
}

export type Action =
  | SetTaxRateAction
  | PlaceTokensAction
  | MoveAction
  | BuildShipsAction
  | ResolveConflictAction
  | BuildCityAction
  | TradeAcquisitionAction
  | ProposeTradeAction
  | RespondTradeAction
  | BuyTradeCardAction
  | ResolveCalamityAction
  | BuyAdvanceAction
  | PassAction;
