# Advanced Civilization (digital)

A digital port of Avalon Hill's **Advanced Civilization** (1991), built on
[`digital-boardgame-framework`](https://www.npmjs.com/package/digital-boardgame-framework).

**Play online:** https://advanced-civilization.pages.dev
(Local hotseat + AI works with no setup; online multiplayer needs the Supabase
env vars below set on the Cloudflare Pages project.)

Rules source: the [Advanced Civilization rules & guide (OCR)](https://astro.ucla.edu/~ianc/files/civ/civ_rules_and_guide_ocr.pdf).
Map / card / advance **data** (area graph, adjacency, advances, calamities, cards)
was extracted into this repo's own JSON from the
[VASSAL module](https://obj.vassalengine.org/images/e/ee/AdvancedCivilization_v1.0.vmod).

**Board artwork is not distributed.** The app ships no map images and draws the
board from its own area geometry, so it is fully playable as-is. A player who owns
the VASSAL module can optionally load it from the in-game prompt; the three map SVGs
are then extracted from it entirely in the browser and cached only on that device
(IndexedDB) — nothing is uploaded, and the deployed app never serves the artwork.
The module file (`assets/civ.vmod`) and any extracted `map-*.svg` are git-ignored.

## Status

Engine-first build (correctness prioritized), local hotseat + heuristic AI.

- ✅ Game data extracted & cross-validated (222 map areas + adjacency, 24 advances,
  18 commodities/114 cards, 12 calamities, 14 civilizations, AST/epochs).
- ✅ Rules engine: full 12-phase turn machine implemented as a `GameAdapter`
  (`src/engine/`). 34 passing tests incl. full random + AI playthroughs to a winner.
- ✅ Trade negotiation (§28): bilateral propose/respond with the honest-count +
  ≥2-declared truth rule, passing tradable calamities among undeclared cards,
  buying Gold/Ivory from the ninth stack (§27.5), and hidden-info redaction of
  hands and pending-offer cards.
- ✅ §26 sequencing: surplus population removed *after* city construction (cities
  built from temporarily over-stacked areas), city areas hold no tokens, and city
  support (2 board tokens per city) enforced after surplus removal and again after
  calamities — reducing unsupported cities.
- ✅ §24 combat: round-robin token attrition (fewest-first, Metalworking removes
  last, coexistence within the area limit, N-player ascending order) and city
  assault — 7-token threshold (6 with attacker Engineering, 8 vs a defender with
  Engineering), city→tokens replacement, pillage (≤3 stock→treasury), and stealing
  a random trade card from the victim (§24.5).
- ✅ Ships & naval movement (§22-23): interactive ship construction (2 tokens,
  coastal, max 4), per-turn maintenance (1 token or scrapped, §22.3), and naval
  transport — a ship ferries up to 5 tokens across water (4 areas, +1 with Cloth
  Making), with open oceans gated by Astronomy. (The module flags every sea
  `OpenSea`; we treat the 7 enclosed/coastal seas as freely navigable and 6 open
  oceans as Astronomy-gated, so coastal/island nations can still sail.)
- ✅ Full three-panel map stitched into one connected graph: the Western/Main/
  Eastern panels each reprint their shared boundary areas (same name, e.g. Etruria
  on Western+Main, Susa on Main+Eastern). Those 15 seam areas are merged into one
  canonical land node (folding the Eastern panel's sustains-0 slivers into the real
  area), joining all 222 areas into a single component (a connectivity test guards it).
- ✅ AST (§33-35): the board's actual 16-space track (read from `map-ast.svg`),
  100 points/space, finishing at 1600. Epoch entry gated by the uniform
  requirements (cities / card count / card groups; Late Iron Age needs civ-card
  value ≥ the space's point value, §33.25); city-less nations slide back. The
  Genuinely **per-civilization**: every epoch boundary for all 14 nations is read
  from the VASSAL per-civ AST strips (`ASTstrip-<civ>.svg`, via `scripts/ast-epochs.mjs`)
  — the grey blocks place each nation's Early Bronze/Late Bronze/Early Iron regions
  at different columns, and each has its own Late Iron Age thresholds (e.g. Egypt
  develops fast with EB at space 4 and LIA 1300/1600/1900; Thrace slower, EB at 6).
  Cross-checked against the 1995 computer version's AST screen: Africa, Illyria and
  Thrace match exactly (validating the extraction); Iberia uses Italy's track per
  the official game (it replaces Italy on the West map), overriding the fan
  module's outlier `iberia` strip.
- ✅ Trade-stack delivery (§15.2/§29.7): stacks built with a top buffer of
  `numPlayers` commodities, tradable calamities shuffled in, and non-tradable
  calamities at the bottom (stack 1 has none). The whole 126-card deck circulates
  and is conserved: resolved calamities (§29.7) and commodity cards spent on
  advances (§31) return face-down to the bottom of their stack — nothing leaves
  the game (enforced by a deck-conservation test, like the piece-supply one).
- ✅ Calamity special cases: Civil War factions defecting to the strongest-reserve
  rival (§30.41, with Music/Drama/Democracy/Philosophy/Military modifiers); the
  Barbarian-Horde landing + multi-step march through the combat engine, persisting
  as a neutral force (§30.52, Crete immune); Piracy turning coastal cities into
  neutral pirate cities for the victim and two secondary victims (§30.91). Both
  persist on the board inertly until a player clears them (§30.5235/§30.913): they
  never grow, count for no nation, survive surplus/support removal, and can be
  attacked away (barbarians by token combat, pirate cities stormed for pillage).
  The board shows barbarians (⚔) and pirate cities (☠) distinctly; and
  secondary-victim selection for Epidemic (25 unit points) and Iconoclasm (2
  cities) — sparing the trader, with Medicine/Roadbuilding and Theology/Philosophy
  modifiers (§30.61, §30.81).
- ✅ Heuristic AI opponent (`src/ai/heuristic.ts`) — grows territory, builds
  supported cities, buys advances, and **initiates trades** (mutually-beneficial
  set-building swaps, dumping tradable calamities onto partners; accepts/declines
  incoming offers). It is **multiplayer-fair** — it only reads its own hand and
  proposes blind, never inspecting opponents' cards.
- ✅ Hotseat React/Vite UI (`src/ui/`) laid out after the 1995 computer version:
  the board on top, an orange/tan control bar (left nav SYSTEM/AST/CENSUS/TOOLS/
  GOODS, a nation status block — In Stock / On Map / Treasury, a phase + message +
  per-phase actions panel, and a minimap), and a turn-order tab strip. AST /
  Census / Tools / Goods open full-screen info views (the AST view shows each
  nation's per-civ track and marker). Run with `npm run dev`.

## Layout

```
src/
  data/        Extracted game data (JSON) + typed loader & validator
  engine/      Types, setup, the phase machine + GameAdapter, helpers, tests
  ai/          Heuristic PlayerController
  ui/          React hotseat client (Vite)
scripts/       Data-extraction scripts (VASSAL buildFile -> JSON)
assets/        Downloaded rules PDF + VASSAL module (+ extracted text)
public/assets/ Board SVG served by the UI
```

## Commands

```bash
npm test         # vitest engine + AI tests
npm run typecheck
npm run dev      # hotseat UI at http://localhost:5173
npm run build:ui # production UI build
```

## Design notes

- **Phase model.** The turn runs through `PHASE_ORDER` (rules §18). System phases
  (taxation, population growth, census, conflict, trade-card acquisition, trade,
  calamity, AST) resolve deterministically; interactive phases (movement, city
  construction, advance acquisition) cycle players in census order until each
  `pass`es. After every action the state is *normalized* so `currentActor()`
  always points at a real decision.
- **Determinism.** All randomness flows through the framework's seeded `Rng`
  (serialized into `GameState.rngState`), so games are reproducible and the
  framework can round-trip state at turn boundaries.

## Verified against the rulebook / components

These were checked directly against the rendered rulebook and VASSAL data, and are
locked in by tests:

- **Commodity values** — single-card value = stack number; a set of n is n²·value.
  Confirmed from the printed cards (Iron 2,8,18,32,…; Wine 5,20,45,…; Ivory 9,36,81,144)
  and the §8.1 table. Counts (total 114) counted from the VASSAL cards.
- **Calamity trade status** (rules §9.1) — non-tradable (4): Volcano/Earthquake,
  Famine, Civil War, Flood. Tradable (8): Treachery, Superstition, Slave Revolt,
  Barbarian Hordes, Epidemic, Civil Disorder, Iconoclasm & Heresy, Piracy.
- **City sites** — the 86 printed city sites from VASSAL `CitySite` tags (6 tokens
  build a city on a site, 12 elsewhere, §25.2). Plus `Floodplain` (29), `OpenSea`
  (14), `VolcanoSite` (5) designations.
- **Opening areas** — each nation's legal start areas from VASSAL `StartRegion` tags.
- **Piece supply** — 55 tokens / 9 cities / 4 ships per nation (VASSAL CardSlots),
  conserved across every action (enforced by tests).

## Async multiplayer

`src/server/` wires the framework's `GameServer` around the engine: storage,
notifications, and realtime are chosen from the environment, so the same code
runs locally (filesystem store, no setup) and in production (Supabase + Resend +
Supabase Realtime). Per-seat secret tokens, redacted views (hidden hands), and
turn-ownership are enforced server-side.

```bash
npm run serve     # build + run the HTTP host (filesystem store) on :8787
```

- `src/server/game-server.ts` — env-driven `GameServer` (FsStore ↔ SupabaseStore,
  Noop ↔ ResendNotifier, Noop ↔ SupabaseBroadcaster).
- `src/server/http.ts` — Node REST host (`POST /api/games`, `GET …/:id`,
  `…/legal`, `POST …/move`, `…/messages`, `…/report`).
- `src/client/api.ts` — a `GameClientApi` over `fetch` (+ optional Realtime) for
  the framework's `useGame` hook; `createGame` returns a shareable URL per seat.
- `supabase/schema.sql` — apply to your Supabase project; see `.env.example`.

Verified end-to-end (`src/server/multiplayer.test.ts` + a live HTTP smoke test):
distinct per-seat tokens, bad tokens rejected, only the seat on the clock may
move, opponents' hands redacted in per-seat views, and moves persisted.

### Deploying (Cloudflare Pages + Supabase)

Deployed at https://advanced-civilization.pages.dev (project `advanced-civilization`).

- `src/server/handlers.ts` — one platform-agnostic `handleApi()` router shared by
  the Node dev host (FsStore) and the Pages Function (Supabase), so dev and prod
  are true parity.
- `functions/api/[[path]].ts` — the Cloudflare Pages Function: builds a
  `GameServer` over `SupabaseStore` + `SupabaseBroadcaster` and delegates to
  `handleApi`. Imports only the Workers-safe server barrel (no `node:fs`).
- `wrangler.toml` — `pages_build_output_dir = dist-ui`, `nodejs_compat`.

Build command (Pages project setting): `npm run build:ui`. Manual deploy:

```bash
npm run build:ui
npx wrangler pages deploy dist-ui --project-name advanced-civilization
```

To enable online multiplayer, set these as Pages environment variables / secrets
(Production) and redeploy:

| variable | purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL (server store + broadcaster) |
| `SUPABASE_SERVICE_KEY` | service-role key (server only — bypasses RLS) |
| `RESEND_API_KEY` *(optional)* | turn-notification emails |
| `MAIL_FROM` *(optional)* | from-address for those emails |

Apply `supabase/schema.sql` to the Supabase project once (creates the `dbf_*`
tables with RLS on). For instant client refresh (vs. polling), also build the SPA
with `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (anon key is safe in the
bundle; Realtime only).

## Online lobby & bug reporting (UI)

The SPA has a landing screen → **Local hotseat + AI** or **Online multiplayer**:

- **Lobby** (`src/ui/online.tsx`): pick 2–6 nations, create a game, and get a
  shareable invite URL per seat (copy, or "Open as <nation>"). Opening an invite
  (`?game=…&token=…`) drops you straight into that seat.
- **OnlineGame**: drives the client API through the framework's **`useGame`** hook
  (polling + optional Supabase Realtime), rendering the same board/panels as
  hotseat and submitting moves to the server.
- **Bug reporting + log upload**: a "Report a bug" panel (severity + message)
  posts via the client `report()` — it attaches the game's move log as `clientLog`
  and the server auto-captures the full game snapshot, so the whole game is
  uploaded. The framework's contract guarantees a report never silently fails
  (you only see "thanks" on a real `reportId`). There's also a "Download game
  log" button. (Verified: `multiplayer.test.ts` stores a report with snapshot +
  log and retrieves it by category; the HTTP `/report` endpoint returns a
  `reportId`.)

## Not yet built

- **AI depth** — the heuristic AI is a competent baseline, not a strong opponent.
- The **West-scenario `africa-western` AST variant** is extracted but unused.

## License

The original source in this repository — the rules engine, server, and UI — is
released under the [MIT License](LICENSE) © 2026 John Champaign.

The MIT grant covers that original code only. *Advanced Civilization* is a game
designed and published by others (Avalon Hill; the design continues today as
Eagle-Gryphon's *Mega Civilization*); all rights in the game itself belong to its
creators. The extracted game **data** (area graph, advances, calamities, cards) is
derived from the publicly distributed VASSAL module and is included here for
interoperability, not relicensed — it remains subject to the rights of the original
game's owners. No board **artwork** is distributed (see "Board artwork" above). This
is an unofficial fan project and is not affiliated with or endorsed by the
publishers.
```
