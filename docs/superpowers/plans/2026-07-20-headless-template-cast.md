# Headless Template-Spell Cast (no 5–8s block) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Casting any area-template spell/item over the bridge (Daylight, Fireball, Word of Radiance, Bead of Force…) returns in well under a second instead of blocking 5–8s on Foundry's headless template-placement prompt and eating a relay 408 — on BOTH the upcast path (`cast-at-slot`) and the base-level path (`use-spell`/`use-item`/`use-feature`).

**Architecture:** dnd5e's `Activity#use` defaults `config.create.measuredTemplate ??= !!this.target.template.type && this.target.prompt` (live-read from dnd5e 5.3.3 on 2026-07-20), so an explicit `create: { measuredTemplate: false }` suppresses the canvas prompt — live-verified: Daylight upcast round-trips in **267ms** (was 5–8s), right slot consumed, chat card posted, zero templates placed. The GM can still place the template from the chat card's own button. Fix A adds the flag to `castAtSlot`'s execute-js script. Fix B: the relay module's `use-*` endpoints can't pass usage config, so the adapter flags template-bearing items (`noTemplate: true`) and the gateway routes those activations through a new execute-js method `useWithoutTemplate` (default consumption — dnd5e itself consumes the base slot / pact slot / item uses), falling back to the module endpoint when execute-js is unavailable (slow-but-works, exactly today's behavior).

**Tech Stack:** TypeScript, Vitest, pnpm workspace. No web changes.

## Global Constraints

- The execute-js script must interpolate caller data ONLY via `JSON.stringify` of pre-validated ids (existing castAtSlot security rule; test asserts no raw uuid outside quotes).
- `useWithoutTemplate` must NOT override consumption (no `consume:`, no `spell.slot`): dnd5e's defaults consume the base slot for leveled spells, pact slots for pact spells, item uses for free-use spells, nothing for cantrips — identical to the module's own `use-spell`. Only `subsequentActions: false` and `create: { measuredTemplate: false }` are set.
- Behavior for non-template items is byte-for-byte unchanged (module `use-*` endpoints stay the only path).
- When execute-js is unavailable (module setting off / key lacks the scope), base-level casts MUST still work via the module endpoint fallback — never surface the upcast-style 422 for a base-level cast.
- The existing 408 tolerance (`isRelayTimeout`) at every call site stays untouched.
- strict `noUncheckedIndexedAccess` is on; SDK import in tests is `@companion/adapter-sdk`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File Structure

- Modify: `packages/foundry-client/src/index.ts` — shared activation-script builder; `castAtSlot` gains the flag; new `useWithoutTemplate`.
- Modify: `packages/foundry-client/test/client.test.ts` — flag assertion + new method's suite.
- Modify: `packages/adapter-sdk/src/index.ts` — `noTemplate?: true` on the `use-*`, `use-and-roll`, and `cast-and-apply-effect` action shapes.
- Modify: `packages/adapter-dnd5e/src/index.ts` — `hasAreaTemplate()`; emit `noTemplate` from the `cast`/`use` branches, `buildHealAction`, and the buff branch.
- Modify: `packages/adapter-dnd5e/test/actions.test.ts` — emission tests.
- Modify: `apps/gateway/src/app.ts` — `RelayPort.useWithoutTemplate`; `activateAbility()` router; three call sites.
- Modify: `apps/gateway/test/fakes.ts` + `apps/gateway/test/app.test.ts` — fake + routing/fallback tests.

---

### Task 1: foundry-client — suppress template placement in both execute-js activations

**Files:**
- Modify: `packages/foundry-client/src/index.ts:309-360` (castAtSlot; add builder + new method)
- Test: `packages/foundry-client/test/client.test.ts` (castAtSlot suite at :412; add a new suite after it)

**Interfaces:**
- Produces: `useWithoutTemplate(actorUuid: string, itemUuid: string): Promise<Record<string, unknown>>` on `FoundryRelayClient` — same return contract as `castAtSlot` (`{ roll: {...} }` for attack activities, `{}` otherwise; throws `RelayError` on relay-reported failure).
- Consumes: existing `request()`, `RelayError`.

- [ ] **Step 1: Write the failing tests**

In `packages/foundry-client/test/client.test.ts`, add to the existing `castAtSlot` describe (after the test at :432-458):

