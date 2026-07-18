# Upcasting via execute-js + Slot Pips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Leveled dnd5e spells can be cast using a higher-level slot (Foundry consumes the right slot via the relay's `execute-js`), and every per-level spell header shows remaining/max slot pips.

**Architecture:** Base-level casts keep the existing `use-spell` path untouched. Upcasts become a new `RelayAction` variant `cast-at-slot` that `foundry-client` turns into a fixed, parameter-validated `execute-js` script calling dnd5e's own `activity.use({ spell: { slot } })`. The PWA's existing ActionSheet slot picker is fed by newly-populated `slotLevels`; the app-side display damage roll scales via dnd5e part-scaling data and a per-spell cast-level memory. Slot pips ride a new `ResourceDescriptor.level` field.

**Tech Stack:** pnpm workspace, TypeScript strict, vitest, Nuxt 4 / Vue 3 PWA, Fastify gateway, foundryvtt-rest-api module+relay 3.4.1 (pinned), dnd5e 5.3.3 on Foundry v13.

**Spec:** `docs/superpowers/specs/2026-07-19-upcasting-and-slot-pips-design.md`

## Global Constraints

- Versions are pinned (VERSIONS.md): dnd5e **5.3.3**, module/relay **3.4.1**, Foundry **v13**. No version bumps in this plan.
- No rules engine in the gateway/adapter beyond display formulas — Foundry owns consumption, refusal, chat cards (PLAN.md §7 philosophy).
- The phone can never supply script text. `execute-js` scripts are constant templates in `foundry-client`; only regex-validated ids/slot keys are interpolated, always through `JSON.stringify`.
- `slotKey` regex everywhere: `^spell[2-9]$`. Foundry id regex: `^[A-Za-z0-9]{1,32}$`.
- Tests: vitest, run per package with `pnpm --filter <pkg> test`. Typecheck with `pnpm --filter <pkg> typecheck` (skip `@companion/bootstrap` — it has a pre-existing unrelated typecheck failure).
- Commit after every task (message style: `feat(scope): …` / `test(scope): …`), trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Do NOT push.
- Windows/PowerShell dev box: use `git commit -F <file>` for multi-line messages (inline quotes get mangled).

---

### Task 1: SDK types + adapter `slotLevels` population

**Files:**
- Modify: `packages/adapter-sdk/src/index.ts` (RelayAction ~line 307, ActionIntent ~line 279)
- Modify: `packages/adapter-dnd5e/src/index.ts` (`canCastAtBase` ~line 1240, `buildActions` cast push ~line 1580)
- Test: `packages/adapter-dnd5e/test/actions.test.ts`

**Interfaces:**
- Consumes: existing `canCastAtBase(actor, spellLevel)`, `numAt`, cast-descriptor push in `buildActions`.
- Produces:
  - SDK `RelayAction` gains `| { endpoint: 'cast-at-slot'; itemId: string; slotKey: string }` and the `use-and-roll` variant's `use` union gains `'cast-at-slot'` plus optional `slotKey?: string`.
  - SDK damage intent becomes `{ kind: 'damage'; actionId: string; critical?: boolean; slotLevel?: number }`.
  - Adapter `payableSlotLevels(actor: FoundryActorDoc, baseLevel: number): number[]` — ascending levels `baseLevel..9` where `spells.spell<L>.value > 0`.
  - Cast descriptors: `slotLevels` absent only for cantrips and free-use/pact-method spells; otherwise the payable array (possibly `[]`).

- [ ] **Step 1: Write the failing tests** — append to `actions.test.ts` (the `warlock(...)` fixture helper and `action(...)`/`actions(...)` helpers already exist in this file):

```ts
describe('slotLevels — payable levels for the upcast picker', () => {
  it('a leveled spell lists every payable level from base up (Guiding Bolt: slots at 1/2/3 all non-empty)', () => {
    // caster-captured has spell1.value=2, spell2.value=1, spell3.value=2.
    expect(action(casterCaptured, 'spell.pZMrJb3AXiRYO5E8.cast').slotLevels).toEqual([1, 2, 3]);
  });

  it('drained base level drops out of the list but higher levels remain', async () => {
    if (!dnd5eAdapter.enrich) throw new Error('adapter must expose enrich()');
    const drained = await dnd5eAdapter.enrich(casterCaptured, {
      getSystemDetails: async () => ({
        spellSlots: { spell1: { value: 0, max: 4 }, spell2: { value: 2, max: 3 }, spell3: { value: 1, max: 1 } },
      }),
    });
    expect(action(drained, 'spell.pZMrJb3AXiRYO5E8.cast').slotLevels).toEqual([2, 3]);
  });

  it('cantrips still carry no slotLevels', () => {
    expect(action(casterCaptured, 'spell.P97npemu7j70IZAQ.cast').slotLevels).toBeUndefined();
  });

  it('pact-only casting stays pickerless (slotLevels absent)', () => {
    const actor = warlock({ value: 2, max: 2, level: 4 });
    expect(action(actor, 'spell.spellHex00000001.cast').slotLevels).toBeUndefined();
  });

  it('nothing payable at all -> [] (disabled)', () => {
    const actor = warlock({ value: 0, max: 2, level: 4 });
    expect(action(actor, 'spell.spellHex00000001.cast').slotLevels).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @companion/adapter-dnd5e vitest run actions.test.ts -t "slotLevels"`
Expected: FAIL — Guiding Bolt currently has `slotLevels` absent (base-castable) and the warlock pact case matches by accident; the first two tests fail.

- [ ] **Step 3: SDK type changes** — in `packages/adapter-sdk/src/index.ts`:

Replace the damage intent variant:

```ts
  /** `critical` (5e nat 20): the damage roll doubles its dice, keeping
   *  static bonuses — armed by the PWA when the preceding attack/cast
   *  roll came back `isCritical`. `slotLevel` is the level the spell was
   *  last cast at (upcasting) so the display roll scales its dice. */
  | { kind: 'damage'; actionId: string; critical?: boolean; slotLevel?: number }
```

Add to `RelayAction` (after the `use-item | use-spell | use-feature` variant):

```ts
  /** Upcast (dnd5e): cast the spell consuming a SPECIFIC higher-level slot.
   *  Executed via the relay's execute-js with a fixed script template —
   *  see foundry-client castAtSlot. slotKey matches ^spell[2-9]$. */
  | { endpoint: 'cast-at-slot'; itemId: string; slotKey: string }
```

And widen the `use-and-roll` variant:

```ts
  | {
      endpoint: 'use-and-roll';
      use: 'use-item' | 'use-spell' | 'use-feature' | 'cast-at-slot';
      itemId: string;
      /** required when use === 'cast-at-slot' (upcast heals). */
      slotKey?: string;
      formula: string;
      flavor: string;
      heal?: { path: string; current: number; max: number };
    }
```

