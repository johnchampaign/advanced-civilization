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
  | 'trade' // §28 open-offer negotiation (declare offers, respond, accept)
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

/** A card bundle in a trade: the cards actually handed over (`actual`, secret),
 *  plus the names the player publicly *announces* (`declared`). Per §28.3 the
 *  announced count must be honest (so `declared` has the same total as `actual`)
 *  and at least two announced cards must be truthful; the rest may be bluffs —
 *  any commodity or *tradable* calamity, "regardless of what was said". Card ids
 *  are commodity ids or `calamity:<id>`. */
export interface TradeBundle {
  actual: Record<string, number>;
  declared: Record<string, number>;
}

/** One player's response to a standing open offer (their counter-give). */
export interface TradeResponse {
  from: PlayerId;
  give: TradeBundle;
}

/** A standing open offer on the trade board (§28 open negotiation). Everyone
 *  sees `declared` + `wants`; `actual` is hidden until a deal executes. */
export interface OpenOffer {
  id: number;
  from: PlayerId;
  /** Cards the offerer will hand over (announced via declared, bluffs allowed). */
  give: TradeBundle;
  /** Commodities the offerer will accept in return — 1..5 alternatives. */
  wants: string[];
  responses: TradeResponse[];
}

/** A completed two-player deal this trade phase (kept so each trader can review
 *  the "Trade Details"; viewFor redacts it to deals involving the viewer). */