```ts
  it('suppresses headless template placement (create.measuredTemplate false in the script)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce({ success: true, result: {} }),
      text: vi.fn(),
    });
    await client.castAtSlot('Actor.abc123', 'Actor.abc123.Item.def456', 'spell3');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { script: string };
    expect(body.script).toContain('create: { measuredTemplate: false }');
  });
```

Then add a new describe after the castAtSlot suite (before `describe('FoundryRelayClient.applyEffect()'` at :502):

```ts
describe('FoundryRelayClient.useWithoutTemplate()', () => {
  let client: FoundryRelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new FoundryRelayClient({
      baseUrl: 'http://relay:3010',
      apiKey: 'test-api-key',
      clientId: 'fvtt_test123',
    });
  });

  it('rejects malformed uuids before any network call', async () => {
    await expect(client.useWithoutTemplate('Actor.abc; drop', 'Actor.abc123.Item.def456')).rejects.toThrow(/actorUuid/);
    await expect(client.useWithoutTemplate('Actor.abc123', 'Actor.abc123.Item.x"y')).rejects.toThrow(/itemUuid/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('POSTs /execute-js with default consumption (no slot/consume override) and template suppression', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce({
        success: true,
        result: { roll: { total: 18, formula: '1d20 + 7' } },
      }),
      text: vi.fn(),
    });

    const res = await client.useWithoutTemplate('Actor.abc123', 'Actor.abc123.Item.def456');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/execute-js');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as { script: string };
    expect(body.script).toContain(JSON.stringify('Actor.abc123.Item.def456'));
    expect(body.script).toContain('create: { measuredTemplate: false }');
    // Default consumption: dnd5e picks the slot/uses itself.
    expect(body.script).not.toContain('spell:');
    expect(body.script).not.toContain('consume:');
    // Caller-controlled uuid never appears outside a quoted literal.
    const rawUuidPattern = /(?<!")Actor\.abc123\.Item\.def456(?!")/g;
    expect(body.script.match(rawUuidPattern)).toBeNull();
    expect(res).toEqual({ roll: { total: 18, formula: '1d20 + 7' } });
  });

  it('rejects with a RelayError carrying the error text when the 200 body reports execute-js disabled', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce({
        success: false,
        error: 'execute-js is disabled in REST API module settings',
      }),
      text: vi.fn(),
    });
    await expect(client.useWithoutTemplate('Actor.abc123', 'Actor.abc123.Item.def456')).rejects.toThrow(
      /execute-js is disabled/,
    );
  });

  it('rejects when the 200 body reports success: false with no error text', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValueOnce({ success: false }),
      text: vi.fn(),
    });
    await expect(client.useWithoutTemplate('Actor.abc123', 'Actor.abc123.Item.def456')).rejects.toThrow(
      /reported failure/,
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @companion/foundry-client test`
Expected: FAIL — `useWithoutTemplate is not a function`, and the new castAtSlot flag test fails (script lacks `create: { measuredTemplate: false }`).

- [ ] **Step 3: Implement**

In `packages/foundry-client/src/index.ts`, replace the body of `castAtSlot` (lines 325-360) with a shared builder + two public methods. Keep the existing doc comments on `castAtSlot`, extending the first paragraph with one sentence: `Template placement is suppressed (create.measuredTemplate false — dnd5e would otherwise block awaiting a canvas click that never comes headless; the chat card's own button still lets the GM place it).`

