<template>
  <section>
    <h2 class="section-title">{{ section.label }}</h2>
    <div class="list card">
      <div v-for="item in section.items" :key="item.id" class="row">
        <button
          v-if="isCast(item)"
          class="row-tap"
          type="button"
          :disabled="readonly || actionBusy !== null"
          :aria-label="`Cast ${item.label}`"
          @click="tap(item)"
        >
          <ActorAvatar :name="item.label" :img="item.img" :size="40" />
          <div class="row-main">
            <span class="row-label">{{ item.label }}</span>
            <span v-if="item.sub" class="row-sub">{{ item.sub }}</span>
            <span v-if="item.tags?.length" class="tags">
              <span v-for="tag in item.tags" :key="tag" class="tag">{{ tag }}</span>
            </span>
          </div>
          <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true">
            <path d="m10 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
          </svg>
        </button>
        <template v-else>
          <ActorAvatar :name="item.label" :img="item.img" :size="40" />
          <div class="row-main">
            <span class="row-label">{{ item.label }}</span>
            <span v-if="item.sub" class="row-sub">{{ item.sub }}</span>
            <span v-if="item.tags?.length" class="tags">
              <span v-for="tag in item.tags" :key="tag" class="tag">{{ tag }}</span>
            </span>
          </div>
        </template>
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
}>()

function actionOf(item: ListItem): ActionDescriptor | undefined {
  return item.actionId ? props.actions[item.actionId] : undefined
}

function equipOf(item: ListItem): ActionDescriptor | undefined {
  return item.equipActionId ? props.actions[item.equipActionId] : undefined
}

function isCast(item: ListItem): boolean {
  return actionOf(item)?.kind === 'cast'
}

function verbOf(item: ListItem): string | null {
  const kind = actionOf(item)?.kind
  if (kind === 'attack') return 'Attack'
  if (kind === 'use') return 'Use'
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
  padding: 10px 12px;
  min-height: 60px;
}

.row + .row {
  border-top: 1px solid var(--line);
}

.row-tap {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  text-align: left;
  margin: -10px -4px -10px -12px;
  padding: 10px 4px 10px 12px;
  min-height: 60px;
  border-radius: 0;
}

.row-tap:active:not(:disabled) {
  background: var(--accent-soft);
}

.chevron {
  flex: none;
  width: 18px;
  height: 18px;
  color: var(--text-dim);
}

.row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.row-label {
  font-weight: 600;
  font-size: 0.92rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-sub {
  font-size: 0.76rem;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tags {
  display: flex;
  gap: 4px;
  margin-top: 2px;
  flex-wrap: wrap;
}

.tag {
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 2px 7px;
  border-radius: 999px;
}

.act-btn,
.equip-btn {
  flex: none;
  min-height: 36px;
  padding: 0 14px;
  border-radius: 999px;
  font-size: 0.76rem;
  font-weight: 700;
  border: 1px solid transparent;
}

.act-btn {
  background: var(--accent-soft);
  color: var(--accent);
}

.equip-btn {
  background: var(--surface-2);
  color: var(--text-dim);
  border-color: var(--line);
}

.equip-btn.on {
  background: var(--accent-soft);
  color: var(--accent);
  border-color: transparent;
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
  color: var(--text-dim);
  font-size: 0.85rem;
}
</style>
