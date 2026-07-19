# Buff Spells Apply As Conditions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Casting a self-buff spell (Shield, Mage Armor) applies the spell's own Active Effect to the caster, so it shows as a removable condition badge and the derived AC updates — no execute-js needed.

**Architecture:** The adapter detects a spell whose item carries a use-applied Active Effect and emits a new `cast-and-apply-effect` relay action (activate via use-spell/cast-at-slot, then create the effect on the actor via the relay's `PUT /update` embedded-upsert). App-applied effects are flagged; `parseEffects` surfaces them as conditions with a `removeActionId`, and an `endeffect` action deletes them via the existing `deleteEntity`.

**Tech Stack:** pnpm workspace, TypeScript strict, vitest, Nuxt 4 / Vue 3 PWA, Fastify gateway, foundryvtt-rest-api module+relay 3.4.1 (pinned), dnd5e 5.3.3 / Foundry v14.

**Spec:** `docs/superpowers/specs/2026-07-19-buff-effects-as-conditions-design.md`
**Root cause + live proof:** `docs/M-buff-effects-findings.md`

## Global Constraints

- Versions pinned (dnd5e 5.3.3, module/relay 3.4.1, Foundry v14) — no bumps.
- No rules engine: detection is data-shape only; the applied effect is copied verbatim from the spell item's own Active Effect (no invented changes/values).
- Buff-apply uses the relay `PUT /update` embedded-effect upsert (`entity:write`), NEVER execute-js — must work with "Allow Execute JS" off.
- Every app-applied effect carries `flags['unseen-servent'].appliedBy = 'app'`; that flag is the sole signal for "removable by the app" (never offer removal for GM/system effects).
- Self-target only. No target picker, no non-self buffs.
- Tests: vitest per package (`pnpm --filter <pkg> vitest run` / `... typecheck`). Skip `@companion/bootstrap` typecheck (pre-existing unrelated failure in test/update-cli.test.ts).
- Commit per task, `feat(scope): …` / `test(scope): …`, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`, multi-line messages via `git commit -F <tempfile>` (Windows/PowerShell mangles inline quotes). Commit on main; do NOT push (Task 8 live-verify gates the push).
- AE `_id` format everywhere: 16 chars matching `^[A-Za-z0-9]{16}$`.

---

### Task 1: SDK types

**Files:**
- Modify: `packages/adapter-sdk/src/index.ts` (Condition interface; SheetActionKind; ActionIntent; new EffectPayload; RelayAction)
- Test: none (type-only; `pnpm --filter @companion/adapter-sdk typecheck` is the gate)

**Interfaces:**
- Produces:
  - `Condition.removeActionId?: string`
  - `SheetActionKind` gains `'endeffect'`
  - `ActionIntent` gains `{ kind: 'endeffect'; actionId: string }`
  - `export interface EffectPayload { name: string; img?: string; changes: Array<{ key: string; mode: number; value: string }>; duration?: Record<string, unknown>; origin?: string }`
  - `RelayAction` gains `{ endpoint: 'cast-and-apply-effect'; use: 'use-spell' | 'cast-at-slot'; itemId: string; slotKey?: string; effect: EffectPayload }` and `{ endpoint: 'remove-effect'; effectId: string }`

- [ ] **Step 1: Condition.removeActionId** — in the `Condition` interface (currently `{ id; label; icon? }`) add:

```ts
  /** When set, this condition was applied by the app and can be removed from
   *  the badge — the id of an 'endeffect' action (2026-07-19 buff effects). */
  removeActionId?: string;
```

- [ ] **Step 2: SheetActionKind** — add after `'endconcentration'`:

```ts
  /** remove an app-applied active effect (buff), by its actionId (2026-07-19). */
  | 'endeffect'
```

- [ ] **Step 3: ActionIntent** — change the actor-scoped line to include `endeffect`:

```ts
  | { kind: 'rest' | 'deathsave' | 'endconcentration' | 'endeffect'; actionId: string }
```

- [ ] **Step 4: EffectPayload** — add near `RelayAction` (before it):

```ts
/** A Foundry Active Effect the app applies to an actor (2026-07-19 buff
 *  spells). Copied verbatim from the casting spell item's own effect — the
 *  app never invents `changes`. `mode` is Foundry's CONST.ACTIVE_EFFECT_MODES
 *  number; `origin` is the source item uuid. */
export interface EffectPayload {
  name: string;
  img?: string;
  changes: Array<{ key: string; mode: number; value: string }>;
  duration?: Record<string, unknown>;
  origin?: string;
}
```

- [ ] **Step 5: RelayAction variants** — add before the final `short-rest|…` member:

```ts
  /** Buff spell (dnd5e): activate the spell (consume the slot via use-spell,
   *  or cast-at-slot for an upcast) THEN create the spell's own Active Effect
   *  on the caster via the relay's PUT /update embedded-upsert — because the
   *  headless use-flow never applies self-effects (see M-buff-effects-findings).
   *  The gateway mints the effect `_id` and sets the unseen-servent flag. */
  | { endpoint: 'cast-and-apply-effect'; use: 'use-spell' | 'cast-at-slot'; itemId: string; slotKey?: string; effect: EffectPayload }
  /** Delete an app-applied active effect off the actor (buff removal); the
   *  gateway resolves `Actor.<id>.ActiveEffect.<effectId>` via deleteEntity. */
  | { endpoint: 'remove-effect'; effectId: string }
```

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @companion/adapter-sdk typecheck` → clean.
Commit: `feat(adapter-sdk): types for applying/removing buff active effects`

---

### Task 2: Adapter — detect self-buff spells, cast-and-apply-effect

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts` (new `selfBuffEffect`; `buildAction` case `'cast'`)
- Test: `packages/adapter-dnd5e/test/actions.test.ts`

**Interfaces:**
- Consumes: Task 1's `EffectPayload`, `cast-and-apply-effect` RelayAction; existing `effectTypeOf`, `payableSlotLevels`, `canCastAtBase`, `rec`, `strAt`, `getPath`, `numAt`.
- Produces: `selfBuffEffect(actor: FoundryActorDoc, item: FoundryItemDoc): EffectPayload | undefined`. `buildAction` cast returns `cast-and-apply-effect` when a self-buff effect is present.

- [ ] **Step 1: Failing tests** — append to `actions.test.ts`. Uses the existing `build`, `expectIntentError` helpers and `structuredClone` shim. Build a synthetic self-buff spell (Shield-shaped) on a clone of `casterCaptured`:

```ts
describe('buildAction — self-buff spells apply their active effect', () => {
  // A minimal Shield-shaped spell: level 1, an item Active Effect applied on
  // use (transfer:false) that adds +5 to ac.bonus. Cast at self.
  function withShield(base = casterCaptured): FoundryActorDoc {
    const actor = structuredClone(base);
    (actor.items as FoundryItemDoc[]).push({
      _id: 'spellShield0001',
      name: 'Shield',
      type: 'spell',
      system: {
        level: 1,
        school: 'abj',
        prepared: 1,
        method: 'spell',
        activities: { a1: { type: 'utility' } },
      },
      effects: [
        {
          _id: 'aeShield00000001',
          name: 'Shield',
          img: 'icons/svg/shield.svg',
          transfer: false,
          disabled: false,
          duration: { seconds: 6 },
          changes: [{ key: 'system.attributes.ac.bonus', mode: 2, value: '+5' }],
        },
      ],
    } as unknown as FoundryItemDoc);
    return actor;
  }

  it('a leveled self-buff cast at base -> cast-and-apply-effect via use-spell, effect copied verbatim', () => {
    const actor = withShield();
    expect(build(actor, { kind: 'cast', actionId: 'spell.spellShield0001.cast', slotLevel: 1 })).toEqual({
      endpoint: 'cast-and-apply-effect',
      use: 'use-spell',
      itemId: 'spellShield0001',
      effect: {
        name: 'Shield',
        img: 'icons/svg/shield.svg',
        changes: [{ key: 'system.attributes.ac.bonus', mode: 2, value: '+5' }],
        duration: { seconds: 6 },
        origin: 'Actor.pjJZgu4Hkiv43Yg9.Item.spellShield0001',
      },
    });
  });

  it('the same spell upcast -> cast-and-apply-effect via cast-at-slot', () => {
    // caster-captured has spell2.value>0; casting Shield (base 1) at 2 upcasts.
    const a = build(withShield(), { kind: 'cast', actionId: 'spell.spellShield0001.cast', slotLevel: 2 });
    expect(a).toMatchObject({ endpoint: 'cast-and-apply-effect', use: 'cast-at-slot', slotKey: 'spell2', itemId: 'spellShield0001' });
  });

  it('a spell with no use-applied effect is unaffected (Guiding Bolt still use-spell)', () => {
    expect(build(casterCaptured, { kind: 'cast', actionId: 'spell.pZMrJb3AXiRYO5E8.cast' })).toEqual({
      endpoint: 'use-spell',
      itemId: 'pZMrJb3AXiRYO5E8',
    });
  });

  it('a transfer:true (passive) item effect does NOT count as a castable buff', () => {
    const actor = withShield();
    const shield = (actor.items as FoundryItemDoc[]).find((i) => i._id === 'spellShield0001')!;
    (shield.effects as Array<Record<string, unknown>>)[0].transfer = true;
    expect(build(actor, { kind: 'cast', actionId: 'spell.spellShield0001.cast', slotLevel: 1 })).toEqual({
      endpoint: 'use-spell',
      itemId: 'spellShield0001',
    });
  });
});
```

Note: `casterCaptured`'s actor `_id` is `pjJZgu4Hkiv43Yg9` — confirm via the fixture and fix the `origin` expectation if it differs before running.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @companion/adapter-dnd5e vitest run actions.test.ts -t "self-buff"`
Expected: FAIL (cast returns `use-spell`, not `cast-and-apply-effect`).

- [ ] **Step 3: Implement `selfBuffEffect`** — add near `effectTypeOf` in `packages/adapter-dnd5e/src/index.ts`:

```ts
/**
 * The Active Effect a self-buff spell should apply to the caster on cast, or
 * undefined. Data-shape only (no rules engine): the spell item carries an
 * effect that is applied on use — `transfer: false` (not a passive/always-on
 * effect) with at least one `change` — and the spell isn't a heal/damage
 * effect. Copied verbatim; `origin` points at the embedded item so Foundry
 * shows provenance. dnd5e/DAE never applies these headless (M-buff-effects
 * findings), so the gateway creates the effect itself.
 */
function selfBuffEffect(actor: FoundryActorDoc, item: FoundryItemDoc): EffectPayload | undefined {
  if (item.type !== 'spell') return undefined;
  if (effectTypeOf(item) !== 'utility') return undefined; // heals/damage handled elsewhere
  const rawEffects = getPath(item, 'effects');
  const effects = Array.isArray(rawEffects) ? rawEffects : [];
  for (const raw of effects) {
    const eff = rec(raw);
    if (eff.transfer === true) continue; // passive/always-on, not a cast-applied buff
    if (eff.disabled === true) continue;
    const changes = Array.isArray(eff.changes)
      ? eff.changes
          .map(rec)
          .filter((c) => typeof c.key === 'string' && c.key !== '')
          .map((c) => ({
            key: c.key as string,
            mode: typeof c.mode === 'number' ? c.mode : 0,
            value: typeof c.value === 'string' ? c.value : String(c.value ?? ''),
          }))
      : [];
    if (changes.length === 0) continue;
    const name = typeof eff.name === 'string' && eff.name !== '' ? eff.name : item.name;
    return {
      name,
      ...(typeof eff.img === 'string' ? { img: eff.img } : {}),
      changes,
      ...(eff.duration !== undefined && eff.duration !== null ? { duration: rec(eff.duration) } : {}),
      origin: `Actor.${actor._id}.Item.${item._id}`,
    };
  }
  return undefined;
}
```

- [ ] **Step 4: Wire into `buildAction` cast** — in the `case 'cast':` block, AFTER `chosen`/`upcast` are resolved and BEFORE the heal check (so a heal spell never also becomes a buff), add:

```ts
      const buff = item ? selfBuffEffect(actor, item) : undefined;
      if (buff) {
        return {
          endpoint: 'cast-and-apply-effect',
          use: upcast ? 'cast-at-slot' : 'use-spell',
          itemId,
          ...(upcast ? { slotKey: `spell${chosen}` } : {}),
          effect: buff,
        };
      }
```

(Read the current `case 'cast':` first — Task-2 of the upcasting feature left `item`, `itemId`, `chosen`, `upcast` in scope; reuse them. Keep the existing heal and use-spell/cast-at-slot returns below this block unchanged.)

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @companion/adapter-dnd5e vitest run` → PASS; `pnpm --filter @companion/adapter-dnd5e typecheck` → clean.

- [ ] **Step 6: Commit** — `feat(adapter-dnd5e): cast self-buff spells via cast-and-apply-effect`

---

### Task 3: Adapter — removable condition badges + endeffect action

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts` (`parseEffects`; `buildActions`; `buildAction`)
- Test: `packages/adapter-dnd5e/test/actions.test.ts` (+ view-model assertions)

**Interfaces:**
- Consumes: Task 1's `Condition.removeActionId`, `endeffect` kind, `remove-effect` RelayAction.
- Produces:
  - `parseEffects` sets `removeActionId: "effect.<_id>.remove"` on conditions whose effect carries `flags['unseen-servent'].appliedBy`.
  - `buildActions` emits `{ id: "effect.<_id>.remove", kind: "endeffect", label: "End <name>" }` per app-applied effect.
  - `buildAction` case `'endeffect'` → `{ endpoint: 'remove-effect', effectId: '<_id>' }`.

- [ ] **Step 1: Failing tests** — append to `actions.test.ts`:

```ts
describe('app-applied effects are removable', () => {
  function withAppliedShield(): FoundryActorDoc {
    const actor = structuredClone(casterCaptured);
    (actor as unknown as { effects: unknown[] }).effects = [
      {
        _id: 'aeApplied0000001',
        name: 'Shield',
        icon: 'icons/svg/shield.svg',
        disabled: false,
        flags: { 'unseen-servent': { appliedBy: 'app' } },
      },
    ];
    return actor;
  }

  it('parseEffects marks the flagged effect with a removeActionId (still a badge)', () => {
    const vm = dnd5eAdapter.toViewModel(withAppliedShield());
    const shield = (vm.conditions ?? []).find((c) => c.label === 'Shield');
    expect(shield?.removeActionId).toBe('effect.aeApplied0000001.remove');
  });

  it('a GM/system effect (no flag) is a plain badge with no removeActionId', () => {
    const actor = structuredClone(casterCaptured);
    (actor as unknown as { effects: unknown[] }).effects = [
      { _id: 'aePoison00000001', name: 'Poisoned', disabled: false },
    ];
    const vm = dnd5eAdapter.toViewModel(actor);
    expect((vm.conditions ?? []).find((c) => c.label === 'Poisoned')?.removeActionId).toBeUndefined();
  });

  it('buildActions emits an endeffect action for the applied effect', () => {
    const actor = withAppliedShield();
    const a = actions(actor).find((x) => x.id === 'effect.aeApplied0000001.remove');
    expect(a).toEqual({ id: 'effect.aeApplied0000001.remove', kind: 'endeffect', label: 'End Shield' });
  });

  it('endeffect intent -> remove-effect with the effect id', () => {
    expect(build(withAppliedShield(), { kind: 'endeffect', actionId: 'effect.aeApplied0000001.remove' })).toEqual({
      endpoint: 'remove-effect',
      effectId: 'aeApplied0000001',
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @companion/adapter-dnd5e vitest run actions.test.ts -t "removable"`
Expected: FAIL.

- [ ] **Step 3: parseEffects** — in the conditions branch of `parseEffects`, replace the `conditions.push({...})` with a flag-aware version:

```ts
    const appliedBy = getPath(eff, 'flags.unseen-servent.appliedBy');
    conditions.push({
      id,
      label: name,
      ...(typeof eff.icon === 'string' ? { icon: eff.icon } : {}),
      ...(typeof appliedBy === 'string' && appliedBy !== '' ? { removeActionId: `effect.${id}.remove` } : {}),
    });
```

(`id` is already the effect `_id` per the existing code.)

- [ ] **Step 4: buildActions endeffect descriptors** — in `buildActions`, where the M8 actor-scoped commands are pushed (near `concentration.end`), add after the concentration block:

```ts
  for (const cond of parseEffects(actor).conditions) {
    if (cond.removeActionId !== undefined) {
      out.push({ id: cond.removeActionId, kind: 'endeffect', label: `End ${cond.label}` });
    }
  }
```

- [ ] **Step 5: buildAction endeffect** — in the `switch (intent.kind)`, add a case (near `endconcentration`):

```ts
    case 'endeffect': {
      const m = /^effect\.([A-Za-z0-9]{1,16})\.remove$/.exec(intent.actionId);
      if (!m) throw new IntentError(`bad endeffect action "${intent.actionId}"`, 'INVALID');
      return { endpoint: 'remove-effect', effectId: m[1] as string };
    }
```

- [ ] **Step 6: Run + commit**

Run: `pnpm --filter @companion/adapter-dnd5e vitest run` → PASS; typecheck clean.
Commit: `feat(adapter-dnd5e): removable app-applied effect badges + endeffect action`

---

### Task 4: foundry-client — applyEffect

**Files:**
- Modify: `packages/foundry-client/src/index.ts` (new `applyEffect`)
- Test: `packages/foundry-client/test/client.test.ts` (match the existing fetch-stub pattern in that file)

**Interfaces:**
- Consumes: existing private `request`, and `updateEntity`'s `PUT /update?uuid=…` convention.
- Produces: `async applyEffect(actorUuid: string, effect: Record<string, unknown>): Promise<void>` — `PUT /update?uuid=<actorUuid>` body `{ data: { effects: [effect] } }`. `effect` is a complete AE doc (the gateway supplies `_id`, `flags`, plus the EffectPayload fields).

- [ ] **Step 1: Failing test** — add to `client.test.ts` (adapt to the file's stub style):

```ts
describe('applyEffect', () => {
  it('PUTs /update with the actor uuid in the query and an effects-upsert body', async () => {
    // stub fetch to capture (method, url, body); respond 200 {}
    await client.applyEffect('Actor.abc123', { _id: 'aeXXXXXXXXXXXXXX', name: 'Shield', changes: [] });
    // captured: method PUT, path /update, query uuid=Actor.abc123,
    // body === { data: { effects: [{ _id: 'aeXXXXXXXXXXXXXX', name: 'Shield', changes: [] }] } }
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @companion/foundry-client vitest run` → FAIL (method missing).

- [ ] **Step 3: Implement** — add near `updateEntity`:

```ts
  /**
   * PUT /update — create/replace an Active Effect on an actor via the relay's
   * embedded-doc upsert (the effect is upserted by its `_id`). Used to apply
   * buff-spell effects the headless use-flow never applies (2026-07-19; see
   * docs/M-buff-effects-findings.md). Needs only `entity:write` — no
   * execute-js. `effect` is a full AE document (the caller supplies `_id`
   * and flags).
   */
  async applyEffect(actorUuid: string, effect: Record<string, unknown>): Promise<void> {
    await this.request('PUT', '/update', { uuid: actorUuid }, { data: { effects: [effect] } });
  }
```

- [ ] **Step 4: Run + commit** — `pnpm --filter @companion/foundry-client vitest run` + typecheck → clean. Commit: `feat(foundry-client): applyEffect creates an actor active effect via /update`

---

### Task 5: Gateway — execute cast-and-apply-effect + remove-effect

**Files:**
- Modify: `apps/gateway/src/app.ts` (RelayPort; `parseActionIntent`; execution switch; add an `_id` minter)
- Modify: `apps/gateway/test/fakes.ts` (FakeRelay + fake adapter)
- Test: `apps/gateway/test/app.test.ts`

**Interfaces:**
- Consumes: Task 4 `applyEffect`; existing `deleteEntity`, `useAbility`, `castAtSlot`, `upcastUnavailable`.
- Produces:
  - `RelayPort.applyEffect(actorUuid: string, effect: Record<string, unknown>): Promise<void>`
  - `parseActionIntent` handles `endeffect` (actionId only).
  - Execution: `cast-and-apply-effect` activates then applies a flagged effect with a minted `_id`; `remove-effect` calls `deleteEntity(Actor.<id>.ActiveEffect.<effectId>)`.

- [ ] **Step 1: FakeRelay + fake adapter** — in `fakes.ts`:

```ts
  // in FakeRelay:
  applyEffectCalls: Array<{ actorUuid: string; effect: Record<string, unknown> }> = [];
  async applyEffect(actorUuid: string, effect: Record<string, unknown>): Promise<void> {
    this.applyEffectCalls.push({ actorUuid, effect });
  }
```

Fake adapter `actionList`: add `{ id: 'spell.b1.cast', label: 'Shield', kind: 'cast', level: 1, slotLevels: [1, 2], effectType: 'utility' }` and `{ id: 'effect.aeFake0000000001.remove', label: 'End Shield', kind: 'endeffect' }`. In `buildAction`: for `spell.b1.cast` return `{ endpoint: 'cast-and-apply-effect', use: intent.slotLevel && intent.slotLevel > 1 ? 'cast-at-slot' : 'use-spell', itemId: 'b1', ...(intent.slotLevel && intent.slotLevel > 1 ? { slotKey: 'spell'+intent.slotLevel } : {}), effect: { name: 'Shield', changes: [{ key: 'system.attributes.ac.bonus', mode: 2, value: '+5' }], origin: 'Actor.a1.Item.b1' } }`; for the `endeffect` kind return `{ endpoint: 'remove-effect', effectId: 'aeFake0000000001' }`.

- [ ] **Step 2: Failing tests** — in `app.test.ts` `actions` describe:

```ts
  it('casting a self-buff activates then applies a flagged effect', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.b1.cast', slotLevel: 1 });
    expect(res.statusCode).toBe(200);
    expect(relay.useAbilityCalls).toEqual([
      { endpoint: 'use-spell', actorUuid: 'Actor.a1', itemUuid: 'Actor.a1.Item.b1', opts: {} },
    ]);
    expect(relay.applyEffectCalls).toHaveLength(1);
    const eff = relay.applyEffectCalls[0]!.effect;
    expect(eff.name).toBe('Shield');
    expect(/^[A-Za-z0-9]{16}$/.test(String(eff._id))).toBe(true);
    expect((eff.flags as Record<string, Record<string, unknown>>)['unseen-servent'].appliedBy).toBe('app');
  });

  it('endeffect removes the active effect by uuid', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'endeffect', actionId: 'effect.aeFake0000000001.remove' });
    expect(res.statusCode).toBe(200);
    expect(relay.deletedUuids).toContain('Actor.a1.ActiveEffect.aeFake0000000001');
  });
```

(Check `fakes.ts` for the exact name of FakeRelay's delete-tracking array — use it in place of `deletedUuids` if different.)

- [ ] **Step 3: Run to verify failure** — `pnpm --filter @companion/gateway vitest run app.test.ts` → FAIL.

- [ ] **Step 4: Implement** — in `app.ts`:

RelayPort: add `applyEffect(actorUuid: string, effect: Record<string, unknown>): Promise<void>;`

`parseActionIntent`: change the actor-command case to include `endeffect`:

```ts
    case 'rest':
    case 'deathsave':
    case 'endconcentration':
    case 'endeffect':
      return { kind, actionId };
```

Add an id minter near the top-level helpers:

```ts
const AE_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** A Foundry-style 16-char document id for an app-applied effect. */
function mintEffectId(): string {
  let s = '';
  for (let i = 0; i < 16; i++) s += AE_ID_ALPHABET[Math.floor(Math.random() * AE_ID_ALPHABET.length)];
  return s;
}
```

Execution switch — two new cases:

```ts
        case 'cast-and-apply-effect': {
          try {
            if (action.use === 'cast-at-slot') {
              await relay.castAtSlot(`Actor.${id}`, `Actor.${id}.Item.${action.itemId}`, action.slotKey as string);
            } else {
              await relay.useAbility('use-spell', `Actor.${id}`, `Actor.${id}.Item.${action.itemId}`, {});
            }
          } catch (err) {
            const status = (err as { status?: unknown }).status;
            if (err instanceof Error && err.name === 'RelayError' && status === 408) {
              req.log.warn({ err }, 'cast-and-apply-effect: activation timed out; applying the effect anyway');
            } else {
              const mapped = action.use === 'cast-at-slot' ? upcastUnavailable(err) : null;
              if (mapped) return sendError(reply, 422, 'INVALID_INTENT', mapped);
              throw err;
            }
          }
          await relay.applyEffect(`Actor.${id}`, {
            _id: mintEffectId(),
            ...action.effect,
            flags: { 'unseen-servent': { appliedBy: 'app' } },
          });
          break;
        }
        case 'remove-effect':
          await relay.deleteEntity(`Actor.${id}.ActiveEffect.${action.effectId}`);
          break;
```

- [ ] **Step 5: Run + commit** — `pnpm --filter @companion/gateway vitest run` + typecheck → clean. Commit: `feat(gateway): execute cast-and-apply-effect and remove-effect`

---

### Task 6: PWA — removable buff badges

**Files:**
- Modify: `apps/web/app/components/ConditionBadges.vue` (× on removable badges)
- Modify: `apps/web/app/pages/actor/[id].vue` (pass through; handle `endeffect`)
- Test: none (no web unit tests; `pnpm --filter @companion/web typecheck` + Task 8 live-verify)

**Interfaces:**
- Consumes: Task 1 `Condition.removeActionId`, `endeffect` intent.
- Produces: ConditionBadges emits `('action', removeActionId)`; `[id].vue` maps `endeffect` to a confirm + `submitAction`.

- [ ] **Step 1: ConditionBadges** — add an emit and a × button. Change `defineProps` to keep `conditions`, add:

```ts
const emit = defineEmits<{ (e: 'action', actionId: string): void }>()
```

In the template, after `{{ c.label }}` inside the badge, add:

```vue
      <button
        v-if="c.removeActionId"
        type="button"
        class="remove"
        :aria-label="`Remove ${c.label}`"
        @click="emit('action', c.removeActionId!)"
      >×</button>
```

Add minimal CSS:

```css
.remove {
  margin-left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: none;
  background: color-mix(in srgb, var(--garnet) 24%, transparent);
  color: var(--garnet);
  font-size: 0.8rem;
  line-height: 1;
  cursor: pointer;
}
```

- [ ] **Step 2: [id].vue wiring** — where `<ConditionBadges :conditions="…">` is rendered, add `@action="onConditionAction"`. Add the handler near `onEndConcentration`:

```ts
async function onConditionAction(actionId: string): Promise<void> {
  if (offline.value || actionBusy.value) return
  const action = actionMap.value[actionId]
  if (!action || action.kind !== 'endeffect') return
  const label = action.label.replace(/^End /, '')
  const ok = await askConfirm(`Remove ${label}?`)
  if (!ok) return
  void submitAction({ kind: 'endeffect', actionId }, action.label)
}
```

(Confirm `actionMap`, `askConfirm`, `submitAction`, `actionBusy`, `offline` are the names already used in this file — they are, per onEndConcentration.)

- [ ] **Step 3: submitAction toast** — `endeffect` returns no roll; ensure `submitAction`'s no-result switch has a sensible default (it already toasts "<label> done" for unknown kinds; add an `endeffect` branch if you want "Removed <name>"). Minimal: add to the switch:

```ts
      case 'endeffect':
        toast.show(`${label.replace(/^End /, '')} removed`)
        break
```

- [ ] **Step 4: Typecheck + commit** — `pnpm --filter @companion/web typecheck` → clean. Commit: `feat(web): remove app-applied buff effects from the condition badge`

---

### Task 7: Mock gateway parity

**Files:**
- Modify: `apps/web/mock/server.mjs`

**Interfaces:**
- Produces: a self-buff spell on Sariel; `cast-and-apply-effect` pushes a flagged condition + raises mock AC; `endeffect`/`remove-effect` removes it + reverts AC.

- [ ] **Step 1: Implement** —
  - Add a Shield spell to Sariel's `staticSections.spells`: `{ id: 's-shield', label: 'Shield', sub: '1st · V,S', level: 1, effectType: 'utility' }` and give it an internal buff marker the mock's `buildActions`/cast handler can read, e.g. `buff: { name: 'Shield', ac: 5 }`.
  - `buildActions`: for a spell with `buff`, keep emitting the normal cast action (the mock doesn't need to emit cast-and-apply-effect as an action — the cast handler branches on `buff`).
  - Cast handler: when the cast target has `buff`, after the slot decrement, push `{ id: 'ae-shield', label: 'Shield', removeActionId: 'effect.ae-shield.remove' }` onto the actor's `conditions` (dedupe), bump a mock AC modifier so the sheet AC reflects +5, and also emit an `endeffect` action `{ id: 'effect.ae-shield.remove', kind: 'endeffect', label: 'End Shield' }` from buildActions when that condition is present.
  - `handleAction`: accept `kind === 'endeffect'`; on `effect.ae-shield.remove` remove the condition + the AC modifier. Add `'endeffect'` to the mock's ACTION_KINDS.
  - Ensure `conditions` are echoed in `buildSheet` with `removeActionId` intact.

- [ ] **Step 2: Smoke** — `node apps/web/mock/server.mjs`; `curl` a `{kind:'cast',actionId:'spell.s-shield.cast',slotLevel:1}` → 200, returned sheet has a Shield condition with `removeActionId` and AC +5; then `{kind:'endeffect',actionId:'effect.ae-shield.remove'}` → condition gone, AC back. Kill the server.

- [ ] **Step 3: Commit** — `feat(mock): self-buff cast applies a removable condition + AC bump`

---

### Task 8: Live verification (before push)

**Files:** none (drive the real stack; screenshots to the session scratchpad, NOT the repo).

- [ ] **Step 1:** Deploy the branch to the host (the operator runs `make update`, or coordinate) so gateway/web carry the new code. Confirm the world is online (`curl -s http://localhost:8080/healthz`).
- [ ] **Step 2:** In the PWA (or via the gateway API with a test token), cast Shield on a caster. Verify the returned sheet: AC rose by the effect amount and a "Shield" condition badge with a removal affordance is present.
- [ ] **Step 3:** Confirm Mage Armor's real effect shape via a read-only relay probe (`execute-js` read, or `/get` for `items[].effects`) — verify `selfBuffEffect` would pick it up; note any shape difference in `docs/M-buff-effects-findings.md` and fix the detector if needed.
- [ ] **Step 4:** Remove the buff from the badge; verify AC reverts and the effect is gone from `actor.effects` (read-only relay check). Leave the actor as found.
- [ ] **Step 5:** Report ready-to-push to the user (do NOT push without their word).

---

## Self-review notes
- Spec coverage: SDK types (T1), detection + cast-and-apply (T2), removable badges + endeffect (T3), applyEffect transport (T4), gateway execute + minted id/flag + remove via deleteEntity (T5), PWA badge × + handler (T6), mock parity (T7), live-verify incl. Mage Armor shape check (T8). Out-of-scope items (target picker, non-self, execute-js) implemented nowhere. ✓
- Type consistency: `EffectPayload` (T1) produced by `selfBuffEffect` (T2), carried in `cast-and-apply-effect` (T1/T2/T5); `remove-effect { effectId }` (T1) built in T3, executed in T5; `Condition.removeActionId` (T1) set in T3, consumed in T6; `applyEffect(actorUuid, effect)` identical in foundry-client (T4) + RelayPort/FakeRelay (T5). ✓
- Anchor by symbol names; the upcasting feature left `item/itemId/chosen/upcast` in the cast case (T2 depends on them) — verify before editing.