```ts
  async castAtSlot(actorUuid: string, itemUuid: string, slotKey: string): Promise<Record<string, unknown>> {
    if (!/^Actor\.[A-Za-z0-9]{1,32}$/.test(actorUuid)) throw new Error(`castAtSlot: invalid actorUuid "${actorUuid}"`);
    if (!/^Actor\.[A-Za-z0-9]{1,32}\.Item\.[A-Za-z0-9]{1,32}$/.test(itemUuid)) {
      throw new Error(`castAtSlot: invalid itemUuid "${itemUuid}"`);
    }
    if (!/^spell[2-9]$/.test(slotKey)) throw new Error(`castAtSlot: invalid slotKey "${slotKey}"`);
    return this.executeActivation(activationScript(itemUuid, slotKey));
  }

  /**
   * POST /execute-js — run an item's usage workflow with dnd5e's DEFAULT
   * consumption (base slot for leveled spells, pact slots for pact spells,
   * item uses for free-use grants, nothing for cantrips — identical to the
   * relay module's own use-* flow) but with headless-blocking template
   * placement suppressed. Used for template-bearing items, whose module
   * use-* activation blocks 5-8s on the canvas prompt and 408s
   * (M-daylight finding, live-verified 2026-07-20: 267ms vs 5-8s).
   * Same scope/setting requirements and injection rules as castAtSlot.
   */
  async useWithoutTemplate(actorUuid: string, itemUuid: string): Promise<Record<string, unknown>> {
    if (!/^Actor\.[A-Za-z0-9]{1,32}$/.test(actorUuid)) {
      throw new Error(`useWithoutTemplate: invalid actorUuid "${actorUuid}"`);
    }
    if (!/^Actor\.[A-Za-z0-9]{1,32}\.Item\.[A-Za-z0-9]{1,32}$/.test(itemUuid)) {
      throw new Error(`useWithoutTemplate: invalid itemUuid "${itemUuid}"`);
    }
    return this.executeActivation(activationScript(itemUuid));
  }

  /** Shared POST + error-normalization for the execute-js activations. */
  private async executeActivation(script: string): Promise<Record<string, unknown>> {
    const body = await this.request<{ result?: unknown; error?: string; success?: boolean }>('POST', '/execute-js', {}, { script });
    if (typeof body.error === 'string' && body.error !== '') {
      throw new RelayError(`relay /execute-js: ${body.error}`, 200, '/execute-js');
    }
    if (body.success === false) {
      throw new RelayError('relay /execute-js: reported failure with no error text', 200, '/execute-js');
    }
    const result = body.result;
    return result !== null && typeof result === 'object' ? (result as Record<string, unknown>) : (body as Record<string, unknown>);
  }
```

Add the module-level script builder (near the class, e.g. right before `export class FoundryRelayClient`):

```ts
/**
 * The execute-js activation script both castAtSlot and useWithoutTemplate
 * run: dnd5e's own activity.use, mirroring the relay module's use-* flow
 * (v13 path) plus two additions the module lacks — an explicit paying slot
 * (when `slotKey` is given) and suppression of measured-template placement.
 * dnd5e 5.3.3 `_prepareUsageConfig` (live-read 2026-07-20):
 *   `config.create.measuredTemplate ??= !!this.target.template.type && this.target.prompt`
 * — headless there is no one to click the canvas, so the default BLOCKS the
 * whole use() promise until the relay 408s (5-8s). An explicit `false`
 * survives the `??=`; the chat card still carries its own place-template
 * button for the GM. Attack-type activities also capture the to-hit roll
 * (same dnd5e.rollAttackV2 hook the module uses) and return it as { roll }.
 * Only validated ids/slot keys are interpolated, via JSON.stringify —
 * callers can never inject script text.
 */
function activationScript(itemUuid: string, slotKey?: string): string {
  const usage =
    slotKey !== undefined
      ? `{ subsequentActions: false, consume: { spellSlot: true }, spell: { slot: ${JSON.stringify(slotKey)} }, create: { measuredTemplate: false } }`
      : `{ subsequentActions: false, create: { measuredTemplate: false } }`;
  return [
    `const item = await fromUuid(${JSON.stringify(itemUuid)});`,
    `if (!item) throw new Error('item not found');`,
    `const activities = item.system?.activities;`,
    `const activity = activities?.size > 0 ? [...activities.values()][0] : null;`,
    `if (!activity) throw new Error('item has no activity');`,
    `let attackRoll = null;`,
    `const hookId = Hooks.once('dnd5e.rollAttackV2', (rolls) => { if (rolls?.length) attackRoll = rolls[0]; });`,
    `try {`,
    `  const hasAttack = typeof activity.rollAttack === 'function';`,
    `  const usage = ${usage};`,
    `  const useResult = await activity.use(usage, { configure: false }, {});`,
    `  if (!useResult) throw new Error('cast could not be performed');`,
    `  if (hasAttack) await activity.rollAttack({}, { configure: false }, {});`,
    `} finally { Hooks.off('dnd5e.rollAttackV2', hookId); }`,
    `return attackRoll ? { roll: { total: attackRoll.total, formula: attackRoll.formula, isCritical: attackRoll.isCritical ?? false, isFumble: attackRoll.isFumble ?? false } } : {};`,
  ].join('\n');
}
```

