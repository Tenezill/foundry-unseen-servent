# Spellbook management — design

Date: 2026-07-08
Status: approved

## Problem

Players cannot manage their spellbook from the companion: no way to prepare/
unprepare spells, learn new ones (add to the spellbook), or forget them.

## Decisions (user-approved)

- **Prepare/unprepare**: pill toggle on spell rows (like Equip on inventory
  rows). Cantrips (level 0) and always-prepared spells (`prepared: 2`) show
  no toggle.
- **Learn**: open compendium search with an informative UI (name, level,
  school, source pack) — any spell can be learned; trust model matches the
  rest of the app (Foundry/GM owns the rules, the sheet informs).
- **Forget**: allowed, as a destructive button in the spell's detail dialog
  behind the existing ConfirmDialog — not on the row.
- Separate spec/milestone from the inventory/actions split.

## Relay groundwork (module 3.4.1 source-verified)

- `give` handler: accepts any item uuid resolvable by `fromUuid` — including
  compendium uuids — and copies `toObject()` onto the target actor. This is
  "learn spell" in one call.
- `search` handler: indexes compendia by default; supports filter strings
  like `documentType:Item,subType:spell`; results carry uuid/name/img/pack.
- `delete` handler: resolves any uuid via `fromUuid`, so
  `Actor.<id>.Item.<id>` deletes one embedded spell.
- **Trap**: the module's dedicated `prepare-spell` endpoint writes
  `system.preparation.prepared` — the pre-5.x data path, dead on dnd5e 5.3.3
  (which uses numeric `system.prepared`; see adapter comment). We bypass it
  and use the generic `PUT /update` on the item — the same plumbing as
  qty/uses updates.
- Exact HTTP route names for give/delete and player-key permission scopes are
  **live-verified as implementation step 1** (repo convention; record
  findings in docs).

## Contract changes (`adapter-sdk`)

1. New action kind `'prepare'`, mirroring `'equip'`:
   - `ActionDescriptor` gains `prepared?: boolean` (current state).
   - `ActionIntent` gains `{ kind: 'prepare'; actionId; prepared: boolean }`.
   - `RelayAction` gains a generic item-field write:
     `{ endpoint: 'update-item'; itemId: string; data: Record<string, number | string | boolean> }`
     which the gateway executes via the existing entity-update path.
2. `ListItem.equipActionId` renamed to `toggleActionId` — it now carries an
   equip **or** prepare action; the PWA picks the pill label from the
   action's kind.
3. New optional adapter capability:

```ts
spellbook?: {
  /** relay /search filter for learnable entries. */
  searchFilter: string;
  /** fetched compendium doc is a learnable spell. */
  canLearn(doc: Record<string, unknown>): boolean;
  /** embedded item may be deleted via the spellbook API. */
  canForget(item: FoundryItemDoc): boolean;
  /** preview for the confirm sheet: label, "3rd level · Evocation", detail HTML. */
  describe(doc: Record<string, unknown>): ListItem;
}
```

## foundry-client

Two new methods, live-verified before use:

- `giveItem(toUuid, itemUuid)` → `POST /give`
- `deleteEntity(uuid)` → `DELETE /delete`

## Gateway

Three new endpoints (ownership-checked like all writes; 404 when the actor's
adapter has no `spellbook`):

- `GET /api/actors/:id/spellbook/search?q=` → relay `/search` with the
  adapter's `searchFilter`; returns `{ results: [{uuid, name, img, pack}] }`.
- `GET /api/actors/:id/spellbook/preview?uuid=` → relay `/get` →
  `describe()`; one fetch for the tapped spell only, not per search result.
- `POST /api/actors/:id/spellbook/learn { uuid }` → `/get` + `canLearn`
  validation → `giveItem`; 422 on a non-spell uuid.
- `DELETE /api/actors/:id/spells/:itemId` → item must exist on the actor and
  pass `canForget` → `deleteEntity('Actor.<id>.Item.<itemId>')`.

Prepare toggles ride the existing action pipeline (no new endpoint):
adapter maps them to `update-item`, gateway maps `update-item` to
`updateEntity('Actor.<actorId>.Item.<itemId>', data)`.

## dnd5e adapter

- `spellListItem` sets `toggleActionId: 'spell.<id>.prepare'` for leveled,
  not-always-prepared spells.
- `buildActions` emits the matching descriptors with `prepared` state.
- `buildAction` maps prepare intents to
  `{ endpoint: 'update-item', itemId, data: { 'system.prepared': 1 | 0 } }`.
- `spellbook`: `searchFilter: 'documentType:Item,subType:spell'`;
  `canLearn`: `doc.type === 'spell'`; `canForget`: `item.type === 'spell'`;
  `describe`: spell-row mapping (level ordinal, school label, sanitizable
  description HTML).

## PWA

- Spell rows: Prepare/Prepared pill via `toggleActionId` (SectionList renders
  the pill label by action kind: Equip/Equipped vs Prepare/Prepared).
- Spells section header: "Learn spell" button → new search sheet component:
  debounced query → result rows (name/img/pack) → tap opens preview (level,
  school, sanitized description, plus an "already known" hint when a
  same-named spell is on the sheet) → Learn → toast + sheet refresh.
- Spell detail dialog: destructive "Forget spell" behind ConfirmDialog.

## Mörk Borg adapter

Untouched — every addition is optional.

## Testing

- Adapter: prepare descriptors exist for leveled spells, absent for cantrips
  and `prepared: 2`; prepare intent maps to `update-item` with
  `system.prepared`; spellbook predicates accept spells / reject non-spells.
- Gateway (fakes): search/preview/learn/forget happy paths; `canLearn`
  rejects a non-spell uuid (422); forget rejects a non-spell item and items
  not on the actor; unknown-actor and readonly cases as per existing write
  routes; adapter without `spellbook` → 404.
- One live round-trip (give + delete + prepared toggle) recorded in docs.
