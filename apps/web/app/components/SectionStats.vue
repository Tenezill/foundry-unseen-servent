<template>
  <section>
    <h2 class="section-title">{{ section.label }}</h2>

    <!-- Ability gems: big modifier + notched score pill (M7). -->
    <div v-if="variant === 'gems'" class="gems tabular">
      <template v-for="stat in section.stats" :key="stat.id">
        <button
          v-if="stat.actionId"
          class="gem tappable"
          type="button"
          :disabled="readonly || busy !== null"
          :aria-label="`Roll ${stat.label}`"
          @click="tap(stat)"
        >
          <span class="tap-glyph" aria-hidden="true">⚅</span>
          <span class="cap">{{ stat.label }}</span>
          <span class="mod">{{ stat.sub ?? stat.value }}</span>
          <span class="score">{{ stat.value }}</span>
        </button>
        <div v-else class="gem">
          <span class="cap">{{ stat.label }}</span>
          <span class="mod">{{ stat.sub ?? stat.value }}</span>
          <span class="score">{{ stat.value }}</span>
        </div>
      </template>
    </div>

    <!-- Full-width label:value rows for prose-length values (traits, M11). -->
    <div v-else-if="variant === 'rows'" class="rows card">
      <div v-for="stat in section.stats" :key="stat.id" class="prose-row">
        <span class="label">{{ stat.label }}</span>
        <span class="prose-value">{{ stat.value }}</span>
      </div>
    </div>

    <!-- Default gilded stat cards (saves, skills…). -->
    <div v-else class="grid">
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

withDefaults(
  defineProps<{
    section: Extract<SheetSection, { kind: 'stats' }>
    readonly?: boolean
    busy?: string | null
    variant?: 'cards' | 'gems' | 'rows'
  }>(),
  { readonly: false, busy: null, variant: 'cards' },
)

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
  fill: var(--ink-faint);
  opacity: 0.7;
}

.label {
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-dim);
}

.value {
  font-size: 1.25rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}

.sub {
  font-size: 0.72rem;
  color: var(--gold);
  font-weight: 600;
}

/* ---- prose rows (traits) ---- */
.rows {
  display: flex;
  flex-direction: column;
}

.prose-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 14px;
}

.prose-row + .prose-row {
  border-top: 1px solid var(--line);
}

.prose-value {
  font-size: 0.88rem;
  color: var(--ink);
  line-height: 1.45;
  overflow-wrap: anywhere;
}

/* ---- ability gems ---- */
.gems {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.gem {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 12px 6px 34px;
  text-align: center;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: linear-gradient(180deg, var(--panel-2), var(--panel));
  transition: transform 0.12s ease, border-color 0.12s ease;
}

.gem.tappable:active:not(:disabled) {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--gold) 55%, var(--line));
}

.gem .tap-glyph {
  position: absolute;
  top: 8px;
  right: 9px;
  color: var(--gold);
  opacity: 0.5;
  font-size: 0.7rem;
}

.gem .cap {
  font-size: 0.6rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ink-dim);
}

.gem .mod {
  font-family: var(--serif);
  font-size: 2rem;
  font-weight: 700;
  line-height: 1.1;
  color: var(--ink);
}

.gem .score {
  position: absolute;
  left: 50%;
  bottom: -1px;
  transform: translate(-50%, 40%);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 0.82rem;
  font-weight: 700;
  padding: 3px 12px;
  color: var(--ink-dim);
}
</style>
