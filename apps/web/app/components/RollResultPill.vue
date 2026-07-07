<template>
  <div class="pill-wrap">
    <button
      class="pill card"
      type="button"
      :class="{ crit: result.isCritical, fumble: result.isFumble }"
      aria-live="assertive"
      @click="emit('dismiss')"
    >
      <span class="total-wrap">
        <span v-if="result.isCritical || result.isFumble" class="burst" aria-hidden="true" />
        <span class="total tabular">{{ result.total }}</span>
      </span>
      <span class="body">
        <span class="label">
          {{ label }}
          <span v-if="result.isCritical" class="flag">Critical!</span>
          <span v-else-if="result.isFumble" class="flag">Fumble</span>
        </span>
        <span class="formula tabular">{{ result.formula }}</span>
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
  box-shadow: 0 10px 30px var(--shadow);
  animation: pill-up 0.18s ease-out;
}

.pill.crit {
  border-color: color-mix(in srgb, var(--gold) 60%, var(--line));
  background: linear-gradient(180deg, color-mix(in srgb, var(--gold) 16%, var(--panel)), var(--panel));
}

.pill.fumble {
  border-color: color-mix(in srgb, var(--garnet) 55%, var(--line));
  background: linear-gradient(180deg, color-mix(in srgb, var(--garnet) 14%, var(--panel)), var(--panel));
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

.total-wrap {
  position: relative;
  display: grid;
  place-items: center;
  min-width: 44px;
}

.burst {
  position: absolute;
  inset: -8px;
  border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--gold) 55%, transparent), transparent 68%);
  animation: burst 0.5s ease-out both;
}

.pill.fumble .burst {
  background: radial-gradient(circle, color-mix(in srgb, var(--garnet) 55%, transparent), transparent 68%);
}

@keyframes burst {
  from {
    transform: scale(0.4);
    opacity: 0.9;
  }
  to {
    transform: scale(1.15);
    opacity: 0;
  }
}

.total {
  position: relative;
  font-size: 2rem;
  font-weight: 800;
  color: var(--gold-bright);
  text-align: center;
}

.pill.crit .total {
  color: var(--gold-bright);
}

.pill.fumble .total {
  color: var(--garnet);
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
  color: var(--gold-bright);
}

.pill.fumble .flag {
  color: var(--garnet);
}

.formula {
  font-size: 0.78rem;
  color: var(--ink-dim);
}

.note {
  font-size: 0.7rem;
  color: var(--ink-faint);
}
</style>
