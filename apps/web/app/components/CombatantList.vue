<template>
  <div class="list card">
    <button
      v-for="c in combatants"
      :key="c.id"
      class="row"
      type="button"
      :disabled="readonly"
      @click="emit('select', c.id)"
    >
      <ActorAvatar :name="c.name" :img="foundryImgUrl(c.img, foundryBase)" :size="40" />
      <div class="row-main">
        <span class="row-label" :class="{ strike: c.defeated }">{{ c.name }}</span>
        <span class="row-sub" :class="healthClass(c)">{{ healthCaption(c) }}</span>
      </div>
      <span class="init-badge tabular">{{ c.initiative ?? '–' }}</span>
    </button>
    <p v-if="combatants.length === 0" class="empty-hint">No combatants.</p>
  </div>
</template>

<script setup lang="ts">
import type { EncounterCombatantView } from '~/types/api'

defineProps<{
  combatants: EncounterCombatantView[]
  readonly: boolean
}>()

const emit = defineEmits<{
  (e: 'select', id: string): void
}>()

const config = useRuntimeConfig()
const foundryBase = String(config.public.foundryBase || '')

function healthCaption(c: EncounterCombatantView): string {
  if (c.isPC && c.hp) return `${c.hp.value}/${c.hp.max}`
  if (c.health) return c.health.charAt(0).toUpperCase() + c.health.slice(1)
  return '—'
}

function healthClass(c: EncounterCombatantView): string {
  return c.health ? `health-${c.health}` : ''
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
  width: 100%;
  text-align: left;
}

.row:disabled {
  opacity: 1;
  cursor: default;
}

.row + .row {
  border-top: 1px solid var(--line);
}

.row:active:not(:disabled) {
  background: color-mix(in srgb, var(--gold) 8%, transparent);
}

.row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  align-items: flex-start;
}

.row-label {
  font-weight: 600;
  font-size: 0.95rem;
  color: var(--ink);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-label.strike {
  text-decoration: line-through;
  color: var(--ink-faint);
}

.row-sub {
  font-size: 0.76rem;
  color: var(--ink-dim);
}

.row-sub.health-wounded {
  color: color-mix(in srgb, var(--garnet) 70%, var(--ink-dim));
}

.row-sub.health-bloodied,
.row-sub.health-down {
  color: var(--garnet);
  font-weight: 600;
}

.init-badge {
  flex: none;
  min-width: 28px;
  text-align: center;
  font-weight: 700;
  font-size: 0.9rem;
  color: var(--gold-bright);
}

.empty-hint {
  color: var(--text-dim);
  font-size: 0.85rem;
  padding: 12px 14px;
  font-style: italic;
}
</style>
