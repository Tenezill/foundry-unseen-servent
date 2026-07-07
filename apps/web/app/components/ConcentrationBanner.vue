<template>
  <div class="conc" role="status">
    <svg class="swirl" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <path d="M12 3a6 6 0 0 1 6 6c0 4-6 12-6 12S6 13 6 9a6 6 0 0 1 6-6Z" />
      <circle cx="12" cy="9" r="2" />
    </svg>
    <div class="body">
      <span class="lab">Concentrating</span>
      <span class="spell">{{ label }}</span>
    </div>
    <button class="end" type="button" :disabled="busy || readonly" @click="emit('end')">
      {{ busy ? '…' : 'End' }}
    </button>
  </div>
</template>

<script setup lang="ts">
defineProps<{ label: string; busy: boolean; readonly: boolean }>()
const emit = defineEmits<{ (e: 'end'): void }>()
</script>

<style scoped>
.conc {
  position: sticky;
  top: calc(6px + var(--safe-top));
  z-index: 25;
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 0 0;
  padding: 10px 12px 10px 14px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--gold) 40%, var(--line));
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--gold) 18%, var(--panel)),
    var(--panel)
  );
  box-shadow: 0 6px 20px var(--shadow);
}

.swirl {
  flex: none;
  width: 24px;
  height: 24px;
  color: var(--gold);
}

.body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.lab {
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--gold);
}

.spell {
  font-family: var(--serif);
  font-size: 1rem;
  font-weight: 700;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.end {
  flex: none;
  min-height: 36px;
  padding: 0 16px;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: var(--garnet);
  background: color-mix(in srgb, var(--garnet) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--garnet) 40%, var(--line));
}

.end:active:not(:disabled) {
  transform: scale(0.96);
}
</style>
