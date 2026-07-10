# Actions-Tab Info Disclosure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tapping a row's name on the Actions tab opens the item/spell/feature/weapon description in the existing detail dialog.

**Architecture:** Pure frontend cross-reference — the sheet payload already carries every description on the list sections' `ListItem.detail`, and every Actions-tab action id embeds its Foundry item id (`item.<id>.attack`, `item.<id>.use`, `spell.<id>.cast`, `feature.<id>.use`). The actor page builds one lookup map, `SectionActions` renders tappable names for rows in the lookup and emits a `detail` event, and the page opens the existing `DetailDialog`.

**Tech Stack:** Vue 3 / Nuxt 3 (`apps/web`), no adapter/adapter-sdk/gateway changes.

## Global Constraints

- **No adapter, adapter-sdk, or gateway change** — the spec explicitly rejects putting `detail` on `ActionDescriptor` (payload duplication) and an on-demand fetch endpoint (needless round-trip). If either seems necessary during implementation, STOP and escalate.
- Trigger is **tap the row's name**; rows without a description (or without an underlying item) keep plain, non-tappable text.
- Scope is **every Actions-tab group uniformly** — Attacks, Spells, Features, Items.
- Match the existing `SectionList` convention exactly: the name renders as a button with `aria-label="Details for <name>"` and the small ⓘ SVG that convention already includes.
- The dialog opens through the existing `detailFor` ref → `DetailDialog` path, with no `removable`/`itemId` (no destructive action).
- `apps/web` has no unit-test harness (repo convention: e2e via the running stack) — the test cycle for this feature is the live-verification pass in Task 2. `pnpm -r test` must stay green (it will: no tested package is touched).

---

### Task 1: Tappable names on `SectionActions` + page-side lookup

**Files:**
- Modify: `apps/web/app/components/SectionActions.vue` (props, emits, the `.row-main` block in the template, styles)
- Modify: `apps/web/app/pages/actor/[id].vue` (the `<SectionActions>` element at lines ~44-50; new computed lookups + handler near `combatActions` at ~349; nothing else)

**Interfaces:**
- Consumes: `ListItem.detail` / `ListItem.label` / `ListItem.id` from `@companion/adapter-sdk` (unchanged), the existing `detailFor` ref (`{ title: string; detail: string; itemId?: string; removable?: string } | null`), the existing `combatActions` computed, and the existing `DetailDialog` wiring — none of these change shape.
- Produces: `SectionActions` prop `detailIds: Set<string>` (action ids whose row name is tappable) and emit `(e: 'detail', actionId: string): void`. Page-side: computed `detailByItemId: Map<string, { title: string; detail: string }>`, computed `actionDetailIds: Set<string>`, function `onCombatDetail(actionId: string): void`.

- [ ] **Step 1: Extend `SectionActions.vue`**

Props and emits (replace the current blocks at lines 52-61):

```ts
const props = defineProps<{
  /** Pre-filtered attack/cast/use actions, in sheet order. */
  actions: ActionDescriptor[]
  actionBusy: string | null
  readonly: boolean
  /** Action ids whose row name opens a description (M17) — computed by the
   *  page from the sheet's list sections, so this component stays
   *  lookup-agnostic. */
  detailIds: Set<string>
}>()

const emit = defineEmits<{
  (e: 'action', actionId: string): void
  (e: 'detail', actionId: string): void
}>()
```

Template — replace the current `.row-main` block (lines 21-24):

```vue
        <div class="row-main">
          <button
            v-if="detailIds.has(action.id)"
            class="row-label detail"
            type="button"
            :aria-label="`Details for ${action.label}`"
            @click="emit('detail', action.id)"
          >
            {{ action.label }}
            <svg class="info" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v5M12 8h.01" stroke-linecap="round" />
            </svg>
          </button>
          <span v-else class="row-label">{{ action.label }}</span>
          <span v-if="noSlots(action)" class="row-sub">No spell slots left</span>
        </div>
```

