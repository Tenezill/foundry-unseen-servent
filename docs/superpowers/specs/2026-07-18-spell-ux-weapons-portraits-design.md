# Spell UX, equipped-weapon actions, portraits — design

Date: 2026-07-18. Approved by the user in-session (option picks recorded
inline). Six items, all small, sharing one deploy.

## 1. Weapon actions only while equipped (adapter)

`buildActions()` emits `item.<id>.attack`/`item.<id>.damage` for every weapon.
Change: emit them only when `system.equipped === true`. The equip toggle,
inventory row, and move/attune actions are unchanged — unequipping a weapon
hides its Attack/Dmg everywhere (user picked "hide entirely", not disabled).
The inventory row's `actionId` (attack) follows the same gate.

## 2. Free-use / innate spells marked distinctly (adapter)

dnd5e 5.3.3 live shape (Morgrim): feat/racial grants import as spells with
`system.method: 'atwill' | 'innate'`, own `uses {spent, max:"1",
recovery:[lr]}`, activities consuming `itemUses` — vs `method: 'spell'` for
slot casts. User picked the full treatment:
- spell row: tag `free use` (atwill) / `innate`, sub gains `1/long rest`
  (from uses+recovery), and `resourceId: item.<id>.uses` (the resource
  already exists — every item with usesInfo gets one) so the row shows a
  correctable 0/1 counter.
- action label: `Healing Word (free use)` in `buildActions`, so the Actions
  tab and roll toasts are unambiguous.
- bugfix: the `slotLevels: []` (disabled, no slot) gate must NOT apply to
  atwill/innate spells — they cast without slots.

## 3. Spells grouped by level with headers (adapter) + 4. filters (web)

Adapter: replace the single `spells` section with per-level sections
`spells.l<N>` (label `Cantrips`, `1st Level`, …), each with a `header` item —
the same mechanism as inventory containers (M19), so the PWA renders the
familiar collapsible headline rows. Web tab heuristic routes them to the
Spells tab automatically (`/spell|cantrip/` matches id).

Web: a `filter-chips` row (same look as the Actions tab's Atk/Heal/Util) on
the Spells tab: one chip per present level (Cantrip, Lvl 1, Lvl 2, …) plus
`Ritual` and `Conc.` chips. Level chips filter sections; ritual/concentration
filter rows by their existing tags. Chips are additive with a single active
level chip (tap again to clear), ritual/conc are independent toggles.

## 5. Portraits in the avatar circle (web + quickstart Caddy)

`SheetHero`/`ActorAvatar` already render `foundryImgUrl(img, foundryBase)`;
`foundryBase` is '' so Foundry-relative paths (e.g. `ddb-images/…`) 404 into
the glyph fallback. User picked the same-origin proxy:
- quickstart `Caddyfile`: `handle_path /fvtt/*` → `reverse_proxy
  foundry:30000`, restricted to image extensions
  (`webp|png|jpe?g|gif|svg|avif`), anything else 404s. No Foundry UI exposure.
- `nuxt.config.ts`: default `foundryBase: '/fvtt'`. Works identically on LAN
  and domain; dev/mock setups without the proxy keep the glyph fallback.

## 6. "Add feat" moves to Vitals (web)

`COLLECTION_TAB.feats: 'overview'` → `'resources'` (the Vitals tab). One
line; the button mechanism is tab-driven.

## Testing / verification

Adapter items TDD in packages/adapter-dnd5e tests (existing fixtures +
Morgrim-shaped free-use spell). Web: nuxt build + mock-server browser pass
(filters, add-feat placement). Portrait proxy verified live post-deploy
(curl the /fvtt image URL through the web container).
