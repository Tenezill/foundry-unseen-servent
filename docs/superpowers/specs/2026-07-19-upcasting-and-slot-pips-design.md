# Upcasting via execute-js + slot pips on level headers — design

Date: 2026-07-19 · Status: approved by user (chat) · Systems: dnd5e only

Two features, shared surfaces:

1. **Upcasting** — cast a leveled spell using a higher-level slot, with
   Foundry (not the app) consuming the right slot and scaling its rules.
2. **Slot pips** — remaining/max spell slots rendered as boxes on the right
   side of every per-level spell header, so the player always sees what is
   left at each level.

## Background / constraint

The relay module's `use-spell` (every released version through 3.4.1) calls
dnd5e's `activity.use({}, { configure: false }, {})` with **no slot option**
— it always consumes the spell's base-level slot (M6 finding, re-verified
against the module source 2026-07-19). True upcasting therefore cannot ride
`use-spell`. The module does expose **`execute-js`** (utility router), gated
behind two module settings: "Allow Execute JS" (off by default) and a
minimum user role (default GM). The relay's headless GM session satisfies
the role gate; the GM must flip the allow setting once.

Decision (user-approved): use `execute-js` with a **fixed script template**
for upcasts only; base-level casts keep today's `use-spell` path unchanged.
Rejected alternatives: slot-swap emulation (wrong chat-card level, GM-side
damage unscaled, slot-count desync risk on mid-flow failure) and waiting on
an upstream module PR (timeline not ours; can still be filed as follow-up).

## Upcasting

### Descriptor semantics (`ActionDescriptor.slotLevels`, adapter-sdk)

Upgraded, remaining backward-compatible with the PWA's existing checks:

- **absent** — directly castable, no picker. Only cantrips and pact-method
  spells (see below).
- Every other leveled spell carries the array: the levels the actor can pay
  for **right now** — each L in `base..9` with `spells.spellL.value > 0`.
  Length 0 → disabled (unchanged); length 1 → direct cast at that level;
  length > 1 → the PWA opens the picker.

Pact magic is excluded from the picker: dnd5e casts `method: 'pact'` spells
at pact level automatically (correct scaling included), and pact slots have
no upcast concept. Pure warlocks keep the pickerless direct cast.

### PWA

- `ActionSheet.vue` already renders a "Cast at Nth level" button per
  `slotLevels` entry (survived the M6 base-only simplification); extend the
  label with remaining-slot counts ("Cast at 4th level · 1 left") fed from
  the sheet's `slots.N` resources.
- `[id].vue` `onCombatAction` currently short-circuits `slotLevels.length
  === 0` to disabled and otherwise direct-casts; new rule as above
  (>1 → sheet, 1 → direct with that `slotLevel`).
- **Cast-level memory** (same pattern as the nat-20 crit arm): remember the
  last cast level per spell id; the companion `spell.<id>.damage` intent
  carries it as `slotLevel` so the display damage roll scales. Consumed on
  the damage roll; overwritten by the next cast.

### Gateway + foundry-client

- New `RelayAction` variant `{ endpoint: 'cast-at-slot', itemId, slotKey }`
  with `slotKey` matching `^spell[2-9]$`.
- `foundry-client` gains `castAtSlot(actorUuid, itemUuid, slotKey)` which
  POSTs `execute-js` with a **constant script template**; only three
  values are interpolated, each validated and JSON.stringify-quoted:
  actor id and item id (`^[A-Za-z0-9]{1,32}$`), slot key (regex above).
  The script resolves the item's first activity and runs
  `activity.use({ consume: { spellSlot: true }, spell: { slot } },
  { configure: false }, {})`; for attack-type activities it also captures
  the attack roll via `dnd5e.rollAttackV2` (same hook the module's own
  use-spell handler uses) and returns it, so the PWA's roll pill and crit
  arming keep working on upcasts. The phone can never supply script text —
  the intent carries only `slotLevel`, allow-listed against the descriptor.
- Error mapping: the module's "execute-js is disabled …" error becomes a
  422 INVALID_INTENT whose message names the module setting; the PWA toast
  surfaces that message instead of the generic one. Base casts never touch
  execute-js and are unaffected when the setting is off.

