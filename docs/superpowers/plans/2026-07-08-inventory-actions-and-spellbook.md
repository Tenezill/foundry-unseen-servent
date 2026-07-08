# Inventory/Actions Split + Spellbook Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inventory rows become manage-only (stepper + equip); usable items (potions, torches…) move to a new Items group on the Actions tab; players can prepare/unprepare, learn, and forget spells.

**Architecture:** Two approved specs, implemented sequentially. Part A (Tasks 1–3) adds a `group` hint to `ActionDescriptor` so item-use actions land in their own Actions-tab group, routed through the existing relay `use-item` workflow. Part B (Tasks 4–8) adds a `prepare` action kind (generic `update-item` relay write), a `spellbook` adapter capability, relay `give`/`delete` client methods, four gateway endpoints, and the PWA search/preview/learn/forget UI.

**Tech Stack:** TypeScript monorepo (pnpm), Fastify gateway, Nuxt 3 PWA, vitest. Adapters are pinned to dnd5e 5.3.3 / Foundry v13 / relay+module 3.4.1.

## Global Constraints

- dnd5e 5.3.3 data paths: `system.prepared` is a NUMERIC flag (0/1/2). Never write `system.preparation.*` (pre-5.x path; the module's `prepare-spell` endpoint uses it and is therefore dead — bypass it).
- The repo ships no game-rules text; only content from the user's own world is rendered, sanitized client-side.
- Foundry owns all rules: actions are offered even when uses/slots are empty; Foundry refuses.
- Ownership failures are 404 (never 403 — do not leak actor existence). Writes share the rate limiter.
- Specs: `docs/superpowers/specs/2026-07-08-inventory-actions-split-design.md`, `docs/superpowers/specs/2026-07-08-spellbook-management-design.md`.
- Run tests with `pnpm --filter @companion/adapter-dnd5e test` / `pnpm --filter @companion/gateway test`; typecheck with `pnpm typecheck` (workspace).
- `POST /give` and `DELETE /delete` relay routes are source-verified in the module but not yet live-verified; the gateway work proceeds against fakes and live verification is recorded as a follow-up (see Task 8 notes).

---

### Task 1: Contract — `ActionDescriptor.group` (Part A)

**Files:**
- Modify: `packages/adapter-sdk/src/index.ts` (ActionDescriptor, ~line 173)

**Interfaces:**
- Produces: `ActionDescriptor.group?: string` — consumed by Task 2 (adapter emits `group: 'items'`) and Task 3 (PWA groups by it).

- [ ] **Step 1: Add the field** (types-only package; verification is typecheck)

```ts
export interface ActionDescriptor {
  /** stable id, e.g. "skill.ath", "ability.str.save", "item.<id>.attack",
   *  "spell.<id>.cast", "feature.<id>.use", "item.<id>.equip",
   *  "rest.short", "rest.long", "deathsave.roll", "concentration.end" */
  id: string;
  label: string;
  kind: SheetActionKind;
  /** UI grouping hint for actions sharing a kind, e.g. "items" separates
   *  item-use from feature-use on the Actions tab. */
  group?: string;
  /** cast only: slot levels currently legal (empty/absent = at-will/cantrip). */
  slotLevels?: number[];
  /** equip only: current state (the intent carries the desired state). */
  equipped?: boolean;
}
```

- [ ] **Step 2: Typecheck** — `pnpm --filter @companion/adapter-sdk typecheck` → Done
- [ ] **Step 3: Commit** — `git commit -m "contract: ActionDescriptor.group UI hint"`

### Task 2: dnd5e adapter — item-use actions, inventory rows lose Attack (Part A)

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts` (`inventoryListItem` ~629, new predicate near `isUsableFeature` ~567, `buildActions` ~730, `buildAction` case `'use'` ~837)
- Test: `packages/adapter-dnd5e/test/adapter.test.ts`

**Interfaces:**
- Consumes: `ActionDescriptor.group` (Task 1).
- Produces: actions `item.<id>.use` (kind `use`, group `items`); `buildAction` maps them to `{ endpoint: 'use-item', itemId }`. Inventory `ListItem`s no longer carry `actionId`.

- [ ] **Step 1: Write failing tests** (fixture `martial.json`: Torch/Rations have activities; Hammer is passive loot; Battleaxe is a weapon)

```ts
describe('item use actions (inventory/actions split)', () => {
  const actor = load('martial.json');
  const actions = dnd5eAdapter.actions!(actor);
  const itemOf = (name: string) => actor.items!.find((i) => i.name === name)!;

  it('offers use (group items) for physical items with activities', () => {
    const torch = itemOf('Torch');
    const a = actions.find((x) => x.id === `item.${torch._id}.use`);
    expect(a).toMatchObject({ kind: 'use', group: 'items', label: 'Torch' });
  });

  it('offers no use action for passive loot', () => {
    const hammer = itemOf('Hammer');
    expect(actions.find((x) => x.id === `item.${hammer._id}.use`)).toBeUndefined();
  });

  it('weapons keep attack and gain no item use action', () => {
    const weapon = actor.items!.find((i) => i.type === 'weapon')!;
    expect(actions.find((x) => x.id === `item.${weapon._id}.attack`)).toBeDefined();
    expect(actions.find((x) => x.id === `item.${weapon._id}.use`)).toBeUndefined();
  });

  it('maps item use intents to the use-item endpoint', () => {
    const torch = itemOf('Torch');
    const action = dnd5eAdapter.buildAction!(actor, { kind: 'use', actionId: `item.${torch._id}.use` });
    expect(action).toEqual({ endpoint: 'use-item', itemId: torch._id });
  });

  it('inventory rows carry no primary actionId', () => {
    const vm = dnd5eAdapter.toViewModel(actor);
    const inv = vm.sections.find((s) => s.id === 'inventory') as Extract<SheetSection, { kind: 'list' }>;
    for (const row of inv.items) expect(row.actionId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @companion/adapter-dnd5e test` → new tests FAIL
- [ ] **Step 3: Implement**

```ts
/** A physical, non-weapon item is usable when its data carries activities
 * (dnd5e 5.x usage rules). Weapons keep their attack action instead. */
function isUsableInventoryItem(item: FoundryItemDoc): boolean {
  if (!PHYSICAL_ITEM_TYPES.has(item.type) || item.type === 'weapon') return false;
  return Object.keys(rec(getPath(item.system, 'activities'))).length > 0;
}
```

In `buildActions`, inside the items loop after the weapon branch:

```ts
    if (isUsableInventoryItem(item)) {
      out.push({ id: `item.${item._id}.use`, label: item.name, kind: 'use', group: 'items' });
    }
```

In `buildAction`, replace the `'use'` case:

```ts
    case 'use': {
      // Items and features share the kind; the id prefix picks the endpoint.
      if (intent.actionId.startsWith('item.')) {
        return { endpoint: 'use-item', itemId: intent.actionId.slice('item.'.length, -'.use'.length) };
      }
      return { endpoint: 'use-feature', itemId: intent.actionId.slice('feature.'.length, -'.use'.length) };
    }
```

In `inventoryListItem`, delete the line
`...(item.type === 'weapon' ? { actionId: `item.${item._id}.attack` } : {}),`

- [ ] **Step 4: Run tests** — all pass (fix any existing test asserting inventory `actionId`)
- [ ] **Step 5: Commit** — `git commit -m "dnd5e: usable items get use actions; inventory rows manage only"`

### Task 3: PWA — Items group on the Actions tab (Part A)

**Files:**
- Modify: `apps/web/app/components/SectionActions.vue` (GROUP_DEFS ~41, groups computed ~48)

**Interfaces:**
- Consumes: `ActionDescriptor.group === 'items'` (Tasks 1–2). No new outputs.

- [ ] **Step 1: Implement** — replace GROUP_DEFS + groups:

```ts
const GROUP_DEFS = [
  { id: 'attacks', label: 'Attacks', kind: 'attack', group: undefined, verb: 'Attack', icon: 'M14.5 3.5 21 10l-2 2-6.5-6.5ZM3 21l7-7M6.5 17.5 3 21' },
  { id: 'spells', label: 'Spells', kind: 'cast', group: undefined, verb: 'Cast', icon: 'M12 3l1.8 4.9L18.8 9l-4.9 1.8L12 15.7 10.2 10.8 5.2 9l5-1.1ZM18 15l.9 2.4 2.4.9-2.4.9L18 22l-.9-2.4-2.4-.9 2.4-.9Z' },
  { id: 'features', label: 'Features', kind: 'use', group: undefined, verb: 'Use', icon: 'M13 2 4 14h6l-1 8 9-12h-6z' },
  { id: 'items', label: 'Items', kind: 'use', group: 'items', verb: 'Use', icon: 'M10 2h4v3.2l2.5 4.2A6 6 0 0 1 12 22a6 6 0 0 1-4.5-12.6L10 5.2Z' },
] as const

/** Non-empty groups only — kind AND group hint must match. */
const groups = computed(() =>
  GROUP_DEFS.map((def) => ({
    ...def,
    actions: props.actions.filter((a) => a.kind === def.kind && a.group === def.group),
  })).filter((g) => g.actions.length > 0),
)
```

- [ ] **Step 2: Verify** — `pnpm --filter @companion/web typecheck`; run the mock-backed dev app if configured (`apps/web/mock`) and eyeball the Actions tab.
- [ ] **Step 3: Commit** — `git commit -m "web: Items group on Actions tab"`

### Task 4: Contract — prepare kind, update-item, toggleActionId, spellbook (Part B)

**Files:**
- Modify: `packages/adapter-sdk/src/index.ts`
- Modify (mechanical rename fallout): `packages/adapter-dnd5e/src/index.ts`, `apps/web/app/components/SectionList.vue`, any tests referencing `equipActionId`

**Interfaces:**
- Produces (consumed by Tasks 5–8):
  - `SheetActionKind` includes `'prepare'`; `ActionDescriptor.prepared?: boolean`
  - `ActionIntent` includes `{ kind: 'prepare'; actionId: string; prepared: boolean }`
  - `RelayAction` includes `{ endpoint: 'update-item'; itemId: string; data: Record<string, number | string | boolean> }`
  - `ListItem.toggleActionId?: string` (replaces `equipActionId`)
  - `ListItem.forgettable?: boolean`
  - `SheetViewModel.hasSpellbook?: boolean`
  - `SystemAdapter.spellbook?: SpellbookSupport`

- [ ] **Step 1: Edit the contract**

```ts
export type SheetActionKind =
  | 'check' | 'save' | 'attack' | 'cast' | 'use' | 'equip'
  /** toggle a spell's prepared state (item-field write, no chat card). */
  | 'prepare'
  | 'rest' | 'deathsave' | 'endconcentration';
```

`ActionDescriptor` gains `/** equip/prepare only: current state. */ prepared?: boolean;`
(keep `equipped?: boolean` as-is).

```ts
export type ActionIntent =
  | { kind: 'check' | 'save'; actionId: string; mode?: 'advantage' | 'disadvantage' }
  | { kind: 'attack' | 'use'; actionId: string }
  | { kind: 'cast'; actionId: string; slotLevel?: number }
  | { kind: 'equip'; actionId: string; equipped: boolean }
  | { kind: 'prepare'; actionId: string; prepared: boolean }
  | { kind: 'rest' | 'deathsave' | 'endconcentration'; actionId: string };

export type RelayAction =
  | { endpoint: 'roll'; formula: string; flavor: string }
  | { endpoint: 'use-item' | 'use-spell' | 'use-feature'; itemId: string; slotLevel?: number }
  | { endpoint: 'equip-item'; itemId: string; equipped: boolean }
  /** Generic embedded-item field write (e.g. prepared state); executed via
   *  the same entity-update path as quantity/uses. */
  | { endpoint: 'update-item'; itemId: string; data: Record<string, number | string | boolean> }
  | { endpoint: 'short-rest' | 'long-rest' | 'death-save' | 'break-concentration' };
```

`ListItem`: rename `equipActionId` → `toggleActionId` (doc: “Secondary toggle action (equip/unequip, prepare/unprepare), when applicable.”) and add
`/** May be deleted via the spellbook API (renders a destructive detail action). */ forgettable?: boolean;`

`SheetViewModel` gains `/** True when the adapter supports spellbook search/learn/forget. */ hasSpellbook?: boolean;`

```ts
/** Optional spellbook capability: search the world's compendia, learn a
 * found spell (relay `give`), forget a known one (relay `delete`). */
export interface SpellbookSupport {
  /** relay /search filter for learnable entries, e.g. "documentType:Item,subType:spell". */
  searchFilter: string;
  /** fetched compendium doc is a learnable spell. */
  canLearn(doc: Record<string, unknown>): boolean;
  /** embedded item may be deleted via the spellbook API. */
  canForget(item: FoundryItemDoc): boolean;
  /** preview for the learn-confirm sheet: label, "3rd level · Evocation", detail HTML. */
  describe(doc: Record<string, unknown>): ListItem;
}
```

`SystemAdapter` gains `spellbook?: SpellbookSupport;`

- [ ] **Step 2: Mechanical rename fallout** — replace `equipActionId` with `toggleActionId` in `packages/adapter-dnd5e/src/index.ts` (`inventoryListItem`) and `apps/web/app/components/SectionList.vue` (`equipOf`, template) and any tests. `pnpm typecheck` must pass workspace-wide.
- [ ] **Step 3: Commit** — `git commit -m "contract: prepare kind, update-item relay action, toggleActionId, SpellbookSupport"`

### Task 5: dnd5e adapter — prepare toggles + spellbook capability (Part B)

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts` (`spellListItem` ~669, `buildActions`, `buildAction`, `toViewModel`, adapter export)
- Test: `packages/adapter-dnd5e/test/adapter.test.ts` (fixture `caster.json` has leveled + always-prepared spells and cantrips)

**Interfaces:**
- Consumes: Task 4 contract.
- Produces: actions `spell.<id>.prepare` with `prepared` state; `buildAction` maps them to `update-item` writing `system.prepared`; `dnd5eAdapter.spellbook` with the four members; spell `ListItem`s carry `toggleActionId` + `forgettable: true`; view model has `hasSpellbook: true`.

- [ ] **Step 1: Write failing tests**

```ts
describe('spellbook management', () => {
  const actor = load('caster.json');
  const actions = dnd5eAdapter.actions!(actor);
  const spells = actor.items!.filter((i) => i.type === 'spell');
  const leveled = spells.find((s) => (s.system.level as number) > 0 && s.system.prepared !== 2)!;
  const cantrip = spells.find((s) => (s.system.level as number) === 0)!;

  it('offers a prepare toggle for leveled, not-always-prepared spells', () => {
    const a = actions.find((x) => x.id === `spell.${leveled._id}.prepare`);
    expect(a).toMatchObject({ kind: 'prepare' });
    expect(typeof a?.prepared).toBe('boolean');
  });

  it('offers no prepare toggle for cantrips', () => {
    expect(actions.find((x) => x.id === `spell.${cantrip._id}.prepare`)).toBeUndefined();
  });

  it('maps prepare intents to an update-item write on system.prepared', () => {
    const action = dnd5eAdapter.buildAction!(actor, {
      kind: 'prepare', actionId: `spell.${leveled._id}.prepare`, prepared: true,
    });
    expect(action).toEqual({ endpoint: 'update-item', itemId: leveled._id, data: { 'system.prepared': 1 } });
  });

  it('spell rows carry toggleActionId and forgettable', () => {
    const vm = dnd5eAdapter.toViewModel(actor);
    const list = vm.sections.find((s) => s.id === 'spells') as Extract<SheetSection, { kind: 'list' }>;
    const row = list.items.find((r) => r.id === leveled._id)!;
    expect(row.toggleActionId).toBe(`spell.${leveled._id}.prepare`);
    expect(row.forgettable).toBe(true);
    expect(vm.hasSpellbook).toBe(true);
  });

  it('spellbook capability accepts spells and rejects everything else', () => {
    const sb = dnd5eAdapter.spellbook!;
    expect(sb.searchFilter).toBe('documentType:Item,subType:spell');
    expect(sb.canLearn({ type: 'spell' })).toBe(true);
    expect(sb.canLearn({ type: 'weapon' })).toBe(false);
    expect(sb.canForget(leveled)).toBe(true);
    expect(sb.canForget(actor.items!.find((i) => i.type !== 'spell')!)).toBe(false);
  });

  it('describe renders a preview ListItem from a raw spell doc', () => {
    const doc = { _id: 'x1', name: 'Fireball', type: 'spell', img: 'i.webp',
      system: { level: 3, school: 'evo', description: { value: '<p>Boom</p>' } } };
    const li = dnd5eAdapter.spellbook!.describe(doc);
    expect(li).toMatchObject({ id: 'x1', label: 'Fireball', detail: '<p>Boom</p>' });
    expect(li.sub).toContain('3rd level');
  });
});
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement**

```ts
/** Leveled, not-always-prepared spells may be toggled; cantrips and
 * `prepared: 2` (always prepared) may not. */
function isPreparableSpell(item: FoundryItemDoc): boolean {
  if (item.type !== 'spell') return false;
  const level = numAt(item.system, 'level') ?? 0;
  return level > 0 && getPath(item.system, 'prepared') !== 2;
}
```

`spellListItem` return gains (reusing its `isPrepared`):

```ts
    ...(isPreparableSpell(item) ? { toggleActionId: `spell.${item._id}.prepare` } : {}),
    forgettable: true,
```

`buildActions` items loop (inside the existing `item.type === 'spell'` branch):

```ts
      if (isPreparableSpell(item)) {
        out.push({
          id: `spell.${item._id}.prepare`,
          label: item.name,
          kind: 'prepare',
          prepared: getPath(item.system, 'prepared') === 2 || getPath(item.system, 'prepared') === 1 || getPath(item.system, 'prepared') === true,
        });
      }
```

`buildAction` gains:

```ts
    case 'prepare': {
      if (typeof intent.prepared !== 'boolean') {
        throw new IntentError('prepare requires a boolean "prepared"', 'INVALID');
      }
      return {
        endpoint: 'update-item',
        itemId: intent.actionId.slice('spell.'.length, -'.prepare'.length),
        data: { 'system.prepared': intent.prepared ? 1 : 0 },
      };
    }
```

`toViewModel` result gains `hasSpellbook: true`. Adapter export gains:

```ts
const spellbook: SpellbookSupport = {
  searchFilter: 'documentType:Item,subType:spell',
  canLearn: (doc) => doc.type === 'spell',
  canForget: (item) => item.type === 'spell',
  describe: (doc) => spellPreview(doc),
};
```

with `spellPreview` building `{ id, label: name, sub: '<ordinal> level · <school>' | 'Cantrip', img?, detail? }` from the raw doc via the existing `numAt`/`strAt`/`SPELL_SCHOOLS`/`ordinal`/`itemDetail` helpers (doc shape: `{ _id, name, img?, system: { level, school, description } }`).

- [ ] **Step 4: Run tests** — pass
- [ ] **Step 5: Commit** — `git commit -m "dnd5e: prepare toggles + spellbook capability"`

### Task 6: foundry-client — giveItem / deleteEntity (Part B)

**Files:**
- Modify: `packages/foundry-client/src/index.ts`

**Interfaces:**
- Produces: `giveItem(toUuid: string, itemUuid: string): Promise<void>`, `deleteEntity(uuid: string): Promise<void>` — consumed by Task 7's RelayPort.

- [ ] **Step 1: Implement** (this package has no unit tests — it is the transport wrapper; contract is live-verified per repo convention)

```ts
  /**
   * POST /give — copy an item (any uuid `fromUuid` resolves, INCLUDING
   * compendium uuids) onto a target actor. Module 3.4.1 source-verified;
   * route + player-key scope pending live verification.
   */
  async giveItem(toUuid: string, itemUuid: string): Promise<void> {
    const body = await this.request<{ error?: string }>('POST', '/give', {}, { toUuid, itemUuid, quantity: 1 });
    if (typeof body.error === 'string' && body.error !== '') {
      throw new RelayError(`relay /give: ${body.error}`, 200, '/give');
    }
  }

  /**
   * DELETE /delete — delete an entity by uuid; embedded item uuids
   * (`Actor.<id>.Item.<id>`) resolve via fromUuid. Module 3.4.1
   * source-verified; route pending live verification.
   */
  async deleteEntity(uuid: string): Promise<void> {
    const body = await this.request<{ error?: string }>('DELETE', '/delete', { uuid });
    if (typeof body.error === 'string' && body.error !== '') {
      throw new RelayError(`relay /delete: ${body.error}`, 200, '/delete');
    }
  }
```

- [ ] **Step 2: Typecheck + commit** — `git commit -m "foundry-client: give-item and delete-entity wrappers"`

### Task 7: Gateway — update-item execution + spellbook endpoints (Part B)

**Files:**
- Modify: `apps/gateway/src/app.ts` (RelayPort, `parseActionIntent` ~165, actions-route switch ~612, new routes after the actions route)
- Modify: `apps/gateway/test/fakes.ts` (FakeRelay search/give/delete, fakeAdapter spellbook, spell item in `actorDoc`)
- Test: `apps/gateway/test/app.test.ts`

**Interfaces:**
- Consumes: Task 4 contract, Task 6 client methods.
- Produces HTTP surface (consumed by Task 8 PWA):
  - `GET  /api/actors/:id/spellbook/search?q=` → `{ results: [{ uuid, name, img?, pack? }] }`
  - `GET  /api/actors/:id/spellbook/preview?uuid=` → `{ preview: ListItem }` (422 when `canLearn` rejects)
  - `POST /api/actors/:id/spellbook/learn` body `{ uuid }` → `{ sheet }` (422 non-spell)
  - `DELETE /api/actors/:id/spells/:itemId` → `{ sheet }` (403 when `canForget` rejects or item missing)
  - All: 404 unknown/unowned actor or adapter without `spellbook`; learn/forget rate-limited.

- [ ] **Step 1: RelayPort + FakeRelay additions**

RelayPort gains:

```ts
  /** GET /search — find entities (compendia included by default). */
  search(opts: { query?: string; filter?: string; limit?: number }): Promise<
    Array<{ uuid: string; id: string; name: string; img?: string; documentType: string; [key: string]: unknown }>
  >;
  /** POST /give — copy an item (compendium uuid ok) onto a target actor. */
  giveItem(toUuid: string, itemUuid: string): Promise<void>;
  /** DELETE /delete — delete an entity (embedded item uuid ok). */
  deleteEntity(uuid: string): Promise<void>;
```

FakeRelay gains:

```ts
  /** Entries returned by search(); tests seed this. */
  searchResults: Array<{ uuid: string; id: string; name: string; img?: string; documentType: string; [key: string]: unknown }> = [];
  readonly searchCalls: Array<{ query?: string; filter?: string; limit?: number }> = [];

  async search(opts: { query?: string; filter?: string; limit?: number }) {
    this.searchCalls.push({ ...opts });
    if (this.actionError) this.throwActionError('search');
    return structuredClone(this.searchResults);
  }

  readonly giveCalls: Array<{ toUuid: string; itemUuid: string }> = [];

  /** Copies the referenced entity's doc into the target actor's items. */
  async giveItem(toUuid: string, itemUuid: string): Promise<void> {
    this.giveCalls.push({ toUuid, itemUuid });
    if (this.actionError) this.throwActionError('give');
    const src = this.entities.get(itemUuid);
    const target = this.entities.get(toUuid);
    if (!src || !target) throw new Error(`give: missing ${!src ? itemUuid : toUuid}`);
    const items = (target.items ?? []) as Array<Record<string, unknown>>;
    items.push({ ...structuredClone(src), _id: `given-${this.giveCalls.length}` });
    target.items = items;
  }

  readonly deleteCalls: string[] = [];

  async deleteEntity(uuid: string): Promise<void> {
    this.deleteCalls.push(uuid);
    if (this.actionError) this.throwActionError('delete');
    const m = /^Actor\.([^.]+)\.Item\.([^.]+)$/.exec(uuid);
    if (!m) throw new Error(`delete: unsupported uuid ${uuid}`);
    const actor = this.entities.get(`Actor.${m[1]}`);
    if (!actor) throw new Error(`delete: no entity ${uuid}`);
    actor.items = ((actor.items ?? []) as Array<Record<string, unknown>>).filter((i) => i._id !== m[2]);
  }
```

fakeAdapter gains a spell item in `actorDoc` (`{ _id: 's1', name: 'Zap', type: 'spell', system: {} }`), `hasSpellbook: true` on its view model, and:

```ts
  spellbook: {
    searchFilter: 'documentType:Item,subType:spell',
    canLearn: (doc) => doc.type === 'spell',
    canForget: (item) => item.type === 'spell',
    describe: (doc) => ({ id: String(doc._id ?? 'preview'), label: String(doc.name ?? '?'), sub: 'spell' }),
  },
```

fakeAdapter's `actionList` gains `{ id: 'spell.s1.prepare', label: 'Zap', kind: 'prepare', prepared: false }` and `buildAction` gains
`case 'prepare': return { endpoint: 'update-item', itemId: 's1', data: { 'system.prepared': intent.prepared ? 1 : 0 } };`

- [ ] **Step 2: Write failing gateway tests**

```ts
describe('spellbook endpoints', () => {
  it('searches with the adapter filter and maps results', async () => {
    const { app, relay } = setup();
    relay.searchResults = [{ uuid: 'Compendium.x.Item.f1', id: 'f1', name: 'Fireball', img: 'f.webp', documentType: 'Item', packageName: 'dnd5e.spells' }];
    const res = await app.inject({ method: 'GET', url: '/api/actors/a1/spellbook/search?q=fire', headers: asAnna });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ results: [{ uuid: 'Compendium.x.Item.f1', name: 'Fireball', img: 'f.webp', pack: 'dnd5e.spells' }] });
    expect(relay.searchCalls[0]).toMatchObject({ query: 'fire', filter: 'documentType:Item,subType:spell' });
  });

  it('previews a learnable spell and rejects non-spells with 422', async () => {
    const { app, relay } = setup();
    relay.entities.set('Compendium.x.Item.f1', { _id: 'f1', name: 'Fireball', type: 'spell', system: {} });
    relay.entities.set('Compendium.x.Item.w1', { _id: 'w1', name: 'Sword', type: 'weapon', system: {} });
    const ok = await app.inject({ method: 'GET', url: '/api/actors/a1/spellbook/preview?uuid=Compendium.x.Item.f1', headers: asAnna });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().preview).toMatchObject({ label: 'Fireball' });
    const bad = await app.inject({ method: 'GET', url: '/api/actors/a1/spellbook/preview?uuid=Compendium.x.Item.w1', headers: asAnna });
    expect(bad.statusCode).toBe(422);
  });

  it('learns a spell via relay give and returns a fresh sheet', async () => {
    const { app, relay } = setup();
    relay.entities.set('Compendium.x.Item.f1', { _id: 'f1', name: 'Fireball', type: 'spell', system: {} });
    const res = await app.inject({ method: 'POST', url: '/api/actors/a1/spellbook/learn', headers: asAnna, payload: { uuid: 'Compendium.x.Item.f1' } });
    expect(res.statusCode).toBe(200);
    expect(relay.giveCalls).toEqual([{ toUuid: 'Actor.a1', itemUuid: 'Compendium.x.Item.f1' }]);
    expect(res.json().sheet).toBeDefined();
  });

  it('rejects learning a non-spell with 422 and no give call', async () => {
    const { app, relay } = setup();
    relay.entities.set('Compendium.x.Item.w1', { _id: 'w1', name: 'Sword', type: 'weapon', system: {} });
    const res = await app.inject({ method: 'POST', url: '/api/actors/a1/spellbook/learn', headers: asAnna, payload: { uuid: 'Compendium.x.Item.w1' } });
    expect(res.statusCode).toBe(422);
    expect(relay.giveCalls).toEqual([]);
  });

  it('forgets a spell via relay delete; non-spells and unknown items are 403', async () => {
    const { app, relay } = setup();
    const ok = await app.inject({ method: 'DELETE', url: '/api/actors/a1/spells/s1', headers: asAnna });
    expect(ok.statusCode).toBe(200);
    expect(relay.deleteCalls).toEqual(['Actor.a1.Item.s1']);
    const nonSpell = await app.inject({ method: 'DELETE', url: '/api/actors/a1/spells/i1', headers: asAnna });
    expect(nonSpell.statusCode).toBe(403);
    const missing = await app.inject({ method: 'DELETE', url: '/api/actors/a1/spells/nope', headers: asAnna });
    expect(missing.statusCode).toBe(403);
  });

  it('hides spellbook routes for unowned actors (404) and unauthenticated (401)', async () => {
    const { app } = setup();
    const unowned = await app.inject({ method: 'GET', url: '/api/actors/b9/spellbook/search?q=x', headers: asAnna });
    expect(unowned.statusCode).toBe(404);
    const anon = await app.inject({ method: 'GET', url: '/api/actors/a1/spellbook/search?q=x' });
    expect(anon.statusCode).toBe(401);
  });

  it('executes prepare actions as an item-field update', async () => {
    const { app, relay } = setup();
    const res = await app.inject({ method: 'POST', url: '/api/actors/a1/actions', headers: asAnna,
      payload: { kind: 'prepare', actionId: 'spell.s1.prepare', prepared: true } });
    expect(res.statusCode).toBe(200);
    expect(relay.updates.at(-1)).toEqual({ uuid: 'Actor.a1.Item.s1', data: { 'system.prepared': 1 } });
  });
});
```

(Adjust `setup()` usage to the file's existing helper; `asAnna` etc. already exist.)

- [ ] **Step 3: Run to verify failure**
- [ ] **Step 4: Implement in app.ts**

`parseActionIntent` gains:

```ts
    case 'prepare':
      if (typeof body.prepared !== 'boolean') return null;
      return { kind, actionId, prepared: body.prepared };
```

Actions-route switch gains:

```ts
        case 'update-item':
          await relay.updateEntity(`Actor.${id}.Item.${action.itemId}`, action.data);
          break;
```

New routes (after the actions route; shared helper mirrors the ownership preamble):

```ts
  /** Ownership + adapter + spellbook preamble shared by the spellbook routes.
   *  Returns null after sending the error response. */
  const spellbookCtx = async (
    req: FastifyRequest,
    reply: FastifyReply,
    id: string,
  ): Promise<{ actor: FoundryActorDoc; adapter: SystemAdapter; spellbook: NonNullable<SystemAdapter['spellbook']> } | null> => {
    const player = req.player as Player;
    if (!player.actorIds.includes(id)) {
      sendError(reply, 404, 'NOT_FOUND', 'actor not found');
      return null;
    }
    const actor = await fetchActor(id);
    if (!actor) {
      sendError(reply, 404, 'NOT_FOUND', 'actor not found');
      return null;
    }
    const adapter = adapterFor(actor);
    if (!adapter) {
      sendError(reply, 502, 'UPSTREAM', 'no adapter for actor system');
      return null;
    }
    if (!adapter.spellbook) {
      sendError(reply, 404, 'NOT_FOUND', 'not found');
      return null;
    }
    return { actor, adapter, spellbook: adapter.spellbook };
  };

  app.get<{ Params: { id: string }; Querystring: { q?: string } }>(
    '/api/actors/:id/spellbook/search',
    { preHandler: auth(false) },
    async (req, reply) => {
      const ctx = await spellbookCtx(req, reply, req.params.id);
      if (!ctx) return reply;
      const q = (req.query.q ?? '').trim();
      if (q === '') return reply.code(200).send({ results: [] });
      const entries = await ctx.spellbook
        ? await relay.search({ query: q, filter: ctx.spellbook.searchFilter, limit: 20 })
        : [];
      const results = entries.map((e) => ({
        uuid: e.uuid,
        name: e.name,
        ...(typeof e.img === 'string' ? { img: e.img } : {}),
        ...(typeof e.packageName === 'string' ? { pack: e.packageName } : {}),
      }));
      return reply.code(200).send({ results });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { uuid?: string } }>(
    '/api/actors/:id/spellbook/preview',
    { preHandler: auth(false) },
    async (req, reply) => {
      const ctx = await spellbookCtx(req, reply, req.params.id);
      if (!ctx) return reply;
      const uuid = req.query.uuid ?? '';
      if (uuid === '') return sendError(reply, 422, 'INVALID_INTENT', 'uuid is required');
      const doc = await relay.getEntity(uuid);
      if (!doc) return sendError(reply, 404, 'NOT_FOUND', 'entry not found');
      if (!ctx.spellbook.canLearn(doc)) {
        return sendError(reply, 422, 'INVALID_INTENT', 'entry is not a learnable spell');
      }
      return reply.code(200).send({ preview: ctx.spellbook.describe(doc) });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/actors/:id/spellbook/learn',
    { preHandler: auth(false) },
    async (req, reply) => {
      const player = req.player as Player;
      if (!limiter.allow(player.tokenHash)) {
        return sendError(reply, 429, 'RATE_LIMITED', 'too many write intents');
      }
      const ctx = await spellbookCtx(req, reply, req.params.id);
      if (!ctx) return reply;
      const raw = (req.body ?? {}) as Record<string, unknown>;
      if (typeof raw.uuid !== 'string' || raw.uuid === '') {
        return sendError(reply, 422, 'INVALID_INTENT', 'uuid is required');
      }
      const doc = await relay.getEntity(raw.uuid);
      if (!doc) return sendError(reply, 404, 'NOT_FOUND', 'entry not found');
      if (!ctx.spellbook.canLearn(doc)) {
        return sendError(reply, 422, 'INVALID_INTENT', 'entry is not a learnable spell');
      }
      await relay.giveItem(`Actor.${req.params.id}`, raw.uuid);
      const fresh = await fetchActor(req.params.id);
      if (!fresh) return sendError(reply, 502, 'UPSTREAM', 'upstream error');
      const freshAdapter = adapterFor(fresh) ?? ctx.adapter;
      return reply.code(200).send({ sheet: buildSheet(freshAdapter, fresh) });
    },
  );

  app.delete<{ Params: { id: string; itemId: string } }>(
    '/api/actors/:id/spells/:itemId',
    { preHandler: auth(false) },
    async (req, reply) => {
      const player = req.player as Player;
      if (!limiter.allow(player.tokenHash)) {
        return sendError(reply, 429, 'RATE_LIMITED', 'too many write intents');
      }
      const ctx = await spellbookCtx(req, reply, req.params.id);
      if (!ctx) return reply;
      const item = (ctx.actor.items ?? []).find((i) => i._id === req.params.itemId);
      if (!item || !ctx.spellbook.canForget(item)) {
        return sendError(reply, 403, 'FORBIDDEN_RESOURCE', 'item does not exist or cannot be forgotten');
      }
      await relay.deleteEntity(`Actor.${req.params.id}.Item.${req.params.itemId}`);
      const fresh = await fetchActor(req.params.id);
      if (!fresh) return sendError(reply, 502, 'UPSTREAM', 'upstream error');
      const freshAdapter = adapterFor(fresh) ?? ctx.adapter;
      return reply.code(200).send({ sheet: buildSheet(freshAdapter, fresh) });
    },
  );
```

(Note: fix the stray `await ctx.spellbook ? … : []` line — it must be a plain `await relay.search(…)`; ctx is already non-null.)

- [ ] **Step 5: Run tests** — pass; full gateway suite green
- [ ] **Step 6: Commit** — `git commit -m "gateway: spellbook search/preview/learn/forget + prepare execution"`

### Task 8: PWA — prepared pill, Learn-spell sheet, Forget button (Part B)

**Files:**
- Modify: `apps/web/app/components/SectionList.vue` (toggle pill by kind)
- Modify: `apps/web/app/components/DetailDialog.vue` (optional destructive action)
- Create: `apps/web/app/components/SpellbookSearch.vue`
- Modify: `apps/web/app/pages/actor/[id].vue` (Learn button, handlers, forget flow)
- Modify: `apps/web/app/types/api.ts` (SpellSearch types)
- Modify: `apps/web/app/composables/useApi.ts` (allow DELETE)

**Interfaces:**
- Consumes: Task 7 HTTP surface; Task 4 `toggleActionId`/`forgettable`/`hasSpellbook`.

- [ ] **Step 1: useApi** — `method?: 'GET' | 'POST' | 'DELETE'`
- [ ] **Step 2: types/api.ts**

```ts
export interface SpellSearchEntry { uuid: string; name: string; img?: string; pack?: string }
export interface SpellSearchResponse { results: SpellSearchEntry[] }
export interface SpellPreviewResponse { preview: ListItem }
```

(`ListItem` imported from `@companion/adapter-sdk`.)

- [ ] **Step 3: SectionList toggle pill** — replace `equipOf`/button:

```ts
function toggleOf(item: ListItem): ActionDescriptor | undefined {
  return item.toggleActionId ? props.actions[item.toggleActionId] : undefined
}
function toggleOn(a: ActionDescriptor): boolean {
  return a.kind === 'prepare' ? a.prepared === true : a.equipped === true
}
function toggleLabel(a: ActionDescriptor): string {
  if (a.kind === 'prepare') return a.prepared ? 'Prepared' : 'Prepare'
  return a.equipped ? 'Equipped' : 'Equip'
}
```

Template: pill uses `toggleOf(item)`, `:class="{ on: toggleOn(toggleOf(item)!), pending: actionBusy === item.toggleActionId }"`, label `{{ toggleLabel(toggleOf(item)!) }}`, click emits `item.toggleActionId`.

- [ ] **Step 4: [id].vue onAction 'prepare' case**

```ts
    case 'prepare':
      void submitAction(
        { kind: 'prepare', actionId, prepared: !(action.prepared ?? false) },
        action.label,
      )
      break
```

- [ ] **Step 5: DetailDialog destructive action** — new optional props `danger?: string`, `dangerBusy?: boolean`; when set, render a destructive button under the content that emits `'danger'`. Style: existing `--garnet` palette, full-width, `border-radius: 12px`.
- [ ] **Step 6: SpellbookSearch.vue** — dumb modal-sheet component (pattern: ActionSheet):

Props `{ results: SpellSearchEntry[]; preview: ListItem | null; knownNames: string[]; busy: boolean; searching: boolean }`, emits `search(q: string)` (input debounced 300 ms in-component), `preview(uuid: string)`, `learn(uuid: string)`, `back` (from preview to results), `close`. Layout: title "Learn a spell", search input, result rows (ActorAvatar + name + pack) tappable → emits preview; preview pane shows `preview.label`, `preview.sub`, sanitized `preview.detail` (via the existing `sanitizeHtml` util), an "Already known" hint when `knownNames` contains the name (case-insensitive), and a gold "Learn" button.

- [ ] **Step 7: [id].vue wiring** — state + handlers:

```ts
const spellSearchOpen = ref(false)
const spellResults = ref<SpellSearchEntry[]>([])
const spellPreview = ref<ListItem | null>(null)
const spellPreviewUuid = ref<string | null>(null)
const spellBusy = ref(false)
const spellSearching = ref(false)

const knownSpellNames = computed(() =>
  (sectionsByTab.value.spells.flatMap((s) => (s.kind === 'list' ? s.items : []))).map((i) => i.label),
)

async function onSpellSearch(q: string): Promise<void> {
  if (q.trim() === '') { spellResults.value = []; return }
  spellSearching.value = true
  try {
    const res = await api<SpellSearchResponse>(
      `/api/actors/${actorId.value}/spellbook/search?q=${encodeURIComponent(q)}`)
    spellResults.value = res.results
  } catch { toast.show('Search failed. Try again.') } finally { spellSearching.value = false }
}

async function onSpellPreview(uuid: string): Promise<void> {
  spellBusy.value = true
  try {
    const res = await api<SpellPreviewResponse>(
      `/api/actors/${actorId.value}/spellbook/preview?uuid=${encodeURIComponent(uuid)}`)
    spellPreview.value = res.preview
    spellPreviewUuid.value = uuid
  } catch { toast.show('Couldn’t load that spell.') } finally { spellBusy.value = false }
}

async function onSpellLearn(uuid: string): Promise<void> {
  spellBusy.value = true
  try {
    const res = await api<SheetResponse>(`/api/actors/${actorId.value}/spellbook/learn`,
      { method: 'POST', body: { uuid } })
    applySheet(res.sheet)
    toast.show(`Learned ${spellPreview.value?.label ?? 'spell'}`)
    spellSearchOpen.value = false
    spellPreview.value = null
  } catch { toast.show('Learning didn’t go through. Try again.') } finally { spellBusy.value = false }
}

async function onForget(): Promise<void> {
  const target = detailFor.value
  if (!target?.itemId) return
  const ok = await askConfirm(`Forget ${target.title}? This removes it from the spellbook.`)
  if (!ok) return
  try {
    const res = await api<SheetResponse>(
      `/api/actors/${actorId.value}/spells/${target.itemId}`, { method: 'DELETE' })
    applySheet(res.sheet)
    detailFor.value = null
    toast.show(`Forgot ${target.title}`)
  } catch { toast.show('Couldn’t forget that spell.') }
}
```

`detailFor` grows `{ title, detail, itemId?, forgettable? }` (set from `onDetail(item)`); DetailDialog gets `:danger="detailFor.forgettable ? 'Forget spell' : undefined"` and `@danger="onForget"`. Template: on the spells tab, when `sheet.hasSpellbook && !offline`, render a "Learn spell" button above the spell sections; `<SpellbookSearch v-if="spellSearchOpen" …>` below the other dialogs.

- [ ] **Step 8: Verify** — `pnpm --filter @companion/web typecheck`; walk the flow against the mock/dev stack if available.
- [ ] **Step 9: Commit** — `git commit -m "web: prepared toggle, learn-spell search, forget spell"`

**Live-verification note (repo convention):** before first production use, verify against the real stack and record in `docs/M0-findings.md` or a new `docs/M10-findings.md`: (1) `POST /give` route name/payload and that the player-scoped key may give compendium items, (2) `DELETE /delete` on an embedded spell uuid, (3) `PUT /update` with `{"system.prepared": 1}` flips the checkbox in the dnd5e sheet.

---

## Self-Review

- Spec coverage: spec 1 → Tasks 1–3 (group hint, adapter actions + row change, PWA group). Spec 2 → Tasks 4–8 (contract incl. rename + forgettable + hasSpellbook, adapter, client, gateway, PWA). Live-verify recorded as a note in Task 8.
- Placeholder scan: all steps carry concrete code; the one intentionally flagged bug (`await ctx.spellbook ? … : []`) is called out for correction in Task 7 Step 4's note.
- Type consistency: `toggleActionId`, `forgettable`, `hasSpellbook`, `SpellbookSupport.{searchFilter,canLearn,canForget,describe}`, `RelayAction 'update-item'`, `giveItem/deleteEntity/search` names match across tasks.
