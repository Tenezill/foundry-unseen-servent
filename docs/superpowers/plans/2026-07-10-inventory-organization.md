# Inventory Organization (M19) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Location-first inventory — a Carried section plus one collapsible section per container, a "Move to…" action that pushes items between locations by writing `system.container`, and the currency wallet relocated from the Resources tab to the Inventory tab.

**Architecture:** A new `move` action kind flows through the existing action pipeline (adapter `buildAction` → gateway `update-item` → relay `updateEntity`) — the gateway's execution switch already handles `update-item`, so no new relay surface. The adapter stops emitting one flat `inventory` section and instead emits `Carried` plus one list section per container (with the container's own ListItem as a new optional section `header`). The web `SectionList` learns to render a header item, collapse with per-device persistence, and an empty hint; `DetailDialog` gains a "Move to…" block.

**Tech Stack:** TypeScript ESM monorepo — `packages/adapter-sdk` (types), `packages/adapter-dnd5e` (vitest, fixture-driven), `apps/gateway` (Fastify, vitest), `apps/web` (Nuxt 3, no unit suite — typecheck + live verify).

**Spec:** `docs/superpowers/specs/2026-07-10-inventory-organization-design.md`

## Global Constraints

- The `move` target must be a `container`-type item on the same actor → `IntentError('…', 'INVALID')` (gateway maps to 422). No cycles: an item cannot move into itself, and a container cannot move into its own transitive contents.
- Moving to *Carried* writes `{'system.container': ''}` (dnd5e clears the ref with an empty string).
- Dangling `system.container` refs (id not on this sheet) count as **Carried** — today's behavior, kept. IMPORTANT: both captured fixtures contain ONLY dangling refs (compendium-source ids); tests that need working containment must repair refs on a `structuredClone` of the fixture.
- Section ids must satisfy the web tab-routing regex `/invent|item|equip|gear|loot/` (`apps/web/app/pages/actor/[id].vue` `tabOf`) — use `inventory` (Carried) and `inventory.<containerId>`.
- Collapse state persists per device via localStorage key `fc:collapse:<actorId>:<sectionId>`; default expanded. Carried is never collapsible.
- Wallet: `CurrencyWallet` renders on the Inventory tab only; Resources keeps rest/death-saves/trackers; `tabEmpty` must stay correct for both tabs.
- Gateway/adapter: strict TypeScript, ESM `.js` import suffixes, no @types/node (gateway hand-maintains `node-shims.d.ts`). `parseActionIntent`'s switch is exhaustive with no default — adding the SDK kind forces the gateway case at compile time.
- Test commands: `pnpm --filter @companion/adapter-dnd5e test`, `pnpm --filter @companion/gateway test` (+ `typecheck` in both), `pnpm --filter @companion/web typecheck`. Full suite before each commit's final step: currently 273 + 110 + 3 green.
- Commit after every task; end commit messages with the Claude Code trailer:

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

### Task 1: The `move` action verb, end to end (no UI)

**Files:**
- Modify: `packages/adapter-sdk/src/index.ts` (SheetActionKind ~L177, ActionIntent ~L222)
- Modify: `packages/adapter-dnd5e/src/index.ts` (buildActions ~L1486, buildAction switch ~L1663)
- Modify: `apps/gateway/src/app.ts` (`parseActionIntent` ~L193)
- Modify: `apps/gateway/test/fakes.ts` (fixedActions + fakeAdapter.buildAction)
- Test: `packages/adapter-dnd5e/test/actions.test.ts`, `apps/gateway/test/app.test.ts`

**Interfaces:**
- Consumes: existing `RelayAction` variant `{ endpoint: 'update-item'; itemId: string; data: … }` (adapter-sdk ~L237) — already executed by the gateway via `relay.updateEntity` (app.ts ~L802), so no gateway execution change.
- Produces (Task 4 relies on these):
  - SDK: `SheetActionKind` gains `'move'`; `ActionIntent` gains `{ kind: 'move'; actionId: string; containerId: string | null }`.
  - Adapter: every physical item gets an ActionDescriptor `{ id: 'item.<id>.move', label: <name>, kind: 'move' }`; `buildAction` maps a valid move to `{ endpoint: 'update-item', itemId, data: { 'system.container': containerId ?? '' } }`.
  - Gateway: `POST /api/actors/:id/actions` accepts `{ kind: 'move', actionId, containerId: string | null }`, 422 on malformed `containerId`.

