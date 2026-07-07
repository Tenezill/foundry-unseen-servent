<template>
  <div class="stepper" :class="{ compact }">
    <button
      class="step-btn"
      type="button"
      :disabled="disabled || busy || atMin"
      :aria-label="`Decrease ${resource.label}`"
      @click="emit('step', resource.id, -1)"
    >
      &minus;
    </button>
    <span class="value" :class="{ busy }">
      <b>{{ resource.value }}</b><span v-if="resource.max !== undefined" class="max">/{{ resource.max }}</span>
    </span>
    <button
      class="step-btn"
      type="button"
      :disabled="disabled || busy || atMax"
      :aria-label="`Increase ${resource.label}`"
      @click="emit('step', resource.id, 1)"
    >
      +
    </button>
  </div>
</template>

<script setup lang="ts">
import type { ResourceDescriptor } from '@companion/adapter-sdk'

const props = withDefaults(
  defineProps<{
    resource: ResourceDescriptor
    disabled?: boolean
    busy?: boolean
    compact?: boolean
  }>(),
  { disabled: false, busy: false, compact: false },
)

const emit = defineEmits<{ (e: 'step', resourceId: string, direction: 1 | -1): void }>()

const atMin = computed(
  () => props.resource.min !== undefined && props.resource.value <= props.resource.min,
)
const atMax = computed(
  () => props.resource.max !== undefined && props.resource.value >= props.resource.max,
)
</script>

<style scoped>
.stepper {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.step-btn {
  min-width: var(--tap);
  min-height: var(--tap);
  border-radius: 12px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text);
  transition: transform 0.06s ease;
}

.step-btn:active:not(:disabled) {
  transform: scale(0.94);
  background: var(--accent-soft);
}

.value {
  min-width: 56px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  transition: opacity 0.15s ease;
}

.value.busy {
  opacity: 0.4;
}

.value b {
  font-size: 1.05rem;
}

.max {
  color: var(--text-dim);
  font-size: 0.85rem;
}

.compact .value {
  min-width: 44px;
}

.compact .value b {
  font-size: 0.95rem;
}
</style>
