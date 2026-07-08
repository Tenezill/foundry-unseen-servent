# Inventory/Actions split + usable items — design

Date: 2026-07-08
Status: approved

## Problem

Inventory rows can show up to three controls at once (quantity stepper,
Attack, Equip), and consumables have no rules-driven way to be used: a player
"drinks" a healing potion by manually stepping quantity −1, bypassing dnd5e's
usage workflow entirely.

## Decision (user-approved)

**Inventory = manage, Actions = do.**

- Inventory rows keep the quantity/uses stepper and the Equip toggle on every
  physical item (including equipped ones) and lose all Attack/Use buttons.
- The Actions tab gains an **Items** group (next to Attacks / Spells /
  Features) listing every physical, non-weapon item whose Foundry data has
  usage rules (`system.activities` non-empty): potions, torches, rations,
  waterskins, horns, rope… If the GM gave it rules, the player can use it.
- Using an item goes through the relay's `use-item` endpoint — the same one
  weapon attacks already use. Foundry runs the real usage workflow: rolls,
  chat card, uses/quantity consumption, auto-destroy (`uses.autoDestroy`).

Verified against captured fixtures (dnd5e 5.3.3): consumables carry
`system.activities` with consumption targets; rations have
`autoDestroy: true`.

## Contract change (`adapter-sdk`)

`ActionDescriptor` gains one optional field:

```ts
/** UI grouping hint for actions sharing a kind, e.g. "items". */
group?: string;
```

Backward compatible; adapters that don't set it are unchanged. This follows
the existing principle: adapters control layout hints, not the PWA.

## dnd5e adapter

- New predicate `isUsableInventoryItem(item)`: `PHYSICAL_ITEM_TYPES` member,
  not a weapon, `system.activities` non-empty. Weapons keep their `attack`
  action.
- `buildActions` additionally emits
  `{ id: 'item.<id>.use', label: item.name, kind: 'use', group: 'items' }`.
  Actions are offered even at 0 uses/quantity — same philosophy as unprepared
  spells: Foundry owns the rules and refuses when empty.
- `buildAction` case `'use'` branches on the id prefix: `item.…` →
  `{ endpoint: 'use-item', itemId }`; `feature.…` → `use-feature` unchanged.
- `inventoryListItem` no longer sets `actionId` (inline Attack button gone).
  It keeps `resourceId`, tags, `equipActionId`, `detail`.

## PWA

- `SectionActions.vue`: fourth group def
  `{ id: 'items', label: 'Items', kind: 'use', group: 'items', verb: 'Use' }`
  with a flask icon. Group matching becomes kind **and** group: the Features
  group takes `use` actions without a group; Items takes `group === 'items'`.
- `SectionList.vue`: no change — without `actionId` no verb button renders.
- `pages/actor/[id].vue`: no change — it already forwards all
  attack/cast/use actions to the Actions tab.

## Gateway / other adapters

No changes. `use` intents are already allow-listed against adapter
descriptors; `group` is optional so the Mörk Borg adapter is untouched.

## Error handling

Unchanged paths: unknown ids throw `IntentError('UNKNOWN_RESOURCE')`;
Foundry-side refusals surface through the existing toast path.

## Testing

- Adapter: torch/rations (fixtures) produce `use` actions with
  `group: 'items'`; passive loot (Hammer, no activities) gets none;
  `item.<id>.use` maps to `use-item`; inventory ListItems carry no `actionId`;
  weapons still get `attack`.
- PWA: Items group renders; Features group does not swallow grouped actions.
