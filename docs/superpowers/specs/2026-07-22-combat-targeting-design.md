# Combat targeting, turn flow & movement budget — design

**Date:** 2026-07-22
**Status:** approved (brainstormed with user; approach C chosen)

## Problem

Combat in the companion is watch-only. Players see the initiative carousel and
combatant list, but:

- Attacks/spells/items never resolve against a target. Damage today is a
  display roll plus a **manual HP delta** — players cannot know whether the
  monster took full or half damage (resistances/immunities are invisible to
  them and applied by hand).
- There is no way to end your turn from the phone; the GM must advance combat
  in Foundry even when a player is done.
- Movement has no per-turn budget — the Move sheet offers the full speed
  radius on every open.
- The dice FAB sits on top of the initiative carousel once combat starts.
- Displayed AC is stale when effects like Mage Armor are active (relay `/get`
  returns source docs; the fallback ignores Active Effects, and Mage Armor
  uses an `ac.calc` OVERRIDE, not a flat bonus).

## Guiding principle

**Foundry is the single source of truth for rules resolution.** Hit vs AC,
saving throws vs DC, resistance/immunity/vulnerability math, temp-HP ordering
— all of it happens inside Foundry (dnd5e system code) via one `/execute-js`
orchestration per action. The gateway validates and forwards; the PWA picks
targets and displays outcomes. No D&D rules are computed outside Foundry.

## Decisions (from brainstorm)

| Topic | Decision |
|---|---|
| Damage application | Auto-apply through Foundry's damage pipeline (resistances honored); no GM click |
| Damage roll | Rolled immediately in the same orchestration as the attack — one tap does attack → hit? → damage → apply. On a miss no damage is rolled. Separate Dmg button remains for the untargeted/out-of-combat flow |
| Save-based actions | Companion has Foundry auto-roll NPC saves, applies full/half per the activity |
| Multi-target | Supported — save spells (Fireball) can target multiple combatants, friends included. Attacks and heals are single-target in v1 |
| Turn control | "End turn" only on your own turn; GM keeps NPC turns in Foundry |
| Movement budget | Soft cap + Dash toggle; cells beyond remaining are shaded until Dash extends range; beyond dash-extended is blocked. Resets when your turn ends |
| Dice FAB | Slides up above the initiative carousel while combat is active |
| AC display | Fixed in this feature: prefer derived AC from `get-actor-details` |

## Scope

**In (6 features):**

- **F1 Targeted execution** — pick target(s) → attack/spell/item resolves in
  Foundry → damage/healing auto-applied with resistances.
- **F2 Multi-target picker** — combatant list picker; single for
  attacks/heals, multi for save spells.
- **F3 End turn** — button on your own turn → `combat.nextTurn()`,
  race-guarded.
- **F4 Movement budget** — per-turn soft cap + Dash; lazy reset by round key.
- **F5 Dice FAB** — repositioned above the carousel during combat.
- **F6 AC display** — derived AC from `get-actor-details` (Mage Armor & co.).

**Out:** AoE template placement on the map (Fireball targets are picked from
the combatant list, not by area), reactions/opportunity attacks, action
economy beyond the Dash toggle, budget persistence across gateway restarts.

## Architecture

### Relay layer (`packages/foundry-client`)

Two new methods, both `/execute-js` based, following the `castAtSlot` pattern
(constant script, JSON.stringify-only interpolation of validated ids, bounded
timeout, normalized errors).

**`useAbilityOnTargets(actorId, itemId, { targetTokenUuids, slotLevel? })`**
— the orchestration script. Inside Foundry it:

1. Resolves actor → item → first activity (existing `activationScript`
   pattern).
2. Sets `game.user.targets` to the chosen tokens (`token.setTarget(...)`,
   executing as the relay GM session user).
3. Runs `activity.use()` with dialogs skipped; captures the attack roll via
   the `dnd5e.rollAttackV2` hook.
4. **Attack activities:** compares the attack total vs each target's derived
   AC; nat 20 = critical hit, nat 1 = auto-miss. On hit, rolls damage with
   `isCritical` when crit.
5. **Save activities:** rolls each target's saving throw via the dnd5e API,
   compares vs the spell DC, resolves full/half per the activity's
   save-damage behavior.
6. **Apply:** snapshots target HP, calls dnd5e's `actor.applyDamage(...)`
   with *typed* damage (resistances/immunities/vulnerabilities and
   temp-HP-first resolve inside dnd5e), then diffs HP for the *actually
   applied* amount. Healing flows through the same pipeline.
7. Releases targets and returns a structured result:

```jsonc
{
  "attack": { "total": 19, "isCritical": false } | null,
  "targets": [
    { "tokenUuid": "...", "name": "Skeleton",
      "outcome": "hit" | "miss" | "save-failed" | "save-passed" | "gone",
      "save": { "total": 9, "dc": 14 } | null,
      "damage": { "rolled": [{ "type": "slashing", "value": 12 }],
                  "applied": 6 } }
  ]
}
```

`applied < rolled` is the player-visible "resistance was in play" signal.
Chat cards still land in Foundry — the GM keeps the full audit trail.

**`endCombatTurn(expectedCombatantId)`** — script checks
`game.combat.combatant?.id === expected` before calling `nextTurn()`; on
mismatch returns `{ advanced: false, reason: "not-your-turn" }`. A turn race
can never skip someone else's turn.

**Side-effect rule:** `useAbilityOnTargets` is **never auto-retried**. On
timeout/stall the player is told to check the Foundry chat before retrying —
damage may already have landed.

