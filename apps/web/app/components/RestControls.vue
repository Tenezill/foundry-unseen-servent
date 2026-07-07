<template>
  <div class="rest card">
    <div class="rest-lab">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <path d="M3 12h6l2-3 2 6 2-3h6" />
      </svg>
      Rest &amp; Recovery
    </div>
    <div class="rest-btns">
      <button
        v-if="hasShort"
        class="rest-btn short"
        type="button"
        :class="{ pending: busy === 'rest.short' }"
        :disabled="readonly || busy !== null"
        @click="emit('rest', 'short')"
      >
        Short Rest
      </button>
      <button
        v-if="hasLong"
        class="rest-btn long"
        type="button"
        :class="{ pending: busy === 'rest.long' }"
        :disabled="readonly || busy !== null"
        @click="emit('rest', 'long')"
      >
        Long Rest
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  hasShort: boolean
  hasLong: boolean
  busy: string | null
  readonly: boolean
}>()

const emit = defineEmits<{ (e: 'rest', kind: 'short' | 'long'): void }>()
</script>

<style scoped>
.rest {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  margin-top: 4px;
}

.rest-lab {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--serif);
  font-size: 0.86rem;
  font-weight: 700;
  color: var(--ink);
}

.rest-lab svg {
  width: 20px;
  height: 20px;
  color: var(--gold);
  flex: none;
}

.rest-btns {
  display: flex;
  gap: 8px;
  flex: none;
}

.rest-btn {
  min-height: 38px;
  padding: 0 14px;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 700;
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--ink);
}

.rest-btn.long {
  border-color: var(--gold-deep);
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  color: var(--accent-ink);
}

.rest-btn:active:not(:disabled) {
  transform: scale(0.96);
}

.pending {
  opacity: 0.55;
}
</style>
