<template>
  <div class="scrim" @click.self="emit('close')">
    <div class="modal-sheet" role="dialog" aria-modal="true" :aria-label="`Adjust ${resource.label}`">
      <div class="head">
        <span class="title">{{ resource.label }}</span>
        <span class="current">
          {{ resource.value }}<span v-if="resource.max !== undefined" class="max">/{{ resource.max }}</span>
        </span>
      </div>

      <div class="display" :class="{ empty: entry === '' }">
        {{ entry === '' ? '0' : entry }}
      </div>

      <div class="keys">
        <button v-for="d in digits" :key="d" class="key" type="button" @click="press(d)">
          {{ d }}
        </button>
        <button class="key" type="button" @click="press('0')">0</button>
        <button class="key key-del" type="button" aria-label="Delete" @click="backspace">⌫</button>
      </div>

      <div class="actions">
        <button class="act damage" type="button" :disabled="amount === 0" @click="apply(-1)">
          &minus; Damage
        </button>
        <button class="act heal" type="button" :disabled="amount === 0" @click="apply(1)">
          + Heal
        </button>
      </div>

      <button class="cancel" type="button" @click="emit('close')">Cancel</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ResourceDescriptor } from '@companion/adapter-sdk'

defineProps<{ resource: ResourceDescriptor }>()

const emit = defineEmits<{
  (e: 'apply', delta: number): void
  (e: 'close'): void
}>()

const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
const entry = ref('')

const amount = computed(() => Number.parseInt(entry.value || '0', 10))

function press(d: string): void {
  if (entry.value.length >= 3) return
  if (entry.value === '' && d === '0') return
  entry.value += d
}

function backspace(): void {
  entry.value = entry.value.slice(0, -1)
}

function apply(sign: 1 | -1): void {
  if (amount.value === 0) return
  emit('apply', sign * amount.value)
}
</script>

<style scoped>
.head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 12px;
}

.title {
  font-weight: 800;
  font-size: 1rem;
}

.current {
  font-variant-numeric: tabular-nums;
  font-weight: 700;
}

.max {
  color: var(--text-dim);
  font-weight: 500;
}

.display {
  text-align: center;
  font-size: 2.4rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  padding: 8px 0 14px;
}

.display.empty {
  color: var(--text-dim);
}

.keys {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.key {
  min-height: 52px;
  border-radius: 12px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  font-size: 1.25rem;
  font-weight: 700;
}

.key:active {
  background: var(--accent-soft);
}

.key-del {
  font-size: 1.1rem;
}

.keys .key:nth-last-child(2) {
  grid-column: 2;
}

.actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 14px;
}

.act {
  min-height: 52px;
  border-radius: 12px;
  font-weight: 800;
  font-size: 1rem;
  border: 1px solid transparent;
}

.damage {
  background: var(--danger-soft);
  color: var(--danger);
}

.heal {
  background: var(--success-soft);
  color: var(--success);
}

.cancel {
  display: block;
  width: 100%;
  min-height: var(--tap);
  margin-top: 8px;
  color: var(--text-dim);
  font-weight: 600;
}
</style>
