# Target buffs (self or another creature) — design

Date: 2026-07-19 · Status: approved by user (chat) · Systems: dnd5e only
Builds on: `docs/superpowers/specs/2026-07-19-buff-effects-as-conditions-design.md`
(self-buffs already apply the spell's own Active Effect to the caster).

## Problem

The shipped buff feature always applies a buff's effect to the **caster**.
Many buffs target another creature (Bless, Aid, Mage Armor, Shield of Faith).
The player needs to choose the target. The encounter tab already lists every
combatant (PCs + monsters) with a linked actor and already applies HP writes
to any combatant's actor, so it's the natural in-combat target surface; out of
combat there's no shared list, so a party roster stands in.

## Approved decisions

- **Out of combat → party roster picker** (all invited characters).
- **Only creature-targetable buffs open the picker.** Self-only buffs (Shield,
  whose activity target is `self`) keep auto-applying to the caster with no
  extra tap.
- **"Yourself" is pinned** at the top of every picker (one-tap self, works even
  when the caster isn't a combatant).
- **MVP limits:** the caster can't remove a buff placed on someone else (only
  the recipient can, from their own sheet); out-of-combat targets are party
  PCs only (no monsters — no roster for them outside an encounter).

## Targetability detection (adapter, data-shape only)

A cast is **targetable** when `selfBuffEffect(actor, item)` returns an effect
AND the spell is not self-only. Self-only = the buff activity's
`target.affects.type === 'self'` (today's `isSelfTargeted` reads only heal
activities; generalize it to read the same activity `selfBuffEffect` drew the
effect from). Shield → self-only → not targetable (auto-self, unchanged).
Bless/Aid/Mage Armor/Shield of Faith → targetable.

## Wire contract

### SDK (`adapter-sdk`)
- `ActionDescriptor.targetable?: boolean` — cast only: the PWA opens the target
  picker before casting.
- `ActionIntent` cast variant gains `targetActorId?: string` — the chosen
  target actor id; absent = the caster.
- `RelayAction` `cast-and-apply-effect` variant gains `targetActorId?: string`
  — the gateway applies the effect to that actor instead of the caster.

### adapter (dnd5e)
- `buildActions`: on a targetable buff cast descriptor set `targetable: true`.
- `buildAction` cast: thread `intent.targetActorId` into the
  `cast-and-apply-effect` result (`...(intent.targetActorId ? { targetActorId:
  intent.targetActorId } : {})`). Everything else (use-spell/cast-at-slot
  activation as the caster, slot resolution, effect payload) is unchanged —
  only the APPLY target changes.
- Generalize self-target detection: `isSelfTargeted` (or a small
  `buffTargetIsSelf`) reads the buff activity's `target.affects.type`.

### gateway
- **`GET /api/party`** (player auth): returns the roster the picker uses out of
  combat — `{ actors: [{ id, name?, img? }] }` for the union of every player's
  `actorIds` (the admin route already computes this union; reuse the
  best-effort, bounded name/img resolution it uses so a slow relay degrades to
  bare ids). Names/images come from `relay.getEntity` (cached where cheap).
- **Cast-and-apply-effect target resolution + permission:** the effect applies
  to `action.targetActorId ?? casterId`. A non-self `targetActorId` MUST be in
  the allowed set = current encounter combatants' actorIds ∪ the party-roster
  actorIds; otherwise `403 FORBIDDEN_RESOURCE`. This is the same cross-actor
  allowance the encounter HP route already grants, scoped to party+combat.
  Apply via `relay.applyEffect(`Actor.<targetActorId>`, effect)` (effect
  origin stays the caster's spell item — provenance).
- `parseActionIntent` cast: accept optional `targetActorId` (string,
  `^[A-Za-z0-9]{1,32}$`, else 422). Existing `slotLevel` parsing unchanged.

### PWA
- New **`TargetPickerSheet.vue`**: a bottom sheet listing targets, "Yourself"
  pinned first, then either the encounter combatants (when an encounter is
  active — reuse `CombatantList` row rendering / `EncounterCombatantView`) or
  the party roster (`GET /api/party`). Each row → an actor id (or "self").
- `[id].vue` cast flow, explicit order: when a cast descriptor has
  `targetable`, open the **target picker first**; after a target is chosen, if
  the descriptor also has `slotLevels` with length > 1, open the existing slot
  picker next; otherwise cast immediately. On the final choose →
  `submitAction({ kind: 'cast', actionId, ...(slotLevel when upcast picked),
  ...(targetActorId when not self) })`. "Yourself" → omit `targetActorId`
  (applies to the caster, today's path).
- Combatant rows without a linked `actorId` (unlinked tokens) can't receive a
  buff — render them disabled/greyed in the picker, never selectable.
- Fetch the party roster lazily (only when a targetable cast is tapped and no
  encounter is active). Cache per session.
- Toast: "Cast <spell> on <target name>".

### mock gateway
Add a targetable buff (e.g. Bless) to Sariel; a `/api/party` stub returning a
couple of roster actors; the cast handler honors `targetActorId` (applies the
mock condition to the chosen actor when it's the same mock actor, else just
acknowledges); so the picker + flow is drivable offline.

## Testing
- adapter: targetable flag set for creature-targetable buffs, absent for
  self-only (Shield) and non-buffs; `buildAction` threads `targetActorId` into
  cast-and-apply-effect; self-only buff still self-applies with no target.
- gateway: `GET /api/party` returns the union with resolved names (+ bounded
  degrade); cast-and-apply-effect applies to `targetActorId` when allowed;
  `403` for a targetActorId outside combat+party; `parseActionIntent`
  targetActorId validation; self (no targetActorId) still applies to caster.
- foundry-client: unchanged (`applyEffect` already takes any actor uuid).
- PWA: typecheck; live-verify drives the picker.

## Live verify (before push)
In an encounter: cast Bless on another PC → the effect lands on their sheet
(badge + bonus); on a monster → applied in Foundry. Out of combat: the party
roster picker appears; cast on a party member. "Yourself" still works. Confirm
a targetActorId outside the party is refused.

## Out of scope
Removing a buff you placed on someone else (recipient removes it); monster
targets out of combat; concentration/duration modeling beyond Foundry's own;
area/multi-target buffs (one target per cast); non-dnd5e.
