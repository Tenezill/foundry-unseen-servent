# Advantage/Disadvantage indicators & d20 roll fidelity

Date: 2026-07-20
Status: Design (approved in brainstorming; pending written-spec review)

## Summary

Four related improvements to how the companion presents and rolls d20 checks,
all sharing one theme — **faithfully mirror what Foundry/dnd5e actually
computes, and surface roll context without deciding the roll for the player**:

1. **Passive advantage/disadvantage indicators** on skill, ability-check, and
   saving-throw rows (a small green **A** die / red **D** die), display-only.
2. **Advantage/disadvantage on attack rolls**, via the existing execute-JS path.
3. **Initiative & skill total fidelity** — read Foundry's derived totals so
   feat/effect bonuses (e.g. Temporal Awareness "add INT to initiative") are
   reflected, instead of recomputing from a single ability.
4. **Foundry text-enricher resolution** in descriptions, so tokens like
   `&Reference[inv]{Investigation}` render as readable text instead of leaking
   raw source.

Guiding principle for (1): the indicator is **informational only**. It never
auto-applies advantage/disadvantage to the roll — other effects can flip the
net result, so the player still explicitly taps Roll / Advantage / Disadvantage.
The badge tells them *why* they might choose one.

## Non-goals

- Auto-resolving the *net* advantage state (5e cancellation). When both an
  advantage and a disadvantage source are present we show **both** badges and
  let the player decide (see Feature 1).
- Server-side (real Foundry) enrichment of descriptions. Feature 4 is a
  best-effort client-side token transform, not a full enricher.
- Reworking the check/save roll path (it already builds `2d20kh1`/`2d20kl1`
  formulas and works today).

---

## Feature 1 — Passive adv/disadv indicators

### Detection (adapter)

New pure helper in `packages/adapter-dnd5e/src/index.ts`:

```
rollBias(actor, kind: 'skill' | 'check' | 'save', id): { advantage: boolean; disadvantage: boolean }
```

`advantage` and `disadvantage` are independent booleans — both may be true.
Sources OR'd together:

- **Effect/feat flags** — `flags.dnd5e.advantage.*` and `flags.dnd5e.disadvantage.*`:
  - always check `.all`
  - `kind==='skill'` → `.skill.all`, `.skill.<id>`
  - `kind==='check'` → `.ability.all`, `.ability.check.all`, `.ability.check.<id>`
  - `kind==='save'`  → `.ability.all`, `.ability.save.all`, `.ability.save.<id>`
  - A flag counts as present when its value is truthy (Foundry writes `"1"`/`true`).
- **Equipped-armor stealth** — for `kind==='skill' && id==='ste'` only: any
  `actor.items` entry with `system.equipped === true` and `system.properties`
  including `'stealthDisadvantage'` → `disadvantage = true`.
- **Manual per-roll override** — `system.skills.<id>.roll.mode` for skills
  (`1` → advantage, `-1` → disadvantage; already read by `passiveStats`).
  Best-effort `system.abilities.<id>.check.roll.mode` / `.save.roll.mode` for
  checks/saves *if the field is present* (guard for absence).

Applied to: the 18 skills, the 6 ability checks, and the 6 ability saves.

### SDK + view model

- Extend the `Stat` type (`packages/adapter-sdk/src/index.ts`) with optional
  `advantage?: boolean` and `disadvantage?: boolean`. Absent = no badge
  (backward compatible; existing Stats unaffected).
- `skillStats`, and the ability-check / save stat builders, call `rollBias`
  and set the two fields when true.

### Rendering (web)

- `apps/web/app/components/SectionStats.vue`: in the card sub-line, after the
  existing `sub` text, append badge glyph(s): a small hex-die containing a
  letter — green **A** when `stat.advantage`, red **D** when `stat.disadvantage`
  (both shown when both true). Matches the approved mock:
  `DEX · ● proficient · ⬡D`.
- New `.badge-adv` (green) / `.badge-dis` (red) styles; accessible `title`/
  `aria-label` ("Advantage" / "Disadvantage").

---

## Feature 2 — Attack advantage/disadvantage (execute-JS, Foundry-native)

### Why execute-JS

