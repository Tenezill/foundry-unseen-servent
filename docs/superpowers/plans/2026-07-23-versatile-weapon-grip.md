# Versatile Weapon Grip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a player set a persistent one-handed/two-handed grip on versatile weapons so the larger versatile die (e.g. longsword `1d8`→`1d10`) drives both the exact combat damage roll and the best-effort standalone Dmg estimate.

**Architecture:** Grip is a per-weapon Foundry item flag (`flags.unseen-servent.grip`) written via the existing `update-item` relay path. The dnd5e adapter reads the flag to (a) pick the two-handed die in the client-side `weaponDamageFormula`, (b) label the attack row, and (c) pass dnd5e's `attackMode` to Foundry on the targeted-combat path so Foundry rolls the correct die itself. A `[1H|2H]` pill on the inventory row toggles the flag; the active die shows on the versatile weapon's attack row.

**Tech Stack:** TypeScript monorepo (pnpm workspace), Vitest, Fastify (gateway), Nuxt/Vue 3 (web), dnd5e 5.3.3 on Foundry 13.

## Global Constraints

- Grip flag path is exactly **`flags.unseen-servent.grip`**, value **`"oneHanded"` | `"twoHanded"`** (the app's existing flag namespace — see `flags.unseen-servent.appliedBy`).
- Grip applies **only to weapons with the `"ver"` property**; every other item ignores it. Default grip is **`"oneHanded"`** (absent flag = one-handed).
- Grip changes the **damage die only** — never the attack bonus.
- No new relay endpoint: grip writes reuse **`update-item`** (`relay.updateEntity`).
- Combat swings are **exact** (Foundry rolls, `attackMode` passed to it); the standalone Dmg button is a **best-effort client estimate** — same contract already in `weaponDamageFormula`'s header.
- Package names: `@companion/adapter-sdk`, `@companion/adapter-dnd5e`, `@companion/gateway`, `@companion/foundry-client`, `@companion/web`.
- Per-package test: `pnpm --filter <pkg> test` (runs `vitest run`). Single file/name: `pnpm --filter <pkg> exec vitest run <file> -t "<name>"`. Typecheck: `pnpm --filter <pkg> typecheck`.
- **Every commit message ends with the trailer** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (omitted from the `git commit` examples below for brevity — add it).
- Work happens on the existing branch **`feat/versatile-grip`**.

## File Structure

- `packages/adapter-sdk/src/index.ts` — add `grip` action kind, `ActionDescriptor.grip`/`.sub`, `ListItem.gripActionId`, `ActionIntent` grip variant, `RelayAction` `use-on-targets.attackMode`. (Type surface only.)
- `packages/adapter-dnd5e/src/index.ts` — grip helpers, `weaponDamageFormula` change, grip descriptor + inventory pill + attack sub-line + shield hint, `case 'grip'`, `attackMode` on the targeted attack.
- `packages/adapter-dnd5e/test/actions.test.ts` — all adapter unit tests (new `describe` blocks; reuse existing helpers).
- `apps/gateway/src/app.ts` — `parseActionIntent` grip case; forward `attackMode` on `use-on-targets`; `RelayPort.useAbilityOnTargets` opts gain `attackMode`.
- `apps/gateway/test/fakes.ts` — fake adapter grip action + buildAction case; `FakeRelay.useAbilityOnTargets` opts type gains `attackMode`.
- `apps/gateway/test/app.test.ts` — grip route test + attackMode forwarding test.
- `packages/foundry-client/src/index.ts` — thread `attackMode` through `useAbilityOnTargets` → `targetedUseScript` (attack config + damage config).
- `packages/foundry-client/test/client.test.ts` — script-generation test.
- `apps/web/app/components/SectionList.vue` — `[1H|2H]` pill on inventory rows.
- `apps/web/app/pages/actor/[id].vue` — `grip` intent build + toast.

---

### Task 1: Adapter — grip-aware damage die

Client-side damage resolution reads the grip flag and picks the versatile die. Self-contained in the adapter; no SDK change needed (`weaponDamageFormula` is internal).

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts` (helpers near `weaponDamageFormula:1781`; rewrite `weaponDamageFormula`)
- Test: `packages/adapter-dnd5e/test/actions.test.ts`

**Interfaces:**
- Consumes: `getPath`, `rec`, `numAt`, `strAt`, `weaponAbilityMod`, `FoundryItemDoc`, `FoundryActorDoc` (existing).
- Produces (used by later tasks): `isVersatileWeapon(item): boolean`, `weaponGrip(item): 'oneHanded' | 'twoHanded'`, `gripDice(item, grip): { number: number; denomination: number } | undefined`, `versatileAttackSub(item): string | undefined`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/adapter-dnd5e/test/actions.test.ts` (the longsword `item.gta26ORvqC323k3r` in `martialCaptured` is versatile, base `1d8` slashing, empty `damage.versatile`):

```ts
describe('versatile weapon grip — damage die', () => {
  const LS = 'item.gta26ORvqC323k3r';
  const dmg = (a: FoundryActorDoc) => formulaOf(a, { kind: 'damage', actionId: `${LS}.damage` });

  function withGrip(grip: 'oneHanded' | 'twoHanded'): FoundryActorDoc {
    const a = structuredClone(martialCaptured);
    const ls = (a.items ?? []).find((i) => i._id === 'gta26ORvqC323k3r')!;
    (ls as { flags?: Record<string, unknown> }).flags = { 'unseen-servent': { grip } };
    return a;
  }

  it('one-handed (default, no flag) uses the base die 1d8', () => {
    expect(dmg(martialCaptured).startsWith('1d8')).toBe(true);
  });

  it('two-handed steps the empty versatile die up one size to 1d10, keeping the bonus', () => {
    const oneH = dmg(martialCaptured);
    const twoH = dmg(withGrip('twoHanded'));
    expect(twoH).toBe(oneH.replace('1d8', '1d10'));
  });

  it('two-handed prefers an explicit populated versatile die', () => {
    const a = withGrip('twoHanded');
    const ls = (a.items ?? []).find((i) => i._id === 'gta26ORvqC323k3r')!;
    (ls.system as Record<string, unknown>).damage = {
      base: { number: 1, denomination: 8, bonus: '', types: ['slashing'] },
      versatile: { number: 2, denomination: 6, bonus: '', types: ['slashing'] },
    };
    expect(dmg(a).startsWith('2d6')).toBe(true);
  });

  it('a non-versatile weapon ignores the grip flag', () => {
    const a = structuredClone(martialCaptured);
    const ls = (a.items ?? []).find((i) => i._id === 'gta26ORvqC323k3r')!;
    (ls.system as Record<string, unknown>).properties = []; // drop "ver"
    (ls as { flags?: Record<string, unknown> }).flags = { 'unseen-servent': { grip: 'twoHanded' } };
    expect(dmg(a).startsWith('1d8')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @companion/adapter-dnd5e exec vitest run test/actions.test.ts -t "versatile weapon grip — damage die"`
Expected: FAIL (two-handed still returns `1d8`; explicit-versatile still `1d8`).

- [ ] **Step 3: Add the helpers**

Insert immediately above `weaponDamageFormula` (currently `packages/adapter-dnd5e/src/index.ts:1781`):

```ts
/** Weapon carries dnd5e's versatile ("ver") property. */
function isVersatileWeapon(item: FoundryItemDoc): boolean {
  if (item.type !== 'weapon') return false;
  const props = getPath(item.system, 'properties');
  return Array.isArray(props) && props.includes('ver');
}

/** Wielded grip for a versatile weapon, from the app's own item flag. Anything
 *  but the explicit 'twoHanded' flag is one-handed (the default). */
function weaponGrip(item: FoundryItemDoc): 'oneHanded' | 'twoHanded' {
  return getPath(item, 'flags.unseen-servent.grip') === 'twoHanded' ? 'twoHanded' : 'oneHanded';
}

/** Next larger polyhedral die (d4→d6→d8→d10→d12; d12 and anything unusual are
 *  returned unchanged). SRD versatile weapons all step exactly one size, so this
 *  reproduces the two-handed die when the item leaves `damage.versatile` empty. */
function stepUpDenomination(denomination: number): number {
  const ladder = [4, 6, 8, 10, 12];
  const i = ladder.indexOf(denomination);
  return i >= 0 && i < ladder.length - 1 ? (ladder[i + 1] as number) : denomination;
}

/** Read a {number, denomination} dice block off `item.system.<path>`, or
 *  undefined when either is missing/non-positive. */
function readDice(item: FoundryItemDoc, path: string): { number: number; denomination: number } | undefined {
  const d = rec(getPath(item.system, path));
  const number = typeof d.number === 'number' && Number.isFinite(d.number) ? d.number : undefined;
  const denomination = typeof d.denomination === 'number' && Number.isFinite(d.denomination) ? d.denomination : undefined;
  if (number === undefined || denomination === undefined || number <= 0 || denomination <= 0) return undefined;
  return { number, denomination };
}

/** Two-handed damage dice for a versatile weapon: the explicit versatile die
 *  when populated, else the base die stepped up one size. */
function versatileDice(item: FoundryItemDoc): { number: number; denomination: number } | undefined {
  const explicit = readDice(item, 'damage.versatile');
  if (explicit !== undefined) return explicit;
  const base = readDice(item, 'damage.base');
  return base === undefined ? undefined : { number: base.number, denomination: stepUpDenomination(base.denomination) };
}

/** Damage dice a versatile weapon rolls under `grip` (base one-handed,
 *  versatile two-handed). Shared by the formula and the attack sub-line so they
 *  never disagree. */
function gripDice(item: FoundryItemDoc, grip: 'oneHanded' | 'twoHanded'): { number: number; denomination: number } | undefined {
  return grip === 'twoHanded' ? versatileDice(item) : readDice(item, 'damage.base');
}

/** Active-die sub-line for a versatile weapon's attack row, e.g.
 *  "1d10 slashing · two-handed". Undefined for non-versatile weapons. */
function versatileAttackSub(item: FoundryItemDoc): string | undefined {
  if (!isVersatileWeapon(item)) return undefined;
  const grip = weaponGrip(item);
  const dice = gripDice(item, grip);
  if (dice === undefined) return undefined;
  const types = getPath(item.system, 'damage.base.types');
  const type = Array.isArray(types) && typeof types[0] === 'string' ? (types[0] as string) : undefined;
  const gripLabel = grip === 'twoHanded' ? 'two-handed' : 'one-handed';
  return `${dice.number}d${dice.denomination}${type !== undefined ? ` ${type}` : ''} · ${gripLabel}`;
}
```

- [ ] **Step 4: Rewrite `weaponDamageFormula` to use `gripDice`**

Replace the body of `weaponDamageFormula` (currently `:1781`-`:1793`) with:

```ts
function weaponDamageFormula(actor: FoundryActorDoc, item: FoundryItemDoc): string | undefined {
  const grip = isVersatileWeapon(item) ? weaponGrip(item) : 'oneHanded';
  const dice = gripDice(item, grip);
  if (dice === undefined) return undefined;
  const diceStr = `${dice.number}d${dice.denomination}`;
  const base = rec(getPath(item.system, 'damage.base'));
  const rawBonus = typeof base.bonus === 'string' ? Number(base.bonus) : 0;
  const staticBonus = Number.isFinite(rawBonus) ? rawBonus : 0;
  const bonus = staticBonus + weaponAbilityMod(actor, item);
  if (bonus === 0) return diceStr;
  return `${diceStr} ${bonus < 0 ? '-' : '+'} ${Math.abs(bonus)}`;
}
```

- [ ] **Step 5: Run the tests to verify they pass, plus the full adapter suite (no regressions)**

Run: `pnpm --filter @companion/adapter-dnd5e test`
Expected: PASS (new grip block green; existing damage/attack/equip tests unchanged).

- [ ] **Step 6: Commit**

```bash
git add packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/actions.test.ts
git commit -m "feat(adapter): grip-aware versatile weapon damage die"
```

---

### Task 2: Grip toggle — state, descriptor, intent

Adds the `grip` action kind end-to-end: SDK types, the adapter's grip descriptor + inventory `gripActionId` + `case 'grip'` write, and the gateway's intent parse.

**Files:**
- Modify: `packages/adapter-sdk/src/index.ts` (`SheetActionKind`, `ActionDescriptor`, `ActionIntent`, `ListItem`)
- Modify: `packages/adapter-dnd5e/src/index.ts` (`buildActions` weapon block; `inventoryListItem`; intent switch `case 'grip'`)
- Modify: `apps/gateway/src/app.ts` (`parseActionIntent`)
- Modify: `apps/gateway/test/fakes.ts` (fake adapter: grip action + buildAction case)
- Test: `packages/adapter-dnd5e/test/actions.test.ts`, `apps/gateway/test/app.test.ts`

**Interfaces:**
- Consumes: `isVersatileWeapon`, `weaponGrip` (Task 1); `IntentError` (existing).
- Produces: SDK `grip` kind; `ActionDescriptor.grip?: 'oneHanded' | 'twoHanded'`; `ListItem.gripActionId?: string`; `ActionIntent` variant `{ kind: 'grip'; actionId: string; grip: 'oneHanded' | 'twoHanded' }`; adapter emits `item.<id>.grip` descriptors and returns `{ endpoint: 'update-item', itemId, data: { 'flags.unseen-servent.grip': grip } }`.

- [ ] **Step 1: Add the SDK types**

In `packages/adapter-sdk/src/index.ts`:

`SheetActionKind` — add after `'attune'` (`:246`):
```ts
  /** toggle a versatile weapon's one-/two-handed grip (item-flag write,
   *  no chat card; mirrors equip/prepare/attune). */
  | 'grip'
```

`ActionDescriptor` — add after `attuned?` (`:286`):
```ts
  /** grip only: current one-/two-handed state (the intent carries the desired
   *  state). Set only for versatile weapons. */
  grip?: 'oneHanded' | 'twoHanded';
```

`ListItem` — add after `attuneActionId?` (`:113`):
```ts
  /** Grip toggle action (versatile weapons): a [1H|2H] pill next to the equip
   *  pill. Only set for weapons with the "ver" property. */
  gripActionId?: string;
```

`ActionIntent` — add after the `attune` variant (`:314`):
```ts
  | { kind: 'grip'; actionId: string; grip: 'oneHanded' | 'twoHanded' }
```

- [ ] **Step 2: Write the failing adapter tests**

Add to `packages/adapter-dnd5e/test/actions.test.ts`:

```ts
describe('versatile weapon grip — toggle', () => {
  const LS = 'item.gta26ORvqC323k3r';

  it('emits a grip descriptor for a versatile weapon, defaulting to one-handed', () => {
    const g = action(martialCaptured, `${LS}.grip`);
    expect(g.kind).toBe('grip');
    expect(g.grip).toBe('oneHanded');
  });

  it('the grip descriptor reflects the stored two-handed flag', () => {
    const a = structuredClone(martialCaptured);
    const ls = (a.items ?? []).find((i) => i._id === 'gta26ORvqC323k3r')!;
    (ls as { flags?: Record<string, unknown> }).flags = { 'unseen-servent': { grip: 'twoHanded' } };
    expect(action(a, `${LS}.grip`).grip).toBe('twoHanded');
  });

  it('does not emit a grip descriptor for a non-weapon (the Shield)', () => {
    expect(actions(martialCaptured).find((x) => x.id === 'item.u69KONMFqydKuk1H.grip')).toBeUndefined();
  });

  it('the inventory row for a versatile weapon carries a gripActionId', () => {
    const rows = section(martialCaptured, 'inventory').kind === 'list'
      ? (section(martialCaptured, 'inventory') as Extract<SheetSection, { kind: 'list' }>).items
      : [];
    const ls = rows.find((r) => r.id === 'gta26ORvqC323k3r');
    expect(ls?.gripActionId).toBe(`${LS}.grip`);
  });

  it('buildAction writes the grip flag via update-item', () => {
    const out = build(martialCaptured, { kind: 'grip', actionId: `${LS}.grip`, grip: 'twoHanded' });
    expect(out).toEqual({
      endpoint: 'update-item',
      itemId: 'gta26ORvqC323k3r',
      data: { 'flags.unseen-servent.grip': 'twoHanded' },
    });
  });

  it('buildAction rejects an invalid grip value', () => {
    let code: string | undefined;
    try {
      build(martialCaptured, { kind: 'grip', actionId: `${LS}.grip`, grip: 'threeHanded' as unknown as 'twoHanded' });
    } catch (e) {
      code = (e as InstanceType<typeof IntentError>).code;
    }
    expect(code).toBe('INVALID');
  });
});
```

Note: confirm the inventory section id is `'inventory'` — if the adapter uses a different id, read it via `dnd5eAdapter.toViewModel(martialCaptured).sections` and adjust the `section(...)` id in the test.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @companion/adapter-dnd5e exec vitest run test/actions.test.ts -t "versatile weapon grip — toggle"`
Expected: FAIL (no grip descriptor; `case 'grip'` unhandled → falls to the default IntentError with the wrong message/route).

- [ ] **Step 4: Emit the grip descriptor in `buildActions`**

In `buildActions`, inside the `for (const item of actor.items ?? [])` loop, add after the `isAttuneable(item)` block (near `:2048`):

```ts
    if (isVersatileWeapon(item)) {
      out.push({ id: `item.${item._id}.grip`, label: item.name, kind: 'grip', grip: weaponGrip(item) });
    }
```

- [ ] **Step 5: Add `gripActionId` to the inventory row**

In `inventoryListItem` (`:1256`), add to the returned object literal, next to the `attuneActionId` line (`:1294`):

```ts
    ...(isVersatileWeapon(item) ? { gripActionId: `item.${item._id}.grip` } : {}),
```

- [ ] **Step 6: Handle `case 'grip'` in the intent switch**

In the `buildAction` intent switch, add after `case 'attune'` (`:2400`):

```ts
    case 'grip': {
      if (intent.grip !== 'oneHanded' && intent.grip !== 'twoHanded') {
        throw new IntentError('grip requires "oneHanded" or "twoHanded"', 'INVALID');
      }
      return {
        endpoint: 'update-item',
        itemId: intent.actionId.slice('item.'.length, -'.grip'.length),
        data: { 'flags.unseen-servent.grip': intent.grip },
      };
    }
```

- [ ] **Step 7: Run the adapter tests**

Run: `pnpm --filter @companion/adapter-dnd5e test`
Expected: PASS.

- [ ] **Step 8: Add the gateway parse case**

In `apps/gateway/src/app.ts` `parseActionIntent`, add after `case 'attune'` (`:422`):

```ts
    case 'grip':
      if (body.grip !== 'oneHanded' && body.grip !== 'twoHanded') return null;
      return { kind, actionId, grip: body.grip };
```

- [ ] **Step 9: Extend the fake adapter, then write the failing gateway test**

In `apps/gateway/test/fakes.ts`, add a grip action to the fake adapter's actions list (next to the `attune`/`move` entries near `:549`):

```ts
    { id: 'item.i1.grip', label: 'Arrows', kind: 'grip', grip: 'oneHanded' },
```

and add a `case 'grip'` to the fake adapter's `buildAction` switch (next to `case 'prepare'`/`case 'move'` near `:728`):

```ts
      case 'grip':
        return { endpoint: 'update-item', itemId: 'i1', data: { 'flags.unseen-servent.grip': intent.grip } };
```

Add to `apps/gateway/test/app.test.ts` (mirror the existing action-route injection pattern — `POST /api/actors/:id/actions`, `asAnna` headers):

```ts
it('accepts a valid grip intent and writes the flag via update-item', async () => {
  const { app, relay } = /* the existing per-suite setup that wires the fake adapter + FakeRelay */ setup();
  const res = await app.inject({
    method: 'POST',
    url: `/api/actors/${actorId}/actions`,
    headers: asAnna,
    payload: { kind: 'grip', actionId: 'item.i1.grip', grip: 'twoHanded' },
  });
  expect(res.statusCode).toBe(200);
  expect(relay.updateEntityCalls.at(-1)?.data).toEqual({ 'flags.unseen-servent.grip': 'twoHanded' });
});

it('rejects an invalid grip value', async () => {
  const { app } = setup();
  const res = await app.inject({
    method: 'POST',
    url: `/api/actors/${actorId}/actions`,
    headers: asAnna,
    payload: { kind: 'grip', actionId: 'item.i1.grip', grip: 'threeHanded' },
  });
  expect(res.statusCode).toBe(400);
});
```

Note: use whatever the surrounding `describe` already uses for app/relay setup, `actorId`, and `asAnna` (copy from a neighbouring action-route test in the same file). If `FakeRelay` records `updateEntity` under a different property than `updateEntityCalls`, grep `fakes.ts` for the `updateEntity(` method and assert on its recorder (or assert only `statusCode === 200` for the valid case and keep the flag-data assertion on the adapter unit test in Step 2).

- [ ] **Step 10: Run the gateway tests to verify fail → pass**

Run: `pnpm --filter @companion/gateway test`
Expected: initially the two new tests FAIL (parse returns null → 400 for the valid case, or the fake adapter has no grip action), then PASS after Steps 8–9.

- [ ] **Step 11: Typecheck the touched packages**

Run: `pnpm --filter @companion/adapter-sdk typecheck && pnpm --filter @companion/adapter-dnd5e typecheck && pnpm --filter @companion/gateway typecheck`
Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add packages/adapter-sdk/src/index.ts packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/actions.test.ts apps/gateway/src/app.ts apps/gateway/test/fakes.ts apps/gateway/test/app.test.ts
git commit -m "feat: versatile grip toggle action (SDK + adapter + gateway parse)"
```

---

### Task 3: Attack-row die sub-line + shield-conflict hint

Show the active die on a versatile weapon's attack row, and a subtle inventory badge when a two-handed grip coexists with an equipped shield.

**Files:**
- Modify: `packages/adapter-sdk/src/index.ts` (`ActionDescriptor.sub`)
- Modify: `packages/adapter-dnd5e/src/index.ts` (`hasEquippedShield`; `buildActions` attack row `sub`; `inventoryListItem` conflict tag + `shieldEquipped` param; both call sites)
- Test: `packages/adapter-dnd5e/test/actions.test.ts`

**Interfaces:**
- Consumes: `isVersatileWeapon`, `weaponGrip`, `versatileAttackSub` (Task 1); `strAt`, `getPath`, `hasStealthDisadvantageArmor` pattern (existing).
- Produces: `ActionDescriptor.sub?: string`; `hasEquippedShield(actor): boolean`; `inventoryListItem(item, resourceIds, physicalIds, shieldEquipped)`.

- [ ] **Step 1: Add `ActionDescriptor.sub` to the SDK**

In `packages/adapter-sdk/src/index.ts`, add to `ActionDescriptor` (after `grip?` from Task 2):
```ts
  /** attack only: active-die sub-line for versatile weapons, e.g.
   *  "1d10 slashing · two-handed". Absent for non-versatile attacks. */
  sub?: string;
```

- [ ] **Step 2: Write the failing tests**

Add to `packages/adapter-dnd5e/test/actions.test.ts`:

```ts
describe('versatile weapon grip — attack sub-line & shield hint', () => {
  const LS = 'item.gta26ORvqC323k3r';

  function invRows(a: FoundryActorDoc) {
    const s = dnd5eAdapter.toViewModel(a).sections.find(
      (x): x is Extract<SheetSection, { kind: 'list' }> => x.kind === 'list' && x.id === 'inventory',
    );
    return s?.items ?? [];
  }
  function withGrip(grip: 'oneHanded' | 'twoHanded'): FoundryActorDoc {
    const a = structuredClone(martialCaptured);
    const ls = (a.items ?? []).find((i) => i._id === 'gta26ORvqC323k3r')!;
    (ls as { flags?: Record<string, unknown> }).flags = { 'unseen-servent': { grip } };
    return a;
  }

  it('one-handed attack row shows the base die', () => {
    expect(action(martialCaptured, `${LS}.attack`).sub).toBe('1d8 slashing · one-handed');
  });

  it('two-handed attack row shows the versatile die', () => {
    expect(action(withGrip('twoHanded'), `${LS}.attack`).sub).toBe('1d10 slashing · two-handed');
  });

  it('a non-versatile weapon attack row has no sub-line', () => {
    const a = structuredClone(martialCaptured);
    const ls = (a.items ?? []).find((i) => i._id === 'gta26ORvqC323k3r')!;
    (ls.system as Record<string, unknown>).properties = [];
    expect(action(a, `${LS}.attack`).sub).toBeUndefined();
  });

  it('flags a two-handed grip while a shield is equipped', () => {
    const two = withGrip('twoHanded'); // martialCaptured has an equipped shield
    expect(invRows(two).find((r) => r.id === 'gta26ORvqC323k3r')?.tags).toContain('2H + shield');
  });

  it('no hint when one-handed even with a shield equipped', () => {
    expect(invRows(martialCaptured).find((r) => r.id === 'gta26ORvqC323k3r')?.tags ?? []).not.toContain('2H + shield');
  });
});
```

Note: this assumes `martialCaptured`'s Shield (`item.u69KONMFqydKuk1H`) is equipped. Verify with `dnd5eAdapter.toViewModel(martialCaptured)` (the Shield row's `tags` should include `'equipped'`). If it is NOT equipped in the fixture, equip it in a `structuredClone` inside the last two tests before asserting.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @companion/adapter-dnd5e exec vitest run test/actions.test.ts -t "attack sub-line & shield hint"`
Expected: FAIL (`sub` undefined; no `2H + shield` tag).

- [ ] **Step 4: Add `hasEquippedShield`**

Insert next to `hasStealthDisadvantageArmor` (`packages/adapter-dnd5e/src/index.ts:740`):

```ts
/** True when the actor has an equipped shield (dnd5e equipment
 *  `system.type.value === 'shield'`). Mirrors hasStealthDisadvantageArmor. */
function hasEquippedShield(actor: FoundryActorDoc): boolean {
  for (const item of actor.items ?? []) {
    if (item.type !== 'equipment') continue;
    if (getPath(item.system, 'equipped') !== true) continue;
    if (strAt(item.system, 'type.value') === 'shield') return true;
  }
  return false;
}
```

- [ ] **Step 5: Set the attack-row `sub` in `buildActions`**

In `buildActions`, the equipped-weapon block (`:2019`-`:2025`) becomes:

```ts
    if (item.type === 'weapon' && getPath(item.system, 'equipped') === true) {
      const sub = versatileAttackSub(item);
      out.push({
        id: `item.${item._id}.attack`,
        label: item.name,
        kind: 'attack',
        targeting: { mode: 'single', kind: 'attack' },
        ...(sub !== undefined ? { sub } : {}),
      });
      if (weaponDamageFormula(actor, item) !== undefined) {
        out.push({ id: `item.${item._id}.damage`, label: item.name, kind: 'damage' });
      }
    }
```

- [ ] **Step 6: Add the shield-conflict tag and thread `shieldEquipped`**

Change `inventoryListItem`'s signature (`:1256`) to accept the precomputed flag:

```ts
function inventoryListItem(
  item: FoundryItemDoc,
  resourceIds: Set<string>,
  physicalIds: Set<string>,
  shieldEquipped: boolean,
): ListItem {
```

Add the tag next to the existing `equipped`/`attuned` tag pushes (`:1274`-`:1275`):

```ts
  if (isVersatileWeapon(item) && weaponGrip(item) === 'twoHanded' && shieldEquipped) tags.push('2H + shield');
```

Update both call sites. Find the enclosing function (the inventory sections builder around `:2570`) and compute the flag once before the loops:

```ts
  const shieldEquipped = hasEquippedShield(actor);
```

then pass it as the 4th argument at both call sites (`:2581` and `:2595`):

```ts
    const row = inventoryListItem(item, resourceIds, physicalIds, shieldEquipped);
    // ...
    const header = inventoryListItem(item, resourceIds, physicalIds, shieldEquipped);
```

Confirm the enclosing function has `actor` in scope (it builds sections from the actor); if the flag must be computed elsewhere, compute it wherever `actor` is first available and thread it in.

- [ ] **Step 7: Run the adapter suite**

Run: `pnpm --filter @companion/adapter-dnd5e test`
Expected: PASS (all blocks, no regressions).

- [ ] **Step 8: Commit**

```bash
git add packages/adapter-sdk/src/index.ts packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/actions.test.ts
git commit -m "feat: versatile attack die sub-line + 2H-with-shield hint"
```

---

### Task 4: Combat path — pass dnd5e attack-mode to Foundry

On the targeted-combat path, pass `attackMode: "twoHanded"` so Foundry rolls the correct versatile die itself.

**Files:**
- Modify: `packages/adapter-sdk/src/index.ts` (`RelayAction` `use-on-targets`)
- Modify: `packages/adapter-dnd5e/src/index.ts` (`case 'attack'` targeted branch)
- Modify: `apps/gateway/src/app.ts` (`RelayPort.useAbilityOnTargets` opts; forward field)
- Modify: `apps/gateway/test/fakes.ts` (`FakeRelay.useAbilityOnTargets` opts type)
- Modify: `packages/foundry-client/src/index.ts` (`useAbilityOnTargets` + `targetedUseScript`)
- Test: `packages/foundry-client/test/client.test.ts`, `packages/adapter-dnd5e/test/actions.test.ts`, `apps/gateway/test/app.test.ts`

**Interfaces:**
- Consumes: `isVersatileWeapon`, `weaponGrip` (Task 1).
- Produces: `RelayAction` `use-on-targets` gains `attackMode?: 'oneHanded' | 'twoHanded'`; `RelayPort.useAbilityOnTargets` opts gain `attackMode?: 'oneHanded' | 'twoHanded'`; `targetedUseScript(itemUuid, targetTokenUuids, slotKey?, mode?, attackMode?)`.

- [ ] **Step 1: Add `attackMode` to the `use-on-targets` RelayAction**

In `packages/adapter-sdk/src/index.ts`, extend the `use-on-targets` variant (`:407`-`:413`):

```ts
  | {
      endpoint: 'use-on-targets';
      itemId: string;
      targetTokenUuids: string[];
      slotKey?: string;
      mode?: 'advantage' | 'disadvantage';
      /** dnd5e attack-mode for the roll; set to 'twoHanded' for a versatile
       *  weapon wielded two-handed so Foundry rolls the larger die. */
      attackMode?: 'oneHanded' | 'twoHanded';
    };
```

- [ ] **Step 2: Write the failing foundry-client script test**

Add to `packages/foundry-client/test/client.test.ts` (mirror the existing `/execute-js` test at `:432`):

```ts
it('threads attackMode into the targeted-use script (rollAttack + rollDamage)', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValueOnce({ success: true, result: { attack: null, targets: [] } }),
    text: vi.fn(),
  });

  await client.useAbilityOnTargets('Actor.abc123', 'Actor.abc123.Item.def456', {
    targetTokenUuids: ['Scene.s.Token.t'],
    attackMode: 'twoHanded',
  });

  const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
  const body = JSON.parse(init.body as string) as { script: string };
  // Appears in both the rollAttack config and the rollDamage config.
  expect(body.script.match(/attackMode:\s*"twoHanded"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @companion/foundry-client exec vitest run test/client.test.ts -t "threads attackMode"`
Expected: FAIL (script has no `attackMode`).

- [ ] **Step 4: Thread `attackMode` through `targetedUseScript`**

In `packages/foundry-client/src/index.ts`, change the signature (`:231`-`:236`) and configs:

```ts
function targetedUseScript(
  itemUuid: string,
  targetTokenUuids: string[],
  slotKey?: string,
  mode?: 'advantage' | 'disadvantage',
  attackMode?: 'oneHanded' | 'twoHanded',
): string {
```

Replace the `attackConfig` builder (`:241`-`:242`) with one that folds in `attackMode`:

```ts
  const attackParts: string[] = [];
  if (mode === 'advantage') attackParts.push('advantage: true');
  else if (mode === 'disadvantage') attackParts.push('disadvantage: true');
  if (attackMode !== undefined) attackParts.push(`attackMode: ${JSON.stringify(attackMode)}`);
  const attackConfig = `{ ${attackParts.join(', ')} }`;
  const damageConfig =
    attackMode !== undefined ? `{ isCritical: isCrit, attackMode: ${JSON.stringify(attackMode)} }` : '{ isCritical: isCrit }';
```

Update the `rollDamage` call (`:295`) to use `damageConfig`:

```ts
    `    const returned = await activity.rollDamage(${damageConfig}, { configure: false }, {});`,
```

(The `rollAttack` call at `:262` already interpolates `${attackConfig}` — no change beyond the new builder.)

- [ ] **Step 5: Pass `attackMode` from `useAbilityOnTargets`**

Still in `packages/foundry-client/src/index.ts`, extend the `useAbilityOnTargets` opts type and forward it (near `:627`-`:630`). The opts currently accept `{ targetTokenUuids; slotKey?; mode? }`; add `attackMode?: 'oneHanded' | 'twoHanded'` and pass it as the 5th arg:

```ts
    const body = await this.executeActivation(
      targetedUseScript(itemUuid, targets, opts.slotKey, opts.mode, opts.attackMode),
    );
```

- [ ] **Step 6: Run the foundry-client suite**

Run: `pnpm --filter @companion/foundry-client test`
Expected: PASS (new test green; existing execute-js tests unchanged — empty `attackMode`/`mode` still yields `{  }` which is valid JS).

- [ ] **Step 7: Set `attackMode` on the adapter's targeted attack**

In `packages/adapter-dnd5e/src/index.ts` `case 'attack'` (`:2220`-`:2240`), hoist the item lookup above the targeted branch and set `attackMode`:

```ts
    case 'attack': {
      const mode = intent.mode;
      if (mode !== undefined && mode !== 'advantage' && mode !== 'disadvantage') {
        throw new IntentError(`unknown roll mode "${String(mode)}"`, 'INVALID');
      }
      const itemId = intent.actionId.slice('item.'.length, -'.attack'.length);
      const item = (actor.items ?? []).find((i) => i._id === itemId);
      if (targeted !== undefined) {
        const attackMode =
          item !== undefined && isVersatileWeapon(item) && weaponGrip(item) === 'twoHanded' ? ('twoHanded' as const) : undefined;
        return {
          endpoint: 'use-on-targets',
          itemId,
          targetTokenUuids: targeted,
          ...(mode !== undefined ? { mode } : {}),
          ...(attackMode !== undefined ? { attackMode } : {}),
        };
      }
      // Plain Roll: Foundry-native item use (consumes ammo/uses, rolls to hit).
      if (mode === undefined) return { endpoint: 'use-item', itemId };
      if (!item) throw new IntentError(`unknown weapon "${itemId}"`, 'UNKNOWN_RESOURCE');
      return {
        endpoint: 'roll',
        formula: d20Formula(weaponAttackBonus(actor, item), mode),
        flavor: `${item.name} — Attack`,
      };
    }
```

(This removes the now-duplicate `const item = …` that was at `:2234`.)

- [ ] **Step 8: Write + run the adapter targeted-attack test**

Add to `packages/adapter-dnd5e/test/actions.test.ts` (`build` returns the RelayAction):

```ts
describe('versatile weapon grip — combat attack-mode', () => {
  const LS = 'item.gta26ORvqC323k3r';
  const targets = ['Scene.s.Token.t'];

  it('one-handed targeted attack sends no attackMode', () => {
    const out = build(martialCaptured, { kind: 'attack', actionId: `${LS}.attack`, targetTokenUuids: targets });
    expect(out).not.toHaveProperty('attackMode');
  });

  it('two-handed targeted attack sends attackMode twoHanded', () => {
    const a = structuredClone(martialCaptured);
    const ls = (a.items ?? []).find((i) => i._id === 'gta26ORvqC323k3r')!;
    (ls as { flags?: Record<string, unknown> }).flags = { 'unseen-servent': { grip: 'twoHanded' } };
    const out = build(a, { kind: 'attack', actionId: `${LS}.attack`, targetTokenUuids: targets });
    expect(out).toMatchObject({ endpoint: 'use-on-targets', attackMode: 'twoHanded' });
  });
});
```

Run: `pnpm --filter @companion/adapter-dnd5e test`
Expected: PASS.

- [ ] **Step 9: Forward `attackMode` through the gateway + fakes**

In `apps/gateway/src/app.ts`:
- `RelayPort.useAbilityOnTargets` opts type (`:152`) — add `attackMode?: 'oneHanded' | 'twoHanded'`.
- the `use-on-targets` forwarder (`:1584`-`:1588`) — add:
```ts
              ...(action.attackMode !== undefined ? { attackMode: action.attackMode } : {}),
```

In `apps/gateway/test/fakes.ts`, add `attackMode?: 'oneHanded' | 'twoHanded'` to both the `useOnTargetsCalls` opts type (`:284`) and the `useAbilityOnTargets` opts parameter (`:293`).

- [ ] **Step 10: Write + run the gateway forwarding test**

Add to `apps/gateway/test/app.test.ts` in the encounter suite (reuse `setupWithEncounter` at `:1248` and its target uuids). Program the fake adapter's targeted attack to return `attackMode` (extend the fake adapter's `case 'attack'` to include `attackMode: intent... `— or hardcode a versatile fake weapon). Minimal version: assert the field forwards when the RelayAction carries it:

```ts
it('forwards attackMode to the relay on a two-handed targeted attack', async () => {
  const { app, relay } = await setupWithEncounter();
  // The fake adapter must return { endpoint: 'use-on-targets', ..., attackMode: 'twoHanded' }
  // for this action id; see the fake adapter buildAction extension.
  await app.inject({
    method: 'POST',
    url: `/api/actors/${encounterActorId}/actions`,
    headers: asAnna,
    payload: { kind: 'attack', actionId: 'item.i1.attack', targetTokenUuids: [targetUuid] },
  });
  expect(relay.useOnTargetsCalls.at(-1)?.opts.attackMode).toBe('twoHanded');
});
```

Extend the fake adapter (`fakes.ts`) attack buildAction to emit `attackMode: 'twoHanded'` on `use-on-targets` for `item.i1.attack` (or add a dedicated versatile fake weapon + action) so this test exercises the gateway forwarder. Keep it minimal and consistent with the existing fake attack path.

Run: `pnpm --filter @companion/gateway test`
Expected: PASS.

- [ ] **Step 11: Typecheck all touched packages**

Run: `pnpm --filter @companion/adapter-sdk typecheck && pnpm --filter @companion/adapter-dnd5e typecheck && pnpm --filter @companion/foundry-client typecheck && pnpm --filter @companion/gateway typecheck`
Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add packages/adapter-sdk/src/index.ts packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/actions.test.ts packages/foundry-client/src/index.ts packages/foundry-client/test/client.test.ts apps/gateway/src/app.ts apps/gateway/test/fakes.ts apps/gateway/test/app.test.ts
git commit -m "feat: pass dnd5e attackMode to Foundry on two-handed targeted swings"
```

---

### Task 5: PWA — grip pill + intent wiring

Render the `[1H|2H]` pill on inventory rows, wire the `grip` intent and toast. The versatile attack sub-line renders automatically once `ActionDescriptor.sub` is populated — but confirm `SectionActions.vue` shows `action.sub` (it currently renders a sub only for "No spell slots left").

**Files:**
- Modify: `apps/web/app/components/SectionList.vue` (grip pill + helpers)
- Modify: `apps/web/app/components/SectionActions.vue` (render `action.sub` on attack rows)
- Modify: `apps/web/app/pages/actor/[id].vue` (`case 'grip'` in `handleAction` + toast)

**Interfaces:**
- Consumes: SDK `ActionDescriptor.grip`/`.sub`, `ListItem.gripActionId`, `ActionIntent` grip variant (Tasks 2–3). The web imports these types directly from `@companion/adapter-sdk` (`apps/web/app/types/api.ts`) — no separate mirror to update.

- [ ] **Step 1: Add the grip pill to `SectionList.vue`**

In the template, add a pill after the attune button (`:104`):

```vue
          <button
            v-if="gripOf(item)"
            class="equip-btn"
            type="button"
            :class="{ on: gripOf(item)!.grip === 'twoHanded', pending: actionBusy === item.gripActionId }"
            :aria-pressed="gripOf(item)!.grip === 'twoHanded'"
            :disabled="readonly || actionBusy !== null"
            @click="item.gripActionId && emit('action', item.gripActionId)"
          >
            {{ gripOf(item)!.grip === 'twoHanded' ? '2H' : '1H' }}
          </button>
```

In the `<script setup>`, add next to `attuneOf` (`:238`):

```ts
function gripOf(item: ListItem): ActionDescriptor | undefined {
  return item.gripActionId ? props.actions[item.gripActionId] : undefined
}
```

- [ ] **Step 2: Render `action.sub` on attack rows in `SectionActions.vue`**

The row already has a `row-sub` span used for `noSlots(action)` (`:41`). Add the die sub-line for attack rows. In `SectionActions.vue`, inside `.row-main` after the existing `row-sub` span (`:41`):

```vue
          <span v-if="action.sub && group.id === 'attacks'" class="row-sub">{{ action.sub }}</span>
```

- [ ] **Step 3: Build the grip intent in `actor/[id].vue`**

In `handleAction`'s `switch (action.kind)` (`:1580`), add after `case 'attune'` (`:1624`):

```ts
    case 'grip':
      void submitAction(
        { kind: 'grip', actionId, grip: action.grip === 'twoHanded' ? 'oneHanded' : 'twoHanded' },
        action.label,
      )
      break
```

- [ ] **Step 4: Add the grip toast**

In the outcome `switch (intent.kind)` (`:2029`), add after `case 'attune'` (`:2035`):

```ts
      case 'grip':
        toast.show(`${label} — ${intent.grip === 'twoHanded' ? 'two-handed' : 'one-handed'}`)
        break
```

- [ ] **Step 5: Typecheck the web app**

Run: `pnpm --filter @companion/web typecheck`
Expected: no errors (the grip descriptor/intent/`sub`/`gripActionId` types resolve from the SDK).

- [ ] **Step 6: Manual smoke via the mock server (optional but recommended)**

The web package has no unit tests (`test` is a stub). Verify visually:
- If `apps/web/mock/server.mjs` serves a sheet, add (or confirm) a versatile weapon with a `grip` action + `gripActionId` on its inventory row so the pill and sub-line render.
- Run: `pnpm --filter @companion/web dev:mock` (mock data) and `pnpm --filter @companion/web dev` in another shell; open the actor page, confirm the `[1H|2H]` pill toggles and the attack row sub-line flips `1d8 → 1d10`.

Real end-to-end behavior is verified against Foundry in Task 6.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/components/SectionList.vue apps/web/app/components/SectionActions.vue apps/web/app/pages/actor/[id].vue
git commit -m "feat(web): versatile grip pill + attack die sub-line"
```

---

### Task 6: Live verification against Foundry (dnd5e API risk)

The one assumption not verifiable offline: that dnd5e 5.3.3's `activity.rollAttack`/`rollDamage` accept `attackMode: "twoHanded"` and roll the larger versatile die. This extends the recorded combat-targeting **Check 7** (`docs/combat-targeting-live-findings.md`).

**Files:**
- Modify: `docs/combat-targeting-live-findings.md` (record the result)

- [ ] **Step 1: Full build + test gate**

Run: `pnpm -r build && pnpm -r test`
Expected: all packages build and pass.

- [ ] **Step 2: Live check — targeted two-handed swing**

With a live Foundry + relay (the existing e2e harness, e.g. `apps/gateway/e2e/live-combat-targeting.mjs`), and a character holding a longsword:
1. Set the longsword to two-handed (toggle the `[1H|2H]` pill, or write `flags.unseen-servent.grip = "twoHanded"`).
2. In an active encounter, make a targeted attack against a dummy.
3. **Expected:** the damage roll in Foundry chat is `1d10 (+ mod)`, not `1d8`. Toggle back to 1H → `1d8`.

- [ ] **Step 3: If `attackMode` is NOT the right dnd5e key (fix-forward)**

If the die does not change, inspect dnd5e 5.3.3's `AttackActivity.rollAttack`/`DamageActivity.rollDamage` config shape (the process-config object) for the correct property name (candidates: `attackMode`, `attackMode` nested under a `midiOptions`/`options` key, or a `versatile: true` flag). Update the two config strings in `targetedUseScript` (Task 4, Step 4) accordingly, adjust the `client.test.ts` assertion to match, and re-run Step 2.

- [ ] **Step 4: Standalone Dmg button check**

Outside an encounter, tap the longsword's **Dmg** button in the PWA with grip = two-handed → the displayed roll is `1d10 (+ mod)`. (This path is client-side and already covered by Task 1 unit tests; confirm the wired UI shows it.)

- [ ] **Step 5: Record findings + commit**

Append the observed results to `docs/combat-targeting-live-findings.md` (update the Check 7 section from "RECORDED/follow-up" to the verified outcome, noting the confirmed dnd5e config key).

```bash
git add docs/combat-targeting-live-findings.md
git commit -m "docs: verify versatile two-handed swing rolls 1d10 live"
```

---

## Self-Review

**1. Spec coverage:**
- §1 Data model & storage (flag, `ver`-only, default 1H, damage-die-only) → Tasks 1 (die), 2 (flag write). ✓
- §2 combat path (attackMode to Foundry) → Task 4. ✓
- §2 standalone Dmg (prefer versatile field, else step up) → Task 1 (`versatileDice`). ✓
- §3 SDK `grip` kind + `ActionDescriptor.grip`/`.sub` + `ListItem.gripActionId` + intent → Tasks 2, 3. ✓
- §3 adapter grip descriptor + inventory pill + attack sub + `case 'grip'` → Tasks 2, 3. ✓
- §3 PWA pill + sub-line → Task 5. ✓
- §4 shield hint (allow + badge) → Task 3. ✓
- §5 non-goals — no enforcement, unchanged mastery/GWM/crit gaps → nothing implemented (correct). ✓
- Testing section (adapter units, script-gen, live E2E) → Tasks 1–4 units, Task 4 script-gen, Task 6 live. ✓

**2. Placeholder scan:** All code steps carry real code. Two spots flagged for the engineer to confirm against the fixture/harness (inventory section id in Task 2/3; FakeRelay `updateEntity` recorder name + `setupWithEncounter` locals in Tasks 2/4) — these are verification notes with concrete fallbacks, not missing content.

**3. Type consistency:** `grip: 'oneHanded' | 'twoHanded'` is identical across `ActionDescriptor.grip`, the `ActionIntent` variant, `RelayAction.use-on-targets.attackMode`, `RelayPort.useAbilityOnTargets` opts, and `targetedUseScript`'s param. Helper names (`isVersatileWeapon`, `weaponGrip`, `gripDice`, `versatileDice`, `versatileAttackSub`, `hasEquippedShield`) are used consistently in Tasks 1→4. Flag path `flags.unseen-servent.grip` is identical in the reader (`weaponGrip`), the writer (`case 'grip'`), and every test.
