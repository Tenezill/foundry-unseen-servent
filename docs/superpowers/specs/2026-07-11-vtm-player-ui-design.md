# Vampire: the Masquerade player UI — design

**Date:** 2026-07-11
**Status:** approved (brainstorm with user)
**Milestone:** M23 (working name: "vtm player ui")

## Problem

The companion PWA is a dnd5e-only player surface. The table also runs a
bi-weekly Vampire: the Masquerade (V5) campaign on Foundry's community
"World of Darkness 5e" system (repo foundryvtt-wod5e, **system id
`vtm5e`**), and those players have no phone sheet at all. The architecture
reserved a second-system proof (`adapter-morkborg` placeholder, PLAN.md §6)
but nothing beyond dnd5e was ever built — and a few 5e assumptions leaked
into supposedly generic layers (hardcoded tab set + label-regex routing in
`apps/web/app/pages/actor/[id].vue`, caster/martial glyph heuristic in
`SheetHero.vue`).

## Goal (user's words, distilled)

Full dnd5e-level parity for Vampire players in one milestone: an
interactive V5 sheet on the phone — dot-rated attributes/skills, tri-state
health/willpower tracks, hunger, humanity, disciplines — with dice-pool
rolls, rouse checks, track edits, and item management. The compendium
library is de-scoped (wod5e ships few preset items); players create
**custom items that are mechanically functional** so custom weapons feed
attack pools correctly rather than breaking the attack flow.

## Decisions (user)

- **Foundry system: wod5e** (system id `vtm5e`), not yet installed —
  M23 starts by standing up the environment.
- **Two independent stacks.** Both campaigns run bi-weekly on alternating
  weeks; each GM keeps always-on access to their world. The VtM campaign
  gets its own Foundry + relay + gateway + web deployment via the M21
  compose. Each gateway therefore only ever serves one system.