Note the one deliberate wording change: the no-activity error becomes `'item has no activity'` (was `'spell has no activity'` — the script now also serves items/features). No test pins the old wording.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @companion/foundry-client test`
Expected: PASS (all pre-existing castAtSlot tests too — the script shape for castAtSlot only GAINS the `create:` field).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @companion/foundry-client typecheck`

```bash
git add packages/foundry-client/src/index.ts packages/foundry-client/test/client.test.ts
git commit -m "feat(foundry-client): suppress headless template placement in execute-js activations

castAtSlot gains create:{measuredTemplate:false} (dnd5e 5.3.3 blocks
activity.use awaiting a canvas click headless -> relay 408 after 5-8s;
live-verified 267ms with the flag). New useWithoutTemplate() runs the
same activation with dnd5e default consumption for base-level casts of
template-bearing items.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: adapter — flag template-bearing items with `noTemplate: true`

**Files:**
- Modify: `packages/adapter-sdk/src/index.ts:337-379` (three action shapes)
- Modify: `packages/adapter-dnd5e/src/index.ts` (new helper near `allActivities` ~1526; `buildHealAction` ~1897; `case 'use'` ~2150-2181; `case 'cast'` ~2200-2223)
- Test: `packages/adapter-dnd5e/test/actions.test.ts`

**Interfaces:**
- Produces: SDK `RelayAction` variants carry `noTemplate?: true`:
  - `{ endpoint: 'use-item' | 'use-spell' | 'use-feature'; itemId: string; slotLevel?: number; noTemplate?: true }`
  - `use-and-roll` object shape gains `noTemplate?: true`
  - `{ endpoint: 'cast-and-apply-effect'; use: 'use-spell' | 'cast-at-slot'; itemId: string; slotKey?: string; effect: EffectPayload; targetActorId?: string; noTemplate?: true }`
  - adapter-dnd5e `hasAreaTemplate(item: FoundryItemDoc): boolean`
- Consumes: existing `allActivities`, `getPath`, `strAt`.

- [ ] **Step 1: Write the failing tests**

In `packages/adapter-dnd5e/test/actions.test.ts`, add a describe (near the other cast suites; reuse the file's existing `build` helper and the inline-actor idiom used by the SHOULD-FIX tests at :1534):

```ts
describe('template-bearing items set noTemplate (M-daylight, 2026-07-20)', () => {
  /** Minimal caster with one leveled utility spell; `template` toggles the
   *  activity's area template (Daylight's live shape: sphere/60). */
  const templateCaster = (template: boolean) => ({
    _id: 'actorTemplate001',
    name: 'Template Caster',
    type: 'character',
    system: {
      attributes: { hp: { value: 20, max: 20 } },
      spells: { spell3: { value: 2, max: 3 }, spell4: { value: 1, max: 1 } },
    },
    items: [
      {
        _id: 'spellDaylight001',
        name: 'Daylight',
        type: 'spell',
        system: {
          level: 3,
          school: 'evo',
          prepared: 1,
          method: 'spell',
          activities: {
            a1: {
              _id: 'a1',
              type: 'utility',
              ...(template ? { target: { template: { type: 'sphere', size: 60 } } } : {}),
            },
          },
        },
      },
    ],
  });

  it('base-level cast of a template spell -> use-spell + noTemplate', () => {
    expect(build(templateCaster(true), { kind: 'cast', actionId: 'spell.spellDaylight001.cast' })).toEqual({
      endpoint: 'use-spell',
      itemId: 'spellDaylight001',
      noTemplate: true,
    });
  });

  it('base-level cast of a non-template spell carries NO flag (unchanged wire shape)', () => {
    expect(build(templateCaster(false), { kind: 'cast', actionId: 'spell.spellDaylight001.cast' })).toEqual({
      endpoint: 'use-spell',
      itemId: 'spellDaylight001',
    });
  });

  it('upcast of a template spell keeps cast-at-slot (no flag needed — castAtSlot suppresses itself)', () => {
    expect(build(templateCaster(true), { kind: 'cast', actionId: 'spell.spellDaylight001.cast', slotLevel: 4 })).toEqual(
      { endpoint: 'cast-at-slot', itemId: 'spellDaylight001', slotKey: 'spell4' },
    );
  });

  it('a template item with damage (Bead of Force shape) -> use-and-roll + noTemplate', () => {
    const actor = {
      _id: 'actorTemplate002',
      name: 'Bead Holder',
      type: 'character',
      system: { attributes: { hp: { value: 20, max: 20 } }, spells: {} },
      items: [
        {
          _id: 'itemBeadForce001',
          name: 'Bead of Force',
          type: 'consumable',
          system: {
            quantity: 1,
            activities: {
              a1: {
                _id: 'a1',
                type: 'save',
                target: { template: { type: 'sphere', size: 10 } },
                damage: { parts: [{ number: 5, denomination: 4, bonus: '', types: ['force'] }] },
              },
            },
          },
        },
      ],
    };
    const a = build(actor, { kind: 'use', actionId: 'item.itemBeadForce001.use' });
    if (a.endpoint !== 'use-and-roll') throw new Error('expected use-and-roll, got ' + a.endpoint);
    expect(a.noTemplate).toBe(true);
    expect(a.use).toBe('use-item');
  });

  it('a template save-spell with damage (Fireball shape): the cast intent carries the flag', () => {
    // Fireball's Cast action is the activation only (damage is the separate
    // spell.<id>.damage action) -> the cast intent must carry the flag.
    const actor = templateCaster(true);
    (actor.items[0]!.system.activities as Record<string, Record<string, unknown>>).a1 = {
      _id: 'a1',
      type: 'save',
      target: { template: { type: 'radius', size: 20 } },
      damage: { parts: [{ number: 8, denomination: 6, bonus: '', types: ['fire'] }] },
    };
    expect(build(actor, { kind: 'cast', actionId: 'spell.spellDaylight001.cast' })).toEqual({
      endpoint: 'use-spell',
      itemId: 'spellDaylight001',
      noTemplate: true,
    });
  });

  it('a self-buff template spell threads the flag through cast-and-apply-effect', () => {
    const actor = templateCaster(true);
    const item = actor.items[0]! as unknown as Record<string, unknown>;
    (item.system as Record<string, unknown>).activities = {
      a1: { _id: 'a1', type: 'utility', target: { template: { type: 'radius', size: 10 }, affects: { type: 'self' } } },
    };
    item.effects = [
      { transfer: false, name: 'Buffed', changes: [{ key: 'system.attributes.ac.bonus', mode: 2, value: '2' }] },
    ];
    const a = build(actor, { kind: 'cast', actionId: 'spell.spellDaylight001.cast' });
    if (a.endpoint !== 'cast-and-apply-effect') throw new Error('expected cast-and-apply-effect, got ' + a.endpoint);
    expect(a.noTemplate).toBe(true);
  });

  it('a heal spell with a template threads the flag through use-and-roll', () => {
    const actor = templateCaster(true);
    (actor.items[0]!.system.activities as Record<string, Record<string, unknown>>).a1 = {
      _id: 'a1',
      type: 'heal',
      target: { template: { type: 'radius', size: 30 } },
      healing: { number: 3, denomination: 8, bonus: '', types: ['healing'] },
    };
    const a = build(actor, { kind: 'cast', actionId: 'spell.spellDaylight001.cast' });
    if (a.endpoint !== 'use-and-roll') throw new Error('expected use-and-roll, got ' + a.endpoint);
    expect(a.noTemplate).toBe(true);
  });
});
```

Note: check the file's existing inline-actor tests for required minimum actor fields (the `warlock()` helper at the top of the file shows the shape); if `build` needs more system fields (e.g. `attributes.spellcasting`), copy what the nearest passing inline test uses. The `heal` case needs `attributes.hp` (present above) because self-target detection reads it only when `affects.type === 'self'` — these fixtures leave `affects` unset so the heal is roll-and-display only.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @companion/adapter-dnd5e test -- actions`
Expected: FAIL — actions lack `noTemplate` (and TypeScript may refuse `a.noTemplate` until the SDK change lands; that is the same failure signal).

