<template>
  <section>
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
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="m9 6 6 6-6 6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <button
        class="head-name"
        type="button"
        :aria-label="`Details for ${section.header.label}`"
        @click="emit('detail', section.header)"
      >
        <span class="section-title">{{ section.header.label }}</span>
        <span v-if="section.header.sub" class="row-sub">{{ section.header.sub }}</span>
      </button>
      <span v-if="pips?.length" class="lvl-pips"><SlotPips v-for="(p, i) in pips" :key="i" v-bind="p" /></span>
    </div>
    <div v-show="!sectionCollapsed" class="list card">
      <div
        v-for="{ item, depth, hasChildren } in rows"
        :key="item.id"
        class="row"
        :style="depth > 0 ? { paddingLeft: `${14 + depth * 22}px` } : undefined"
      >
        <button
          v-if="hasChildren"
          class="chev"
          type="button"
          :class="{ open: !isCollapsed(item.id) }"
          :aria-expanded="!isCollapsed(item.id)"
          :aria-label="`Toggle contents of ${item.label}`"
          @click="toggleCollapse(item.id)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="m9 6 6 6-6 6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <ActorAvatar :name="item.label" :img="item.img" :size="38" />
        <div class="row-main">
          <button
            v-if="item.detail || (item.removable && !readonly)"
            class="row-name detail"
            type="button"
            :aria-label="`Details for ${item.label}`"
            @click="emit('detail', item)"
          >
            {{ item.label }}
            <svg class="info" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v5M12 8h.01" stroke-linecap="round" />
            </svg>
          </button>
          <span v-else class="row-label">{{ item.label }}</span>
          <span v-if="item.sub" class="row-sub">{{ item.sub }}</span>
          <span v-if="item.tags?.length" class="tags">
            <span v-for="tag in item.tags" :key="tag" class="tag" :class="{ conc: tag === 'concentration' }">{{ tag }}</span>
          </span>
        </div>

        <div class="row-controls">
          <ResourceStepper
            v-if="item.resourceId && resources[item.resourceId]"
            :resource="resources[item.resourceId]!"
            :disabled="readonly || !resources[item.resourceId]!.writable"
            :busy="busy === item.resourceId"
            compact
            @step="(id, dir) => emit('step', id, dir)"
          />
          <!-- Outlined toggles (Prepared / Equipped / Attune) tuck inward so the
               yellow primary button stays flush-right, consistent with the
               Actions tab. -->
          <button
            v-if="toggleOf(item)"
            class="equip-btn"
            type="button"
            :class="{ on: toggleOn(toggleOf(item)!), pending: actionBusy === item.toggleActionId }"
            :aria-pressed="toggleOn(toggleOf(item)!)"
            :disabled="readonly || actionBusy !== null"
            @click="item.toggleActionId && emit('action', item.toggleActionId)"
          >
            {{ toggleLabel(toggleOf(item)!) }}
          </button>
          <button
            v-if="attuneOf(item)"
            class="equip-btn"
            type="button"
            :class="{ on: attuneOf(item)!.attuned === true, pending: actionBusy === item.attuneActionId }"
            :aria-pressed="attuneOf(item)!.attuned === true"
            :disabled="readonly || actionBusy !== null"
            @click="item.attuneActionId && emit('action', item.attuneActionId)"
          >
            {{ attuneOf(item)!.attuned ? 'Attuned' : 'Attune' }}
          </button>
          <button
            v-if="verbOf(item)"
            class="act-btn"
            type="button"
            :class="{ pending: actionBusy === item.actionId }"
            :disabled="readonly || actionBusy !== null"
            @click="tap(item)"
          >
            {{ verbOf(item) }}
          </button>
        </div>
      </div>
      <p v-if="rows.length === 0" class="empty-hint">Empty</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { ActionDescriptor, ListItem, ResourceDescriptor, SheetSection } from '@companion/adapter-sdk'

const props = defineProps<{
  section: Extract<SheetSection, { kind: 'list' }>
  resources: Record<string, ResourceDescriptor>
  actions: Record<string, ActionDescriptor>
  busy: string | null
  actionBusy: string | null
  readonly: boolean
  collapsible?: boolean
  storageKey?: string
  /** Slot pips (2026-07-19) for this section's level header, when the page
   *  identifies it as a per-level spell section — see pipsForLevel in
   *  [id].vue. */
  pips?: Array<{ value: number; max: number; pact?: boolean }>
}>()

const emit = defineEmits<{
  (e: 'step', resourceId: string, direction: 1 | -1): void
  (e: 'action', actionId: string): void
  (e: 'detail', item: ListItem): void
}>()

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

/* ---- container grouping (M12) ----------------------------------------- */

interface Row {
  item: ListItem
  depth: number
  hasChildren: boolean
}

const collapsedIds = ref(new Set<string>())

function isCollapsed(id: string): boolean {
  return collapsedIds.value.has(id)
}