- [ ] **Step 1: SDK types**

In `packages/adapter-sdk/src/index.ts`, add `'move'` to `SheetActionKind` (after `'attune'`):

```ts
  | 'attune'
  | 'move'
```

and a variant to `ActionIntent` (after the attune line):

```ts
  | { kind: 'move'; actionId: string; containerId: string | null }
```

- [ ] **Step 2: Write the failing adapter tests**

Append to `packages/adapter-dnd5e/test/actions.test.ts` (reuse the file's existing `build` helper and `martialCaptured` import; add `structuredClone` patching where noted). Real ids from `martial-captured.json`: Backpack `wYUZWMKa6FntpIvv`, Pouch `T8BW5LfQIDdur78q`, Rations `ulOW5qzq7q2edJTP` (its captured `system.container` is a dangling compendium id):

```ts
describe('move', () => {
  const withRealContainment = () => {
    const actor = structuredClone(martialCaptured);
    const items = actor.items as Array<{ _id: string; system: Record<string, unknown> }>;
    // Repair the captured dangling refs into a real containment chain:
    // Rations -> Backpack, Pouch -> Backpack (nested container).
    items.find((i) => i._id === 'ulOW5qzq7q2edJTP')!.system.container = 'wYUZWMKa6FntpIvv';
    items.find((i) => i._id === 'T8BW5LfQIDdur78q')!.system.container = 'wYUZWMKa6FntpIvv';
    return actor;
  };

  it('every physical item gets a move descriptor', () => {
    const ids = dnd5eAdapter.actions!(martialCaptured).filter((a) => a.kind === 'move').map((a) => a.id);
    expect(ids).toContain('item.ulOW5qzq7q2edJTP.move'); // consumable
    expect(ids).toContain('item.wYUZWMKa6FntpIvv.move'); // container itself
    expect(ids).not.toContain('item.PHmMOFdCcVieUYak.move'); // a spell/feat id must not (pick any non-physical id from the fixture)
  });

  it('move into a container writes system.container', () => {
    expect(
      build(withRealContainment(), {
        kind: 'move',
        actionId: 'item.ulOW5qzq7q2edJTP.move',
        containerId: 'wYUZWMKa6FntpIvv',
      }),
    ).toEqual({
      endpoint: 'update-item',
      itemId: 'ulOW5qzq7q2edJTP',
      data: { 'system.container': 'wYUZWMKa6FntpIvv' },
    });
  });

  it('move to carried clears the ref with an empty string', () => {
    expect(
      build(withRealContainment(), { kind: 'move', actionId: 'item.ulOW5qzq7q2edJTP.move', containerId: null }),
    ).toEqual({ endpoint: 'update-item', itemId: 'ulOW5qzq7q2edJTP', data: { 'system.container': '' } });
  });

  it('rejects a non-container target', () => {
    expect(() =>
      build(withRealContainment(), {
        kind: 'move',
        actionId: 'item.wYUZWMKa6FntpIvv.move',
        containerId: 'ulOW5qzq7q2edJTP', // Rations: physical but not a container
      }),
    ).toThrow(IntentError);
  });

  it('rejects an unknown target id', () => {
    expect(() =>
      build(withRealContainment(), { kind: 'move', actionId: 'item.ulOW5qzq7q2edJTP.move', containerId: 'nope' }),
    ).toThrow(IntentError);
  });

  it('rejects moving an item into itself', () => {
    expect(() =>
      build(withRealContainment(), {
        kind: 'move',
        actionId: 'item.wYUZWMKa6FntpIvv.move',
        containerId: 'wYUZWMKa6FntpIvv',
      }),
    ).toThrow(IntentError);
  });

  it('rejects moving a container into its own contents (cycle)', () => {
    // Pouch sits inside Backpack; Backpack -> Pouch would be a cycle.
    expect(() =>
      build(withRealContainment(), {
        kind: 'move',
        actionId: 'item.wYUZWMKa6FntpIvv.move',
        containerId: 'T8BW5LfQIDdur78q',
      }),
    ).toThrow(IntentError);
  });
});
```

Adjust the non-physical id in the first test to a real spell/feat `_id` from the fixture (grep `"type": "spell"` in `martial-captured.json`). Import `IntentError` from `@companion/adapter-sdk` if the file doesn't already.

- [ ] **Step 3: Run adapter tests — expect FAIL** (`move` kind unknown / no descriptors)

Run: `pnpm --filter @companion/adapter-dnd5e test -- test/actions.test.ts`

- [ ] **Step 4: Implement in adapter-dnd5e**

In `buildActions` (next to the equip/attune pushes ~L1486, inside the physical-item branch):

```ts
if (PHYSICAL_ITEM_TYPES.has(item.type)) {
  out.push({ id: `item.${item._id}.move`, label: item.name, kind: 'move' });
}
```

(Place it so it runs for every physical item — mirror however the equip/attune pushes are gated in that loop.)

In `buildAction`'s switch (next to `case 'prepare'`):

```ts
case 'move': {
  if (intent.containerId !== null && (typeof intent.containerId !== 'string' || intent.containerId === '')) {
    throw new IntentError('move requires a container id or null', 'INVALID');
  }
  const itemId = intent.actionId.slice('item.'.length, -'.move'.length);
  if (intent.containerId !== null) {
    const items = new Map((actor.items ?? []).map((i) => [i._id, i]));
    const target = items.get(intent.containerId);
    if (!target || target.type !== 'container') {
      throw new IntentError('move target must be a container on this sheet', 'INVALID');
    }
    if (intent.containerId === itemId) {
      throw new IntentError('an item cannot contain itself', 'INVALID');
    }
    // No cycles: walk the target's containment chain upward; hitting the
    // moved item means the target lives (transitively) inside it.
    let cursor: string | undefined = intent.containerId;
    const hops = new Set<string>();
    while (cursor !== undefined && !hops.has(cursor)) {
      hops.add(cursor);
      const parent = strAt(items.get(cursor)?.system, 'container');
      if (parent === itemId) {
        throw new IntentError('cannot move a container into its own contents', 'INVALID');
      }
      cursor = parent !== undefined && parent !== '' && items.has(parent) ? parent : undefined;
    }
  }
  return {
    endpoint: 'update-item',
    itemId,
    data: { 'system.container': intent.containerId ?? '' },
  };
}
```

- [ ] **Step 5: Gateway `parseActionIntent` case** (the SDK change makes the exhaustive switch a compile error until this lands)

In `apps/gateway/src/app.ts`, add before the `rest` group:

```ts
    case 'move':
      if (body.containerId !== null && (typeof body.containerId !== 'string' || body.containerId === '')) {
        return null;
      }
      return { kind, actionId, containerId: body.containerId as string | null };
```

- [ ] **Step 6: Gateway route test**

In `apps/gateway/test/fakes.ts`, add to `fixedActions` (~L315):

```ts
{ id: 'item.i1.move', label: 'Arrows', kind: 'move' },
```

and to `fakeAdapter.buildAction`'s handling a move branch mirroring its equip branch:

```ts
if (intent.kind === 'move') {
  return {
    endpoint: 'update-item',
    itemId: intent.actionId.slice('item.'.length, -'.move'.length),
    data: { 'system.container': intent.containerId ?? '' },
  };
}
```

Append to the actions describe in `apps/gateway/test/app.test.ts` (mirror the equip test idiom; `relay.updates` records `updateEntity` calls):

```ts
it('move -> update-item writing system.container, result null', async () => {
  const { app, relay } = setup();
  const res = await post(app, 'a1', { kind: 'move', actionId: 'item.i1.move', containerId: 'c9' });
  expect(res.statusCode).toBe(200);
  expect(relay.updates).toEqual([{ uuid: 'Actor.a1.Item.i1', data: { 'system.container': 'c9' } }]);
  expect((res.json() as { result: unknown }).result).toBeNull();
});

it('move to carried sends an empty string; malformed containerId is 422', async () => {
  const { app, relay } = setup();
  const ok = await post(app, 'a1', { kind: 'move', actionId: 'item.i1.move', containerId: null });
  expect(ok.statusCode).toBe(200);
  expect(relay.updates).toEqual([{ uuid: 'Actor.a1.Item.i1', data: { 'system.container': '' } }]);
  for (const bad of [{}, { containerId: '' }, { containerId: 7 }]) {
    const res = await post(app, 'a1', { kind: 'move', actionId: 'item.i1.move', ...bad });
    expect(res.statusCode, JSON.stringify(bad)).toBe(422);
  }
});
```

(Use the file's existing `setup`/`post` helpers; adjust names if they differ.)

- [ ] **Step 7: Run both suites + typechecks — expect PASS**

Run: `pnpm --filter @companion/adapter-dnd5e test && pnpm --filter @companion/gateway test && pnpm --filter @companion/adapter-dnd5e typecheck && pnpm --filter @companion/gateway typecheck` (skip a typecheck script that doesn't exist; adapter-sdk builds via the dependents).

- [ ] **Step 8: Commit**

```bash
git add packages/adapter-sdk/src/index.ts packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/actions.test.ts apps/gateway/src/app.ts apps/gateway/test/fakes.ts apps/gateway/test/app.test.ts
git commit -m "feat: move action — push items between carried and containers"
```

---

### Task 2: Location-first sections in the adapter

**Files:**
- Modify: `packages/adapter-sdk/src/index.ts` (SheetSection list variant ~L143)
- Modify: `packages/adapter-dnd5e/src/index.ts` (section assembly ~L1770–1808)
- Test: `packages/adapter-dnd5e/test/adapter.test.ts`

**Interfaces:**
- Consumes: `inventoryListItem(item, resourceIds, physicalIds)` (unchanged).
- Produces (Tasks 3–4 rely on these):
  - SDK list sections gain `header?: ListItem` — `{ kind: 'list'; id: string; label: string; items: ListItem[]; header?: ListItem }`.
  - Adapter emits, in place of the single `inventory` section: `{ id: 'inventory', label: 'Carried', items: <loose items> }` followed by one `{ id: 'inventory.<cid>', label: <container name>, header: <container's ListItem>, items: <direct contents> }` per container in sheet order. Container sections' labels carry no weight — the weight total goes into `header.sub`'s existing weight slot semantics via a `Σ <n> <unit>` part appended to the header item's sub.

- [ ] **Step 1: SDK type**

```ts
  | { kind: 'list'; id: string; label: string; items: ListItem[]; header?: ListItem }
```

(replacing the current list variant — `header` is the container's own tappable ListItem.)

- [ ] **Step 2: Write the failing adapter tests**

Append to `packages/adapter-dnd5e/test/adapter.test.ts` (same `withRealContainment` clone-and-repair helper as Task 1 — extract it to a shared local helper in each file, do NOT import across test files; ids: Backpack `wYUZWMKa6FntpIvv`, Pouch `T8BW5LfQIDdur78q`, Quiver `B2OSARI9hcSzaai9`, Rations `ulOW5qzq7q2edJTP`):

```ts
describe('inventory location sections', () => {
  const inventorySections = (actor: FoundryActorDoc) =>
    dnd5eAdapter.toViewModel(actor).sections.filter(
      (s): s is Extract<SheetSection, { kind: 'list' }> => s.kind === 'list' && /^inventory/.test(s.id),
    );

  it('emits Carried first, then one section per container in sheet order', () => {
    const secs = inventorySections(withRealContainment());
    expect(secs[0]).toMatchObject({ id: 'inventory', label: 'Carried' });
    const containerSecs = secs.slice(1);
    expect(containerSecs.map((s) => s.id)).toEqual(
      expect.arrayContaining(['inventory.wYUZWMKa6FntpIvv', 'inventory.T8BW5LfQIDdur78q', 'inventory.B2OSARI9hcSzaai9']),
    );
    expect(containerSecs.every((s) => s.header !== undefined)).toBe(true);
  });

  it('direct contents land in their container section; containers are not Carried rows', () => {
    const secs = inventorySections(withRealContainment());
    const backpack = secs.find((s) => s.id === 'inventory.wYUZWMKa6FntpIvv')!;
    expect(backpack.items.map((i) => i.id)).toEqual(
      expect.arrayContaining(['ulOW5qzq7q2edJTP', 'T8BW5LfQIDdur78q']), // Rations + nested Pouch as a row
    );
    const carried = secs.find((s) => s.id === 'inventory')!;
    expect(carried.items.map((i) => i.id)).not.toContain('wYUZWMKa6FntpIvv');
    expect(carried.items.map((i) => i.id)).not.toContain('ulOW5qzq7q2edJTP');
  });

  it('a nested container still gets its own top-level section', () => {
    const secs = inventorySections(withRealContainment());
    expect(secs.some((s) => s.id === 'inventory.T8BW5LfQIDdur78q')).toBe(true);
  });

  it('dangling refs count as Carried (captured fixture, unrepaired)', () => {
    const secs = inventorySections(martialCaptured);
    const carried = secs.find((s) => s.id === 'inventory')!;
    expect(carried.items.map((i) => i.id)).toContain('ulOW5qzq7q2edJTP'); // its captured ref dangles
  });

  it('an empty container renders as a section with zero items', () => {
    const secs = inventorySections(withRealContainment());
    const quiver = secs.find((s) => s.id === 'inventory.B2OSARI9hcSzaai9')!;
    expect(quiver.items).toEqual([]);
  });

  it("the header's sub carries the contents weight total", () => {
    const actor = withRealContainment();
    // give Rations a known weight for a deterministic sum
    const rations = (actor.items as Array<{ _id: string; system: Record<string, unknown> }>).find(
      (i) => i._id === 'ulOW5qzq7q2edJTP',
    )!;
    rations.system.quantity = 2;
    rations.system.weight = { value: 1, units: 'lb' };
    const backpack = inventorySections(actor).find((s) => s.id === 'inventory.wYUZWMKa6FntpIvv')!;
    expect(backpack.header!.sub).toMatch(/Σ [\d.]+ lb/);
  });
});
```

(Adjust the exact expected item lists after inspecting what other captured items resolve to each container — the assertions above pin only the repaired ids. Import `SheetSection` type if needed.)

- [ ] **Step 3: Run — expect FAIL** (single flat section today)

Run: `pnpm --filter @companion/adapter-dnd5e test -- test/adapter.test.ts`

- [ ] **Step 4: Implement the assembly**

Replace the inventory-collection block (~L1770–1808). Keep `featureListItem`/`spellListItem` handling untouched; only the physical-item path changes:

```ts
const physicalItems = (actor.items ?? []).filter((i) => PHYSICAL_ITEM_TYPES.has(i.type));
const physicalIds = new Set(physicalItems.map((i) => i._id));

/** Resolved location: a container id on this sheet, else undefined (Carried). */
const locationOf = (item: FoundryItemDoc): string | undefined => {
  const c = strAt(item.system, 'container');
  return c !== undefined && c !== '' && c !== item._id && physicalIds.has(c) ? c : undefined;
};

const carried: ListItem[] = [];
const byContainer = new Map<string, ListItem[]>();
for (const item of physicalItems) {
  const loc = locationOf(item);
  const row = inventoryListItem(item, resourceIds, physicalIds);
  if (loc !== undefined) {
    const list = byContainer.get(loc);
    if (list) list.push(row);
    else byContainer.set(loc, [row]);
  } else if (item.type !== 'container') {
    carried.push(row); // containers render as sections, not Carried rows
  }
}

sections.push({ kind: 'list', id: 'inventory', label: 'Carried', items: carried });
for (const item of physicalItems) {
  if (item.type !== 'container') continue;
  const contents = byContainer.get(item._id) ?? [];
  const header = inventoryListItem(item, resourceIds, physicalIds);
  // Presentation-only contents weight (direct contents; same parsing as rows).
  let total = 0;
  let unit = 'lb';
  for (const child of physicalItems) {
    if (locationOf(child) !== item._id) continue;
    const w = numAt(child.system, 'weight.value');
    if (w === undefined || w <= 0) continue;
    total += w * (numAt(child.system, 'quantity') ?? 1);
    unit = strAt(child.system, 'weight.units') || unit;
  }
  if (total > 0) header.sub = `${header.sub} · Σ ${Number(total.toFixed(2))} ${unit}`;
  sections.push({ kind: 'list', id: `inventory.${item._id}`, label: item.name, header, items: contents });
}
```

(Delete the old `inventory.push(...)` accumulation and single `sections.push({... id: 'inventory' ...})` — feats/spells loops keep their current form; the `gearstats` push stays.)

- [ ] **Step 5: Run adapter suite + typecheck — fix any existing tests that asserted the old single-section shape** (there will be some: they now find `label: 'Carried'` and per-container sections; update those assertions to the new shape — that is the intended behavior change, not a regression).

- [ ] **Step 6: Full suite** (`pnpm -r test`) — gateway/web consume sections opaquely; expect green.

- [ ] **Step 7: Commit**

```bash
git add packages/adapter-sdk/src/index.ts packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/adapter.test.ts
git commit -m "feat(adapter): location-first inventory sections — Carried + one section per container"
```

---

### Task 3: Web — container sections (header row, collapse persistence, empty hint)

**Files:**
- Modify: `apps/web/app/components/SectionList.vue`
- Modify: `apps/web/app/pages/actor/[id].vue` (SectionList call site ~L105–116)

**Interfaces:**
- Consumes: list sections with optional `header?: ListItem` (Task 2).
- Produces: `SectionList` new optional props `collapsible?: boolean` and `storageKey?: string`; the section title area renders `section.header` when present (name tap emits `detail(header)`, sub shown, chevron collapses the whole section, state persisted under `storageKey`); empty sections show a hint row. Actor page passes `:collapsible="section.kind === 'list' && !!section.header"` and `:storage-key="`fc:collapse:${actorId}:${section.id}`"`.

- [ ] **Step 1: SectionList changes**

Props: add

```ts
collapsible?: boolean
storageKey?: string
```

State (near `collapsedIds`):

```ts
/** Whole-section collapse (container sections), persisted per device. */
const sectionCollapsed = ref(false)

onMounted(() => {
  if (!props.storageKey) return
  try {
    sectionCollapsed.value = localStorage.getItem(props.storageKey) === '1'
  } catch {
    /* private mode — default expanded */
  }
})

function toggleSection(): void {
  sectionCollapsed.value = !sectionCollapsed.value
  if (!props.storageKey) return
  try {
    localStorage.setItem(props.storageKey, sectionCollapsed.value ? '1' : '0')
  } catch {
    /* noop */
  }
}
```

Template — replace the bare `<h2 class="section-title">{{ section.label }}</h2>` with:

```html
<h2 v-if="!section.header" class="section-title">{{ section.label }}</h2>
<div v-else class="section-head">
  <button
    v-if="collapsible"
    class="chev"
    type="button"
    :class="{ open: !sectionCollapsed }"
    :aria-expanded="!sectionCollapsed"
    :aria-label="`Toggle contents of ${section.header.label}`"
    @click="toggleSection"
  >
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
  </button>
  <button class="head-name" type="button" @click="emit('detail', section.header)">
    <span class="section-title">{{ section.header.label }}</span>
    <span v-if="section.header.sub" class="row-sub">{{ section.header.sub }}</span>
  </button>
</div>
<div v-show="!sectionCollapsed" class="list card">
  …existing rows v-for…
  <p v-if="rows.length === 0" class="empty-hint">Empty</p>
</div>
```

Reuse the existing `.chev` styles (same class as the row chevron; check its existing CSS and adapt the selector if it was scoped to rows). Add scoped styles:

```css
.section-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.head-name {
  display: flex;
  align-items: baseline;
  gap: 8px;
  text-align: left;
  padding: 0;
  background: none;
  border: 0;
  color: inherit;
}

.empty-hint {
  color: var(--text-dim);
  font-size: 0.85rem;
  padding: 12px 14px;
  font-style: italic;
}
```

Note: the wrapping `<div class="list card">` already exists — the change is adding `v-show="!sectionCollapsed"` and the empty hint inside it. The `detail` emit already exists (`(e: 'detail', item: ListItem)`), so header taps flow through the actor page's existing `onDetail`.

- [ ] **Step 2: Actor page call site**

On the `<SectionList>` element (~L105) add:

```html
  :collapsible="section.kind === 'list' && !!section.header"
  :storage-key="section.kind === 'list' && section.header ? `fc:collapse:${actorId}:${section.id}` : undefined"
```

(`actorId` is the existing computed in that file.)

- [ ] **Step 3: Typecheck + visual smoke**

Run: `pnpm --filter @companion/web typecheck` → 0 errors. With the dev stack up, load an actor's GEAR tab (`http://localhost:3001/actor/<id>`): sections render (Carried + containers; the live world's refs may be dangling like the fixtures — if no container section appears, move an item into a container in Foundry first or proceed and rely on Task 5's live pass).

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/components/SectionList.vue "apps/web/app/pages/actor/[id].vue"
git commit -m "feat(web): container sections — tappable header, persisted collapse, empty hint"
```

---

### Task 4: Web — "Move to…" in the detail dialog + wallet relocation

**Files:**
- Modify: `apps/web/app/components/DetailDialog.vue`
- Modify: `apps/web/app/pages/actor/[id].vue` (detailFor ~L281, onDetail ~L675, DetailDialog wiring ~L161, wallet block ~L119, tabEmpty ~L412)

**Interfaces:**
- Consumes: `move` intent (Task 1): POST body `{ kind: 'move', actionId: 'item.<id>.move', containerId: string | null }` → response `{ result: null, sheet }`; container sections (Task 2) as the source of location options.
- Produces: DetailDialog optional props `locations?: Array<{ id: string | null; label: string; current: boolean }>`, `moveBusy?: boolean` and emit `(e: 'move', id: string | null)`.

- [ ] **Step 1: DetailDialog additions**

Props/emits:

```ts
locations?: Array<{ id: string | null; label: string; current: boolean }>
moveBusy?: boolean
// emits: (e: 'move', id: string | null)
```

Template, between the body and the danger button:

```html
<div v-if="locations && locations.length" class="move-block">
  <p class="move-title">Move to…</p>
  <button
    v-for="loc in locations"
    :key="loc.id ?? 'carried'"
    class="move-btn"
    type="button"
    :disabled="loc.current || moveBusy"
    :class="{ current: loc.current, pending: moveBusy }"
    @click="emit('move', loc.id)"
  >
    {{ loc.label }}<span v-if="loc.current" class="current-tag"> · here</span>
  </button>
</div>
```

Scoped styles (match the dialog's existing tone):

```css
.move-block {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.move-title {
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--ink-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.move-btn {
  min-height: 42px;
  border-radius: 12px;
  border: 1px solid var(--line);
  color: var(--ink);
  font-size: 0.85rem;
  text-align: left;
  padding: 0 14px;
}

.move-btn.current {
  opacity: 0.55;
}

.move-btn.pending {
  opacity: 0.55;
}
```

- [ ] **Step 2: Actor page wiring**

Extend `detailFor`'s type with move data:

```ts
const detailFor = ref<{
  title: string
  detail: string
  itemId?: string
  removable?: string
  moveActionId?: string
  currentContainerId?: string | null
} | null>(null)
```

Location options from the sheet's container sections (place near other computeds):

```ts
/** Container sections double as the move-target list. */
const containerOptions = computed(() =>
  (sheet.value?.sections ?? [])
    .filter((s): s is Extract<SheetSection, { kind: 'list' }> => s.kind === 'list' && s.header !== undefined)
    .map((s) => ({ id: s.id.slice('inventory.'.length), label: s.label })),
)

const detailLocations = computed(() => {
  const d = detailFor.value
  if (!d?.moveActionId || offline.value) return undefined
  const current = d.currentContainerId ?? null
  return [
    { id: null as string | null, label: 'Carried', current: current === null },
    ...containerOptions.value
      .filter((c) => c.id !== d.itemId) // an item can't move into itself
      .map((c) => ({ id: c.id as string | null, label: c.label, current: current === c.id })),
  ]
})
```

In `onDetail(item)`, capture move data — the actions map tells us whether a move descriptor exists:

```ts
function onDetail(item: ListItem): void {
  const moveActionId = actionMap.value[`item.${item.id}.move`] ? `item.${item.id}.move` : undefined
  if (!item.detail && !(item.removable && !offline.value) && !moveActionId) return
  detailFor.value = {
    title: item.label,
    detail: item.detail ?? '',
    itemId: item.id,
    ...(item.removable ? { removable: item.removable } : {}),
    ...(moveActionId ? { moveActionId, currentContainerId: item.containerId ?? null } : {}),
  }
}
```

Move handler (mirror `onRemove`'s direct-api idiom, with a success toast naming the destination):

```ts
const moveBusy = ref(false)

async function onMove(targetId: string | null): Promise<void> {
  const d = detailFor.value
  if (!d?.moveActionId || moveBusy.value || offline.value) return
  const destination = targetId === null ? 'Carried' : containerOptions.value.find((c) => c.id === targetId)?.label ?? 'container'
  moveBusy.value = true
  try {
    const res = await api<ActionResponse>(`/api/actors/${actorId.value}/actions`, {
      method: 'POST',
      body: { kind: 'move', actionId: d.moveActionId, containerId: targetId },
    })
    applySheet(res.sheet)
    detailFor.value = null
    toast.show(`${d.title} → ${destination}`)
  } catch {
    toast.show('Couldn’t move that.')
  } finally {
    moveBusy.value = false
  }
}
```

DetailDialog wiring gains:

```html
  :locations="detailLocations"
  :move-busy="moveBusy"
  @move="onMove"
```

- [ ] **Step 3: Wallet relocation**

Move the `<CurrencyWallet>` block (~L119) so it renders under the inventory tab, after the sections loop:

```html
<CurrencyWallet
  v-if="activeTab === 'inventory' && walletResources.length"
  :resources="walletResources"
  :busy="busy"
  :readonly="offline"
  @step="stepResource"
/>
```

Update `tabEmpty` (~L412): the resources clause drops `walletResources`, inventory gains it:

```ts
const tabEmpty = computed(() => {
  if (activeTab.value === 'actions') return false
  if (renderableSections.value.length > 0) return false
  if (activeTab.value === 'resources' && (hasRest.value || dying.value)) return false
  if (activeTab.value === 'inventory' && walletResources.value.length > 0) return false
  return true
})
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @companion/web typecheck` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/DetailDialog.vue "apps/web/app/pages/actor/[id].vue"
git commit -m "feat(web): Move to… in item detail + wallet relocates to Inventory"
```

---

### Task 5: Live verification + docs touch

**Files:**
- Modify: `docs/API.md` (actions documentation: add the `move` kind + body shape)
- The live checklist runs against the dev stack from this checkout.

- [ ] **Step 1: API.md** — in the actions-endpoint documentation, add the `move` row/paragraph: body `{ kind: 'move', actionId: 'item.<id>.move', containerId: '<containerItemId>' | null }`; null = carried; 422 on non-container target or containment cycle; executes as a `system.container` item update (no roll, no chat card). Commit:

```bash
git add docs/API.md
git commit -m "docs: move action + location sections (M19)"
```

- [ ] **Step 2: Live checklist** (stack: Foundry+relay docker, gateway 8090, web dev server; the world's captured container refs may be dangling — first move writes will *create* real containment):

1. Open Randal's GEAR tab: Carried section renders; container sections (Backpack/Pouch/Quiver etc.) render with header name + chevron; empty ones say "Empty".
2. Tap a potion/rations row name → detail dialog shows "Move to…" with Carried marked "here" → pick Backpack → toast "Rations → Backpack", row now under the Backpack section; **verify in Foundry's sheet the item nests inside the Backpack**.
3. Move it back to Carried; verify Foundry cleared the containment.
4. Backpack's header sub shows a Σ weight total once it has contents.
5. Collapse the Backpack section, reload the page → still collapsed (localStorage); expand → persists expanded.
6. Move the Pouch into the Backpack (container into container); then open the Backpack's detail and confirm "Move to… Pouch" is offered but returns the 422 toast (cycle guard) — expect "Couldn't move that."
7. Wallet renders at the bottom of the GEAR tab and is gone from VITALS; a currency stepper write still works.
8. Offline (stop the gateway briefly): detail dialog hides the Move block; restore the gateway.

- [ ] **Step 3: Record results** in `.superpowers/sdd/progress.md` (new M19 section), then run `pnpm -r test` one final time.

---

## Self-Review (done at plan-writing time)

- **Spec coverage:** layout (Carried + per-container sections, sheet order, empty hint, collapse persisted per device, weight in header) → Tasks 2–3; modeling (base = container, no invented state) → inherent; moving (detail-dialog control, current marked/disabled, offline-hidden, toast) → Task 4; data flow (`move` kind → `update-item` → `updateEntity('system.container')`) → Task 1; guards (non-container 422, self/descendant cycle, carried=null→'') → Task 1; wallet relocation incl. `tabEmpty` → Task 4; error handling (sheet re-fetch via `applySheet(res.sheet)` on every mutation; dangling refs → Carried) → Tasks 1–2; testing section (sectioning, dangling, nested-both-places, weight totals, move guards, gateway move happy/carried/malformed, live checklist) → Tasks 1, 2, 5. Spec refinement, recorded: cycle/target validation lives in the adapter's `buildAction` (which the gateway runs against the freshly fetched actor and maps `IntentError` → 422) rather than in gateway route code — same guarantee, one layer lower, where the item data already is.
- **Placeholder scan:** clean — every code step carries code; the two "adjust after inspecting fixture" notes name exactly what to inspect.
- **Type consistency:** `containerId: string | null` used identically in SDK intent, gateway parse, fake adapter, and web POST body; section header field `header?: ListItem` consistent across SDK/adapter/web; `item.<id>.move` id format consistent between descriptors, `buildAction` slicing, and web's `actionMap` lookup.
