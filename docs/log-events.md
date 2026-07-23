# Game log event registry (log-format v2)

The engine's `state.log` is an array of the framework's `GameLogEntry<PlayerId>`
(digital-boardgame-framework ≥ 0.42.0):

```ts
{ seq, turn, phase, side, kind, msg, payload? }
```

- `msg` always carries the full human prose, **including the rulebook § citation**
  when one applies.
- Whenever the prose cites a rule, `payload.rule` carries the bare id (e.g.
  `"19.31"`) — the choke-point `log()` helper in `src/engine/engine.ts` extracts
  it automatically, so analyzers never parse prose.
- `side` is the acting/affected civ id, or `null` for neutral events
  (Barbarians, pirates, multi-party conflict).
- The in-state log is capped at 2000 entries (`LOG_CAP`); `seq` is monotonic and
  stable across trims.
- Snapshots saved under schemaVersion 1 (prose `string[]`) are upgraded by
  `CivAdapter.migrate()` via the framework's `upgradeProseLog` — those entries
  have `kind: 'legacy'` and the old line in `msg`.

## Kinds by phase

### Turn rollover / census (§21)
| kind | payload |
|---|---|
| `census.order` | `{order: civ[], populations: Record<civ, n>}` (side = null) |

### Population expansion (§18)
| kind | payload |
|---|---|
| `tokens.grow` | `{total, areas: Record<area, n>}` — automatic §13 growth (stock sufficient) |
| `tokens.place` | `{placements: Record<area, n>}` — hand-placed growth when stock is short |

### Movement (§23)
| kind | payload |
|---|---|
| `move.land` | `{from, to, count, via?}` — one entry per land move (`via` = Roadbuilding §32.251) |
| `move.voyage` | `{steps: {area, load?, unload?}[]}` — one entry per ship voyage (§23.5); byShip single-destination sailings log as a voyage too |
| `phase.pass` | `{}` — deliberate "did nothing" in movement / cityConstruction / acquireAdvances |

### Surplus removal (§26.1)
| kind | payload |
|---|---|
| `surplus.removed` | `{area, lost, kept}` — tokens over the population limit returned to stock |

### Setup
| kind | payload | notes |
|---|---|---|
| `game.start` | `{players, seed}` | first entry, written in setup.ts |

### Taxation (§19)
| kind | payload |
|---|---|
| `tax.collect` | `{amount, rate, cities}` |
| `tax.shortfall` | `{amount, rate, cities, payable, revolting, rule:'19.31'}` |
| `city.takeover` | `{area, from, rule:'19.32'}` (side = the taker) |
| `city.collapse` | `{area, rule:'19.33'}` |

### Ship construction (§22)
| kind | payload |
|---|---|
| `ship.build` | `{area, count, paidFrom: 'area'\|'treasury'}` |
| `ship.scrap` | `{area, count, reason: 'maintenance'\|'voluntary', rule:'22.3'}` |

### Conflict (§24)
| kind | payload |
|---|---|
| `conflict.losses` | `{area, losses: Record<civ, tokensLost>}` (side = null) |
| `city.storm` | `{area, defender?, defendedBy?, pirate?}` (side = attacker) |
| `city.storm.fail` | `{area, defender?, required, lost, pirate?}` |
| `combat.pillage` | `{victim}` (§24.51 card steal) |

### Surplus removal / city support (§26)
| kind | payload |
|---|---|
| `city.reduce` | `{area, reason:'support', rule:'26.32'}` — forced or chosen support reduction |
| `city.reduce` | `{areas: string[], calamity}` — calamity-directed city choice |

### Trade-card acquisition (§27) & trade (§28)
| kind | payload |
|---|---|
| `trade.cards.draw` | `{count, cities}` |
| `trade.offer` | `{gives, wants: string[]}` |
| `trade.respond` | `{to, offerId}` |
| `trade.offer.expire` / `trade.response.expire` | — |
| `trade.complete` | `{with, gave, got}` (counts only — §28 keeps contents private) |
| `trade.buyNinth` | `{count, cost}` (§27.5) |

### Calamities (§29–30)
All carry `payload.calamity` (the calamity id) and `rule` when cited.

| kind | payload extras |
|---|---|
| `calamity.units` | `{points}` — primary/secondary unit-point loss (Famine, Epidemic, Flood…) |
| `calamity.unmodeled` | — |
| `calamity.famine.grain` | `{grain, reduction, rule:'30.312'}` |
| `calamity.volcano` | `{areas}` |
| `calamity.earthquake` | `{area, reduced?\|destroyed?\|noEffect?}` |
| `calamity.earthquake.secondary` | `{area}` (side = the secondary victim) |
| `calamity.slaverevolt` | `{withheld}` |
| `calamity.civilwar.fizzle` | — (§30.411/.413) |
| `calamity.civilwar.select` | `{points, by:'victim'\|'beneficiary', victim?}` |
| `calamity.civilwar.military` | `{points:5, rule:'30.414'}` |
| `calamity.civilwar.defect` | `{points, beneficiary}` |
| `calamity.civilwar.keep` | `{kept, annexed, beneficiary, rule:'30.415'}` |
| `calamity.treachery` | `{area?, defectsTo?\|destroyed?\|reduced?\|noEffect?}` |
| `calamity.flood` | `{area?, reduced?\|destroyed?\|noEffect?}` |
| `calamity.piracy.raze` | `{area, rule:'30.91'}` (side = null; city becomes pirate) |
| `calamity.barbarians.land` | `{area, count:15}` (side = null) |
| `calamity.barbarians.march` | `{from, to, count}` (side = null) |
| `calamity.barbarians` | `{immune?\|noEffect?}` (side = primary victim) |

### Hand limit & advances (§31)
| kind | payload |
|---|---|
| `hand.discard` | `{count, rule:'31.71'}` |
| `advance.buy` | `{advance, cost, paid}` |

### Movement / Monotheism (§23, §32.94)
| kind | payload |
|---|---|
| `monotheism.convert` | `{area, victim, city, tokens, rule:'32.94'}` |

(Ordinary token movement is deliberately not logged — it never was in the prose
log either; the board diff carries it.)

### City construction (§25)
| kind | payload |
|---|---|
| `city.build` | `{area, treasuryUsed}` |

### AST adjustment (§33)
| kind | payload |
|---|---|
| `ast.slideback` | `{space}` (§33.4) |
| `ast.frozen` | `{space}` |
| `ast.finish` | `{space}` — sets `finished` |

### Migration
| kind | payload |
|---|---|
| `legacy` | `{}` — a pre-v2 prose line wrapped by `upgradeProseLog`; text in `msg` |

## Adding a new event

Always go through `log(s, kind, side, msg, payload)` in `src/engine/engine.ts` —
never push to `s.log` directly. Put the § citation in the prose; `payload.rule`
is derived. Add the kind to this registry.
