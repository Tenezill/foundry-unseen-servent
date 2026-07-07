<template>
  <section>
    <h2 class="section-title">{{ section.label }}</h2>
    <div class="grid">
      <template v-for="stat in section.stats" :key="stat.id">
        <button
          v-if="stat.actionId"
          class="stat card tappable"
          type="button"
          :disabled="readonly || busy !== null"
          :aria-label="`Roll ${stat.label}`"
          @click="tap(stat)"
        >
          <span class="label">{{ stat.label }}</span>
          <span class="value">{{ stat.value }}</span>
          <span v-if="stat.sub" class="sub">{{ stat.sub }}</span>
          <svg class="die" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2 3 7v10l9 5 9-5V7Zm0 2.3L18.9 8 12 11.7 5.1 8ZM5 9.7l6 3.3v6.6l-6-3.3Zm14 0v6.6l-6 3.3V13Z" />
          </svg>
        </button>
        <div v-else class="stat card">
          <span class="label">{{ stat.label }}</span>
          <span class="value">{{ stat.value }}</span>
          <span v-if="stat.sub" class="sub">{{ stat.sub }}</span>
        </div>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { SheetSection, Stat } from '@companion/adapter-sdk'

defineProps<{
  section: Extract<SheetSection, { kind: 'stats' }>
  readonly?: boolean
  busy?: string | null
}>()

const emit = defineEmits<{ (e: 'action', actionId: string): void }>()

function tap(stat: Stat): void {
  if (stat.actionId) emit('action', stat.actionId)
}
</script>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

@media (min-width: 480px) {
  .grid {
    grid-template-columns: repeat(4, 1fr);
  }
}

.stat {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 12px 6px;
  min-height: 72px;
  text-align: center;
}

.stat.tappable:active:not(:disabled) {
  transform: scale(0.97);
  background: var(--accent-soft);
}

.die {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 13px;
  height: 13px;
  fill: var(--text-dim);
  opacity: 0.7;
}

.label {
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-dim);
}

.value {
  font-size: 1.25rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}

.sub {
  font-size: 0.72rem;
  color: var(--accent);
  font-weight: 600;
}
</style>