- **Approach A — minimal SDK extension, adapter stays king.** Extend the
  `adapter-sdk` contract only where VtM needs a genuinely new primitive
  (tabs, tri-state tracks, dots, pool rolls — see Architecture); every
  extension is optional/additive so dnd5e is untouched, and each one is a
  primitive Mörk Borg (system #3) will reuse. Rejected: B (squeeze VtM
  into existing primitives — clunky track UX for VtM's core interaction,
  tab regex still needs touching anyway) and C (full schema-driven UI —
  a web-shell rewrite whose benefit only appears at system #4+).
- **Custom items are mechanically functional:** the add-item form carries
  the few mechanical fields (item type, damage value) so a custom weapon
  contributes to attack pools. Descriptive-only items and GM-only item
  creation were rejected.
- **Dedicated VtM theme:** a second token set (near-black surfaces,
  oxblood/crimson accent) auto-selected when the sheet's system is
  `vtm5e`; same components, different skin. Light/dark toggle keeps
  working (VtM light = pale marble + dried-blood red).
- **Encounter mode deferred** (M22 port is a follow-up milestone). V5
  combat is looser and the gateway encounter code assumes dnd5e HP;
  prove the core loop at the table first.
- **Dot ratings render up to max 10, not 5.** Attributes/skills top out
  at 5, but Humanity is 0–10 and homebrew reaches ~7; the dot primitive
  carries its own per-stat `max` (≤10) rather than hardcoding 5.

## Non-goals (v1)

- Encounter/initiative support for VtM (deferred; see above).
- Compendium library search → preview → add (the M13 flow) for wod5e.
- Hunter/Werewolf actor types. Mortal/ghoul PCs only if the Task-0
  capture shows they share the vampire data shape cheaply.
- Migrating the dnd5e adapter onto explicit `tabs` (cheap follow-up that
  lets us delete the regex fallback — not required for M23).
- Full V5 rules automation (frenzy checks, resonance, blood surge…):
  Foundry owns the rules; the PWA mirrors and triggers.

## Feasibility gate (Task 0 of the plan — vet before building)

Stand up the second stack (M21 compose), install wod5e, create a test
vampire, and capture the raw actor JSON as a fixture. The adapter is built
against real captures, not the wod5e source's implied schema — all data
paths named in this spec (`system.health.superficial` etc.) are
provisional until captured. Then vet the relay against this system (the
`prepare-spell` precedent: existing ≠ working):

1. `GET /get` actor serialization: are health/willpower
   superficial/aggravated, hunger, humanity, attributes/skills,
   disciplines/powers (embedded items?) all present?
2. Actor updates: writing damage-track fields via dotted paths.
3. Rolls: does any relay path trigger **wod5e's own roll workflow**
   (hunger dice, messy criticals, bestial failures computed by the
   system)? Or is generic `/roll` with a d10 success-counting formula the
   only option? This decides the roll strategy (below).
4. Item creation: can the relay create an embedded item on the actor
   (`give`/create-entity equivalent) with wod5e weapon fields?
5. Do actor/item update hooks flow through the existing hooks SSE for
   this system (live sheet refresh)?

Findings get recorded in the plan before implementation tasks are drawn.

## Architecture

### Roll strategy (the one spike-dependent decision)

- **Strategy 1 (preferred): system-native roll.** If Task 0 finds a relay
  path into wod5e's roll workflow, rolls produce real V5 results in
  Foundry chat; the adapter just names the pool.
- **Strategy 2 (fallback): formula roll + adapter interpretation.** The
  relay's generic `/roll` posts normal and hunger dice as separate terms
  (e.g. `3d10cs>=6 + 2d10cs>=6`) with a flavor line ("Strength + Brawl ·
  2 hunger"). Messy-crit/bestial detection is best-effort from the dice
  results, worst case narrated by the GM.
- Rouse checks are a fixed 1d10 (success on 6+, hunger +1 on failure) and
  work under Strategy 2 regardless. Whether hunger auto-increments (a
  follow-up gateway write) or is player-confirmed is decided in Task 0
  based on what the system automates.

### `packages/adapter-sdk` (four additive, optional extensions)

1. **Adapter-declared tabs.** `SheetViewModel.tabs?: Array<{ id; label;
   sectionIds: string[] }>` plus a hint for which tab hosts actions.
   Present → the PWA renders exactly these tabs; absent → today's regex
   heuristic (dnd5e unchanged).
2. **Tri-state track rendering.** `tracks` section entries may declare
   `style: 'boxes'` pairing two resources over one max (e.g. health =
   superficial + aggravated). The *data* stays two plain writable
   `ResourceDescriptor`s — `buildUpdate`, clamping, and optimistic-lock
   409s work unchanged; only rendering is new. Hunger (0–5) and Humanity
   (0–10, plus stains) reuse the style with a single resource.
3. **Dot display hint.** `Stat.display?: 'dots'` with numeric `value` and
   per-stat `max` (≤10).
4. **Pool roll action.** New `SheetActionKind: 'pool'`; intent `{ kind:
   'pool', actionId, attribute?, skill?, modifier? }` (mirrors how `cast`
   carries `slotLevel`). The adapter enumerates tappable *entry points*
   (each attribute, skill, discipline power) — not the 9×27 cross
   product; `buildAction` computes pool size + hunger split and returns
   the relay call.

### `packages/adapter-wod5e` (new)

Implements `SystemAdapter` for `systemId: 'vtm5e'`. All wod5e knowledge
(data paths, attribute/skill vocab, discipline structure, damage-track
invariants) lives here and nowhere else. Emits tabs like *Overview /
Rolls / Disciplines / Vitals / Gear*; view model covers dot-rated
attributes/skills, box tracks (health, willpower, hunger, humanity),
blood potency, disciplines with powers, inventory. `buildUpdate` enforces
`superficial + aggravated ≤ max` per track. `buildAction` covers pool
rolls, rouse checks, power use, equip, item field writes.

### `apps/gateway`

- Register the adapter in `registry.ts` (one line; resolution via the
  existing `adapterFor`/`systemIdOf` path).
- Custom-item creation: expose the relay's create-embedded-item call for
  adapter-validated item payloads (shape finalized after Task 0). The
  adapter whitelists the writable wod5e item fields — the gateway never
  passes client JSON through raw.
- Everything else (auth, scoping, intents, SSE, limiter) unchanged.

### `apps/web`

- **`pages/actor/[id].vue`:** render tabs from `viewModel.tabs` when
  present; regex fallback otherwise. 5e-flavored vocab (`REMOVE_LABELS`
  etc.) moves behind the view-model-driven path.
- **Box tracks** (extend `SectionTracks.vue` or sibling `TrackBoxes`):
  tap a box to cycle empty → superficial → aggravated → empty; taps
  translate to `delta`/`set` intents on the two underlying resources;
  optimistic UI with the existing 409-refresh.
- **Dot stats:** `SectionStats.vue` renders `display: 'dots'` rows.
- **`SheetHero.vue`:** glyph becomes view-model-driven (adapter picks);
  dnd5e keeps its current heuristic as fallback.
- **Pool roll sheet:** tapping an attribute/skill/power opens a bottom
  sheet pre-filled with the pairing, showing the computed pool
  ("Strength 3 + Brawl 2 = 5 dice, 2 hunger"), adjustable
  attribute/skill/modifier, roll on confirm.
- **Custom item form:** "Add item" opens a form (name, type
  weapon/gear, damage value, description) → gateway create-item; renders
  in Gear with a remove action.
- **VtM theme:** a `vtm5e` palette in `main.css` mapped onto the existing
  `--accent`/`--surface` tokens, stamped by the sheet's `systemId`;
  coexists with the light/dark mechanism in `useTheme.ts`.

## Error handling

- Established patterns throughout: relay calls bounded by timeouts (M18
  `adminNameTimeoutMs` precedent — relay requests can stall),
  `IntentError` → HTTP mapping unchanged, 409 optimistic-lock refresh on
  stale writes, `enrich` (if needed) tolerates IO failure — a degraded
  sheet beats no sheet.
- Track invariant violations (write would push `superficial + aggravated`
  past `max`) clamp per the descriptor bounds, same as hp today.
- Custom-item payloads failing adapter validation → 422 with the standard
  envelope; nothing reaches the relay.

## Testing

- **Fixtures:** Task-0 captured vampire actor JSON (plus mortal/ghoul if
  in scope) drives all adapter tests.
- **`adapter-wod5e` unit tests:** fixture → view-model snapshots;
  `buildUpdate` clamping incl. the `superficial + aggravated ≤ max`
  invariant; `buildAction` pool math incl. hunger split and rouse;
  `IntentError` cases (unknown resource, read-only, invalid pool params);
  custom-item field whitelist.
- **Gateway tests (fake relay):** registry resolution for `vtm5e`; intent
  round-trips through the new adapter; create-item validation (422 path).
- **Web:** component tests for box-track cycling and dot rendering;
  dnd5e regression — existing tests stay green and the tabs fallback
  path keeps the 5e sheet pixel-identical.
- **Live verification** against the second stack (standard table-loop
  pass): mark superficial/aggravated damage from the phone and see it in
  Foundry; roll a pool with hunger; rouse check; create a custom weapon
  and attack with it; theme applies; live refresh via SSE.
