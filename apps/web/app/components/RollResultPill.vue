<template>
  <div class="pill-wrap">
    <button
      class="pill card"
      type="button"
      :class="{ crit: result.isCritical, fumble: result.isFumble }"
      aria-live="assertive"
      @click="emit('dismiss')"
    >
      <span class="total">{{ result.total }}</span>
      <span class="body">
        <span class="label">
          {{ label }}
          <span v-if="result.isCritical" class="flag">Critical!</span>
          <span v-else-if="result.isFumble" class="flag">Fumble</span>
        </span>
        <span class="formula">{{ result.formula }}</span>
        <span class="note">Also posted to Foundry chat</span>
      </span>
    </button>
  </div>
</template>

<script setup lang="ts">
import type { ActionRollResult } from '~/types/api'

defineProps<{ result: ActionRollResult; label: string }>()

const emit = defineEmits<{ (e: 'dismiss'): void }>()
</script>

<style scoped>
.pill-wrap {
  position: fixed;
  left: 0;
  right: 0;
  bottom: calc(84px + var(--safe-bottom));
  z-index: 70;
  display: flex;
  justify-content: center;
  padding: 0 16px;
  pointer-events: none;
}

.pill {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 18px;
  border-radius: 18px;
  max-width: 100%;
  text-align: left;
  box-shadow: var(--shadow);
  animation: pill-up 0.18s ease-out;
}

@keyframes pill-up {
  from {
    transform: translateY(10px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.total {
  font-size: 2rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  color: var(--accent);
  min-width: 44px;
  text-align: center;
}

.pill.crit .total {
  color: var(--success);
}

.pill.fumble .total {
  color: var(--danger);
}

.body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.label {
  font-weight: 700;
  font-size: 0.92rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.flag {
  margin-left: 6px;
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.pill.crit .flag {
  color: var(--success);
}

.pill.fumble .flag {
  color: var(--danger);
}

.formula {
  font-size: 0.78rem;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.note {
  font-size: 0.7rem;
  color: var(--text-dim);
}
</style>
