# Buff spells apply as conditions (self-target) — design

Date: 2026-07-19 · Status: approved by user (chat) · Systems: dnd5e only
Root cause + live proof: `docs/M-buff-effects-findings.md` (read it first).

## Problem

Casting a self-buff spell (Shield, Mage Armor) from the app does nothing
visible: the relay's `use-spell` runs `activity.use()` headless, which posts
the chat card but **never applies the spell's Active Effect** to the actor
(no targeted token, no card click). Shield's own `system.attributes.ac.bonus
+5` effect never lands, so the app's (correct) AC readout never moves.

## Approach (user-approved, live-proven)

Make it "work like a condition" (Haste already does): after casting a
self-buff, the app copies the spell item's own Active Effect onto the caster
via the relay's plain `PUT /update` (embedded-effect upsert; `entity:write`
only, **no execute-js**). Then the effect shows as a condition badge
(`parseEffects`) AND derived AC updates (`enrich`→`stats.ac`) for free — both
live-verified (AC 11→16, badge present, `stats.ac`=16). Because Shield's
duration is combat-shaped and won't self-expire outside combat, **removal is
in scope for this first increment**: app-applied buffs are removable from the
badge, mirroring End Concentration.

Scope: **self-target only** (Shield always; Mage Armor on self — the common
case). A self/other target picker is a later increment. Manual AC modifier is
dropped.

## Detection (adapter, data-shape only — no rules engine)

A spell qualifies as a self-buff when its item carries an Active Effect that
is applied on use (`effects[]` entry with `transfer:false` and ≥1 `changes`)
and it is not a heal/damage effectType. `selfBuffEffect(actor, item)` returns
the payload to apply — `{ name, img?, changes, duration?, origin }` copied
verbatim from that effect, `origin` = `Actor.<actorId>.Item.<itemId>` — or
undefined. Verify Mage Armor's real shape during live-verify (it may set
`ac.calc:"mage"` rather than a flat bonus; copying its changes verbatim
handles either).

## Wire contract

### SDK (`adapter-sdk`)
- `Condition` gains optional `removeActionId?: string` — the badge renders a
  removal affordance only for conditions that carry it (app-applied buffs).
- `SheetActionKind` gains `'endeffect'` (remove an app-applied active effect).
- `ActionIntent` gains `{ kind: 'endeffect'; actionId: string }`.
- `EffectPayload` type: `{ name: string; img?: string; changes: Array<{ key: string; mode: number; value: string }>; duration?: Record<string, unknown>; origin?: string }`.
- `RelayAction` gains:
  - `{ endpoint: 'cast-and-apply-effect'; use: 'use-spell' | 'cast-at-slot'; itemId: string; slotKey?: string; effect: EffectPayload }`
  - `{ endpoint: 'remove-effect'; effectId: string }`

### adapter (dnd5e)
- `buildAction` cast: if `selfBuffEffect` present → `cast-and-apply-effect`
  (`use` = `use-spell` at base, `cast-at-slot` when upcast — compose with the
  existing slotLevel logic), carrying the effect payload. Else unchanged.
- `parseEffects`: an enabled effect flagged
  `flags.unseen-servent.appliedBy` becomes a Condition with
  `removeActionId: "effect.<_id>.remove"` (still also a normal badge).
- `buildActions`: emit an `endeffect` descriptor
  `{ id: "effect.<_id>.remove", kind: "endeffect", label: "End <name>" }`
  per app-applied effect.
- `buildAction` endeffect: `{ endpoint: 'remove-effect', effectId }` (parse
  `effect.<id>.remove`; validate id shape).

### foundry-client
- New `applyEffect(actorUuid, effect: EffectPayload & { _id: string; flags: … })`:
  `PUT /update?uuid=<actorUuid>` body `{ data: { effects: [ effect ] } }`
  (upsert-by-id create — live-proven). Errors surface via `request` as today.
- Removal reuses existing `deleteEntity(`Actor.<id>.ActiveEffect.<effectId>`)`
  (fromUuid resolves embedded AE uuids) — no new method.

### gateway
- `RelayPort.applyEffect(actorUuid, effect)`.
- Execution switch:
  - `cast-and-apply-effect`: activate first (`use-spell` via `useAbility`, or
    `castAtSlot` for upcast) inside the SAME try/catch the `use-and-roll` case
    uses (408 tolerance first, then `upcastUnavailable` for the cast-at-slot
    leg), THEN `applyEffect(Actor.<id>, effect)`. The gateway mints the AE
    `_id` (16-char alnum) and sets `flags['unseen-servent'].appliedBy = 'app'`
    — randomness lives here, not in the pure adapter.
  - `remove-effect`: `deleteEntity(`Actor.<id>.ActiveEffect.<action.effectId>`)`.
- `parseActionIntent`: add `endeffect` (actionId only).

### PWA
- Cast needs no new client logic — a self-buff cast already flows through
  `submitAction({kind:'cast',…})`; the adapter picks `cast-and-apply-effect`.
  Toast copy stays the generic cast confirmation.
- `ConditionBadges.vue`: render a × button on badges whose Condition has
  `removeActionId`; clicking emits `('action', removeActionId)`.
- `[id].vue`: pass conditions through (already does); handle `endeffect` in
  the action path (confirm dialog "End <name>?" → `submitAction({kind:
  'endeffect', actionId})`), mirroring `onEndConcentration`.

### mock gateway
Add a self-buff spell (Shield) to Sariel with an effect payload; a
`cast-and-apply-effect` handler that pushes a flagged condition (with
`removeActionId`) and updates the mock AC; `endeffect`/`remove-effect` removes
it and reverts AC. Keeps the whole flow drivable offline.

## Testing
- adapter: `selfBuffEffect` detection (positive Shield-shaped, negative
  heal/damage/no-effect/transfer:true); cast → `cast-and-apply-effect` at base
  and upcast; `parseEffects` sets `removeActionId` only for flagged effects;
  `endeffect` → `remove-effect`.
- gateway: `cast-and-apply-effect` calls activate then `applyEffect` (fake
  relay `applyEffectCalls`); `remove-effect` calls `deleteEntity` with the AE
  uuid; `endeffect` intent parse.
- foundry-client: `applyEffect` PUT shape (uuid in query, `{data:{effects:[…]}}`
  body, id+flag present).
- PWA: typecheck; live-verify drives the real flow.

## Live verify (before push)
On the stack: cast Shield from the app → AC 16, "Shield" badge with a ×;
tap × → AC 11, badge gone. Confirm Mage Armor's effect shape while there.

## Charter note
First feature that CREATES game state Foundry didn't derive. Justified:
Foundry cannot apply the effect headless, and we copy the world's own effect
verbatim (no invented rules content) — same philosophy as the hand-add-item
chain. The flag makes every app-applied effect identifiable and removable.

## Out of scope
Self/other target picker, non-self buffs, buffs without an Active Effect,
concentration interaction beyond what Foundry already tracks, non-dnd5e.
