# Spell Preparation Declutter — Design (2026-07-23)

## Problem

The Spells tab makes preparation feel *busy*. Three concrete causes, confirmed
with the user:

1. **Redundant "prepared" signalling.** A prepared leveled spell states the same
   fact three times: the sub-line pushes `"prepared"`
   (`packages/adapter-dnd5e/src/index.ts:1372`), the tag row pushes a `"prepared"`
   tag (`:1376`), and the row's **Prepare / Prepared** toggle already carries the
   state. Three restatements per row make the list heavy to scan.
2. **Prepared and unprepared spells are interleaved.** Each level section
   (`spells.l<n>`) lists every known spell for that level in insertion order
   (`:2650`, `:2656`–`:2658`), so the handful actually prepared is buried among the
   ones that are not — each dragging its own Prepare pill.
3. **No sense of a prep budget.** There is no "you've prepared X of Y" summary, so
   preparing feels like toggling in the dark rather than managing a budget.

The user explicitly did **not** flag the Prepare control itself as intrusive —
keeping a per-row toggle is fine. The pain is redundancy, mixing, and the missing
budget.

## Decision

Declutter presentation without changing the preparation mechanic. Three prongs:

1. Remove the redundant `prepared` sub-line and tag; let the toggle be the single
   source of that signal.
2. Order prepared-first within each level and dim the unprepared rows.
3. Add a single **"Prepared X / Y"** budget summary at the top of the Spells tab,
   with `Y` = a best-effort computed base plus a **manual, persisted offset** so
   multiclass / homebrew / feat cases are correctable by the player rather than
   guessed wrong by us.

The underlying data model is unchanged: dnd5e stores `system.prepared` (0/1/2),
toggled through the existing `prepare` action (`:2527`). No relay changes.

## 1. Redundancy removal (adapter)

In `spellListItem` (`packages/adapter-dnd5e/src/index.ts:1347`):

- **Drop the `prepared` sub push** (`:1372`, the `else if (isPrepared)
  subParts.push('prepared')` branch).
- **Drop the `prepared` tag push** (`:1376`).

Both branches are reached *only* by spells that also receive a Prepare toggle:
they require `isPrepared && !always && freeUse === undefined`, which is exactly
`isPreparableSpell` (`:1400`, `level > 0 && prepared !== 2 && freeUse ===
undefined`). So the toggle is always present to carry the signal, and removal
loses no information.

**Kept unchanged:**
- `"always prepared"` sub (`:1371`) — `prepared: 2` domain/feat spells have **no**
  toggle, so this text is their only signal.
- The level/school sub prefix (`"3rd level · Evocation"`), the free-use uses sub
  (`"1/long rest"` / `"no slot needed"`), and the `free use` / `innate` /
  `concentration` / `ritual` tags — each carries distinct information.

Net effect: a prepared row goes from `icon · name · "…· prepared" · [prepared tag]
· [Prepared] · [Cast]` to `icon · name · [conc/ritual if any] · [Prepared] ·
[Cast]`.

## 2. Prepared-first ordering + dimmed unprepared

### Ordering (adapter)
When building `spellsByLevel` (`:2650`), sort each level's spells before they
become a section (`:2741`–`:2749`). The raw dnd5e item — and thus
`system.prepared` — is still in hand at grouping time, so the sort key is
available without adding any `ListItem` field.

Order within a level:
1. Always-prepared (`prepared: 2`) and prepared (`prepared: 1`) spells first,
2. then unprepared,
3. ties broken by current insertion order (spell name), preserving today's stable
   ordering.

Cantrip sections (`l0`) are unaffected in practice (cantrips are never
preparable) but the same sort is harmless there.

### Dimming (web, `SectionList.vue`)
A row is "unprepared" iff it has a Prepare toggle that is off — already derivable
via `toggleOf(item)` → `action.kind === 'prepare' && action.prepared === false`.
Add a `dimmed`-style class bound to that condition. No SDK/adapter field needed;
purely visual (reduced opacity on name/sub), and it must not dim the toggle or
Cast button themselves (they stay fully interactive).

No per-level "show N unprepared" disclosure in this pass (considered, deferred as
a possible follow-up) — sort + dim is the agreed scope.

## 3. Prepared-spell budget

### What counts
Foundry does **not** store a prepared-spell limit, so we compute a best-effort
base and let the player correct it.

- **`prepared` (current):** count of *preparable* spells currently prepared —
  i.e. spells matching `isPreparableSpell` with `system.prepared === 1`.
  Always-prepared (`prepared: 2`) domain/feat spells and cantrips are **excluded**
  (RAW: they do not count against the limit).
- **`base` (computed max):** spellcasting-ability modifier + preparing-class
  level; half-casters (paladin/artificer) use ⌊level ÷ 2⌋. When multiclassed,
  use the highest-level preparing class for the ability and level. This is
  best-effort; the exact dnd5e field reads (which class prepares, its
  `spellcasting.ability`, its `spellcasting.progression`) are resolved during
  implementation against `packages/adapter-dnd5e/test/fixtures/caster.json`,
  with the manual offset (below) as the correctness backstop.