### Adapter (dnd5e) — cast + scaled display formulas

- `buildActions`: populate `slotLevels` per the semantics above (needs the
  enriched slot values, already present).
- `buildAction` cast: validate `intent.slotLevel` ∈ descriptor.slotLevels;
  base level → `use-spell` (today's action, unchanged); higher →
  `cast-at-slot` with `spell${slotLevel}`.
- **Display scaling** in `itemDamageFormula`/`healFormula` (the app-side
  display rolls only — Foundry's own card already scales): a new optional
  `castLevel` scales each part by dnd5e 5.x part scaling data
  (`damage.parts[].scaling` / `healing.scaling`: `{ mode, number,
  formula }`): mode `'whole'` adds `number ?? 0` (dnd5e's own scaledFormula
  fallback) dice per level above base; mode `'half'` the same per two
  levels; unknown modes
  fall back to the unscaled base formula (documented gap, same honesty as
  the existing formula helpers). Crit doubling composes **after** scaling.
- **Cantrip character-level scaling** (pre-existing gap, fixed here since
  the scaling code now exists): display damage for cantrips gains the
  dnd5e tier multiplier (levels 5/11/17 → ×2/×3/×4 dice). Pact-method
  leveled spells scale to pact level.

### Live verification step (before wiring, M-findings habit)

Verify against the user's stack (dnd5e 5.3.3 / Foundry v13) via a manual
`execute-js` call: the exact usage-config shape (`spell.slot` key name,
slot-key string format), that the chat card shows the chosen level, that
the correct slot decrements, and the attack-roll capture. Record in
`docs/M-findings` style. If the shape differs, adjust the template before
anything ships.

## Slot pips on level headers

- **Data**: `ResourceDescriptor` (adapter-sdk) gains optional `level?:
  number` — "the spell level this slot pool casts at". dnd5e sets it on
  `slots.N` (= N) and `slots.pact` (= derived pact level, present after
  enrich; omitted when unknown).
- **Actions tab** (`SectionActions.vue`): the level-header row becomes
  flex; right side renders pips — filled boxes for remaining, hollow for
  spent (`value`/`max` from the matching `slots.N` resource), display-only,
  refreshed by the normal post-action sheet echo. Pact pips render in a
  visually distinct style on **every** header of level ≤ pact level (the
  pool is shared; for a warlock that IS the per-level answer). A pool with
  `max > 8` falls back to "2/4" text (defensive; 5e never exceeds 4).
- **Spells tab** (`SectionList.vue` per-level sections): same pips on the
  section headers, same data path.
- Cantrip headers show no pips (no slots).

## Mock gateway

`mock/server.mjs` mirrors the new behavior so everything is drivable
offline: populated `slotLevels` on Sariel's leveled spells, a `slotLevel`-
aware cast handler that decrements the chosen slot and scales the mock
damage, and `level` on the slot resources for the pips.

## Testing

- **adapter-dnd5e**: slotLevels population (multiple payable levels, single
  level, drained, pact-only); cast intent → use-spell at base vs
  cast-at-slot above base; slotLevel not in descriptor → INVALID; scaling
  math for damage/heal (whole + fallback modes), cantrip tiers, crit ×
  scaling composition; `slots.*` resources carry `level`.
- **gateway**: cast-at-slot route calls the new client method with
  validated args; execute-js-disabled error → 422 with the setting name;
  fake relay grows `castAtSlotCalls`.
- **foundry-client**: script template interpolation is quoted/validated;
  bad ids/slot keys throw before any network call.
- **PWA**: manual verification against the mock (picker, pips, upcast
  damage memory), per the project's e2e-via-stack convention.

## Docs / ops impact

- HOSTING/runbook: one-time GM step — enable "Allow Execute JS" in the
  foundry-rest-api module settings; upcasting degrades to a clear 422
  toast when off, base casting unaffected.
- Follow-up (out of scope): upstream PR adding native slot-level support
  to the module's use-spell; when released and pinned, `cast-at-slot` can
  drop execute-js without any PWA change.

## Out of scope

- Upcasting via pact slots (no such rule), ritual casting UX, spending
  slots by tapping the pips (display-only per user decision), non-dnd5e
  systems.
