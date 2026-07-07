<template>
  <div class="scrim" @click.self="emit('close')">
    <div class="modal-sheet log" role="dialog" aria-modal="true" aria-label="Roll history">
      <div class="head">
        <span class="title">Roll History</span>
        <button class="close" type="button" aria-label="Close" @click="emit('close')">✕</button>
      </div>

      <p v-if="entries.length === 0" class="empty">No rolls yet this session.</p>

      <ul v-else class="entries">
        <li v-for="e in entries" :key="e.id" class="entry" :class="{ crit: e.isCritical, fumble: e.isFumble }">
          <span class="total tabular">{{ e.total }}</span>
          <span class="meta">
            <span class="label">
              {{ e.label }}
              <span v-if="e.isCritical" class="flag good">Critical</span>
              <span v-else-if="e.isFumble" class="flag bad">Fumble</span>
            </span>
            <span class="formula tabular">{{ e.formula }}</span>
          </span>
        </li>
      </ul>

      <button class="cancel" type="button" @click="emit('close')">Close</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { RollLogEntry } from '~/types/api'

defineProps<{ entries: RollLogEntry[] }>()
const emit = defineEmits<{ (e: 'close'): void }>()
</script>

<style scoped>
.log {
  max-height: 80dvh;
  overflow-y: auto;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.title {
  font-family: var(--serif);
  font-weight: 700;
  font-size: 1.15rem;
  color: var(--ink);
}

.close {
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  color: var(--ink-dim);
  border: 1px solid var(--line);
  font-size: 0.9rem;
}

.empty {
  padding: 30px 8px;
  text-align: center;
  color: var(--ink-dim);
  font-size: 0.9rem;
}

.entries {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.entry {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--panel-2);
  border: 1px solid var(--line);
}

.entry.crit {
  border-color: color-mix(in srgb, var(--gold) 55%, var(--line));
}
.entry.fumble {
  border-color: color-mix(in srgb, var(--garnet) 50%, var(--line));
}

.total {
  font-size: 1.5rem;
  font-weight: 800;
  color: var(--gold-bright);
  min-width: 40px;
  text-align: center;
}
.entry.fumble .total {
  color: var(--garnet);
}

.meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.label {
  font-weight: 700;
  font-size: 0.9rem;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.flag {
  margin-left: 6px;
  font-size: 0.66rem;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.flag.good {
  color: var(--gold-bright);
}
.flag.bad {
  color: var(--garnet);
}

.formula {
  font-size: 0.76rem;
  color: var(--ink-dim);
}

.cancel {
  display: block;
  width: 100%;
  min-height: var(--tap);
  margin-top: 12px;
  color: var(--ink-dim);
  font-weight: 600;
}
</style>