function toggleCollapse(id: string): void {
  const next = new Set(collapsedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsedIds.value = next
}

/** Flattened rows: items nested (depth-first) under their container row,
 *  default expanded; containerIds that match no row render flat. */
const rows = computed<Row[]>(() => {
  const items = props.section.items
  const ids = new Set(items.map((i) => i.id))
  const children = new Map<string, ListItem[]>()
  const roots: ListItem[] = []
  for (const item of items) {
    const cid = item.containerId
    if (cid && cid !== item.id && ids.has(cid)) {
      const kids = children.get(cid)
      if (kids) kids.push(item)
      else children.set(cid, [item])
    } else {
      roots.push(item)
    }
  }
  const out: Row[] = []
  const seen = new Set<string>()
  // Descendants of a collapsed container are hidden, not unreachable — mark
  // them seen so the leftover pass below doesn't resurface them flat.
  const markSeen = (item: ListItem): void => {
    for (const kid of children.get(item.id) ?? []) {
      if (seen.has(kid.id)) continue
      seen.add(kid.id)
      markSeen(kid)
    }
  }
  const visit = (item: ListItem, depth: number): void => {
    if (seen.has(item.id)) return
    seen.add(item.id)
    const kids = children.get(item.id) ?? []
    out.push({ item, depth, hasChildren: kids.length > 0 })
    if (collapsedIds.value.has(item.id)) {
      markSeen(item)
      return
    }
    for (const kid of kids) visit(kid, depth + 1)
  }
  for (const item of roots) visit(item, 0)
  // Container cycles never reach a root; render any leftovers flat.
  for (const item of items) if (!seen.has(item.id)) visit(item, 0)
  return out
})

function actionOf(item: ListItem): ActionDescriptor | undefined {
  return item.actionId ? props.actions[item.actionId] : undefined
}

function attuneOf(item: ListItem): ActionDescriptor | undefined {
  return item.attuneActionId ? props.actions[item.attuneActionId] : undefined
}

function toggleOf(item: ListItem): ActionDescriptor | undefined {
  return item.toggleActionId ? props.actions[item.toggleActionId] : undefined
}

function toggleOn(action: ActionDescriptor): boolean {
  return action.kind === 'prepare' ? action.prepared === true : action.equipped === true
}

function toggleLabel(action: ActionDescriptor): string {
  if (action.kind === 'prepare') return action.prepared ? 'Prepared' : 'Prepare'
  return action.equipped ? 'Equipped' : 'Equip'
}

function verbOf(item: ListItem): string | null {
  const kind = actionOf(item)?.kind
  if (kind === 'attack') return 'Attack'
  if (kind === 'use') return 'Use'
  if (kind === 'cast') return 'Cast'
  return null
}

function tap(item: ListItem): void {
  if (item.actionId) emit('action', item.actionId)
}
</script>

<style scoped>
.list {
  overflow: hidden;
}

.row {
  display: flex;
  flex-wrap: wrap; /* controls wrap below the name instead of crushing it */
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  min-height: 60px;
}

.row + .row {
  border-top: 1px solid var(--line);
}

.chev {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin-left: -6px;
  margin-right: -6px;
  border-radius: 8px;
  color: var(--ink-faint);
}

.chev svg {
  width: 14px;
  height: 14px;
  transition: transform 0.15s ease;
}

.chev.open svg {
  transform: rotate(90deg);
}

.chev:active {
  color: var(--gold);
}

.row-main {
  flex: 1 1 160px; /* name keeps a readable minimum before controls wrap */
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  align-items: flex-start;
}

.row-controls {
  flex: none;
  max-width: 100%;
  margin-left: auto; /* stays flush-right, on either line */
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}

.row-controls:empty {
  display: none; /* rows without controls keep their old spacing */
}

.row-label,
.row-name {
  font-weight: 600;
  font-size: 0.95rem;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-name {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--ink);
}

.row-name .info {
  width: 14px;
  height: 14px;
  color: var(--gold);
  opacity: 0.7;
  flex: none;
}

.row-name:active {
  color: var(--gold-bright);
}

.row-sub {
  font-size: 0.76rem;
  color: var(--ink-dim);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tags {
  display: flex;
  gap: 4px;
  margin-top: 3px;
  flex-wrap: wrap;
}

.tag {
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--gold-bright);
  background: color-mix(in srgb, var(--gold) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--gold) 30%, transparent);
  padding: 2px 7px;
  border-radius: 999px;
}

.tag.conc {
  color: var(--garnet);
  background: color-mix(in srgb, var(--garnet) 14%, transparent);
  border-color: color-mix(in srgb, var(--garnet) 34%, transparent);
}

.act-btn,
.equip-btn {
  flex: none;
  min-height: 36px;
  padding: 0 16px;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  border: 1px solid transparent;
}

.act-btn {
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  color: var(--accent-ink);
  border-color: var(--gold-deep);
  box-shadow: 0 2px 8px color-mix(in srgb, var(--gold) 30%, transparent);
}

.equip-btn {
  background: var(--panel-2);
  color: var(--ink-dim);
  border-color: var(--line);
}

.equip-btn.on {
  background: var(--accent-soft);
  color: var(--gold-bright);
  border-color: color-mix(in srgb, var(--gold) 30%, transparent);
}

.act-btn:active:not(:disabled),
.equip-btn:active:not(:disabled) {
  transform: scale(0.96);
}

.pending {
  opacity: 0.55;
}

.section-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.head-name {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  text-align: left;
  padding: 0;
  background: none;
  border: 0;
  color: inherit;
}

/* Let the title grow so .section-title::after (the gilded trailing line)
   has room to expand, matching every other section heading. */
.head-name .section-title {
  flex: 1;
}

.lvl-pips {
  flex: none;
  display: inline-flex;
  gap: 8px;
}

.empty-hint {
  color: var(--text-dim);
  font-size: 0.85rem;
  padding: 12px 14px;
  font-style: italic;
}
</style>
