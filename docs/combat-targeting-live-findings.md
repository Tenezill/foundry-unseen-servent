# Combat targeting — live-check findings (2026-07-22)

Stack: relay 3.4.1 (Go binary) + Foundry **14.364** + dnd5e **5.3.3**, dev compose.
Verified end-to-end via `apps/gateway/e2e/live-combat-targeting.mjs` — **83/83 checks**
against a live world (Morthos the Tiefling Sorcerer + a slashing/piercing-resistant
"E2E Skeleton" + Akra the ally, real combat running on the active scene). The script
boots the real gateway (`buildApp` + `EncounterManager` over `FoundryRelayClient`) in
process and drives the `/api/actors/:id/actions`, `/api/encounter*`, and movement routes
exactly as the PWA would.

## Headline: `dnd5e.dice.aggregateDamageRolls` does not exist in dnd5e 5.3.3 (fixed)

The one API assumption the design flagged as "not verifiable offline" was wrong.
`targetedUseScript` (packages/foundry-client/src/index.ts) built its damage parts with:

```js
const agg = dnd5e.dice.aggregateDamageRolls(dmgRolls, { respectProperties: true });
damages = agg.map((r) => ({ value: r.total, type: r.options.type, properties: … }));
```

Live-probed, **`dnd5e.dice` is an empty object on 5.3.3** — `aggregateDamageRolls` and
`DamageRoll` are both `undefined`. Every damage application therefore threw
`Cannot read properties of undefined (reading 'aggregateDamageRolls')`, surfacing to the
player as a bare **502**. (Early test runs masked this: randomized dice made the sample
attacks *miss*, and a miss never reaches the damage path.)

**Fix (this branch):** map the `rollDamage()` rolls straight to `applyDamage` parts — no
helper needed. Each returned Roll already carries its `total`, `options.type`, and
`options.properties`, and `actor.applyDamage([{value,type,properties}], {multiplier})`
accepts that array directly (resistances/immunities/vulnerabilities still resolved inside
dnd5e).

```js
damages = dmgRolls.map((r) => ({ value: r.total, type: r.options?.type, properties: new Set(r.options?.properties ?? []) }));
```

Unit test added (`packages/foundry-client/test/client.test.ts`): the generated script must
never reference `aggregateDamageRolls` and must map `dmgRolls`. After the fix, every damage
check went green.

## Per-check results

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| 0 | tokenUuid format | **PASS** | `GET /encounters` combatants carry full `Scene.76dw….Token.…` uuids (REST + gateway view). No `normalizeTokenUuid` change needed. |
| 1 | attack hit + resistance | **PASS (after fix)** | slashing longsword hit; skeleton HP dropped by `applied = floor(rolled/2)` — slashing resistance halves. |
| 2 | attack miss | **PASS** | forced d20=2 → `miss`, no damage entry, HP unchanged, no damage roll in chat. |
| 3 | crit | **PASS** | forced d20=20 → `attack.isCritical:true`, chat damage roll shows **2d8** (doubled dice); HP dropped by `floor(rolled/2)` (still resisted). |
| 4 | save spell, multi-target + friendly fire | **PASS (after fix)** | Fireball at skeleton **and Akra**; both `save-passed` → half (fire unresisted, `applied=floor(rolled/2)`), per-target save totals+DC in chat, HP deltas match, ally really takes friendly fire. Acid Splash (none-on-save) both `save-failed` → full. |
| 5 | heal | **PASS** | Cure Wounds on the damaged ally → HP went **UP** by `applied`, 1st-level slot −1. **No heal-sign flip needed** — `applyDamage(damages, {multiplier:1})` heals correctly on 5.3.3 (the `type:'healing'` roll drives HP up). |
| 6 | upcast slot consumption | **PASS** | Fireball at `slotLevel:4` → 4th-level slot −1, 3rd-level untouched, damage rolled+applied. |
| 7 | versatile weapon (record only) | **RECORDED** | see below. |
| 8 | end turn | **PASS** | stale press after a GM advance → 403/409 (never skips a combatant); own-turn press advances Foundry's tracker; off-turn press → 403. |
| 9 | movement budget | **PASS** | move 20 ft of 30 → remaining 10; Dash → remaining 40 + chat note; second Dash → 409; new round → budget refilled, dashed reset. |
| 10 | AC staleness (ac.calc) | **PASS** (see note) | sheet AC == Foundry live derived at rest; a +4 AC effect → live 23, **sheet reflects 23** (the bbf22eb fix — a stale adapter would show 19); removal restores 19. |
| 11 | dice FAB position | **live-skipped** | pure CSS position (FAB above the carousel) already verified against the mock in Task 10; live-verifying needs the full web+gateway+invite browser wiring for a visual-only assertion. |

