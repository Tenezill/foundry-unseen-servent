<template>
  <span class="pill" :data-state="state">
    <span class="dot" />
    {{ label }}
  </span>
</template>

<script setup lang="ts">
const props = defineProps<{ state: 'live' | 'reconnecting' | 'offline' }>()

const label = computed(() =>
  props.state === 'live' ? 'Live' : props.state === 'reconnecting' ? 'Reconnecting' : 'Offline',
)
</script>

<style scoped>
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--text-dim);
  white-space: nowrap;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-dim);
}

.pill[data-state='live'] .dot {
  background: var(--success);
  box-shadow: 0 0 0 3px var(--success-soft);
}

.pill[data-state='reconnecting'] .dot {
  background: var(--accent);
  animation: pulse 1.2s ease-in-out infinite;
}

.pill[data-state='offline'] .dot {
  background: var(--danger);
}

@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}
</style>
