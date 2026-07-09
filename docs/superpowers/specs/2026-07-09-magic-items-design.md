# Magic items — on-use effects, attunement enforcement, charge/recharge display

Date: 2026-07-09
Status: approved

## Problem

Magic items (potions, wands, rods, staves, etc.) are physical items with
activities, same as any other equipment — but the app treats every physical
item's Use action identically: a blind `use-item` call with no indication of
what the item does, no attunement check, and no charge/recharge visibility
beyond a bare count. This was explicitly deferred out of M15's scope
("Magic items with charges and on-use damage (Bead of Force et al.) — no
fixture groundwork exists for this yet; separate design later").

Confirmed today: neither test fixture (`martial-captured.json`,
`caster-captured.json`) contains a single item with non-empty
`system.rarity` — there are currently zero magic items in the app's data.
Neither fixture has an item requiring attunement, or an item with more than
one charge and a recovery period. All of that groundwork needs to be added
before this can be built and tested against real data.

## Scope

In scope:
- On-use damage/heal effects for physical items, reusing M15's
  classification and formula machinery (Cure Wounds/Second Wind/weapon
  damage precedent) instead of building parallel logic.
- Attunement enforcement: using an item that requires attunement and isn't
  attuned is blocked with a clear error, not silently allowed (M12 tracks
  attunement state today but deliberately doesn't enforce it).
- Charge/recharge visibility: surfacing an item's recovery period (e.g.
  "recharges at dawn") next to its existing uses count.
- Adding real magic items (Bead of Force, Potion of Healing) to the live
  Foundry world and re-capturing fixtures, so this is built and tested
  against real dnd5e 5.3.3 data shapes, matching every prior milestone's
  convention (live-captured fixtures, not hand-written ones).

Explicitly out of scope:
- Target selection for effects that hit a chosen creature other than the
  item's owner (Bead of Force's area, an ally drinking a potion someone else
  administers) — same boundary M15 already drew for spells. Bead of Force's
  damage rolls and displays; it is never auto-applied to any creature's HP,
  since no target-selection UI exists in this app.
- A full magic-item catalog or compendium browser. This covers the mechanics
  needed to *use* a magic item already on a character sheet, not authoring
  or acquiring new ones.
- Item description/info disclosure UI (the "ⓘ" idea from the original ask)
  — unrelated, separate follow-up, same as M15 noted.
- Enforcing the attunement *cap* (max 3 attuned items) — M12 already made a
  deliberate choice not to enforce this (GM/Foundry owns it) and this design
  doesn't revisit that; it only adds the *per-item* "must be attuned to use"
  check, which is a different rule.

## Contract changes (`adapter-sdk`)

None. `ActionDescriptor.effectType` and the `roll` / `roll-and-heal`
`RelayAction` variants (both added in M15) are already generic enough to
cover items — they don't know or care whether the underlying Foundry
document is a `feat` or a `consumable`.

## Adapter logic (`adapter-dnd5e`)

### effectType on item actions

`buildActions`' push for `item.<id>.use` (`index.ts:1337`) currently reads:

```ts
out.push({ id: `item.${item._id}.use`, label: item.name, kind: 'use', group: 'items' });
```

It gains `effectType: effectTypeOf(item)`, identical to the call the
`feature.<id>.use` push already makes. `effectTypeOf`'s existing rule set
(heal-type activity → `heal`; attack-type → `damage`; save-type with
non-empty `damage.parts` → `damage`; else → `utility`) needs no changes —
verified against Bead of Force's real shape (a `save` activity, DC-based,
with non-empty `damage.parts`, structurally identical to Sacred Flame) and
Potion of Healing's (a `heal` activity).

### Generalized damage formula

`weaponDamageFormula` reads a *single* damage entry
(`activity.damage.base.number/denomination/bonus`) because a weapon's
attack activity has exactly one. Save/attack-type item activities carry an
array instead: `activity.damage.parts`, each `{number, denomination,
bonus, types}`. New `activityDamageFormula(actor, item)`:

- Reads the first activity's `damage.parts`.
- For each part, resolves `number`/`denomination` into a dice term and
  `bonus` into a modifier, using the *same* two resolvable roll-data shapes
  already accepted by `healFormula`/`weaponDamageFormula` (`@mod` → the
  actor's spellcasting ability modifier; `@classes.<id>.levels` →
  approximated with total character level; anything else → `+0`, same
  documented gap).
- Joins parts with `+` into one formula string (e.g. `4d4` for Bead of
  Force — a single part, no bonus).
- Returns `undefined` if there are no damage parts, so the caller can throw
  the same `IntentError` shape `buildHealAction` already throws for a
  missing formula.

### Wiring into `buildAction`

`buildAction`'s `'use'` case, `item.` branch (`index.ts:1469-1470`)
currently unconditionally returns `{ endpoint: 'use-item', itemId }`. It
gains the same shape of branch the `feature.` case already has:

```ts
if (intent.actionId.startsWith('item.')) {
  const itemId = intent.actionId.slice('item.'.length, -'.use'.length);
  const item = (actor.items ?? []).find((i) => i._id === itemId);
  if (item && isAttuneable(item) && !isAttuned(item)) {
    throw new IntentError(`"${item.name}" requires attunement`, 'INVALID');
  }
  if (item && activityType(item) === 'heal') {
    return buildHealAction(actor, item, intent.actionId);
  }
  if (item && effectTypeOf(item) === 'damage') {
    const formula = activityDamageFormula(actor, item);
    if (!formula) throw new IntentError(`no damage formula for "${intent.actionId}"`, 'UNKNOWN_RESOURCE');
    return { endpoint: 'roll', formula, flavor: `${item.name} — Damage` };
  }
  return { endpoint: 'use-item', itemId };
}
```

The attunement gate runs before either effect check and before the
`use-item` fallback, so it applies uniformly to every item action, not just
ones with an on-use effect. It reuses the existing `IntentError` → 422
`INVALID_INTENT` flow (`app.ts:610-615`) end to end — no gateway changes
needed.

Non-heal, non-damage items (the vast majority — mundane gear, tools) are
completely unaffected; they still fall through to `use-item`.

### Charges and recharge

No new consumption mechanism. `system.uses.max/spent` is already
item-type-agnostic (M12) and Foundry's own activation flow — triggered by
`relay.useAbility` for `use-item` exactly as it is today — already
decrements `spent` by whatever the item's own activity is configured to
consume, and already auto-destroys single-use consumables
(`autoDestroy: true`, proven today by Rations). This design adds no new
write path for charges.

The one net-new piece: `usesInfo` currently returns only `{ spent, max }`
(`index.ts:321`). It gains a third optional field, `recovery: string |
undefined`, reading `uses.recovery[0]?.period` (e.g. `"dawn"`, `"dusk"`,
`"sr"`, `"lr"`) when present. This flows into the existing uses resource
(`index.ts:465-472`) as an added `recovery` field on the resource object,
consumed only by the item detail view — everything else that reads uses
(`gearStats`, the attunement cap counter) ignores the new field.

## Frontend (`apps/web`)

- Item action rows pick up the same effect-aware roll wording
  `actor/[id].vue`'s `showRoll`/`submitAction` already apply to
  spells/features (`+N HP` for heal, `N dmg` for damage) — no new
  branching needed, since it already keys off `effectType`/`intent.kind`,
  which items now populate identically.
- Attunement-blocked taps surface the gateway's `422 INVALID_INTENT`
  message through the existing error-toast path (the same one that already
  handles e.g. "no spell slot available") — no new UI component.
- Item detail view: when the uses resource's new `recovery` field is
  present, render a small "recharges: `<period>`" line next to the existing
  uses count (e.g. "3/7 — recharges at dawn"). Absent for items with no
  recovery period (unchanged today).

## Live data groundwork

Add to the live Foundry world before implementation starts, then
re-capture `martial-captured.json`/`caster-captured.json` the same way they
were originally captured:

- **Bead of Force** on Randal or Akra — validates the save+damage.parts
  classification and the new `activityDamageFormula` against real data, and
  the "display-only, never auto-applied" boundary (it has no self-target).
- **Potion of Healing** on the other character — validates the heal
  classification, `buildHealAction`'s self-target detection (a potion is
  drunk by its own holder), and consumable auto-destroy-on-use.

If the recaptured fixtures happen to already include (or the user adds) an
attunement-required item or a multi-charge/recharge item, those get
live-verified too; otherwise the attunement gate and `recovery` field are
covered by unit tests against synthetic activity/uses data matching the
already-verified real schema shapes (`system.attunement` enum,
`uses.recovery[].period`), and flagged in the plan as pending live
verification whenever such an item exists in the world.

## Testing

- `adapter-dnd5e`: `activityDamageFormula` unit tests (Bead of Force's real
  shape, plus a synthetic multi-part case). `buildAction` tests: item
  heal → `roll-and-heal` (self) or `roll` (target-chosen); item damage →
  `roll`, display-only; attunement-required + unattuned → `IntentError`;
  attunement-required + attuned → falls through normally; non-effect item →
  unchanged `use-item`. `usesInfo`/resource test for the new `recovery`
  field, present and absent cases.
- `apps/gateway`: no new executor logic (reuses `roll`/`roll-and-heal`/
  `use-item` cases verbatim) — existing tests already cover the 422 path
  for `IntentError`, so no new gateway tests required beyond confirming an
  item-sourced `IntentError` reaches the client unchanged.
- Manual live verification: Potion of Healing heals and disappears from
  inventory in one tap; Bead of Force shows a rolled damage total; an
  attunement-required item (real or, if none exists in the recaptured
  fixtures, a temporary Foundry-side test item) blocks its Use action with
  a visible message until attuned, then works normally once attuned.