- [ ] **Step 3: Implement**

`packages/adapter-sdk/src/index.ts` — extend the three shapes (exact current lines 337-379). Add to the `use-*` variant and document once above it:

```ts
  /** noTemplate: the item's activities carry an area template — dnd5e's
   *  headless activation would block awaiting canvas placement (relay 408
   *  after 5-8s). The gateway routes flagged activations through the
   *  execute-js path (which suppresses placement) and falls back to the
   *  module endpoint when execute-js is unavailable. */
  | { endpoint: 'use-item' | 'use-spell' | 'use-feature'; itemId: string; slotLevel?: number; noTemplate?: true }
```

Add `noTemplate?: true;` to the `use-and-roll` object shape (after `slotKey?: string;` at :369) and to the `cast-and-apply-effect` line (:379).

`packages/adapter-dnd5e/src/index.ts` — add the helper right after `allActivities` (~1529):

```ts
/** True when any activity targets an area template (Daylight sphere/60,
 *  Fireball radius/20…). Headless, dnd5e's use() blocks awaiting canvas
 *  placement for these (M-daylight finding) — the gateway routes them
 *  through the template-suppressing execute-js activation instead. */
function hasAreaTemplate(item: FoundryItemDoc): boolean {
  return allActivities(item).some((a) => {
    const type = getPath(a, 'target.template.type');
    return typeof type === 'string' && type !== '';
  });
}
```