The current attack path emits `{ endpoint: 'use-item' }`, which the relay
module runs as `rollAttack({}, {configure:false}, {})` — no advantage field
anywhere in the gateway payload, `useAbility`, or the pinned module handler.
The relay module cannot pass advantage through `use-item` without patching it.

We already own an execute-JS path (`castAtSlot` in
`packages/foundry-client/src/index.ts`, used for upcasting) and it requires the
"Allow Execute JS" world setting, which is already enabled. dnd5e's
`rollAttack(config, dialog, message)` accepts `{ advantage: true }` /
`{ disadvantage: true }` in its config, so a companion-owned script yields a
fully native attack roll (situational modifiers, ammo/consumption, crit
detection intact).

### Changes

- Intent type: add `mode?: 'advantage' | 'disadvantage'` to the `attack`
  variant of `ActionIntent` (`packages/adapter-sdk/src/index.ts`).
- UI: `apps/web/app/pages/actor/[id].vue` `onAction` — for `kind === 'attack'`,
  open the `ActionSheet` (as checks/saves do) instead of firing immediately.
  `ActionSheet.vue` — extend the Roll / Advantage / Disadvantage button block
  and `roll()` to accept `kind === 'attack'`.
- Adapter `buildAction` `case 'attack'`: when a `mode` is present, emit an
  execute-JS action that performs the item's attack with the corresponding
  `rollAttack` config; a plain Roll (no mode) keeps today's `use-item` behavior.
- Foundry client: a helper (mirroring `castAtSlot`) that runs the attack script
  with the chosen mode.

### Risk / spike (first task of implementation)

Confirm against the live world that the execute-JS attack still triggers item
consumption (ammo/limited uses) the way `use-item` does, and that crit handling
is preserved. If consumption differs, adjust the script to `item.use(...)` with
the attack config rather than a bare `rollAttack`. **Do not finalize the script
shape until this is verified live.**

### Defined fallback

If the spike shows the execute-JS attack cannot cleanly preserve consumption
and crit, fall back to the **companion-built formula** path (no execute-JS):
emit `{ endpoint: 'roll', formula: d20Formula(attackBonus, mode), flavor:
'<weapon> — Attack' }` on the generic `/roll` route, computing the to-hit
bonus in the adapter (ability mod + proficiency + weapon/enchant bonus) — the
same trade-off already accepted for the `damage` case. This decouples from
Foundry's item use (no ammo/slot consumption, no auto-crit) but reliably gives
the chosen advantage/disadvantage. The plan's first task decides between native
and fallback based on the spike result; everything downstream (intent `mode`,
`ActionSheet` buttons, `onAction` opening the sheet) is identical either way,
so the UI work is not blocked on the spike.

---

## Feature 3 — Initiative & skill total fidelity

### Root cause

The relay's plain `/get` serializes source data, not derived totals (documented
in `packages/adapter-dnd5e/test/fixtures/README.md`). So `attributes.init.total`
and `skills.<id>.total` are absent, and `initiative()` / `skillInfo()` fall back
to recomputing from a single ability (+ static bonus / proficiency) — which
misses feat/active-effect bonuses like Temporal Awareness (adds INT mod to
initiative).

### The data is already available

The relay's `get-actor-details` handler already returns, keyed off the requested
`details` array:

- `details:["stats"]` → `stats.initBonus = system.attributes.init.total ?? dex.mod`
  (the **derived** initiative total, already computed with effects).
- `details:["skills"]` → `skills.<id>.{ total, mod, value, passive }`.
- `details:["abilities"]` → `abilities.<id>.{ mod, save, proficient }`.

`enrich` already calls `getSystemDetails` for `["spells","stats"]` and folds AC
and encumbrance from `stats`. We extend it — **no module patch, no execute-JS**.

### Changes (adapter `enrich`, `packages/adapter-dnd5e/src/index.ts`)

- Request `"skills"` and `"abilities"` in addition to the current keys
  (`"stats"` always; `"spells"` when caster).
- Fold derived data into the actor `system` (same merge pattern already used):
  - `stats.initBonus` → `system.attributes.init.total`
  - `skills.<id>.total` (+ `mod`, `passive`) → `system.skills.<id>.total`
  - `abilities.<id>.mod` / `.save.value` → `system.abilities.<id>.mod` /
    `.save.value` (so ability checks/saves also reflect derived bonuses).