**Check 4 (save spells) — deliberate deviation:** saving throws are auto-rolled for **every**
target passed in, PCs included when friendly-fired (as the Fireball-at-Akra case above
exercises) — the script has no notion of "roll only for NPCs" and singling PCs out would need
either a real player-facing save prompt or a GM-only override, neither of which exists headless;
auto-rolling everyone uniformly is the only workable v1 behavior.

## Check 7 — versatile longsword (follow-up, not fixed per brief)

The longsword has `properties:["ver"]`, base damage `1d8`, and `attackModes:["oneHanded","twoHanded"]`.
The targeted attack's auto damage roll used **`1d8` (one-handed default)**. There is **no grip
input on the wire today** — `use-on-targets` / `targetedUseScript` always fires the activity's
first/default damage, so a two-handed swing (`1d10`) can't be requested from the PWA.

**Follow-up (tracked, task #9 style):** thread an attack `mode`/grip option through
`use-on-targets` → `targetedUseScript` and pass dnd5e's attack-mode to `rollAttack`/`rollDamage`
so versatile weapons can roll `1d10` two-handed. Low priority — 1H is the safe default.

## Check 6 — upcast damage does not scale (follow-up, out of Check-6 scope)

Check 6 only asserts *slot consumption* (green). Observed separately: with all dice forced to 1,
the 4th-level Fireball rolled a **die-count of 8** — i.e. base `8d6`, **not** the upcast `9d6`.
`targetedUseScript` calls `activity.rollDamage({ isCritical }, …)` **without a scaling level**, so
the auto damage roll ignores the upcast even though the correct (4th-level) slot is consumed.

**Follow-up (tracked):** pass the cast level into `rollDamage` (dnd5e's `scaling`/`spellLevel`
option) so upcast targeted spells scale their damage. The slot economy is already correct.

## Check 10 — AC staleness note + a separate self-buff-cast issue

The branch fix (commit `bbf22eb`, adapter reports the *live derived* AC via `getDerivedAc`) is
verified: applying a +4 AC effect raises Foundry's live AC to 23 and the gateway sheet reports
**23**, not the stale 19; removing it restores 19. Sheet AC == live derived across apply/remove.

Two things worth recording, **both outside combat-targeting scope**:

1. **Mage Armor is the wrong probe on Morthos.** His unarmored calc is `unarmoredBard` (AC 19 with
   Bracers of Defense), which already beats Mage Armor's `mage` calc (13+DEX = 15), so Mage Armor
   never raises his AC. The check therefore uses an explicit +4 AC-bonus effect instead.
2. **The app's "cast Mage Armor" self-buff path did not apply an effect on this stack** (status 200,
   but no ActiveEffect created in Foundry). A *direct* `relay.applyEffect` with the same shape
   **does** create the effect (verified — a +4 bonus lands and AC moves), so the relay path is fine;
   the gap is upstream in `cast-and-apply-effect` / `selfBuffEffect` detection against relay 3.4.1's
   actor serialization (the embedded item `effects` the adapter reads may be absent from
   `GET /get`). This is the older M-buff-effects feature, not combat targeting — flagged for a
   separate look.

## Environment / relay notes (for future live runs)

- **Foundry v14 dice override:** `CONFIG.Dice.randomUniform` is honored, but the face mapping is
  `face = ceil((1 - v) * faces)` — i.e. `v→0` yields the MAX face, `v→1` yields 1. (The test forces
  determinism through this and always restores the original in a `finally`.)
- **`execute-js` pattern filter:** the relay rejects scripts containing the token `globalThis`
  ("Script contains forbidden patterns", 400). Use `window` to stash globals in the GM client.
- **ActiveEffect `_id` must be exactly 16 chars** (Foundry doc-id length). A 15- or 17-char `_id`
  makes the relay's `PUT /update` embedded-effects upsert silently no-op (returns OK, creates
  nothing). `mintEffectId()` already produces 16 chars — safe.
- **Standing fixture left in the world:** actor **"E2E Skeleton"** (`GU6KMCFHfDuBmYBq`,
  slashing/piercing-resistant, bludgeoning-vulnerable, AC 13) with a token on the active
  "Movement Live Check" scene, plus a **Longsword** and **Cure Wounds** added to Morthos (both set
  `system.prepared:1`, along with Mage Armor). The combat the script creates is deleted on exit and
  PC HP/slots + any app effects are restored. Delete the skeleton via
  `DELETE /delete?uuid=Actor.GU6KMCFHfDuBmYBq` if unwanted.
