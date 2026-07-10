# Actions-tab info disclosure — design

Date: 2026-07-10
Status: approved

## Problem

The Actions tab is where a player decides whether to use something
mid-combat, but its rows show only a name and an action button — there is
no way to read what a spell, item, feature, or weapon actually does without
switching to the Gear/Features/Spells tabs. This was the third part of the
original M15-era feature request ("get the info text of items via an arrow
down or small (i) icon"), explicitly deferred out of both the M15 and M16
specs as its own follow-up.

## Decision summary

- Trigger: **tap the row's name** (chosen over a dedicated ⓘ icon) — same
  convention as the "Details for X" name-buttons the Gear/Features/Spells
  tabs already use, bigger touch target, no new visual element.
- Scope: **every Actions-tab row whose underlying item has description
  HTML** — Attacks (weapons), Spells, Features, and Items uniformly. Rows
  without a description (or with no underlying item at all — skills,
  ability checks, rests) keep plain, non-tappable text.
- Delivery: **frontend cross-reference** — no adapter, adapter-sdk, or
  gateway change. Alternatives rejected: putting `detail` on
  `ActionDescriptor` duplicates every description in an already ~40 KB
  sheet payload for a purely presentational need; an on-demand fetch
  endpoint adds a network round-trip for data the client already holds.

## Data flow

The sheet payload already carries every description: the list sections
(inventory, features, spells) hold `ListItem`s whose `id` is the Foundry
item `_id` and whose `detail` is the sanitizable description HTML
(`itemDetail`, M8). Every Actions-tab descriptor id embeds the same item
id: `item.<id>.attack`, `item.<id>.use`, `spell.<id>.cast`,
`feature.<id>.use`.

`apps/web/app/pages/actor/[id].vue` adds one computed lookup:

- Walk `sheet.sections`, take every section with `kind === 'list'`, and map
  each `ListItem` with a non-empty `detail` to `itemId → { title: label,
  detail }`.
- Extract an action id's item id with `^(?:item|spell|feature)\.([^.]+)\.`
  — non-matching ids (`skill.*`, `ability.*`, `rest.*`, `init.roll`,
  `deathsave.roll`, `concentration.end`) get no detail, by construction.

## Component changes

Two files, frontend only:

- **`apps/web/app/components/SectionActions.vue`**
  - New prop: the set of action ids that resolve to a description (computed
    by the page, so this component stays lookup-agnostic).
  - New emit: `detail(action)` when a row's name is tapped and the row is
    in the set.
  - Rendering: the name becomes a `<button>` with
    `aria-label="Details for <name>"` (the `SectionList` convention) when
    a description exists; plain text otherwise. Styling matches the
    existing detail-trigger names elsewhere in the app (no new visual
    affordance beyond the tap behavior).
- **`apps/web/app/pages/actor/[id].vue`**
  - Computes the map + set described above, passes the set into
    `SectionActions`.
  - Handles the `detail` event by setting the existing `detailFor` ref with
    `{ title, detail }` — the existing `DetailDialog` opens with the same
    sanitized-HTML rendering and close behavior as the Gear tab. No
    `removable`/`itemId` is passed, so the dialog never shows a destructive
    action from this path.

## Edge cases

- Works offline — the data is already client-side; no new requests.
- Disabled rows (e.g. a Cast with no slot) still allow reading the
  description; deciding whether something is worth a slot is exactly when
  the text matters.
- Weapon rows carry two buttons (Attack + Dmg) and one name; the name tap
  shows the weapon's description, the buttons are untouched.
- The spell filter chips (M15) and effect wording are untouched — the name
  tap is a new, orthogonal target on the same rows.
- Items whose description is empty/missing simply stay non-tappable — no
  empty dialog can open.

## Testing

`apps/web` has no unit-test harness (repo convention: e2e via the running
stack), and no adapter/gateway code changes, so the whole suite stays as-is
and verification is the established manual live pass:

1. Tap Longsword's name on Randal's Actions tab → dialog shows the weapon
   description; Attack/Dmg buttons still roll.
2. Tap Sacred Flame's name on Akra's Actions tab → spell text.
3. Tap Waterskin's name → item text; tap Second Wind's name → feature text.
4. Tapping a name never triggers the row's Use/Cast/Attack action, and
   tapping the action button never opens the dialog.
5. Dialog closes cleanly; a subsequent Use/Cast works normally.

(Skill/ability/rest rows never render inside `SectionActions` — they live
on the Overview tab as stat tiles and in `RestControls` — so the
non-matching-id case cannot even present a tap target there.)