- `initiative()` and `skillInfo()` already prefer the derived totals, so they
  light up automatically. Keep their DEX/recompute fallbacks for when the relay
  is unavailable (enrich failure returns the unenriched actor).

---

## Feature 4 — Foundry enricher resolution in descriptions

### Problem

Feat/spell descriptions render through `DetailDialog.vue` via
`sanitizeHtml` (`apps/web/app/utils/sanitizeHtml.ts`), which strips executable
HTML but leaves Foundry enricher tokens untouched, so a description shows raw
`&Reference[inv]{Investigation}` (observed on "Warder's Intuition").

### Change

New pure util `apps/web/app/utils/resolveEnrichers.ts` — a best-effort text
transform applied **before/with** `sanitizeHtml` wherever world description HTML
is rendered (`DetailDialog.vue`, `LibrarySearch.vue` preview). Handles the
common dnd5e/Foundry tokens, preferring the author-supplied label:

- `&Reference[key]{Label}` → `Label` (fallback: prettified `key`)
- `@UUID[...]{Label}` → `Label`
- `@Check[...]{Label}` / `@Save`/`@Attack`/`@Damage`/`@Heal[...]{Label}` → `Label`
  (fallback: a readable rendering of the token's parameters)
- `[[/r ...]]{Label}` / `[[/roll ...]]` / `[[...]]` → `Label` or the formula

Unmatched/unknown tokens are left as-is rather than mangled. The transform is
conservative: it only rewrites recognized token shapes.

---

## Testing

- **Feature 1 (`rollBias`):** unit tests in the adapter.
  - `martial-captured.json` already equips Chain Mail (`stealthDisadvantage`) →
    assert Stealth shows disadvantage with no new fixture.
  - Add one small synthetic fixture carrying
    `flags.dnd5e.advantage.skill.acr`, `flags.dnd5e.disadvantage.skill.ste`,
    `flags.dnd5e.advantage.ability.save.wis`, and a skill with both an advantage
    flag and armor-stealth to cover the both-badges case.
- **Feature 2 (attack):** unit-test that `buildAction` emits a mode-carrying
  execute-JS action for advantage/disadvantage and leaves the plain path
  unchanged; intent-validation rejects an unknown mode. Live spike (above)
  verifies consumption/crit before merge.
- **Feature 3 (enrich):** unit-test that with a fake `getSystemDetails`
  returning `stats.initBonus`, `skills.<id>.total`, and `abilities.<id>.mod`,
  the enriched actor exposes `attributes.init.total` / `skills.<id>.total` /
  `abilities.<id>.mod`, and that `initiative()` / `skillInfo()` return the
  derived values. Gateway test: the details request now includes `skills` and
  `abilities`.
- **Feature 4 (`resolveEnrichers`):** unit tests covering each token shape,
  the "Warder's Intuition" `&Reference[inv]{Investigation}` case, label vs.
  fallback, and that unknown tokens pass through untouched.
- Full `packages/adapter-dnd5e`, `apps/gateway`, and `apps/web` suites +
  typecheck green before completion.

## Delivery / decomposition

Shipped as **four independent PRs**, each its own branch, plan, and merge — no
cross-dependencies, so the safe wins land without waiting on the risky one.
Recommended order (safest / highest-value first):

1. **Feature 3 — initiative & skill fidelity.** Safe, no new deps, fixes a
   visible correctness bug (Temporal Awareness). Ship first.
2. **Feature 1 — adv/disadv indicators.** Display-only, no new deps.
3. **Feature 4 — enricher resolution.** Self-contained web util.
4. **Feature 2 — attack adv/disadv.** Last, because of the execute-JS spike;
   the defined fallback keeps it from getting stuck.

Each PR gets its own implementation plan (via writing-plans) executed with
subagent-driven development, verified independently.

## Rollout

Feature branch off `main`; standard verification; merge to `main` for redeploy
(deploy performed by the user / on explicit authorization). Features 1, 3, 4
carry no new relay scope. Feature 2 depends on the already-enabled
"Allow Execute JS" world setting.
