# Versatile Weapon Grip — Design (2026-07-23)

## Problem

Versatile weapons (longsword, battleaxe, quarterstaff…) deal a larger damage
die when wielded two-handed (longsword `1d8` → `1d10`). Today the app never
asks or tracks how a weapon is held:

- `weaponDamageFormula` (`packages/adapter-dnd5e/src/index.ts:1781`) reads only
  `system.damage.base` — the one-handed die. The versatile die is explicitly
  "Deliberately NOT modelled" (function header, `:1777`).
- `buildActions` emits one Attack row + one Damage row per equipped weapon
  (`:2019`–`:2025`); no handedness anywhere.
- The targeted-combat path was live-verified to auto-roll `1d8` even though the
  item exposes `attackModes: ["oneHanded","twoHanded"]`
  (`docs/combat-targeting-live-findings.md` Check 7).

Tracked as **M25, gap #7** in `docs/superpowers/specs/2026-07-19-ddb-parity-round2.md`.

## Decision

Model grip as a **persistent per-weapon toggle** (not a per-swing prompt, not
twin damage rows). Rationale confirmed with the user, and reinforced by the
architecture: in combat the attack and damage fire as a **single fused action**
(`use-on-targets`), so the grip must be known *before* the swing — a stored grip
is the only model that fits that path without adding a mid-combat prompt.

## 1. Data model & storage

- Grip is stored as a Foundry item flag: **`flags.unseen-servent.grip`**, value
  `"twoHanded"`. Absent (or `"oneHanded"`) means the default one-handed grip.
  - Same flag namespace the app already writes (`flags.unseen-servent.appliedBy`,
    `index.ts:1245`).
  - Written via the existing **`update-item`** relay endpoint — the same
    mechanism `prepare` (`index.ts:2409`) and `move` (`:2442`) already use. **No
    new relay endpoint.**
- The grip toggle applies **only to weapons with the `"ver"` property**. Any
  other weapon ignores the flag entirely.
- Grip affects the **damage die only** — never the attack bonus (RAW). The
  Attack button and its roll are untouched; only damage formulas and display
  labels change.
- Default is **one-handed**, matching the safe default the live test already
  assumes.

## 2. Damage resolution — two paths

The system has two damage paths that resolve the die differently. Both become
grip-aware, driven by the single stored grip flag.

### Combat / targeted (exact)
`use-on-targets` → `targetedUseScript` (`packages/foundry-client/src/index.ts`).
Foundry rolls the die itself. We pass dnd5e's attack-mode (`"twoHanded"` when the
weapon's grip flag is set) into `rollAttack`/`rollDamage`; Foundry produces the
correct `1d10`. This is precisely the follow-up recorded in Check 7. **Accurate**,
because Foundry owns the die.

### Standalone Dmg button (best-effort estimate)
`item.<id>.damage` → `weaponDamageFormula` (`index.ts:1781`), a client-built
`roll` formula. There is no relay damage-roll endpoint, so this stays
client-side. Grip resolution:

1. If `system.damage.versatile` is populated (`number` + `denomination` > 0), use it.
2. Otherwise **step the base die up one size** (`d4→d6→d8→d10→d12`).

Fallback #2 is required because the SRD longsword's `system.damage.versatile` is
**empty** (`denomination: 0`) in captured 5.3.3 data even though `"ver"` is set
(`packages/adapter-dnd5e/test/fixtures/martial-captured.json:2176`). One-step-up
is correct for every SRD versatile weapon (quarterstaff/spear d6→d8;
longsword/battleaxe/warhammer d8→d10). Documented best-effort, consistent with
the existing "client-side estimate, gaps noted" contract in the function header.

### Honest asymmetry (stated in UI copy / docs)
Combat swings are **exact** (Foundry rolls); the standalone Dmg button is a
**best-effort estimate**. This is already true today for the one-handed die — the
two-handed grip only extends the same estimate, it does not introduce a new class
of inaccuracy.

## 3. SDK + UI

### SDK (`packages/adapter-sdk/src/index.ts`)
- New action kind **`grip`** on `SheetActionKind` (`:238`), mirroring
  `equip`/`attune`.
- New optional state field on `ActionDescriptor` (`:262`):
  `grip?: "oneHanded" | "twoHanded"` (the intent carries the desired state, same
  shape as `equipped`/`attuned`).
