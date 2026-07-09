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

It gains `effectType: effectTypeOf(item)`. **Live-capture correction**
(2026-07-09, after adding real items to the world): the original rule set
only inspected the item's *first* activity, which is wrong for Bead of
Force's real shape — its first activity is `save`-type with **empty**
`damage.parts` (`[]`); the actual `5d4` damage lives in a *second*,
separate `utility`-type activity's `roll.formula` field, not inline on the
save activity. Sacred Flame's single-activity save+damage shape does not
generalize to this item.

`effectTypeOf` therefore needs to inspect **all** of an item's activities,
not just the first, via a new `allActivities(item): Rec[]` helper
(`Object.values(rec(getPath(item.system, 'activities')))`):

1. any activity `type === 'heal'` → `heal`
2. any activity `type === 'attack'` → `damage`
3. any activity `type === 'save'` with non-empty `damage.parts` → `damage`
   (unchanged rule, covers a future item shaped like Sacred Flame)
4. any activity `type === 'save'` **and a separate** activity
   `type === 'utility'` with a non-empty `roll.formula` string → `damage`
   (the Bead of Force shape: DC lives on the save activity, the damage die
   lives on a sibling utility activity)
5. everything else → `utility`

Verified this doesn't regress existing classifications: Bane/Command/
Sanctuary (caster fixture) each have exactly one `save` activity and no
sibling `utility` activity, so rule 4 doesn't fire for them — they stay
`utility`. Guiding Bolt (`attack`) and Sacred Flame (`save` + inline
`damage.parts`) are unaffected — rules 2 and 3 already catch them before
rule 4 is reached.

### Generalized damage formula

`weaponDamageFormula` reads a *single* damage entry
(`activity.damage.base.number/denomination/bonus`) because a weapon's
attack activity has exactly one. New `itemDamageFormula(actor, item)`,
checked in this order (matching the two real shapes now confirmed to
exist):

1. **Inline parts:** the first activity with non-empty `damage.parts`
   (each `{number, denomination, bonus, types}`) — resolves each part's
   `number`/`denomination` into a dice term and `bonus` into a modifier
   using the same two resolvable roll-data shapes `healFormula`/
   `weaponDamageFormula` already accept (`@mod`, `@classes.<id>.levels`;
   anything else → `+0`), joining parts with `+`. Covers a future
   Sacred-Flame-shaped item.
