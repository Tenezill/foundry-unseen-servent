<template>
  <section>
    <h2 class="section-title">{{ section.label }}</h2>
    <div class="grid">
      <div v-for="stat in section.stats" :key="stat.id" class="stat card">
        <span class="label">{{ stat.label }}</span>
        <span class="value">{{ stat.value }}</span>
        <span v-if="stat.sub" class="sub">{{ stat.sub }}</span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { SheetSection } from '@companion/adapter-sdk'

defineProps<{ section: Extract<SheetSection, { kind: 'stats' }> }>()
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
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 12px 6px;
  min-height: 72px;
  text-align: center;
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
