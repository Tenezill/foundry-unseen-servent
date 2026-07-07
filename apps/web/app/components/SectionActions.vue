<template>
  <section v-for="group in groups" :key="group.id">
    <h2 class="section-title">{{ group.label }}</h2>
    <div class="list card">
      <div v-for="action in group.actions" :key="action.id" class="row">
        <div class="row-main">
          <span class="row-label">{{ action.label }}</span>
          <span v-if="noSlots(action)" class="row-sub">No spell slots left</span>
        </div>
        <button
          class="act-btn"
          type="button"
          :class="{ pending: actionBusy === action.id }"
          :disabled="readonly || actionBusy !== null || noSlots(action)"
          @click="emit('action', action.id)"
        >
          {{ group.verb }}
        </button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { ActionDescriptor } from '@companion/adapter-sdk'

const props = defineProps<{
  /** Pre-filtered attack/cast/use actions, in sheet order. */
  actions: ActionDescriptor[]
  actionBusy: string | null
  readonly: boolean
}>()

const emit = defineEmits<{
  (e: 'action', actionId: string): void
}>()

const GROUP_DEFS = [
  { id: 'attacks', label: 'Attacks', kind: 'attack', verb: 'Attack' },
  { id: 'spells', label: 'Spells', kind: 'cast', verb: 'Cast' },
  { id: 'features', label: 'Features', kind: 'use', verb: 'Use' },
] as const

/** Non-empty groups only — empty headers are omitted. */
const groups = computed(() =>
  GROUP_DEFS.map((def) => ({
    ...def,
    actions: props.actions.filter((a) => a.kind === def.kind),
  })).filter((g) => g.actions.length > 0),
)

function noSlots(action: ActionDescriptor): boolean {
  return action.kind === 'cast' && action.slotLevels !== undefined && action.slotLevels.length === 0
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

.act-btn {
  flex: none;
  min-height: 36px;
  padding: 0 14px;
  border-radius: 999px;
  font-size: 0.76rem;
  font-weight: 700;
  border: 1px solid transparent;
  background: var(--accent-soft);
  color: var(--accent);
}

.act-btn:active:not(:disabled) {
  transform: scale(0.96);
}

.pending {
  opacity: 0.55;
}
</style>
