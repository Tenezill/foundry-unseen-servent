# Spell/item effect classification & self-heal fix — design

Date: 2026-07-09
Status: approved

## Problem

The Actions tab lists every spell/feature flat, with no indication of what it
actually does — the user wants to distinguish damage / healing / utility
spells, both to scan the list faster and because tapping a "heal" action
(Second Wind) currently does **nothing**: the relay posts an unrolled
activation card and stops; nothing is rolled, HP never changes, only the use
gets consumed. This is the same underlying limitation as the M14 weapon-damage
gap (docs: `2026-07-08-...` weapon damage work) — the relay module only
auto-executes the roll for `attack`-type activities. `heal`/`save`/`utility`
just post an inert card that a human must click through in Foundry itself.

Live-verified (2026-07-09): reset Randal's Second Wind uses to 1, called
`use-feature` via the gateway. Result: uses correctly dropped to 0 (Foundry
consumed the use), but HP stayed at 41/44 and the gateway's `result` was
`null`. Inspecting the posted chat card confirmed it carries an unrolled
`data-action="rollHealing"` button — the heal never happened.

## Scope

In scope:
- Classify spells/features into `damage` / `heal` / `utility` using data
  already present in the Foundry document (activity `type` + damage parts) —
  no new relay calls needed.
- Filter chips on the Spells section of the Actions tab, single-select,
  default "All".
- Effect-aware wording in the roll-result popup (`+N HP`, `N dmg`).
- Fix Second Wind (and any other **self-targeted** heal) to actually roll and
  apply HP, mirroring the weapon-damage client-computed-formula approach.
- Cure Wounds / Healing Word (and other **target-chosen** heals): make them
  actually roll and show the total (currently do nothing) — but do NOT
  auto-apply to the caster's own HP, since in normal play they target someone
  else.

Explicitly out of scope (unchanged from the original ask):
- Magic items with charges and on-use damage (Bead of Force et al.) — no
  fixture groundwork exists for this yet; separate design later.
- Item description/info disclosure UI (the "ⓘ" idea) — small, unrelated
  feature, own follow-up.
- Target selection for spells/effects that hit a chosen creature other than
  the caster (Guiding Bolt on an enemy, Cure Wounds on an ally). Foundry's own
  card-click workflow remains how those get applied to the right creature.

## Classification rule

Computed once per spell/feature, from its first activity, in that priority
order:

1. `activity.type === 'heal'` → `heal`
2. `activity.type === 'attack'` → `damage`
3. `activity.type === 'save'` **and** `activity.damage.parts.length > 0` →
   `damage` (catches save-and-damage spells like Sacred Flame, which is
   mechanically a `save` activity, not an `attack`, but still deals radiant
   damage — verified against the caster fixture: Sacred Flame's `damage.parts`
   has one entry, Bane/Command/Sanctuary's are empty)
4. everything else (pure debuff saves, all `utility`/`check` activities) →
   `utility`

Live-verified activity types (caster-captured.json): `heal` → Cure Wounds,
Healing Word; `attack` → Guiding Bolt, Inflict Wounds; `save` with damage →
Sacred Flame; `save` without damage → Bane, Command, Sanctuary; `utility` →
Thaumaturgy, Guidance, Detect Magic, Bless, etc.

## Contract changes (`adapter-sdk`)

`ActionDescriptor` gains one new optional field, present on `cast` and `use`
kinds (not on `attack`/`damage` — those stay their own section, unfiltered):

```ts
effectType?: 'damage' | 'heal' | 'utility';
```

`RelayAction` gains one new variant for the self-heal write-through:

```ts
| {
    endpoint: 'roll-and-heal';
    formula: string;
    flavor: string;
    /** dnd5e-specific field path, resolved by the adapter so the gateway
     *  stays system-agnostic — e.g. "system.attributes.hp.value". */
    path: string;
    current: number;
    max: number;
  }
```

Gateway executor (generic, no dnd5e knowledge): roll the formula → extract
`total` → `newValue = Math.min(max, current + total)` → one entity-update call
writing `{ [path]: newValue }` → return the extracted roll as `result` (so the
PWA still shows `+11 HP`) — same shape the frontend already expects from
`ActionResponse.result`.

## Heal formula computation (`adapter-dnd5e`)

Mirrors `weaponDamageFormula`: read `activity.healing.number` /
`.denomination` / `.bonus`. `bonus` is a Foundry roll-data reference string;
only two shapes appear in dnd5e content and are resolved explicitly (anything
else falls back to `+0`, documented as a known gap — not a roll-data
evaluator):

- `@mod` → the actor's spellcasting ability modifier
  (`actor.system.attributes.spellcasting`, e.g. `"wis"` for a Cleric).
- `@classes.<id>.levels` → approximated with total character level (same
  multiclass caveat already accepted for weapon damage's ability-mod lookup).

Self-vs-other decision: `activity.target.affects.type === 'self'` (true only
for Second Wind in current fixtures — Cure Wounds/Healing Word have no
`affects.type`, they're target-chosen) is the sole signal for whether
`buildAction` returns `roll-and-heal` (self, auto-apply) vs. plain `roll`
(target-chosen, display-only, matches existing weapon-damage precedent).

`buildAction`'s existing `'use'`/`'cast'` cases gain a branch: if the
descriptor's underlying activity is `heal`-type, return the computed roll
(with or without the heal path/current/max per the self-check) instead of the
current `use-feature`/`use-spell` call. Non-heal `use`/`cast` actions are
unchanged.

## Frontend (`apps/web`)

- `SectionActions.vue`: filter chips (`All` / `⚔️ Atk` / `⚕️ Heal` /
  `⚙️ Util`) above the Spells list only, driven by `effectType`, single-select,
  default All. Pure client-side filter, no new API calls.
- `actor/[id].vue` `showRoll`: pick the displayed label from the action's
  `effectType`/`kind` — `heal` → `+N HP`, `damage` (including weapon damage
  rolls) → `N dmg`, everything else → today's plain total. Only the label
  string changes; popup/haptics/roll-history mechanics are untouched.
- HP sync for the self-heal case falls out for free: `applySheet(res.sheet)`
  already runs after every action, and the sheet is rebuilt from the actor
  Foundry just updated.

## Testing

- `adapter-dnd5e`: classification-rule unit tests against real fixture
  spells/features (one per bucket, including the Sacred-Flame-is-`save`-but-
  `damage` case). Formula tests for Second Wind's `@classes.fighter.levels`
  and a synthetic `@mod` case (mirrors the weapon-damage formula test style).
  `buildAction` tests: self-heal returns `roll-and-heal` with correct
  path/current/max; target-chosen heal returns plain `roll`.
- `apps/gateway`: `roll-and-heal` executor test via the existing
  fake-adapter/fake-relay harness — verifies the clamp-to-max behavior and
  that `result` is still returned to the client.
- Manual live verification (same method used for the weapon-damage feature):
  confirm Second Wind actually heals and decrements uses in one tap; confirm
  Cure Wounds/Healing Word roll and show `+N HP` without touching the caster's
  own HP.