Then set the flag at four places (spread-idiom, matching the file's optional-field style):

1. `case 'use'`, item damage branch (~2171):
```ts
            return {
              endpoint: 'use-and-roll',
              use: 'use-item',
              itemId,
              formula,
              flavor: `${item.name} — Damage`,
              ...(hasAreaTemplate(item) ? { noTemplate: true as const } : {}),
            };
```
2. `case 'use'`, plain item/feature returns (~2174 and ~2181) — both need the item in scope (already looked up):
```ts
        return { endpoint: 'use-item', itemId, ...(item !== undefined && hasAreaTemplate(item) ? { noTemplate: true as const } : {}) };
```
```ts
      return { endpoint: 'use-feature', itemId, ...(item !== undefined && hasAreaTemplate(item) ? { noTemplate: true as const } : {}) };
```
3. `case 'cast'`, buff branch (~2204) and final base-level return (~2223):
```ts
        return {
          endpoint: 'cast-and-apply-effect',
          use: upcast ? 'cast-at-slot' : 'use-spell',
          itemId,
          ...(upcast ? { slotKey: `spell${chosen}` } : {}),
          effect: buff,
          ...(intent.targetActorId !== undefined && item !== undefined && !buffTargetIsSelf(item)
            ? { targetActorId: intent.targetActorId }
            : {}),
          ...(item !== undefined && hasAreaTemplate(item) ? { noTemplate: true as const } : {}),
        };
```
```ts
      return { endpoint: 'use-spell', itemId, ...(item !== undefined && hasAreaTemplate(item) ? { noTemplate: true as const } : {}) };
```
4. `buildHealAction` (~1897), in the `base` object after `flavor`:
```ts
    ...(hasAreaTemplate(item) ? { noTemplate: true as const } : {}),
```

The upcast `cast-at-slot` return stays untouched (castAtSlot suppresses in its own script).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @companion/adapter-sdk test && pnpm --filter @companion/adapter-dnd5e test`
Expected: PASS, including every pre-existing action test (`toEqual` on non-template fixtures must be unchanged — if one of the captured fixtures carries a template and a wire-shape test now fails, the fixture item genuinely has a template and the test's expected object gains `noTemplate: true`; verify against the fixture data before touching the assertion).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @companion/adapter-sdk typecheck && pnpm --filter @companion/adapter-dnd5e typecheck`

```bash
git add packages/adapter-sdk/src/index.ts packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/actions.test.ts
git commit -m "feat(adapter-dnd5e): flag template-bearing activations with noTemplate

Any activity with target.template.type (Daylight, Fireball, Bead of
Force, Word of Radiance...) blocks 5-8s headless on the canvas
placement prompt. The adapter marks those actions so the gateway can
route them through the template-suppressing execute-js activation.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: gateway — route `noTemplate` activations through execute-js with module fallback

**Files:**
- Modify: `apps/gateway/src/app.ts` (RelayPort ~:68-75; new `activateAbility` near `upcastUnavailable` ~:417; call sites :1063-1088, :1128-1133, :1173-1187)
- Modify: `apps/gateway/test/fakes.ts` (~:228, next to castAtSlot fake)
- Test: `apps/gateway/test/app.test.ts`

**Interfaces:**
- Consumes: `FoundryRelayClient.useWithoutTemplate` (Task 1), `noTemplate` on actions (Task 2), existing `isRelayTimeout`, `upcastUnavailable`.
- Produces: `RelayPort.useWithoutTemplate(actorUuid: string, itemUuid: string): Promise<Record<string, unknown>>`; module-level `activateAbility(relay, endpoint, actorUuid, itemUuid, opts, noTemplate): Promise<Record<string, unknown>>`.

- [ ] **Step 1: Extend the fake**

In `apps/gateway/test/fakes.ts`, next to the castAtSlot fake (:228-234):

```ts
  useWithoutTemplateCalls: Array<{ actorUuid: string; itemUuid: string }> = [];
  useWithoutTemplateResult: Record<string, unknown> = {};
  useWithoutTemplateError: Error | null = null;
  async useWithoutTemplate(actorUuid: string, itemUuid: string): Promise<Record<string, unknown>> {
    if (this.useWithoutTemplateError) throw this.useWithoutTemplateError;
    this.useWithoutTemplateCalls.push({ actorUuid, itemUuid });
    return structuredClone(this.useWithoutTemplateResult);
  }
```

(If the real server wiring in `apps/gateway/src/server.ts` constructs the RelayPort from FoundryRelayClient by listing methods explicitly, add `useWithoutTemplate` there too — check with `grep -n "castAtSlot" apps/gateway/src/server.ts`; if it passes the client object straight through, nothing to do.)

- [ ] **Step 2: Write the failing tests**

In `apps/gateway/test/app.test.ts`, next to the cast tests (~:428-470). Follow the file's existing test idiom for POSTing an action (copy the setup lines from the test at :428 — same auth/token/actor scaffolding, same `postAction` helper if one exists):

```ts
  it('a noTemplate use-spell routes through useWithoutTemplate (no module use-* call)', async () => {
    relay.useWithoutTemplateResult = { roll: { total: 12, formula: '1d20 + 5' } };
    // adapter emits noTemplate for template spells; drive whatever action the
    // suite's fixture produces for a cast intent on a template spell, or POST
    // the action body directly if the suite drives wire actions.
    const res = await castTemplateSpell(); // mirror the :428 test's call shape
    expect(res.statusCode).toBe(200);
    expect(relay.useWithoutTemplateCalls).toEqual([
      { actorUuid: expect.stringMatching(/^Actor\./), itemUuid: expect.stringMatching(/\.Item\./) },
    ]);
    expect(relay.useAbilityCalls).toEqual([]);
  });

  it('falls back to the module use-* endpoint when execute-js is unavailable (base-level cast never 422s)', async () => {
    const err = new Error('execute-js is disabled in REST API module settings. A GM must enable it…');
    err.name = 'RelayError';
    relay.useWithoutTemplateError = err;
    const res = await castTemplateSpell();
    expect(res.statusCode).toBe(200);
    expect(relay.useAbilityCalls).toHaveLength(1); // fell back
  });

  it('a non-config execute-js failure on the noTemplate path stays fatal (502), no silent fallback double-cast risk', async () => {
    const err = new Error('relay /execute-js -> 500: boom');
    err.name = 'RelayError';
    (err as unknown as { status: number }).status = 500;
    relay.useWithoutTemplateError = err;
    const res = await castTemplateSpell();
    expect(res.statusCode).toBe(502);
    expect(relay.useAbilityCalls).toEqual([]);
  });

  it('a 408 on the noTemplate path is tolerated exactly like the module path (200, null result)', async () => {
    const err = new Error('relay /execute-js -> 408: Request timed out');
    err.name = 'RelayError';
    (err as unknown as { status: number }).status = 408;
    relay.useWithoutTemplateError = err;
    const res = await castTemplateSpell();
    expect(res.statusCode).toBe(200);
    expect((res.json() as { result: unknown }).result).toBeNull();
    expect(relay.useAbilityCalls).toEqual([]); // a timeout means it likely executed — never re-cast
  });
```

`castTemplateSpell()` is shorthand: build it exactly like the suite's existing cast test at :428 (same app/store setup), but with the sheet's spell fixture given an activity `target: { template: { type: 'sphere', size: 60 } }` so the adapter emits `noTemplate: true`. If the suite's fixture actor is shared, clone-and-extend it locally in this describe.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @companion/gateway test -- app`
Expected: FAIL — `useWithoutTemplateCalls` empty (route still calls useAbility) / type error on RelayPort.

- [ ] **Step 4: Implement**

`apps/gateway/src/app.ts` — RelayPort (after castAtSlot at :75):

```ts
  /** POST /execute-js via foundry-client useWithoutTemplate — template-
   *  bearing items only (headless placement block, M-daylight 2026-07-20). */
  useWithoutTemplate(actorUuid: string, itemUuid: string): Promise<Record<string, unknown>>;
```

Module-level helper after `upcastUnavailable` (~:417):

```ts
/** Run an item's usage workflow. Template-bearing items (action.noTemplate)
 *  go through the execute-js activation, which suppresses the headless-
 *  blocking canvas placement prompt (5-8s -> ~250ms, live-verified
 *  2026-07-20); when the table has execute-js disabled/unscoped
 *  (upcastUnavailable wording — used here as a detector only, its message is
 *  NOT surfaced) the module use-* endpoint still works, just slow (the
 *  template prompt 408s and the caller's isRelayTimeout handling tolerates
 *  it). Every other execute-js failure stays fatal — a fallback would risk a
 *  double activation. `slotLevel` casts skip the execute-js path (it speaks
 *  default consumption only).
 */
async function activateAbility(
  relay: RelayPort,
  endpoint: 'use-item' | 'use-spell' | 'use-feature',
  actorUuid: string,
  itemUuid: string,
  opts: { slotLevel?: number },
  noTemplate: true | undefined,
): Promise<Record<string, unknown>> {
  if (noTemplate === true && opts.slotLevel === undefined) {
    try {
      return await relay.useWithoutTemplate(actorUuid, itemUuid);
    } catch (err) {
      if (upcastUnavailable(err) === null) throw err;
      // execute-js unavailable -> module endpoint (slow-but-works).
    }
  }
  return relay.useAbility(endpoint, actorUuid, itemUuid, opts);
}
```

Three call-site swaps (each keeps its surrounding try/catch untouched):

1. `use-item|use-spell|use-feature` case (:1067-1074): replace `relay.useAbility(...)` with

```ts
            result = extractRoll(
              await activateAbility(
                relay,
                action.endpoint,
                `Actor.${id}`,
                `Actor.${id}.Item.${action.itemId}`,
                action.slotLevel !== undefined ? { slotLevel: action.slotLevel } : {},
                action.noTemplate,
              ),
            );
```

2. `use-and-roll` case (:1132): `await relay.useAbility(action.use, ...)` becomes

```ts
              await activateAbility(relay, action.use, `Actor.${id}`, `Actor.${id}.Item.${action.itemId}`, {}, action.noTemplate);
```

(the `action.use === 'cast-at-slot'` branch above it is untouched).

3. `cast-and-apply-effect` case (:1177): `await relay.useAbility('use-spell', ...)` becomes

```ts
              await activateAbility(relay, 'use-spell', `Actor.${id}`, `Actor.${id}.Item.${action.itemId}`, {}, action.noTemplate);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @companion/gateway test`
Expected: PASS — new routing tests AND every pre-existing cast/use test (non-template actions carry no flag, so they still hit useAbility directly).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @companion/gateway typecheck`

```bash
git add apps/gateway/src/app.ts apps/gateway/test/fakes.ts apps/gateway/test/app.test.ts
git commit -m "feat(gateway): route noTemplate activations through execute-js with module fallback

Template-bearing casts return in ~250ms instead of blocking 5-8s on
the headless canvas prompt; when execute-js is unavailable the module
use-* endpoint remains the (slow) fallback so base-level casts never
fail outright.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: full-suite gate

**Files:** none new.

- [ ] **Step 1: Run the whole workspace**

Run: `pnpm -r typecheck && pnpm -r test`
Expected: all packages PASS (web has no code change; its typecheck must stay green).

- [ ] **Step 2: Fix anything that surfaced, amend nothing — new commits only.**
