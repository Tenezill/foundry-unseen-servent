<template>
  <section>
    <h2 class="section-title">{{ section.label }}</h2>
    <div class="list card">
      <div v-for="item in section.items" :key="item.id" class="row">
        <ActorAvatar :name="item.label" :img="item.img" :size="38" />
        <div class="row-main">
          <button
            v-if="item.detail"
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

        <ResourceStepper
          v-if="item.resourceId && resources[item.resourceId]"
          :resource="resources[item.resourceId]!"
          :disabled="readonly || !resources[item.resourceId]!.writable"
          :busy="busy === item.resourceId"
          compact
          @step="(id, dir) => emit('step', id, dir)"
        />
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
        <button
          v-if="equipOf(item)"
          class="equip-btn"
          type="button"
          :class="{ on: equipOf(item)!.equipped, pending: actionBusy === item.equipActionId }"
          :aria-pressed="equipOf(item)!.equipped === true"
          :disabled="readonly || actionBusy !== null"
          @click="item.equipActionId && emit('action', item.equipActionId)"
        >
          {{ equipOf(item)!.equipped ? 'Equipped' : 'Equip' }}
        </button>
      </div>
      <p v-if="section.items.length === 0" class="empty">Nothing here yet.</p>
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
}>()

const emit = defineEmits<{
  (e: 'step', resourceId: string, direction: 1 | -1): void
  (e: 'action', actionId: string): void
  (e: 'detail', item: ListItem): void
}>()

function actionOf(item: ListItem): ActionDescriptor | undefined {
  return item.actionId ? props.actions[item.actionId] : undefined
}

function equipOf(item: ListItem): ActionDescriptor | undefined {
  return item.equipActionId ? props.actions[item.equipActionId] : undefined
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
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  min-height: 60px;
}

.row + .row {
  border-top: 1px solid var(--line);
}

.row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  align-items: flex-start;
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

.empty {
  padding: 20px;
  text-align: center;
  color: var(--ink-dim);
  font-size: 0.85rem;
}
</style>
