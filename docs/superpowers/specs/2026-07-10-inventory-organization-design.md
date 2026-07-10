# Inventory organization — design

**Date:** 2026-07-10
**Status:** approved (brainstorm with user, incl. layout mockup choice)
**Milestone:** M19 (working name: "inventory organization")

## Problem

The Inventory tab is one flat list. Items sitting inside a container do nest
under it (M12 display plumbing reads `system.container`), but there is no way
to *move* an item into or out of a container from the PWA, no location-level
structure ("what am I carrying vs. what is at camp"), and the currency wallet
lives on the Resources tab even though it is inventory, not vitality.

## Goal (user's D&D Beyond mental model)

- The tab answers "where is my stuff": loose carried items first, then one
  group per container (backpack, base chest, …).
- Items can be pushed into and pulled out of containers from the phone.
- The wallet renders on the Inventory tab; Resources keeps only vitality
  (rest, death saves, trackers).

## Modeling decision: "at my base" is just a container

No invented "stored" state. A base is a container item on the actor's sheet
in Foundry (chest, strongbox). The PWA treats every container identically; a
GM who wants base storage to not count against carry weight gives that
container dnd5e's weightless-contents property. Zero sync surface, fully
native.

## Non-goals (v1)

- Creating/deleting containers from the PWA (add a chest via the existing
  library search, or in Foundry).
- Encumbrance bar / carry-weight warnings.
- Transfers between actors (`give`) — separate feature.
- Custom manual item ordering or user-defined groups; grouping is by
  location only (user chose location-first over type sections).

## Layout (per the chosen mockup)

The Inventory tab renders, in order:

1. **Carried** — every physical item whose `system.container` is unset or
   unresolvable on this sheet. Rows keep today's full behavior: equip and
   attune pills, quantity stepper, tap-name-for-detail, weight in the sub
   line.
2. **One section per container**, in sheet order — header shows the
   container's name and the total weight of its contents (presentation-only,
   same weight parsing as rows). Sections are collapsible; collapse state
   persists per device (localStorage keyed by actor + container id).
   Default: expanded. Empty containers render with an "empty" hint row.
   The container itself remains tappable (detail dialog: description,
   move, remove).
3. **Wallet** — the existing `CurrencyWallet`, moved from the Resources tab,
   behavior unchanged.

Nested containers (pouch in backpack): every container gets its own
top-level section regardless of nesting depth; the nested container
additionally appears as a row inside its parent's section so it can be
moved like any other item. No recursive section nesting on the phone.

### Adapter shape

The single `inventory` list section becomes one list section per location:
`inventory.carried` plus `inventory.<containerId>` per container, emitted by
`adapter-dnd5e`. The web tab mapping keys on the `inventory.` prefix (today
it matches the single id). `containerId` stays on items only as the
move-target/parent-row relationship; the web no longer needs its nesting
renderer for inventory (it remains for any other list that uses it).

## Moving items

### UI

The item detail dialog gains a **"Move to…"** control listing the possible
locations: *Carried* plus every container on the sheet, current location
marked and disabled. Picking a location performs the move, closes the
dialog, and toasts ("Rations → Backpack"). Disabled offline. Containers'
own dialogs get the same control (a backpack can be moved into the base
chest).

### Data flow

New action kind `move` in the existing actions vocabulary:

- Adapter: every physical item gets `moveActionId: item.<id>.move`; the
  action descriptor carries the current `containerId` (or none).
- Web → gateway: `POST /api/actors/:id/actions` body
  `{ kind: 'move', actionId, containerId: string | null }` (null = carried).
- Gateway: validates the target is a container-type item on the same actor
  (re-reads the sheet), then relay `updateEntity(item, { 'system.container':
  containerId ?? '' })` — the generic `update` action, no dnd5e-specific
  endpoint needed. Returns the refreshed sheet like other mutations.

### Guards

- Target must be a `container`-type item on the same actor → 422 otherwise.
- No cycles: an item cannot move into itself, and a container cannot move
  into its own (transitive) contents → 422. Cycle check runs in the gateway
  against the fetched sheet.
- Moving a non-empty container moves its contents with it (native dnd5e
  behavior — contents reference the container, nothing to rewrite).

## Wallet relocation

Web-only: the Resources tab stops rendering `CurrencyWallet`; the Inventory
tab renders it after the container sections. The `walletResources` plumbing
and currency write paths are untouched. Resources' empty-state logic is
adjusted accordingly (it currently counts wallet presence).

## Error handling

- Move failures (relay error, validation) → existing toast + error-code
  conventions; sheet state re-fetched so the UI never shows a phantom move.
- Unresolvable `system.container` refs (dangling id) → item counts as
  Carried (today's behavior for dangling refs, kept).

## Testing

- **Adapter fixture tests:** sectioning (carried + per-container, sheet
  order, empty container), dangling-ref → carried, nested container appears
  both as section and as parent-row, weight totals, `moveActionId` presence.
  Fixtures gain a container with contents if the captured ones lack one.
- **Gateway tests:** move happy path (relay update called with the right
  path/value), carried (null) move, non-container target 422, cycle 422,
  unknown item 404.
- **Web live-verify checklist:** push a potion into the backpack from the
  phone and watch it nest in Foundry's sheet; move it back; collapse the
  base chest and reload (state persists); wallet renders on Inventory and
  is gone from Resources; currency stepper still writes.