### When it shows
The budget is emitted **only when the actor has at least one preparable spell**
(`isPreparableSpell` true for some item). This ties the summary precisely to the
thing already being managed — the summary appears exactly when the app already
shows Prepare toggles — and sidesteps prepared-vs-known class detection.

Note this is a *dependency on the existing classification*, not a new guarantee:
whether a spontaneous caster (sorcerer, bard, ranger, warlock — spells *known*)
has any preparable spell depends on how their data marks `system.prepared`, which
this spec does not change. If their known spells are marked `prepared: 1` today,
they already receive Prepare toggles and would likewise get a summary; if marked
`prepared: 2` / a known method, they get neither. Implementation must verify the
actual classification against a known-caster fixture (capture one if none exists)
before assuming "no summary for sorcerers."

### SDK (`packages/adapter-sdk/src/index.ts`)
New optional field on `SheetViewModel` (`:199`):

```ts
/** Prepared-caster budget (2026-07-23). Present only when the actor has at
 *  least one preparable spell. `base` is a best-effort rules maximum; the PWA
 *  adds a persisted, player-set offset on top of it. */
spellPrep?: { prepared: number; base: number }
```

### Adapter (`packages/adapter-dnd5e/src/index.ts`)
Populate `spellPrep` on the view model when preparable spells exist: `prepared`
from the count above, `base` from the formula above.

### Web (`apps/web`)
- New `SpellPrepSummary.vue` component rendered at the **top of the Spells tab**
  (above the per-level sections), only when `sheet.spellPrep` is present.
- Displays **`Prepared {prepared} / {base + offset}`**.
- A compact `−` / `+` **offset stepper** adjusts a per-actor offset persisted in
  `localStorage` under `fc:prepoffset:<actorId>` (same try/catch-guarded pattern
  as the section-collapse state in `SectionList.vue:160`). Offset may be negative
  or positive; the displayed denominator is clamped to a floor of `0`.
- If `prepared` exceeds the displayed denominator (over-prepared), show the number
  in a subtle over-budget tint — display-only, never blocks toggling.
- The summary reflects the current prepared count; on an optimistic Prepare toggle
  it updates when the sheet re-renders from the reconciled snapshot (consistent
  with how the rest of the sheet already reconciles). No separate optimistic path.

The offset lives in the PWA (not the adapter) because it is player preference, not
game state, and must never round-trip to Foundry.

## Scope / non-goals

- **Not changing** the preparation mechanic, the `prepare` intent/relay path, or
  the per-row Prepare toggle placement.
- **Not enforcing** the prepared limit — the budget is informational; over-
  preparing is allowed (Foundry does not enforce it either).
- **Not adding** a per-level "show N unprepared" disclosure (deferred follow-up).
- **Not syncing** the offset across devices (per-device localStorage, matching the
  existing collapse-state precedent).
- The budget follows the existing preparable classification (see §3 "When it
  shows"); this spec does not re-classify which spells are preparable, so a
  spontaneous caster is untouched unless their data already marks spells
  preparable today.
- Cantrip sections are unaffected in behaviour.

## Affected files (summary)

| Area | File | Change |
|------|------|--------|
| Adapter — spell rows | `packages/adapter-dnd5e/src/index.ts` | drop `prepared` sub (`:1372`) + tag (`:1376`); sort each level prepared-first at `spellsByLevel` build (`:2650`); populate `spellPrep` |
| SDK types | `packages/adapter-sdk/src/index.ts` | optional `SheetViewModel.spellPrep` field |
| PWA — list | `apps/web/app/components/SectionList.vue` | dim rows whose Prepare toggle is off |
| PWA — summary | `apps/web/app/components/SpellPrepSummary.vue` (new) | budget line + persisted offset stepper |
| PWA — page | `apps/web/app/pages/actor/[id].vue` | render `SpellPrepSummary` atop the Spells tab when `spellPrep` present |

## Testing

Adapter unit tests (`packages/adapter-dnd5e/test/`, extend `spell-ux.test.ts`):
- A prepared leveled spell emits **no** `prepared` sub segment and **no**
  `prepared` tag, but still carries its Prepare toggle; `concentration` / `ritual`
  / `free use` tags and the `always prepared` sub are preserved.
- Each level's spells are ordered prepared/always-prepared before unprepared;
  same-group order is stable (by name/insertion).
- `spellPrep.prepared` counts only `isPreparableSpell` items with `prepared === 1`
  (excludes `prepared: 2` and cantrips); `spellPrep.base` matches the formula for
  the caster fixture; `spellPrep` is **absent** for an actor with no preparable
  spells (the martial fixture has no spells at all — the unambiguous case). If a
  known-caster fixture is captured, assert its classification explicitly rather
  than assuming.

Web verification (no unit harness in `apps/web` — `nuxt typecheck` + running
stack, per project convention):
- `nuxt typecheck` passes with the new field and component.
- In the stack: unprepared rows render dimmed and prepared rows do not; the
  summary shows atop the Spells tab for a prepared caster and is absent for a
  spontaneous caster; the offset stepper changes the denominator and survives a
  reload (localStorage).