Styles — extend the existing `.row-label` rule (keep it) and add, directly after it (mirrors `SectionList.vue`'s `.row-name` detail convention, lines 264-290 there):

```css
.row-label.detail {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  color: var(--ink);
  text-align: left;
}

.row-label.detail .info {
  width: 14px;
  height: 14px;
  color: var(--gold);
  opacity: 0.7;
  flex: none;
}

.row-label.detail:active {
  color: var(--gold-bright);
}
```

(Note: the name-button is deliberately NOT disabled by `readonly`/`actionBusy` — reading a description is safe offline and while another action is in flight.)

- [ ] **Step 2: Add the lookup + handler to `actor/[id].vue`**

Directly after the `combatActions` computed (currently ending around line 357), add:

```ts
/** M17: Actions-tab info disclosure. The list sections already carry every
 *  description, and action ids embed the Foundry item id — a row's detail
 *  is a lookup away, no new data over the wire. */
const ACTION_ITEM_ID = /^(?:item|spell|feature)\.([^.]+)\./

const detailByItemId = computed(() => {
  const m = new Map<string, { title: string; detail: string }>()
  for (const section of sheet.value?.sections ?? []) {
    if (section.kind !== 'list') continue
    for (const item of section.items) {
      if (item.detail) m.set(item.id, { title: item.label, detail: item.detail })
    }
  }
  return m
})

const actionDetailIds = computed(() => {
  const s = new Set<string>()
  for (const a of combatActions.value) {
    const itemId = ACTION_ITEM_ID.exec(a.id)?.[1]
    if (itemId && detailByItemId.value.has(itemId)) s.add(a.id)
  }
  return s
})

function onCombatDetail(actionId: string): void {
  const itemId = ACTION_ITEM_ID.exec(actionId)?.[1]
  const entry = itemId ? detailByItemId.value.get(itemId) : undefined
  if (!entry) return
  detailFor.value = { title: entry.title, detail: entry.detail }
}
```

Template — extend the `<SectionActions>` element (currently lines 44-50):

```vue
          <SectionActions
            v-if="activeTab === 'actions'"
            :actions="combatActions"
            :action-busy="actionBusy"
            :readonly="offline"
            :detail-ids="actionDetailIds"
            @action="onCombatAction"
            @detail="onCombatDetail"
          />
```

- [ ] **Step 3: Type-check and confirm nothing else regressed**

Run: `pnpm -r test` from the repo root.
Expected: all workspaces pass unchanged (273 adapter-dnd5e + 86 gateway + 3 foundry-client; `apps/web` has no unit tests). If Nuxt/Vite type checking is wanted, loading any actor page in Step 4 will surface template/prop type errors in the dev overlay.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/components/SectionActions.vue "apps/web/app/pages/actor/[id].vue"
git commit -m "feat(web): tap an Actions-tab row name to read its description"
```

---

### Task 2: Live verification

**Files:** none (verification-only; any bug found gets fixed as a follow-up commit and re-verified)

With the dev stack up (Foundry :30000, gateway :8090, web :3001 — the gateway does NOT hot-reload but is untouched here; the Nuxt dev server hot-reloads the two changed files automatically):

- [ ] **Step 1: Verify the five spec checks on the live PWA**

1. Randal's Actions tab: tap **Longsword**'s name → `DetailDialog` opens with the weapon description; close it; Attack and Dmg buttons still roll normally.
2. Akra's Actions tab: tap **Sacred Flame**'s name → the spell's text appears.
3. Tap **Waterskin**'s name → item text; Randal: tap **Second Wind**'s name → feature text.
4. Tapping a name never triggers the row's Use/Cast/Attack action, and tapping the action button never opens the dialog.
5. Close the dialog, then perform a normal Use/Cast → works exactly as before.

Also confirm the ⓘ glyph renders on tappable names (the convention's SVG) and that a disabled Cast row (drain Akra's slots via GM if needed: `game.actors.get('pTvtx5dm2AuYqeX2').update({'system.spells.spell1.value': 0})`, then restore) still opens its description.

- [ ] **Step 2: Record the outcome**

Append one line to `.superpowers/sdd/progress.md` noting the live pass. If any check fails, treat it as a real bug — fix, commit, re-verify before calling the feature done.

---

## Self-Review Notes

- **Spec coverage:** trigger = tappable name with `Details for` aria-label + ⓘ glyph (Task 1 Step 1) ✓; uniform scope across all four groups — the template change is in the shared row markup, group-independent ✓; frontend-only delivery, map + regex exactly as specified (Task 1 Step 2) ✓; `DetailDialog` reuse without `removable` ✓; offline/disabled-row/empty-description edge cases — name button never disabled, `v-else` plain text, `if (item.detail)` filter ✓; live-verification pass mirrors the spec's five checks (Task 2) ✓.
- **Type consistency:** `detailIds: Set<string>` matches `:detail-ids="actionDetailIds"` (`Set<string>`); `emit('detail', action.id)` (string) matches `onCombatDetail(actionId: string)`; `detailFor` assignment `{ title, detail }` satisfies its declared ref type with optional `itemId`/`removable` omitted.
- **No placeholders:** every step carries the complete code/commands.