- [ ] **Step 4: Adapter — payableSlotLevels + descriptor rules** — in `packages/adapter-dnd5e/src/index.ts`, next to `canCastAtBase`:

```ts
/** Ascending spell-slot levels the actor can pay for RIGHT NOW for a spell
 *  of `baseLevel`: every L in base..9 with `spells.spellL.value > 0`. Pact
 *  slots are deliberately excluded — dnd5e consumes them automatically for
 *  pact-method spells at pact level (no upcast concept). */
function payableSlotLevels(actor: FoundryActorDoc, baseLevel: number): number[] {
  const out: number[] = [];
  for (let lvl = Math.max(1, baseLevel); lvl <= 9; lvl++) {
    if ((numAt(actor.system, `spells.spell${lvl}.value`) ?? 0) > 0) out.push(lvl);
  }
  return out;
}
```

In `buildActions`, replace the cast-descriptor `slotLevels` line
(`...(freeUse === undefined && level > 0 && !canCastAtBase(actor, level) ? { slotLevels: [] } : {})`) with:

```ts
          // slotLevels semantics (2026-07-19 spec): absent = direct cast, no
          // picker (cantrips, free-use, pact-payable); otherwise the payable
          // spellN levels — [] disables, length 1 direct-casts, >1 opens the
          // PWA picker.
          ...(freeUse === undefined && level > 0
            ? (() => {
                const payable = payableSlotLevels(actor, level);
                if (payable.length > 0) return { slotLevels: payable };
                return canCastAtBase(actor, level) ? {} : { slotLevels: [] };
              })()
            : {}),
```

- [ ] **Step 5: Fix the existing tests this changes** — in `actions.test.ts`:
  - The `toEqual` on Guiding Bolt's cast descriptor ("a leveled spell with a base-level slot is directly castable…") gains `slotLevels: [1, 2, 3]`; rename it to "a leveled spell with payable slots lists them (picker feed)".
  - The drained-slots test ("…disabled (slotLevels: [])") drains ALL levels or asserts `[2, 3]` per the new test above — change its enrich payload to `{ spell1: { value: 0, max: 4 }, spell2: { value: 0, max: 3 }, spell3: { value: 0, max: 1 } }` so `[]`+throw still hold.
  - Pact tests from 2026-07-18: `slotLevels` for the warlock's spells is now absent (unchanged assertions pass) — verify, don't assume.

- [ ] **Step 6: Run the full package suite**

Run: `pnpm --filter @companion/adapter-dnd5e vitest run`
Expected: PASS (all). Also `pnpm --filter @companion/adapter-sdk typecheck` and `pnpm --filter @companion/adapter-dnd5e typecheck`: clean.

- [ ] **Step 7: Commit** — `feat(adapter-dnd5e): populate slotLevels with payable slot levels for the upcast picker`

---