- New optional **`sub?: string`** on `ActionDescriptor` so an attack row can show
  its active die (e.g. `"1d10 slashing · two-handed"`).
- New optional **`gripActionId?: string`** on `ListItem` (`:96`), rendered as a
  pill next to Equip — same pattern as `attuneActionId` (`:113`).
- `ActionIntent` (`:302`) gains a `grip` variant:
  `{ kind: 'grip'; actionId: string; grip: 'oneHanded' | 'twoHanded' }`.

### Adapter (`packages/adapter-dnd5e/src/index.ts`)
- `buildActions`: for a versatile equipped weapon, set the Attack descriptor's
  `sub` to the active-grip die + damage type + grip label. **Only versatile
  weapons get a sub-line**; non-versatile attack rows stay label + buttons.
- Inventory row builder: for a versatile weapon, emit `gripActionId =
  item.<id>.grip` and set the descriptor's `grip` to the current stored value.
- Intent switch: handle `case 'grip'` → `{ endpoint: 'update-item', itemId,
  data: { 'flags.unseen-servent.grip': <value> } }` (mirrors `prepare`/`move`).
- `weaponDamageFormula` reads the grip flag and applies §2 resolution.

### PWA
- **Inventory row** (`apps/web/app/components/SectionList.vue:85`): a `[1H|2H]`
  pill next to the Equip pill, driven by `gripActionId` / `grip` state (mirrors
  the attune pill).
- **Attack row** (`apps/web/app/components/SectionActions.vue`): render the
  descriptor's `sub` on the row's sub-line (the slot currently used only for
  "No spell slots left").

## 4. Shield conflict — allow with a hint

Wielding a versatile weapon two-handed while a shield is equipped is a RAW
conflict, but not enforced (Foundry does not enforce it either — grip stays a
free toggle).

- Detection: an equipped shield is an `equipment` item with
  `system.type.value === "shield"` and `system.equipped === true` (the `"shield"`
  type is already in `ARMOR_EQUIPMENT_TYPES`, `index.ts:217`). A
  `hasEquippedShield(actor)` helper mirrors `hasStealthDisadvantageArmor`
  (`:740`).
- When a weapon's grip is `"twoHanded"` **and** a shield is equipped, surface a
  subtle badge on the **inventory row** (via `ListItem.tags`, e.g.
  `"2H + shield"`) — right next to the grip pill, the moment the player sets the
  conflicting grip. Display-only; nothing is blocked.

## 5. Scope / non-goals

- **Not enforced:** the shield / off-hand-weapon vs two-handed conflict (hint
  only, §4).
- **Unchanged gaps** (already documented in `weaponDamageFormula`): weapon
  mastery bonus dice, Great Weapon Fighting, critical doubling on the client-side
  estimate.
- The grip pill shows on any versatile weapon in inventory, equipped or stowed
  (like the equip pill).
- No change to non-versatile weapons anywhere.

## Affected files (summary)

| Area | File | Change |
|------|------|--------|
| SDK types | `packages/adapter-sdk/src/index.ts` | `grip` kind, `ActionDescriptor.grip`/`.sub`, `ListItem.gripActionId`, `grip` intent |
| Adapter — actions | `packages/adapter-dnd5e/src/index.ts` | grip toggle rows, attack sub-line, `case 'grip'`, shield-hint tag |
| Adapter — damage | `packages/adapter-dnd5e/src/index.ts` | `weaponDamageFormula` grip resolution + die-step helper |
| Relay script | `packages/foundry-client/src/index.ts` | pass attack-mode to `rollAttack`/`rollDamage` in `targetedUseScript` |
| PWA inventory | `apps/web/app/components/SectionList.vue` | `[1H\|2H]` pill + conflict badge |
| PWA attacks | `apps/web/app/components/SectionActions.vue` | render attack `sub` line |

## Testing

- Adapter unit tests: grip flag read → correct die in `weaponDamageFormula`
  (1H base, 2H populated-versatile, 2H empty-versatile→step-up); `case 'grip'`
  produces the right `update-item` payload; versatile weapon emits `gripActionId`
  + attack `sub`; non-versatile weapon emits neither; shield-hint tag appears
  only on 2H + equipped shield.
- Relay-script generation test: `targetedUseScript` includes the attack-mode
  argument when grip is two-handed.
- Live E2E (extends Check 7): flip a longsword to 2H, targeted swing rolls
  `1d10`; standalone Dmg button shows `1d10`; flip back → `1d8`.