2. **Sibling utility roll (Bead of Force's real shape):** if no activity
   has inline damage parts, look for a `utility`-type activity with a
   non-empty `roll.formula` string and use it verbatim — Bead of Force's
   is the literal string `"5d4"`, already a complete dice formula with no
   roll-data references to resolve.
3. Returns `undefined` if neither shape is found, so the caller throws the
   same `IntentError` shape `buildHealAction` already throws for a missing
   formula.

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
  if (item && effectTypeOf(item) === 'heal') {
    return buildHealAction(actor, item, intent.actionId, { forceSelf: true });
  }
  if (item && effectTypeOf(item) === 'damage') {
    const formula = itemDamageFormula(actor, item);
    if (!formula) throw new IntentError(`no damage formula for "${intent.actionId}"`, 'UNKNOWN_RESOURCE');
    return { endpoint: 'roll', formula, flavor: `${item.name} — Damage` };
  }
  return { endpoint: 'use-item', itemId };
}
```

**Live-capture correction:** the original plan reused `activityType(item)
=== 'heal'` (spell/feature check) and relied on `isSelfTargeted`'s
`target.affects.type === 'self'` rule inside `buildHealAction` to decide
self-apply. Potion of Healing's real activity has
`target.affects.type: "creature"` (count 1), **not** `"self"` — under the
unmodified spell/feature rule it would be treated as target-chosen
(roll-and-display only, no HP write), which is wrong for an item: this app
has no other-creature-targeting flow for items at all, so an item's heal
is always drunk/used by its own holder. `buildHealAction` gains an
optional third parameter, `{ forceSelf?: boolean }`, defaulting to
`false`; when `true` it skips the `isSelfTargeted` check and always
returns `roll-and-heal`. The `item.` branch above always passes
`forceSelf: true`; the existing `feature.`/`cast` call sites (Second Wind,
Cure Wounds, Healing Word) are unchanged — they omit the option and keep
today's `isSelfTargeted`-driven behavior.

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

**Simpler than originally planned:** rather than adding a new field to
`ResourceDescriptor` (an actual `adapter-sdk` contract change, contradicting
this design's "no contract changes" claim), reuse the existing free-form
`ListItem.sub` string `inventoryListItem` (`index.ts:930-972`) already
builds for the inventory row (today: `"×1 · consumable · 0.06 lb"`). A
recovery period, when present, appends as one more `subParts` entry (e.g.
`"recharges: dawn"`), mapping the raw `uses.recovery[0]?.period` value
(`"dawn"`, `"dusk"`, `"sr"`, `"lr"`) through a small friendly-label table
(`sr` → "short rest", `lr` → "long rest", else used as-is). No new type,
no new field — `ResourceDescriptor`/`buildResources` are untouched.

## Frontend (`apps/web`)

- Item action rows pick up the same effect-aware roll wording
  `actor/[id].vue`'s `showRoll`/`submitAction` already apply to
  spells/features (`+N HP` for heal, `N dmg` for damage) — no new
  branching needed, since it already keys off `effectType`/`intent.kind`,
  which items now populate identically.
- Attunement-blocked taps surface the gateway's `422 INVALID_INTENT`
  message through the existing error-toast path (the same one that already
  handles e.g. "no spell slot available") — no new UI component.
- Recharge display needs no frontend change at all — it's already part of
  the inventory row's existing `sub` text, which the PWA already renders
  verbatim.

## Live data groundwork

**Done (2026-07-09).** Added to the live world via the GM browser session
and the dnd5e system's own `dnd5e.items` compendium (2014-ruleset pack, matching
the rest of the fixtures' rules version), then captured via
`actor.items.get(id).toObject()` in the same session:

- **Bead of Force** (`iecfawCz0pIwcPVg`) added to Randal
  (`zteTG9PZZ6XQpQtK`). Real shape: `rarity: "rare"`, `attunement: ""` (does
  **not** require attunement), `uses: {max:"1", autoDestroy:true}`, two
  activities — `save` (DC 15 Dex, `damage.parts: []`) and `utility`
  (`roll.formula: "5d4"`). This is what drove the classification and
  formula corrections above.
- **Potion of Healing** (`7vIZxvwGzmJgmugo`) added to Akra
  (`pTvtx5dm2AuYqeX2`). Real shape: `rarity: "common"`, `attunement: ""`,
  `uses: {max:"1", autoDestroy:true}`, one `heal` activity
  (`healing: {number:2, denomination:4, bonus:"2"}`,
  `target.affects: {type:"creature", count:"1"}` — confirmed **not**
  `"self"`, the source of the `forceSelf` correction above).

Both items' `attunement` came back empty, so neither exercises the
attunement gate with real data — confirmed consistent with the scope
decision to skip adding a dedicated attunement-required item. The
attunement gate and the `uses.recovery` display are covered by unit tests
against synthetic activity/uses data matching the already-verified real
schema shapes (`system.attunement` enum values, `uses.recovery[].period`),
flagged in the plan as pending live verification whenever such an item
exists in the world.

Remaining step: merge these two item documents into
`martial-captured.json`'s / `caster-captured.json`'s `items` arrays — see
the implementation plan's first task for the exact objects.

## Testing

- `adapter-dnd5e`: `effectTypeOf` tests for the new sibling-utility-roll
  rule (Bead of Force's real shape) plus a regression check that
  Bane/Command/Sanctuary stay `utility`. `itemDamageFormula` unit tests
  (Bead of Force's real `"5d4"` sibling-roll shape, plus a synthetic
  inline-`damage.parts` case). `buildAction` tests: item heal → always
  `roll-and-heal` (Potion of Healing's real shape, confirming `forceSelf`
  overrides its non-`"self"` `target.affects.type`); item damage → `roll`,
  display-only (Bead of Force); attunement-required + unattuned →
  `IntentError`; attunement-required + attuned → falls through normally;
  non-effect item → unchanged `use-item`. `inventoryListItem` test for the
  new recovery-period `sub` text, present and absent cases.
- `apps/gateway`: no new executor logic (reuses `roll`/`roll-and-heal`/
  `use-item` cases verbatim) — existing tests already cover the 422 path
  for `IntentError`, so no new gateway tests required beyond confirming an
  item-sourced `IntentError` reaches the client unchanged.
- Manual live verification: Potion of Healing heals and disappears from
  inventory in one tap; Bead of Force shows a rolled damage total; an
  attunement-required item (real or, if none exists in the recaptured
  fixtures, a temporary Foundry-side test item) blocks its Use action with
  a visible message until attuned, then works normally once attuned.

## Addendum — branch-review corrections (2026-07-10)

A whole-branch adversarial review of the implemented feature found five
defects in the shipped design; the implementation now diverges from the
sections above as follows:

1. **Consumption is Foundry's job, via a new `use-and-roll` relay action**
   (supersedes "Contract changes: None" and "no new write path for
   charges"). Client-computed rolls (`roll` / the M15 `roll-and-heal`)
   bypassed Foundry's activation entirely, so nothing was ever consumed:
   heal-classified casts stopped consuming spell slots, damage items (Bead
   of Force) never consumed or destroyed themselves, and a first-pass
   hand-rolled `consumeUse` write deleted whole item stacks and wrote
   `uses.spent` past max. `use-and-roll` activates the item through
   Foundry's own `use-item`/`use-spell`/`use-feature` flow FIRST (slots,
   uses, quantity, auto-destroy, refusal when empty — all Foundry's rules),
   then fires the adapter-computed display roll, then applies the optional
   self-heal HP write. `roll-and-heal` is removed from the contract.
2. **The attunement gate blocks only `attunement === "required"`** (plus
   the legacy numeric 1) — the section above gated on `isAttuneable`, which
   also covers `"optional"`, wrongly blocking items that work unattuned.
3. **An exhausted use/cast is rejected with a 422** before the activation:
   Foundry refuses too, but its refusal is a chat message, not a relay
   error, so the display roll would otherwise still fire.
4. **`healFormula`/`isSelfTargeted` read the heal-type activity found by
   scanning all activities** (`healActivity`), not blindly the first —
   matching how `effectTypeOf` classifies.
5. **Item damage uses show `N dmg` wording** — the M15 rule "damage wording
   only from the weapon-damage intent kind" was extended: an item `use`
   whose descriptor is damage-classified returns a genuine damage roll (not
   a to-hit roll), so its `effectType` is trustworthy for wording; only
   spell casts must keep suppressing it.