### Gateway (`apps/gateway`)

- **`EncounterCombatantView` gains `tokenUuid`.** The relay already sends
  `RelayCombatant.tokenUuid`; normalization currently drops it
  (`encounters.ts:468`). The target picker needs tokens. NPC HP secrecy
  unchanged (derived health tier only).
- **Action pipeline:** `ActionIntent` (adapter-sdk) gains optional
  `targetTokenUuids?: string[]` on attack/cast/use kinds. With targets,
  `buildAction` emits a new `RelayAction` endpoint **`use-on-targets`**;
  without, behavior is exactly today's (out-of-combat flow untouched). New
  case in the `app.ts` action switch calls `relay.useAbilityOnTargets(...)`
  and returns the normalized outcome **synchronously in the POST response**.
- **Targeting metadata:** the adapter annotates each action in the actions
  view with `targeting: { mode: 'single'|'multiple',
  kind: 'attack'|'save'|'heal' } | null`, derived from the activity
  (attack → single, save → multiple, heal → single). The PWA decides how to
  open the picker from this — no rules logic in the UI.
- **Turn route:** `POST /api/encounter/turn/end`, registered with the
  existing encounter routes (gated on `deps.encounters`). Auth: resolve
  player from invite token → active combatant's `actorId` must be in the
  player's `actorIds` → `relay.endCombatTurn(expectedCombatantId)`. Wrong
  player → 403; turn already advanced → 409 (PWA refreshes).
- **Movement budget** (in-memory, next to `EncounterManager`):
  - Spent distance keyed by `${combatId}:${round}:${combatantId}` — a new
    round is a new key, so budgets **reset lazily with no reset logic**. Map
    pruned on round change / combat end.
  - Each successful move POST during combat adds the path distance.
    `GET /api/actors/:id/movement` gains
    `{ inCombat, yourTurn, remainingFt, dashed }`.
  - **Dash:** `POST /api/actors/:id/movement/dash` — once per turn, adds
    speed to the budget, posts a chat note to Foundry ("<name> dashes") so
    the GM sees it.
  - **In combat, moving is only allowed on your own turn** (consistent with
    end-turn). Out of combat: unchanged.
  - Gateway restart mid-combat refills budgets (in-memory only) —
    acceptable under the soft-cap philosophy.
- **AC (F6):** request `ac` in the `get-actor-details` derived totals (same
  pattern as the initiative fix); `armorClass()` in adapter-dnd5e prefers the
  derived value; the equipped-armor fallback stays as last resort.

### Web / PWA (`apps/web`)

- **Target picker:** extend `TargetPickerSheet` with a combat mode — lists
  combatants (grouped friend/foe, health tier shown), returns token UUIDs,
  multi-select only when `targeting.mode === 'multiple'`. In combat, tapping
  Attack/Cast/Use on a targeting-capable action opens it; confirm executes.
- **Outcome card:** new sheet rendered from the action POST response. Per
  target: hit/miss or save result, damage rolled → applied, "resistant" hint
  when `applied < rolled`.
- **End turn:** button in/next to `InitiativeCarousel`, rendered only when
  the active combatant's actorId belongs to the viewed actor. Single tap, no
  confirmation.
- **Dice FAB:** when the carousel is visible (`showCarousel`), a modifier
  class transitions `bottom` so the FAB sits just above the carousel dock.
  `RollResultPill` / `ToastHost` share the same band — adjust if they
  collide too.
- **Move sheet:** budget chip ("15 / 30 ft"), Dash button, cells beyond
  remaining shaded and non-tappable until Dash extends the range; beyond
  dash-extended stays blocked.

## Error handling

- `useAbilityOnTargets` side-effecting → bounded timeout, **no auto-retry**;
  timeout message: "Timed out — check the Foundry chat before retrying."
- Target vanished between pick and execute → per-target try/catch in the
  script; that target reports `outcome: "gone"`, the rest proceed. Partial
  results are truthful; Foundry chat is the audit trail.
- End-turn race → 409; PWA refreshes encounter state silently.
- Actions without a resolvable activity/save fall back to the existing
  untargeted flow rather than erroring.

## Testing

- **foundry-client:** script-generation unit tests (ids JSON.stringified —
  injection safety), timeout bounding.
- **gateway:** `FakeRelay` gains both new methods; route tests for auth
  (wrong player can't end turn / can't move off-turn), turn-guard 409,
  outcome normalization, budget accumulation + lazy reset via fake combat
  hooks (`encounters.test.ts` pattern), dash once-per-turn.
- **adapter-dnd5e:** fixture tests for `buildAction` with targets and
  targeting-metadata derivation (captured caster/martial fixtures).
- **mock server (`apps/web/mock/server.mjs`):** outcome + budget fixtures
  for PWA dev parity.
- **Live E2E** (movement-style scripted live-check): attack hit/miss/crit vs
  a resistant monster (skeleton, bludgeoning vs slashing), Fireball
  multi-target with saves, healing an ally, end-turn, budget reset across
  rounds, Mage Armor AC display.

## Follow-ups

- **Versatile weapons (tracked):** 1H vs 2H grips deal different damage
  (longsword d8/d10). The orchestration must pick the damage formula matching
  the current equip/grip state (dnd5e attack modes) — live-verify, and expose
  a grip choice if dnd5e doesn't persist one. Relates to roll-fidelity
  attack-modes work (PR4).
- AoE template placement on the map (deferred out of scope).
- Budget persistence across gateway restarts (deliberately skipped).