### Task 2: Adapter — cast intent → use-spell (base) / cast-at-slot (upcast), incl. heals

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts` (`buildAction` case `'cast'`, `buildHealAction`)
- Test: `packages/adapter-dnd5e/test/actions.test.ts`

**Interfaces:**
- Consumes: Task 1's `slotLevels` descriptor + `cast-at-slot` RelayAction variant.
- Produces: `buildAction` cast mapping used by the gateway:
  - `slotLevels` absent on descriptor → today's behavior (ignore `intent.slotLevel`, `use-spell` / heal path).
  - `slotLevels` present: `intent.slotLevel` (or the base level when omitted and payable) must be in the array, else `IntentError('INVALID')`.
  - Chosen level === spell base level → `use-spell` (unchanged wire shape).
  - Chosen level > base → `{ endpoint: 'cast-at-slot', itemId, slotKey: 'spell<L>' }`; heal spells → `use-and-roll` with `use: 'cast-at-slot'`, `slotKey`, and the (Task 3-scaled) formula.
  - `buildHealAction(actor, item, actionId, opts?: { forceSelf?: boolean; slotLevel?: number })` — when `opts.slotLevel` > base, activation becomes `use: 'cast-at-slot'` + `slotKey`.

- [ ] **Step 1: Failing tests**

```ts
describe('buildAction — upcast (cast-at-slot)', () => {
  it('base-level choice keeps the plain use-spell wire shape', () => {
    expect(build(casterCaptured, { kind: 'cast', actionId: 'spell.pZMrJb3AXiRYO5E8.cast', slotLevel: 1 })).toEqual({
      endpoint: 'use-spell',
      itemId: 'pZMrJb3AXiRYO5E8',
    });
  });

  it('a higher slot maps to cast-at-slot with the spellN key (Guiding Bolt at 3rd)', () => {
    expect(build(casterCaptured, { kind: 'cast', actionId: 'spell.pZMrJb3AXiRYO5E8.cast', slotLevel: 3 })).toEqual({
      endpoint: 'cast-at-slot',
      itemId: 'pZMrJb3AXiRYO5E8',
      slotKey: 'spell3',
    });
  });

  it('a slotLevel not in the payable list is INVALID (no slot to pay with)', () => {
    expectIntentError(
      () => build(casterCaptured, { kind: 'cast', actionId: 'spell.pZMrJb3AXiRYO5E8.cast', slotLevel: 5 }),
      'INVALID',
    );
  });

  it('omitted slotLevel defaults to base when base is payable', () => {
    expect(build(casterCaptured, { kind: 'cast', actionId: 'spell.pZMrJb3AXiRYO5E8.cast' })).toEqual({
      endpoint: 'use-spell',
      itemId: 'pZMrJb3AXiRYO5E8',
    });
  });

  it('an upcast heal keeps the use-and-roll display shape but activates via cast-at-slot (Cure Wounds at 2nd)', () => {
    const a = build(casterCaptured, { kind: 'cast', actionId: 'spell.LjT1wf4D38c9Ieuo.cast', slotLevel: 2 });
    expect(a).toMatchObject({
      endpoint: 'use-and-roll',
      use: 'cast-at-slot',
      itemId: 'LjT1wf4D38c9Ieuo',
      slotKey: 'spell2',
      flavor: 'Cure Wounds — Healing',
    });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @companion/adapter-dnd5e vitest run actions.test.ts -t "cast-at-slot"` → FAIL (use-spell returned / no validation).

- [ ] **Step 3: Implement** — in `buildAction` case `'cast'` replace the body after the existing `slotLevels.length === 0` guard:

```ts
    case 'cast': {
      const itemId = intent.actionId.slice('spell.'.length, -'.cast'.length);
      if (descriptor.slotLevels !== undefined && descriptor.slotLevels.length === 0) {
        throw new IntentError(`no spell slot available for "${intent.actionId}"`, 'INVALID');
      }
      const item = (actor.items ?? []).find((i) => i._id === itemId);
      const baseLevel = numAt(item?.system, 'level') ?? 0;
      // Resolve the paying slot: with a payable list, the intent's slotLevel
      // (default: base) must be in it. Without a list (cantrip/free-use/
      // pact) any slotLevel is ignored — today's behavior.
      let chosen = baseLevel;
      if (descriptor.slotLevels !== undefined) {
        chosen = intent.slotLevel ?? baseLevel;
        if (!descriptor.slotLevels.includes(chosen)) {
          throw new IntentError(`no ${ordinal(chosen)}-level slot available for "${intent.actionId}"`, 'INVALID');
        }
      }
      const upcast = descriptor.slotLevels !== undefined && chosen > baseLevel;
      if (item && activityType(item) === 'heal') {
        return buildHealAction(actor, item, intent.actionId, upcast ? { slotLevel: chosen } : undefined);
      }
      if (upcast) {
        return { endpoint: 'cast-at-slot', itemId, slotKey: `spell${chosen}` };
      }
      return { endpoint: 'use-spell', itemId };
    }
```

And in `buildHealAction`, change the opts type to `{ forceSelf?: boolean; slotLevel?: number }` and the `base` object to:

```ts
  const baseLevel = numAt(item.system, 'level') ?? 0;
  const upcast = opts?.slotLevel !== undefined && opts.slotLevel > baseLevel;
  const base = {
    endpoint: 'use-and-roll' as const,
    use: upcast ? ('cast-at-slot' as const) : useEndpointFor(actionId),
    ...(upcast ? { slotKey: `spell${opts.slotLevel}` } : {}),
    itemId: item._id,
    formula,
    flavor: `${item.name} — Healing`,
  };
```

(`formula` picks up scaling in Task 3 — for now it stays the base formula; the `toMatchObject` test above deliberately doesn't pin it.)

- [ ] **Step 4: Run full suite** — `pnpm --filter @companion/adapter-dnd5e vitest run` → PASS. Note: the pre-existing test "cast is the to-hit/activation: … (a requested slotLevel is ignored — no upcast)" now conflicts by name and behavior — REWRITE it: slotLevel 2 now legally upcasts (covered above); replace its body with the base-default assertion or delete it in favor of the new suite.

- [ ] **Step 5: Commit** — `feat(adapter-dnd5e): map upcast intents to cast-at-slot (heals included)`

---

### Task 3: Adapter — scaled display formulas (damage, heal, cantrip tiers, pact) + damage intent slotLevel

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts` (`itemDamageFormula`, `healFormula`, `buildAction` case `'damage'`, `buildHealAction`)
- Test: `packages/adapter-dnd5e/test/actions.test.ts`

**Interfaces:**
- Consumes: dnd5e 5.x part scaling (real captured shape: `scaling: { mode: 'whole', number: 1, formula: '' }` on `damage.parts[]` and on `healing`), `characterLevel(actor)`, `freeUseMethod`, pact level at `spells.pact.level`.
- Produces:
  - `scaledDiceNumber(baseNumber: number, scaling: unknown, steps: number): number | undefined` — mode `'whole'`: `base + (scaling.number ?? 1) * steps`; mode `'half'`: `base + (scaling.number ?? 1) * Math.floor(steps / 2)`; absent/unknown mode or non-finite number: returns `baseNumber` when `steps === 0`, else `undefined` (caller falls back to unscaled — documented gap).
  - `itemDamageFormula(actor, item, castLevel?: number)` and `healFormula(actor, item, castLevel?: number)` — scale each part's dice count by `steps = castLevel - baseLevel` (clamped ≥ 0). Cantrips (base 0): `steps = tier` where tier = 1 at character level ≥ 5, 2 at ≥ 11, 3 at ≥ 17, else 0 — applied even with no castLevel argument.
  - Effective cast level default when no explicit castLevel: pact-method (`method === 'pact'`… note: `freeUseMethod` only covers atwill/innate — read `strAt(item.system, 'method') === 'pact'`) leveled spells use `spells.pact.level` when known.
  - `buildAction` case `'damage'`: validates optional `intent.slotLevel` (integer 1..9), passes it as castLevel for spells; crit doubling composes AFTER scaling (`criticalFormula(scaledFormula)`).

- [ ] **Step 1: Failing tests**

```ts
describe('display formula scaling (upcast + cantrip tiers)', () => {
  it('Guiding Bolt at 3rd rolls 6d6 (base 4d6, whole-mode +1 die/level)', () => {
    expect(build(casterCaptured, { kind: 'damage', actionId: 'spell.pZMrJb3AXiRYO5E8.damage', slotLevel: 3 })).toEqual({
      endpoint: 'roll',
      formula: '6d6',
      flavor: 'Guiding Bolt — Damage',
    });
  });

  it('crit doubles the SCALED dice (Guiding Bolt at 3rd, crit: 12d6)', () => {
    expect(
      build(casterCaptured, { kind: 'damage', actionId: 'spell.pZMrJb3AXiRYO5E8.damage', slotLevel: 3, critical: true }),
    ).toEqual({ endpoint: 'roll', formula: '12d6', flavor: 'Guiding Bolt — Critical Damage' });
  });

  it('cantrip damage scales with character level (Akra is level 5: Sacred Flame 2d8)', () => {
    expect(build(casterCaptured, { kind: 'damage', actionId: 'spell.P97npemu7j70IZAQ.damage' })).toEqual({
      endpoint: 'roll',
      formula: '2d8',
      flavor: 'Sacred Flame — Damage',
    });
  });

  it('a slotLevel below base or out of range is INVALID', () => {
    expectIntentError(
      () => build(casterCaptured, { kind: 'damage', actionId: 'spell.pZMrJb3AXiRYO5E8.damage', slotLevel: 0 }),
      'INVALID',
    );
  });

  it('upcast heal formula scales (Cure Wounds at 2nd: 2d8 + 2)', () => {
    const a = build(casterCaptured, { kind: 'cast', actionId: 'spell.LjT1wf4D38c9Ieuo.cast', slotLevel: 2 });
    if (a.endpoint !== 'use-and-roll') throw new Error('expected use-and-roll');
    expect(a.formula).toBe('2d8 + 2');
  });

  it('weapon damage is untouched by slotLevel (weapons have no cast level)', () => {
    expect(formulaOf(martialCaptured, { kind: 'damage', actionId: 'item.gta26ORvqC323k3r.damage' })).toBe('1d8 + 3');
  });
});
```

Heads-up on pre-existing expectations this changes: any test pinning cantrip display damage at base dice for a level-5 actor (e.g. Sacred Flame `'1d8'` in the M14/M16 suites, and the mock-independent `spell.P97npemu7j70IZAQ.damage` = `'1d8'` toEqual) must be updated to the tiered value (`2d8`). Search for `'1d8'` occurrences tied to Sacred Flame before assuming.

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @companion/adapter-dnd5e vitest run actions.test.ts -t "scaling"` → FAIL.

- [ ] **Step 3: Implement** — add the helper near `itemDamageFormula`:

```ts
/** dnd5e 5.x part scaling ({ mode, number, formula }): extra dice per step
 *  above base. 'whole' = every level, 'half' = every two levels. Returns
 *  undefined when scaling data can't be applied (caller keeps base dice —
 *  documented gap, same honesty as the formula builders). */
function scaledDiceNumber(baseNumber: number, rawScaling: unknown, steps: number): number | undefined {
  if (steps <= 0) return baseNumber;
  const scaling = rec(rawScaling);
  const per = typeof scaling.number === 'number' && Number.isFinite(scaling.number) ? scaling.number : 1;
  if (scaling.mode === 'whole') return baseNumber + per * steps;
  if (scaling.mode === 'half') return baseNumber + per * Math.floor(steps / 2);
  return undefined;
}

/** Cantrip damage tier from total character level (dnd5e: 5/11/17). */
function cantripSteps(actor: FoundryActorDoc): number {
  const lvl = characterLevel(actor);
  return lvl >= 17 ? 3 : lvl >= 11 ? 2 : lvl >= 5 ? 1 : 0;
}

/** Steps above base the display roll should scale by: explicit castLevel
 *  wins; cantrips use the character-level tier; pact-method spells scale to
 *  the pact slot level when known; everything else stays at base. */
function scalingSteps(actor: FoundryActorDoc, item: FoundryItemDoc, castLevel?: number): number {
  const base = numAt(item.system, 'level') ?? 0;
  if (base === 0) return cantripSteps(actor);
  if (castLevel !== undefined) return Math.max(0, castLevel - base);
  if (strAt(item.system, 'method') === 'pact') {
    const pactLevel = numAt(actor.system, 'spells.pact.level');
    if (pactLevel !== undefined) return Math.max(0, pactLevel - base);
  }
  return 0;
}
```

Thread it through: `itemDamageFormula(actor, item, castLevel?)` — inside the parts loop, compute `const steps = scalingSteps(actor, item, castLevel);` (hoist above the loop) and build dice with `const scaled = scaledDiceNumber(number, part.scaling, steps) ?? number;` → `const dice = `${scaled}d${denomination}`;`. Same pattern in `healFormula` with `healing.scaling`. NOTE: `itemDamageFormula` is also used for ITEMS (Bead of Force) — `scalingSteps` returns 0 for non-spell items because their `level` is absent → `numAt … ?? 0` makes them look like cantrips! Guard: apply scaling only when `item.type === 'spell'` (add `if (item.type !== 'spell') return 0;` as the first line of `scalingSteps`).

`buildAction` case `'damage'`: after the `critical` validation add:

```ts
      if (
        intent.slotLevel !== undefined &&
        (!Number.isInteger(intent.slotLevel) || intent.slotLevel < 1 || intent.slotLevel > 9)
      ) {
        throw new IntentError('damage slotLevel must be an integer 1-9', 'INVALID');
      }
```

then `const formula = item ? (isSpell ? itemDamageFormula(actor, item, intent.slotLevel) : weaponDamageFormula(actor, item)) : undefined;` and additionally reject `slotLevel < baseLevel` for spells (`numAt(item.system, 'level')`) with the same INVALID error. `buildHealAction` passes `opts?.slotLevel` into `healFormula(actor, item, opts?.slotLevel)`.

- [ ] **Step 4: Run full suite; fix the flagged cantrip expectations** — `pnpm --filter @companion/adapter-dnd5e vitest run` → PASS.

- [ ] **Step 5: Commit** — `feat(adapter-dnd5e): scale display damage/heal formulas for upcasts, cantrip tiers, pact level`

---

### Task 4: foundry-client — `castAtSlot` via POST /execute-js

**Files:**
- Modify: `packages/foundry-client/src/index.ts` (new method near `useAbility`)
- Test: `packages/foundry-client/test/` (follow the existing test file pattern there — check how `request` is stubbed; the existing tests fake `fetch`)

**Interfaces:**
- Consumes: `this.request<T>(method, path, query, body?)` (private helper used by `rollFormula` etc.).
- Produces: `async castAtSlot(actorUuid: string, itemUuid: string, slotKey: string): Promise<Record<string, unknown>>` — validates inputs, POSTs `/execute-js` with `{ script }`, returns `body.result ?? body` (object-shaped; `extractRoll`-compatible `{ roll: {...} }` when an attack roll was captured).

- [ ] **Step 1: Failing tests** (adapt stubbing to the package's existing pattern):

```ts
describe('castAtSlot', () => {
  it('rejects malformed uuids and slot keys before any network call', async () => {
    const client = makeClient(); // however existing tests construct it
    await expect(client.castAtSlot('Actor.abc; drop', 'Actor.a.Item.b', 'spell3')).rejects.toThrow(/actorUuid/);
    await expect(client.castAtSlot('Actor.abc123', 'Actor.abc123.Item.x"y', 'spell3')).rejects.toThrow(/itemUuid/);
    await expect(client.castAtSlot('Actor.abc123', 'Actor.abc123.Item.def456', 'pact')).rejects.toThrow(/slotKey/);
    await expect(client.castAtSlot('Actor.abc123', 'Actor.abc123.Item.def456', 'spell1')).rejects.toThrow(/slotKey/);
    // and assert zero fetch calls happened
  });

  it('POSTs /execute-js with a script containing the quoted item uuid and slot key', async () => {
    // stub fetch to capture; respond { success: true, result: { roll: { total: 18, formula: '1d20 + 7' } } }
    const res = await client.castAtSlot('Actor.abc123', 'Actor.abc123.Item.def456', 'spell3');
    // captured request: path /execute-js, method POST
    // body.script includes JSON.stringify('Actor.abc123.Item.def456') and '"spell3"'
    // and does NOT include any unquoted interpolation
    expect(res).toEqual({ roll: { total: 18, formula: '1d20 + 7' } });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @companion/foundry-client vitest run` → FAIL (method missing).

- [ ] **Step 3: Implement** in `packages/foundry-client/src/index.ts`:

```ts
  /**
   * POST /execute-js — cast a spell consuming a SPECIFIC slot (upcast).
   * The relay module's use-spell cannot pass a slot to dnd5e (M6/2026-07-19
   * finding), so this runs a CONSTANT script template through execute-js:
   * dnd5e's own activity.use({ spell: { slot } }) — right slot consumed,
   * card labeled with the cast level, concentration applied. Attack-type
   * activities also capture the to-hit roll (same dnd5e.rollAttackV2 hook
   * the module's use-spell uses) and return it as { roll } so the gateway's
   * extractRoll keeps working. Requires the relay API key scope
   * `execute-js` AND the module setting "Allow Execute JS".
   * Only validated ids/slot keys are interpolated, via JSON.stringify —
   * callers can never inject script text.
   */
  async castAtSlot(actorUuid: string, itemUuid: string, slotKey: string): Promise<Record<string, unknown>> {
    if (!/^Actor\.[A-Za-z0-9]{1,32}$/.test(actorUuid)) throw new Error(`castAtSlot: invalid actorUuid "${actorUuid}"`);
    if (!/^Actor\.[A-Za-z0-9]{1,32}\.Item\.[A-Za-z0-9]{1,32}$/.test(itemUuid)) {
      throw new Error(`castAtSlot: invalid itemUuid "${itemUuid}"`);
    }
    if (!/^spell[2-9]$/.test(slotKey)) throw new Error(`castAtSlot: invalid slotKey "${slotKey}"`);
    // Mirrors the module's own use-spell flow (v13 path) with the one
    // addition it lacks: spell.slot. Shape live-verified per the plan's
    // final task before any push.
    const script = [
      `const item = await fromUuid(${JSON.stringify(itemUuid)});`,
      `if (!item) throw new Error('item not found');`,
      `const activities = item.system?.activities;`,
      `const activity = activities?.size > 0 ? [...activities.values()][0] : null;`,
      `if (!activity) throw new Error('spell has no activity');`,
      `let attackRoll = null;`,
      `const hookId = Hooks.once('dnd5e.rollAttackV2', (rolls) => { if (rolls?.length) attackRoll = rolls[0]; });`,
      `try {`,
      `  const hasAttack = typeof activity.rollAttack === 'function';`,
      `  const usage = { subsequentActions: false, consume: { spellSlot: true }, spell: { slot: ${JSON.stringify(slotKey)} } };`,
      `  const useResult = await activity.use(usage, { configure: false }, {});`,
      `  if (!useResult) throw new Error('cast could not be performed');`,
      `  if (hasAttack) await activity.rollAttack({}, { configure: false }, {});`,
      `} finally { Hooks.off('dnd5e.rollAttackV2', hookId); }`,
      `return attackRoll ? { roll: { total: attackRoll.total, formula: attackRoll.formula, isCritical: attackRoll.isCritical ?? false, isFumble: attackRoll.isFumble ?? false } } : {};`,
    ].join('\n');
    const body = await this.request<Record<string, unknown>>('POST', '/execute-js', {}, { script });
    const result = body.result;
    return result !== null && typeof result === 'object' ? (result as Record<string, unknown>) : body;
  }
```

- [ ] **Step 4: Run** — `pnpm --filter @companion/foundry-client vitest run` and `typecheck` → PASS.

- [ ] **Step 5: Commit** — `feat(foundry-client): castAtSlot — fixed execute-js template for dnd5e upcasting`

---

### Task 5: Gateway — execute cast-at-slot, damage slotLevel parsing, actionable errors

**Files:**
- Modify: `apps/gateway/src/app.ts` (`RelayPort` ~line 55, action-execution switch ~line 948, `parseActionIntent` damage case)
- Modify: `apps/gateway/test/fakes.ts` (FakeRelay + fake adapter)
- Test: `apps/gateway/test/app.test.ts`

**Interfaces:**
- Consumes: Task 4's `castAtSlot` signature; SDK `cast-at-slot` action + widened `use-and-roll`.
- Produces:
  - `RelayPort.castAtSlot(actorUuid: string, itemUuid: string, slotKey: string): Promise<Record<string, unknown>>`
  - Route behavior: `cast-at-slot` → `extractRoll(await relay.castAtSlot(...))`; `use-and-roll` with `use === 'cast-at-slot'` activates via `castAtSlot` instead of `useAbility`.
  - RelayError containing "execute-js" (disabled setting / missing scope) → 422 INVALID_INTENT, message: `Upcasting is not enabled on the table: enable "Allow Execute JS" in the Foundry REST API module settings and grant the relay API key the execute-js scope.`
  - `parseActionIntent` damage: optional `slotLevel` must be an integer ≥ 1 (deep bounds live in the adapter).

- [ ] **Step 1: FakeRelay + fake adapter support** — in `fakes.ts`: add to FakeRelay:

```ts
  castAtSlotCalls: Array<{ actorUuid: string; itemUuid: string; slotKey: string }> = [];
  castAtSlotResult: Record<string, unknown> = {};
  castAtSlotError: Error | null = null;
  async castAtSlot(actorUuid: string, itemUuid: string, slotKey: string): Promise<Record<string, unknown>> {
    if (this.castAtSlotError) throw this.castAtSlotError;
    this.castAtSlotCalls.push({ actorUuid, itemUuid, slotKey });
    return this.castAtSlotResult;
  }
```

Fake adapter: the `'cast'` case returns `{ endpoint: 'cast-at-slot', itemId: 's1', slotKey: `spell${intent.slotLevel}` }` when `intent.slotLevel !== undefined && intent.slotLevel > 1`, else the existing `use-spell` shape (drop the old slotLevel passthrough on use-spell — mirrors the real adapter now).

- [ ] **Step 2: Failing tests** — in `app.test.ts` (`post` helper exists):

```ts
  it('cast with a higher slotLevel routes through cast-at-slot', async () => {
    const { app, relay } = setup();
    relay.castAtSlotResult = { roll: { total: 18, formula: '1d20 + 7', isCritical: false, isFumble: false } };
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.s1.cast', slotLevel: 2 });
    expect(res.statusCode).toBe(200);
    expect(relay.castAtSlotCalls).toEqual([
      { actorUuid: 'Actor.a1', itemUuid: 'Actor.a1.Item.s1', slotKey: 'spell2' },
    ]);
    expect(res.json().result).toEqual({ total: 18, formula: '1d20 + 7', isCritical: false, isFumble: false });
  });

  it('execute-js disabled on the module -> 422 naming the setting', async () => {
    const { app, relay } = setup();
    const err = new Error('execute-js is disabled in REST API module settings. A GM must enable it…');
    err.name = 'RelayError';
    relay.castAtSlotError = err;
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.s1.cast', slotLevel: 2 });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/Allow Execute JS/);
  });

  it('damage accepts an integer slotLevel and rejects junk', async () => {
    const { app } = setup();
    const bad = await post(app, 'a1', { kind: 'damage', actionId: 'item.i1.damage', slotLevel: 1.5 });
    expect(bad.statusCode).toBe(422);
  });
```

Also EXTEND the existing "cast with slotLevel 2 -> use-spell…" test: it is now the cast-at-slot test above — rewrite/rename it (fake adapter no longer emits use-spell for level 2).

- [ ] **Step 3: Run to verify failure** — `pnpm --filter @companion/gateway vitest run app.test.ts` → FAIL.

- [ ] **Step 4: Implement in app.ts** — RelayPort method (docstring: "POST /execute-js via foundry-client castAtSlot — upcast only"); `parseActionIntent` damage case gains:

```ts
    case 'damage':
      if (body.critical !== undefined && typeof body.critical !== 'boolean') return null;
      if (body.slotLevel !== undefined && (typeof body.slotLevel !== 'number' || !Number.isInteger(body.slotLevel) || body.slotLevel < 1)) return null;
      return {
        kind,
        actionId,
        ...(body.critical !== undefined ? { critical: body.critical } : {}),
        ...(body.slotLevel !== undefined ? { slotLevel: body.slotLevel } : {}),
      };
```

Execution switch — new case plus a shared helper for the error mapping:

```ts
        case 'cast-at-slot':
          try {
            result = extractRoll(await relay.castAtSlot(`Actor.${id}`, `Actor.${id}.Item.${action.itemId}`, action.slotKey));
          } catch (err) {
            const mapped = upcastUnavailable(err);
            if (mapped) return sendError(reply, 422, 'INVALID_INTENT', mapped);
            throw err;
          }
          break;
```

```ts
/** RelayError from execute-js when the module setting or API-key scope is
 *  missing — surfaced as an actionable 422 instead of a generic 502. */
function upcastUnavailable(err: unknown): string | null {
  if (!(err instanceof Error) || err.name !== 'RelayError') return null;
  if (!/execute-js/i.test(err.message)) return null;
  return 'Upcasting is not enabled on the table: enable "Allow Execute JS" in the Foundry REST API module settings and grant the relay API key the execute-js scope.';
}
```

`use-and-roll` case: replace the single `relay.useAbility(action.use, …)` call with:

```ts
          try {
            if (action.use === 'cast-at-slot') {
              await relay.castAtSlot(`Actor.${id}`, `Actor.${id}.Item.${action.itemId}`, action.slotKey as string);
            } else {
              await relay.useAbility(action.use, `Actor.${id}`, `Actor.${id}.Item.${action.itemId}`, {});
            }
          } catch (err) {
```

and inside that catch, BEFORE the existing 408 tolerance, add the same `upcastUnavailable` mapping (return the 422). Keep the 408 path exactly as-is.

- [ ] **Step 5: Run** — `pnpm --filter @companion/gateway vitest run` and `typecheck` → PASS.

- [ ] **Step 6: Commit** — `feat(gateway): execute cast-at-slot upcasts with actionable execute-js errors`

---

### Task 6: PWA — picker routing, slot counts, cast-level memory, error pass-through

**Files:**
- Modify: `apps/web/app/pages/actor/[id].vue` (`onCombatAction`, crit-memory block, `submitAction` error handling, ActionSheet usage)
- Modify: `apps/web/app/components/ActionSheet.vue`

**Interfaces:**
- Consumes: populated `slotLevels`; damage intent `slotLevel`; gateway 422 `{ error: { message } }` via `errorData`.
- Produces:
  - `onCombatAction` cast rules: `slotLevels` absent → direct cast (unchanged); `[]` → no-op; length 1 → direct `submitAction({ kind: 'cast', actionId, slotLevel: slotLevels[0] }, …)`; length > 1 → open ActionSheet.
  - ActionSheet new optional prop `slotsLeft?: Record<number, number>` — picker labels become `Cast at 3rd level · 2 left`.
  - `castLevels = ref<Record<string, number>>({})` — set after a successful cast with a chosen level ABOVE the spell's lowest offered level? No: set whenever the cast intent carried a `slotLevel`; keyed by damage-action id (`spell.<id>.damage`), consumed by the next damage roll (deleted after), overwritten by the next cast. Damage intent gains `slotLevel: castLevels[actionId]` when present.
  - Cast/use 422 errors whose body message mentions "Allow Execute JS" toast the server message verbatim instead of the generic copy.

- [ ] **Step 1: ActionSheet** — add prop and label:

```ts
const props = defineProps<{ action: ActionDescriptor; busy: boolean; slotsLeft?: Record<number, number> }>()
```

```vue
          <button v-for="lvl in action.slotLevels" :key="lvl" class="opt" type="button" :disabled="busy" @click="cast(lvl)">
            Cast at {{ ordinal(lvl) }} level{{ props.slotsLeft?.[lvl] !== undefined ? ` · ${props.slotsLeft[lvl]} left` : '' }}
          </button>
```

- [ ] **Step 2: [id].vue** — where `<ActionSheet` is rendered, pass `:slots-left="slotsLeft"`; add near the crit block:

```ts
/** Remaining slots per level, for the upcast picker labels. */
const slotsLeft = computed<Record<number, number>>(() => {
  const out: Record<number, number> = {}
  for (const r of sheet.value?.resources ?? []) {
    const m = /^slots\.([1-9])$/.exec(r.id)
    if (m) out[Number(m[1])] = r.value
  }
  return out
})

/** Upcast memory (2026-07-19): the level each spell was last cast at, keyed
 *  by its damage-action id — the companion Dmg roll sends it so the display
 *  dice scale. Consumed by that roll; overwritten by the next cast. */
const castLevels = ref<Record<string, number>>({})
```

`onCombatAction` cast branch becomes:

```ts
  if (action.kind === 'cast') {
    if (action.slotLevels === undefined) {
      void submitAction({ kind: 'cast', actionId }, action.label, action.effectType)
      return
    }
    if (action.slotLevels.length === 0) return
    if (action.slotLevels.length === 1) {
      void submitAction({ kind: 'cast', actionId, slotLevel: action.slotLevels[0] }, action.label, action.effectType)
      return
    }
    actionSheetFor.value = actionId
    return
  }
```

In `submitAction`'s success path (next to `updateCritArmed`):

```ts
      if (intent.kind === 'cast' && intent.slotLevel !== undefined) {
        castLevels.value = { ...castLevels.value, [intent.actionId.replace(/\.cast$/, '.damage')]: intent.slotLevel }
      }
```

`onAction` damage case: read `const lvl = castLevels.value[actionId]`, include `...(lvl !== undefined ? { slotLevel: lvl } : {})` in the intent, and after a successful damage roll delete the key (same place the crit flag is consumed — extend `updateCritArmed`'s damage branch or mirror it).

Error handling in `submitAction`'s catch, inside the `status === 403 || status === 422` branch:

```ts
      const msg = errorData<{ error?: { message?: string } }>(err)?.error?.message
      if (msg && /Allow Execute JS/i.test(msg)) toast.show(msg)
      else toast.show('That action isn’t available right now.')
```

- [ ] **Step 3: Typecheck** — `pnpm --filter @companion/web typecheck` → clean. (PWA has no unit tests; Task 9 verifies in-browser.)

- [ ] **Step 4: Commit** — `feat(web): upcast picker with slot counts, cast-level damage memory, actionable upcast toasts`

---

### Task 7: Slot pips — `ResourceDescriptor.level` + `SlotPips.vue` on both tabs

**Files:**
- Modify: `packages/adapter-sdk/src/index.ts` (ResourceDescriptor)
- Modify: `packages/adapter-dnd5e/src/index.ts` (`spellSlots()` SlotInfo + `buildResources`)
- Create: `apps/web/app/components/SlotPips.vue`
- Modify: `apps/web/app/components/SectionActions.vue` (bucket headers), `apps/web/app/components/SectionList.vue` (section header), `apps/web/app/pages/actor/[id].vue` (props wiring)
- Test: `packages/adapter-dnd5e/test/adapter.test.ts` (resources suite)

**Interfaces:**
- Consumes: `slots.N` / `slots.pact` resources; `spells.pact.level` (enriched).
- Produces:
  - SDK: `ResourceDescriptor.level?: number` — "spell level this slot pool casts at" (docstring).
  - Adapter: `slots.N` resources carry `level: N`; `slots.pact` carries `level: <pact level>` when `spells.pact.level` is a finite number, omitted otherwise.
  - `SlotPips.vue` props: `{ value: number; max: number; pact?: boolean }` — renders `max` boxes (filled = `value`); `max > 8` renders `{value}/{max}` text instead; pact styling distinct (garnet) with `title="Pact slots"`.
  - SectionActions new prop `slotResources: ResourceDescriptor[]`; SectionList new optional prop `pips?: Array<{ value: number; max: number; pact?: boolean }>`.

- [ ] **Step 1: Failing adapter test**

```ts
  it('slot resources carry their spell level for the pips UI', () => {
    expect(resource(caster, 'slots.1').level).toBe(1);
    expect(resource(caster, 'slots.3').level).toBe(3);
    const warlockish: FoundryActorDoc = {
      _id: 'actorPact0000002',
      name: 'Pact Pips',
      type: 'character',
      system: { spells: { pact: { value: 1, max: 2, level: 3 } } },
      items: [],
    };
    expect(resource(warlockish, 'slots.pact').level).toBe(3);
  });
```

- [ ] **Step 2: Run to verify failure**, then implement:
  - SDK ResourceDescriptor: `/** spell-slot pools only: the spell level this pool casts at (pips UI). */ level?: number;`
  - Adapter `SlotInfo` gains `castsAt?: number`; in `spellSlots()` set `castsAt: lvl` for spellN and for pact `...(pactLevel !== undefined ? { castsAt: pactLevel } : {})` where `const pactLevel = numAt(actor.system, 'spells.pact.level')`. In `buildResources`'s slot loop: `out.push({ id: slot.id, …, ...(slot.castsAt !== undefined ? { level: slot.castsAt } : {}) })`.
  - Run: `pnpm --filter @companion/adapter-dnd5e vitest run` → PASS.

- [ ] **Step 3: SlotPips.vue** (new file):

```vue
<template>
  <span v-if="max > 8" class="pips text" :class="{ pact }">{{ value }}/{{ max }}</span>
  <span v-else class="pips" :class="{ pact }" :title="pact ? 'Pact slots' : 'Spell slots'" aria-hidden="false"
        :aria-label="`${value} of ${max} ${pact ? 'pact ' : ''}slots left`">
    <span v-for="i in max" :key="i" class="pip" :class="{ filled: i <= value }" />
  </span>
</template>

<script setup lang="ts">
defineProps<{ value: number; max: number; pact?: boolean }>()
</script>

<style scoped>
.pips { display: inline-flex; gap: 3px; align-items: center; }
.pips.text { font-size: 0.7rem; font-weight: 700; color: var(--gold); }
.pip {
  width: 9px; height: 9px; border-radius: 2px;
  border: 1px solid color-mix(in srgb, var(--gold) 55%, transparent);
  background: transparent;
}
.pip.filled { background: linear-gradient(180deg, var(--gold-bright), var(--gold)); border-color: var(--gold-deep); }
.pips.pact .pip { border-radius: 50%; border-color: color-mix(in srgb, var(--garnet) 60%, transparent); }
.pips.pact .pip.filled { background: var(--garnet); border-color: var(--garnet); }
.pips.pact.text { color: var(--garnet); }
</style>
```

(Verify `--garnet` exists in `apps/web/app/assets/css/main.css`; if not, use the variable the concentration tag uses in SectionList (`.tag.conc` uses `var(--garnet)` — it exists).)

- [ ] **Step 4: SectionActions** — add prop `slotResources: ResourceDescriptor[]` (import type). Compute per-bucket pips:

```ts
function pipsFor(bucket: { key: string; label?: string }): Array<{ value: number; max: number; pact?: boolean }> {
  const m = /^l([0-9])$/.exec(bucket.key)
  if (!m) return []
  const lvl = Number(m[1])
  if (lvl === 0) return []
  const out: Array<{ value: number; max: number; pact?: boolean }> = []
  const own = props.slotResources.find((r) => r.id === `slots.${lvl}`)
  if (own && own.max !== undefined) out.push({ value: own.value, max: own.max })
  const pact = props.slotResources.find((r) => r.id === 'slots.pact')
  if (pact && pact.max !== undefined && pact.level !== undefined && pact.level >= lvl) {
    out.push({ value: pact.value, max: pact.max, pact: true })
  }
  return out
}
```

Template — the level-head becomes a flex row:

```vue
      <div v-if="bucket.label" class="lvl-head">
        <span>{{ bucket.label }}</span>
        <span class="lvl-pips"><SlotPips v-for="(p, i) in pipsFor(bucket)" :key="i" v-bind="p" /></span>
      </div>
```

CSS: `.lvl-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }` (merge with the existing `.lvl-head` rules) and `.lvl-pips { display: inline-flex; gap: 8px; }`.
`[id].vue`: pass `:slot-resources="slotResources"` where `const slotResources = computed(() => (sheet.value?.resources ?? []).filter((r) => r.id.startsWith('slots.')))`.

- [ ] **Step 5: SectionList** — optional prop `pips?: Array<{ value: number; max: number; pact?: boolean }>`; render inside `.section-head` after `.head-name`:

```vue
      <span v-if="pips?.length" class="lvl-pips"><SlotPips v-for="(p, i) in pips" :key="i" v-bind="p" /></span>
```

In `[id].vue`, where spell sections render `SectionList` (per-level `spells.l<N>` sections), compute pips per section id with the same rule as `pipsFor` (extract a shared helper into the page: `pipsForLevel(lvl: number)` used by both wirings — SectionActions can keep its component-local version consuming `slotResources`, or better: move the shared helper to the page and pass ready-made pips into BOTH components; choose the page-computed variant for SectionList and the component-local one for SectionActions as written above — do not duplicate the rule a third time).

- [ ] **Step 6: Typecheck + commit** — `pnpm --filter @companion/web --filter @companion/adapter-dnd5e --filter @companion/adapter-sdk typecheck` → clean. Commit: `feat: slot pips on spell-level headers (Actions + Spells tabs)`

---

### Task 8: Mock gateway parity

**Files:**
- Modify: `apps/web/mock/server.mjs`

**Interfaces:**
- Consumes: mock `availableSlotLevels(actor, level)` (exists), slot resources with `group: 'slots'`.
- Produces: mock casts honor `slotLevel` (consume the chosen slot), slot resources carry `level`, mock damage results scale, so Task 9 can drive everything offline.

- [ ] **Step 1: Implement** —
  - Slot resources: in the actor definitions, `r('slots.1', '1st Level', 3, { max: 4, group: 'slots' })` → add `level: 1` (and 2/3 accordingly) — the mock's `r()` spreads opts, so `r('slots.1', '1st Level', 3, { max: 4, group: 'slots', level: 1 })`.
  - Cast handler (`kind === 'cast'` branch): when `action.slotLevels !== undefined`, the existing validation already checks membership; it already decrements `slots.${lvl}` — verify it uses the INTENT's level (it does). Nothing else needed for consumption.
  - Damage handler: accept optional integer `slotLevel` ≥ 1 (422 otherwise, mirroring `critical`); scale: `const extra = (intent.slotLevel ?? base) - base` where base is the spell's level — the mock damage handler is item-based (`item.i-*.damage`), which has no spell level; keep it simple: `const dice = 1 + Math.max(0, (intent.slotLevel ?? 1) - 1)` → formula `${crit ? dice * 2 : dice}d8 + 3`.
  - Mock spells: give Fireball `slotLevels` via the existing `availableSlotLevels` (already there) — confirm `availableSlotLevels` returns levels ≥ spell level with remaining slots (it should; read it, fix if it returns only the base).

- [ ] **Step 2: Manual smoke** — `node apps/web/mock/server.mjs` then `curl -s -X POST localhost:8090/api/actors/a-sariel/actions -H "Authorization: Bearer demo" -H "Content-Type: application/json" -d '{"kind":"cast","actionId":"spell.s-fireball.cast","slotLevel":3}'` → 200, `slots.3` decremented in the returned sheet.

- [ ] **Step 3: Commit** — `feat(mock): slotLevel-aware casts, slot levels on resources, scaled damage`

---

### Task 9: Manual browser verification (mock stack)

**Files:** none (verification only; screenshots to the session scratchpad, NOT the repo)

- [ ] **Step 1:** Start `node apps/web/mock/server.mjs` and `pnpm --filter @companion/web dev` (backgrounded).
- [ ] **Step 2:** Open `http://localhost:3000/join?token=demo` → Sariel → Actions tab. Verify: level headers show gold pips matching the Vitals slot values; cantrips header has none.
- [ ] **Step 3:** Tap Cast on Fireball (multiple payable levels) → picker sheet lists "Cast at 3rd level · N left" style options. Cast at a higher level → the matching pips row loses one box; network request body carries the chosen `slotLevel`.
- [ ] **Step 4:** Roll the paired Dmg after the upcast → request body carries `slotLevel`; formula in the roll pill shows scaled dice. Roll Dmg again → no `slotLevel` (memory consumed).
- [ ] **Step 5:** Spells tab → per-level section headers show the same pips.
- [ ] **Step 6:** Kill both servers. Fix anything broken before committing a `fix:` commit if needed.

---

### Task 10: Docs — enable execute-js (module setting + relay scope)

**Files:**
- Modify: `docs/HOSTING.md` (troubleshooting/ops section), `docs/LLM-SETUP-RUNBOOK.md` (module settings step)

- [ ] **Step 1:** Add to both docs (adapted to each file's surrounding style):

> **Upcasting (cast at a higher spell level)** rides the relay's `execute-js` endpoint and is OFF until two switches are flipped:
> 1. Foundry → Configure Settings → REST API module → enable **"Allow Execute JS"**.
> 2. Relay web UI → the gateway's API key → grant the **`execute-js`** scope.
> Without them, base-level casting works normally and upcast attempts return a clear error naming this section. The gateway only ever sends a fixed script template (cast this spell consuming that slot) — phone clients cannot inject script text.

- [ ] **Step 2:** Commit — `docs: upcasting requires Allow Execute JS + execute-js scope`

---

### Task 11: Live verification gate (BEFORE any push)

**Files:** none — findings go to `docs/M-upcast-findings.md` if discrepancies appear.

Run against the live stack (the user's quickstart host; needs the relay URL + API key with `execute-js` scope + module setting enabled — coordinate with the user):

- [ ] **Step 1:** `curl -s -X POST "$RELAY/execute-js?clientId=$CLIENT" -H "x-api-key: $KEY" -H "Content-Type: application/json" -d '{"script":"return game.system.id + \" \" + game.system.version;"}'` → expect `dnd5e 5.3.3`. A scope/setting error here means the switches from Task 10 aren't flipped.
- [ ] **Step 2:** Pick a leveled spell on a test actor with a known slot state. POST the gateway upcast intent (or the raw script from Task 4 with real uuids). Verify in Foundry: the CHOSEN slot decremented (not base), chat card labeled with the chosen level, concentration applied if applicable, attack spells return `{ roll: … }`.
- [ ] **Step 3:** If `activity.use({ spell: { slot } })` does NOT consume the chosen slot on dnd5e 5.3.3 (shape drift), STOP: record the actual working shape (try `{ consume: { spellSlots: true } }` plural, or `spell: { slot: 3 }` numeric) in `docs/M-upcast-findings.md`, fix the Task 4 template + its test, re-run Tasks 4-5 suites.
- [ ] **Step 4:** Only after this passes: report ready-to-push to the user (do NOT push without their word).

---

## Self-review notes

- Spec coverage: descriptor semantics (T1), cast mapping incl. heals (T2), display scaling + cantrip tiers + pact + crit composition (T3), fixed script template + validation (T4), gateway wiring + damage slotLevel parse + actionable errors (T5), picker + counts + memory + toast (T6), pips both tabs + ResourceDescriptor.level (T7), mock parity (T8), manual verification (T9), docs (T10), live-verify gate (T11). Out-of-scope items from the spec are not implemented anywhere. ✓
- Type consistency: `castAtSlot(actorUuid, itemUuid, slotKey)` identical in foundry-client (T4), RelayPort + FakeRelay (T5). `cast-at-slot` RelayAction `{ itemId, slotKey }` (T1) consumed in T2/T5. Damage intent `slotLevel` (T1) produced by T6, parsed in T5, consumed in T3. `ResourceDescriptor.level` (T7) produced by adapter, consumed by SectionActions/SectionList. ✓
- Known judgment calls for implementers: exact anchor lines may have drifted a few lines — anchor by symbol names, not line numbers.
