# Buff-spell active effects over the bridge — findings (2026-07-19)

Live-verified against the running stack (Foundry v14.364, dnd5e 5.3.3,
module/relay 3.4.1, world Vareon), actor Morgrim Ashmantle
(`Actor.FMuwT5NOXsNQF0gq`) via read-only + self-reverting `execute-js` probes.
World left exactly as found.

## Symptom
Casting **Shield** from the app does not raise AC by +5; casting **Mage
Armor** has no visible effect and offers no self/target choice. User report
2026-07-19.

## Root cause — CONFIRMED
The relay's `use-spell` runs dnd5e's `activity.use({}, {configure:false}, {})`.
Headless (no token selected/targeted, no chat-card "Apply Effect" click),
this **posts the chat card but never applies the item's Active Effect to the
actor.** Evidence:

- Shield's item effect is exactly what we'd want:
  `changes: [{ key: "system.attributes.ac.bonus", mode: 2 (ADD), value: "+5" }]`,
  `transfer: false`, `duration: { value: 6s, expiry: "turnStart" }`.
- Before cast: `ac.value 11`, `ac.bonus 0`, no Shield effect on the actor.
- After `activity.use()` (no error): `ac.value 11`, `ac.bonus 0`,
  `activeEffectsOnActor: []` — **nothing applied, nothing to revert.**

So it is NOT a duration/encounter issue (the effect never lands at all) and
NOT an app-refresh issue (the gateway already re-fetches + enrich merges
`stats.ac` after every action — it faithfully shows an AC that never changed).
The app's AC path is correct; the effect application upstream is the gap.

## Design direction (user-approved intent: "make it work like a condition")
The app already surfaces `actor.effects` as condition badges + concentration
(`parseEffects`) and shows derived AC (`enrich` → `stats.ac`). If a buff's
Active Effect were actually ON the actor, both would "just work" — Shield
would show as a badge AND AC would read 16. So the fix is: **after casting a
buff spell that carries a self-applicable Active Effect, explicitly apply that
effect to the caster** (Foundry won't, headless).

### Mechanism — DECIDED + LIVE-PROVEN (2026-07-19)
**Relay `PUT /update` with an embedded-effect upsert** — the relay's entity
update handler upserts embedded docs by `_id`, so posting
`data: { effects: [ ae ] }` to `/update?uuid=Actor.<id>` CREATES the effect.
No execute-js dependency; needs only `entity:write` (always minted), so buff
apply works on every install regardless of the "Allow Execute JS" setting.

Two live self-reverting probes confirmed the whole chain:
1. `createEmbeddedDocuments` of a Shield-copied AE → `ac.value` 11→16,
   `ac.bonus` 5, effect present (→ badge); delete → 11.
2. **Relay `/update`** with `{data:{effects:[{_id,name,changes:[{key:
   "system.attributes.ac.bonus",mode:2,value:"+5"}],flags:{unseen-servent:
   {appliedBy}}}]}}` → `get-actor-details stats.ac` (the app's own AC source)
   returned **16**; cleanup via delete → 11.

So the build: on a self-buff cast, after the normal `use-spell` activation,
PUT-update the actor with an effect copied from the spell item's own AE
(generated `_id`, `origin` = spell uuid, flag `flags.unseen-servent.appliedBy`
so it's findable). The next sheet re-fetch shows the badge (`parseEffects`) and
AC 16 (`enrich`→`stats.ac`) for free. Removal = delete the flagged effect via
an "End <buff>" action mirroring End Concentration.

Decisions (user-approved 2026-07-19): auto-apply as a condition (not a manual
AC modifier), **self-target only** first (a self/other picker is a later
increment). Manual "tap AC + modifier" is dropped unless a real need appears.

### Open sub-questions for the build (for the plan/live-verify)
- **Which spells qualify?** A spell whose item (or activity) carries an AE
  with `transfer:false` and at least one change, cast at self. Need to detect
  this in the adapter without a rules engine (data-shape only).
- **Cast flow shape.** Pressing Cast on a self-buff should do BOTH: the normal
  `use-spell` (consume slot, post card) AND the effect PUT-update — model as a
  new RelayAction (e.g. `cast-and-apply-effect`) or extend `use-and-roll`'s
  activate-then-do shape. Upcast (cast-at-slot) + buff-apply must compose.
- **Duration:** Shield's `expiry:"turnStart"` is combat-shaped; outside combat
  it simply persists (worldTime doesn't advance per turn). Acceptable — the
  player (or GM) drops it; we already have an effect-removal path idea.
- **Removal:** surface a way to end an app-applied buff (like End
  Concentration) — delete the flagged effect.
- **Mage Armor vs Shield:** Mage Armor is `system.attributes.ac.calc:"mage"`
  or a flat bonus depending on import; verify its effect shape before assuming
  it matches Shield's `ac.bonus +5`.

## Live confirmation of the built feature (2026-07-19, self-reverting probes)
- Real data is MIXED on `disabled`: Morgrim's Mage Armor/Shield effects are
  `disabled:false`; the caster fixture's Shield of Faith/Bane are
  `disabled:true`. → validated dropping the `disabled` guard in `selfBuffEffect`
  (MF-1): keeping it would have no-op'd the disabled:true buffs.
- **Shield**: `changes:[{key:'system.attributes.ac.bonus',mode:2,value:'+5'}]`;
  applying it → AC 11→16, badge shown, delete → 11.
- **Mage Armor**: `changes:[{key:'system.attributes.ac.calc',mode:5,value:
  'mage'}]` (an OVERRIDE, not a flat bonus); applying the copied effect →
  AC 11→14, "Mage Armor" badge, delete → 11. Verbatim copy handles both
  shapes — no special-casing needed.
- Save-gated debuffs (Bane) correctly excluded by MF-2's save-activity guard.
- REMAINING (full e2e through the deployed PWA→gateway→relay): pending a
  deploy of the branch — the underlying Foundry mechanism is proven for both
  Shield and Mage Armor; the app path is code-reviewed (per-task + adversarial
  whole-branch + fix wave + re-review, all clean).

## Charter note
This is the first place the app would CREATE game state Foundry didn't derive
on its own. Justified: Foundry genuinely cannot apply the effect headless, and
we copy the world's own effect verbatim (no invented rules content). Same
philosophy as the existing hand-add-item chain.