export interface CompletedTrade {
  a: PlayerId;
  b: PlayerId;
  aGave: TradeBundle;
  bGave: TradeBundle;
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
  /** Tax rate this player levies each turn (§19, 1-3). Only adjustable with the
   *  Coinage advance (§32.421); defaults to 2. */
  taxRate?: number;
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
  /** Set once this player has used Monotheism's one conversion this turn (§32.941). */
  convertedThisTurn?: boolean;
  /** Set once this player has used Architecture's treasury assist this turn (§32.631). */
  builtWithTreasuryThisTurn?: boolean;
  /** §30.312: Grain cards committed to soften Famine via Pottery are placed face
   *  up and may not be spent on civilization cards until next turn. Count locked
   *  this turn (cleared at turn rollover). */
  grainLockedThisTurn?: number;
  /** §26.32: area ids of cities built or acquired THIS turn — these must be the
   *  first reduced when short of city support. Cleared at turn rollover. */
  citiesBuiltThisTurn?: string[];
  /** §31.53: advances acquired THIS turn — their credits may not be used until
   *  next turn. Cleared at turn rollover. */
  advancesThisTurn?: string[];
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

/** A pending secondary-victim allocation (§29.64): the primary victim of Famine /
 *  Epidemic / Iconoclasm must distribute the ordered losses among eligible rivals,
 *  bounded by per-victim caps. Resolved by an `allocateLoss` action. */
export interface PendingAllocation {
  calamityId: string;
  /** The primary victim, who directs the losses. */
  holder: PlayerId;
  /** 'unitPoints' (Famine/Epidemic) or 'cities' (Iconoclasm). */
  kind: 'unitPoints' | 'cities';
  /** Total to distribute (may exceed the sum of caps; then allocate all caps). */
  pool: number;
  /** Max each rival may be ordered to lose (player -> cap). */
  caps: Record<PlayerId, number>;
  /** Unit-point value of a city for this calamity (Epidemic 4, else 5). */
  cityWorth: number;
  /** If set, losses are confined to these areas (Flood §30.512 — the same flood
   *  plain the primary victim was hit on). */
  areas?: string[];
  /** Board snapshot at the calamity's start, to diff into the event after the
   *  allocation is applied (resume context). */
  before: Record<string, { city?: PlayerId; tokens: Record<PlayerId, number> }>;
  overviewBefore: string;
}

/** A pending city-reduction choice (§30.321/.711/.811): the primary victim of
 *  Superstition / Civil Disorder / Iconoclasm picks WHICH of their cities to
 *  reduce. Resolved by a `chooseCities` action. */
export interface PendingCityChoice {
  calamityId: string;
  holder: PlayerId;
  /** How many of the holder's cities must be reduced. */
  count: number;
  before: Record<string, { city?: PlayerId; tokens: Record<PlayerId, number> }>;
  overviewBefore: string;
}

/** A pending "choose which of your own units to give up" decision (§29.63): the
 *  primary victim of Famine/Epidemic/Flood picks which units to lose, and the
 *  Civil War victim picks which to cede to the beneficiary. */
export interface PendingUnitLoss {
  calamityId: string;
  holder: PlayerId;
  /** Unit points to shed (a token = 1, a city = cityWorth). */
  points: number;
  cityWorth: number;
  /** 'remove' → back to stock (reduced/substituted); 'cede' → to the beneficiary. */
  mode: 'remove' | 'cede';
  beneficiary?: PlayerId;
  /** If set, the loss is confined to these areas (Flood plain). */
  areas?: string[];
  before: Record<string, { city?: PlayerId; tokens: Record<PlayerId, number> }>;
  overviewBefore: string;
}

/** §31.71: a player over the 8-commodity-card hand limit must discard the excess
 *  (their choice). `count` = how many surplus cards to surrender. */
export interface PendingDiscard {
  holder: PlayerId;
  count: number;
}

/** A set of a player's board units (tokens per area + whole cities), used to
 *  describe a Civil War faction (§30.412). */
export interface UnitSet {
  tokens: Record<string, number>;
  cities: string[];
}

/** One secondary victim's directed loss, resolved by that victim choosing which
 *  of their own units/cities to give up (§30.311/.512/.611/.818). */
export interface SecondaryLoss {
  victim: PlayerId;
  kind: 'unitPoints' | 'cities';
  /** Unit points (or whole cities) the primary directed this victim to lose. */
  amount: number;
  cityWorth: number;
  /** Flood (§30.512): confined to the affected flood plain. */
  areas?: string[];
}

/** §26.32: a player short of city support must reduce a city of their choice,
 *  newly-built cities first. Also drives Slave Revolt's reductions (§30.42), which
 *  withhold `lock` tokens from support. Resolved one city at a time (a `chooseCities`
 *  of exactly one area from `candidates`), re-checking until support is met. */
export interface PendingSupport {
  holder: PlayerId;
  /** The cities the player may reduce now (newly-built ones, else all). */
  candidates: string[];
  /** Tokens withheld from support (Slave Revolt §30.421; 0 for normal support). */
  lock: number;
  /** 'support' = §26.3/§29.8 check; 'slaverevolt' = the §30.42 calamity. */
  mode: 'support' | 'slaverevolt';
  /** Slave Revolt context, to finalize the calamity event when reductions finish. */
  before?: Record<string, { city?: PlayerId; tokens: Record<PlayerId, number> }>;
  overviewBefore?: string;
}

/** A pending "this player selects which cities" decision, used where the rules
 *  name a specific chooser: Treachery (§30.221, the trader picks the victim's
 *  city), Flood with no flood-plain units (§30.514, the primary picks a coastal
 *  city), and Piracy (§30.911 trader picks the primary's cities, §30.912 primary
 *  picks the secondaries'). */
export interface PendingPick {
  /** The player making the selection (trader or primary victim). */
  chooser: PlayerId;
  /** What is being picked, to drive the effect + any chaining. */
  stage: 'treachery' | 'floodCity' | 'piracyPrimary' | 'piracySecondary' | 'volcanoSite' | 'earthquakeSite' | 'barbarian' | 'taxRevolt';
  /** Barbarian-march context (§30.5251): `here` is the area to march FROM (null on
   *  the initial placement choice); `visited` are areas already occupied. */
  march?: { here: string | null; visited: string[] };
  /** The primary victim of the calamity (context / chaining). */
  victim: PlayerId;
  /** The player who traded the card to the victim, if any (§29.61). */
  trader?: PlayerId;
  /** How many cities to pick (an upper bound; fewer if fewer are available). */
  count: number;
  /** The area ids the chooser may pick from. */
  candidates: string[];
  /** Calamity snapshot for the event (absent for the non-calamity tax-revolt pick). */
  before?: Record<string, { city?: PlayerId; tokens: Record<PlayerId, number> }>;
  overviewBefore?: string;
}

/** A queue of secondary-victim losses awaiting each victim's own which-units
 *  choice, after the primary victim has directed the amounts. */
export interface PendingSecondary {
  calamityId: string;
  /** The primary victim who directed the losses (the event is attributed here). */
  primary: PlayerId;
  queue: SecondaryLoss[];
  before: Record<string, { city?: PlayerId; tokens: Record<PlayerId, number> }>;
  overviewBefore: string;
}

/** §30.41 Civil War — a multi-step split resolved interactively:
 *   1. `victimSelect`  — the victim picks 15 (+Music/Drama/Democracy) unit points
 *      for the first faction (§30.4121-4122); skipped if the victim holds
 *      Philosophy (§30.4124).
 *   2. `beneficiarySelect` — the beneficiary picks an additional 20 of the
 *      victim's units to complete the first faction (§30.4123); 15 under
 *      Philosophy and it forms the entire first faction.
 *   3. `victimKeep` — after Military removal (§30.414), the victim chooses which
 *      faction to keep; the beneficiary annexes the other (§30.415). */
export interface PendingCivilWar {
  victim: PlayerId;
  beneficiary: PlayerId;
  stage: 'victimSelect' | 'beneficiarySelect' | 'victimKeep';
  /** Unit points the victim selects for the first faction (0 under Philosophy). */
  victimPoints: number;
  /** Unit points the beneficiary adds to complete the first faction. */
  beneficiaryPoints: number;
  philosophy: boolean;
  military: boolean;
  /** The first faction, accumulated across the two selection steps. */
  faction1: UnitSet;
  /** The second faction (everything else), fixed once the first is complete. */
  faction2?: UnitSet;
  before: Record<string, { city?: PlayerId; tokens: Record<PlayerId, number> }>;
  overviewBefore: string;
}

/** A force present in an area, for the combat step-through display. */
export interface CombatForce { id: PlayerId; tokens: number; city: boolean }

/** One area's combat this conflict phase, captured for a replay modal. */
export interface CombatEvent {
  area: string;
  before: CombatForce[];
  after: CombatForce[];
  /** Rules that shaped the outcome (Metalworking removal order, Engineering thresholds). */
  modifiers: string[];
  /** Human-readable summary of what happened (losses, city taken, pillage). */
  note: string;
}

/** One resolution step of a calamity, attributed to the affected player. */
export interface CalamityStep { text: string; player?: PlayerId; secondary?: boolean }

/** One calamity's full outcome, captured for a step-by-step modal. */
export interface CalamityEvent {
  calamity: string;
  calamityId: string;
  description: string;
  holder: PlayerId;
  steps: CalamityStep[];
  /** Board overview (per player: cities/tokens) before and after this calamity. */
  overviewBefore: string;
  overviewAfter: string;
  /** True if the holder made an interactive choice resolving it (city/unit/allocation)
   *  — the UI skips replaying these to that player, who already saw them inline. */
  interactive?: boolean;
}

export interface GameState {
  schemaVersion: number;
  turn: number;
  phase: Phase;
  /** Player order for the current turn (census order). Acting player = first
   *  in `activeOrder` not yet in `actedThisPhase`. */
  activeOrder: PlayerId[];
  /** The turn's census order (§21), captured once so per-phase reordering (e.g.
   *  Military moving last, §32.831) derives from it without drifting. */
  censusOrder?: PlayerId[];
  /** Cities that revolted this taxation phase (player -> count), resolved only
   *  after every player has paid (§19.31). Cleared once resolved. */
  pendingRevolts?: Record<PlayerId, number>;
  actedThisPhase: PlayerId[];
  players: Record<PlayerId, PlayerState>;
  /** All players in seating order (stable). */
  seating: PlayerId[];
  areas: Record<string, AreaState>;
  trade: TradeStacks;
  /** Calamities drawn this turn awaiting resolution: { calamityId, holder }. */
  pendingCalamities: { calamityId: string; holder: PlayerId }[];
  /** Trade-phase negotiation sub-state (open-offer board, §28). */
  negotiation: {
    /** Index into activeOrder of whose turn it is to act. */
    turnPointer: number;
    /** Consecutive pass count; phase ends when it reaches player count. */
    passStreak: number;
    /** Trade actions taken this phase; a generous cap bounds the phase so eager
     *  AIs (whose deals reset passStreak) can't loop forever. */
    actions?: number;
    /** Monotonic id source for offers. */
    nextOfferId?: number;
    /** Players who have passed ("Done trading") — skipped for the rest of the
     *  phase so they aren't repeatedly prompted; the phase ends when all are done. */
    done?: PlayerId[];
    /** Standing open offers anyone may respond to. */
    offers: OpenOffer[];
    /** Deals executed this phase (for the Trade Details review). */
    completed?: CompletedTrade[];
  };
  /** Population-expansion placement when stock can't cover all growth (§13): the
   *  player distributes their remaining stock among eligible areas. Absent when
   *  growth was fully auto-applied (enough stock). */
  expansion?: {
    /** Stock tokens each constrained player still has to place. */
    remaining: Record<PlayerId, number>;
    /** Per-player remaining growth capacity per area (area -> tokens it may still gain). */
    caps: Record<PlayerId, Record<string, number>>;
  };
  /** The most recent calamity phase's outcomes, one per calamity, so the UI can
   *  show a step-by-step modal. Overwritten each calamity phase; empty if none. */
  lastCalamities?: CalamityEvent[];
  /** True while the calamity phase is mid-resolution (held calamities still to
   *  process). Lets runCalamity resume after an interactive allocation pause. */
  calamityActive?: boolean;
  /** Set when the current calamity's primary victim must distribute secondary
   *  losses among rivals (§29.64); resolved by an `allocateLoss` action. */
  pendingAllocation?: PendingAllocation;
  /** Set when the current calamity's primary victim must choose which of their
   *  cities to reduce (§30.321/.711/.811); resolved by a `chooseCities` action. */
  pendingCityChoice?: PendingCityChoice;
  /** Set when the current calamity's primary victim must choose which of their
   *  units to lose/cede (§29.63 / §30.41); resolved by a `chooseUnits` action. */
  pendingUnitLoss?: PendingUnitLoss;
  /** Set when a player over the 8-card hand limit must choose which surplus
   *  commodity cards to discard (§31.71); resolved by a `chooseDiscard` action. */
  pendingDiscard?: PendingDiscard;
  /** Set while a Civil War (§30.41) is being resolved through its interactive
   *  faction-selection and keep steps. */
  pendingCivilWar?: PendingCivilWar;
  /** A queue of secondary-victim losses (§30.311/.512/.611/.818) awaiting each
   *  victim's choice of which units/cities to surrender. */
  pendingSecondary?: PendingSecondary;
  /** A pending city-selection by a named chooser (Treachery/Flood/Piracy). */
  pendingPick?: PendingPick;
  /** A pending city-support reduction the player must direct (§26.32 / §30.42). */
  pendingSupport?: PendingSupport;
  /** §22.3: ships owing maintenance this Ship Construction phase (count per player,
   *  snapshotted at phase entry — ships built this phase aren't maintained until
   *  next turn). Resolved when the player finishes; lets them decline maintenance
   *  (scrap a ship) instead. */
  shipMaintOwed?: Record<PlayerId, number>;
  /** The most recent conflict phase's combats, one per area, for a step-through
   *  modal. Overwritten each conflict phase; empty if none. */
  lastCombats?: CombatEvent[];
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

/** §22.3: scrap one of your ships in an area (return it to stock) instead of
 *  maintaining it — e.g. to relocate it by rebuilding elsewhere this phase. */
export interface ScrapShipAction {
  type: 'scrapShip';
  area: string;
}

export interface TradeAcquisitionAction {
  type: 'drawTradeCards';
}

/** Post (or replace) your standing open offer on the trade board (§28): the
 *  cards you'll give (announced via `give.declared`, bluffs allowed) and 1..5
 *  commodities you'll accept in return. */
export interface PostOfferAction {
  type: 'postOffer';
  give: TradeBundle;
  wants: string[];
}

/** Attach (or replace) your counter-give to another player's open offer. */
export interface RespondOfferAction {
  type: 'respondOffer';
  offerId: number;
  give: TradeBundle;
}

/** As the offer's owner, accept one responder's counter — executes the deal. */
export interface AcceptResponseAction {
  type: 'acceptResponse';
  offerId: number;
  responder: PlayerId;
}

/** Withdraw your own standing open offer. */
export interface WithdrawOfferAction {
  type: 'withdrawOffer';
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

/** Monotheism (§32.94): replace the occupants of one land-adjacent enemy area
 *  with your own units. Usable once per turn, during the advances phase. */
export interface ConvertAreaAction {
  type: 'convertArea';
  area: string;
}

/** §29.64: as the primary victim of Famine/Epidemic/Iconoclasm, distribute the
 *  ordered secondary losses among rivals (player -> amount), within the caps. */
export interface AllocateLossAction {
  type: 'allocateLoss';
  allocation: Record<PlayerId, number>;
}

/** §30.321/.711/.811: as the primary victim of Superstition/Civil Disorder/
 *  Iconoclasm, choose which of your cities to reduce. */
export interface ChooseCitiesAction {
  type: 'chooseCities';
  areas: string[];
}

/** §29.63: choose which of your own units to give up (Famine/Epidemic/Flood loss,
 *  or the Civil War faction you cede) — tokens per area + whole cities. */
export interface ChooseUnitsAction {
  type: 'chooseUnits';
  tokens: Record<string, number>;
  cities: string[];
  /** §30.312: for Famine, how many Grain cards the Pottery holder chooses to commit
   *  (each cuts the loss by 4 and locks that Grain until next turn). */
  grainCommit?: number;
}

/** §31.71: surrender these surplus commodity cards (one entry per card; length
 *  must equal the pending discard count) to trim the hand to 8. */
export interface ChooseDiscardAction {
  type: 'chooseDiscard';
  cards: string[];
}

/** §30.4121-4123: select units (tokens per area + whole cities) of the victim's
 *  nation to add to the Civil War's first faction. Used for both the victim's
 *  and the beneficiary's selection step. */
export interface CivilWarSelectAction {
  type: 'civilWarSelect';
  tokens: Record<string, number>;
  cities: string[];
}

/** §30.415: the victim decides which faction (1 = first, 2 = second) to keep
 *  playing; the beneficiary annexes the other. */
export interface CivilWarKeepAction {
  type: 'civilWarKeep';
  faction: 1 | 2;
}

/** A chooser selects cities for a Treachery/Flood/Piracy pending pick. */
export interface PickAreasAction {
  type: 'pickAreas';
  areas: string[];
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
  | ConvertAreaAction
  | AllocateLossAction
  | ChooseCitiesAction
  | ChooseUnitsAction
  | ChooseDiscardAction
  | CivilWarSelectAction
  | CivilWarKeepAction
  | PickAreasAction
  | PlaceTokensAction
  | MoveAction
  | BuildShipsAction
  | ScrapShipAction
  | ResolveConflictAction
  | BuildCityAction
  | TradeAcquisitionAction
  | PostOfferAction
  | RespondOfferAction
  | AcceptResponseAction
  | WithdrawOfferAction
  | BuyTradeCardAction
  | ResolveCalamityAction
  | BuyAdvanceAction
  | PassAction;
