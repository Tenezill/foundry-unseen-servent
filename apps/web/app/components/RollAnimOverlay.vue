<template>
  <div class="anim-wrap" aria-hidden="true">
    <div class="die-stage">
      <svg class="die" :class="{ settled, crit: settled && result?.isCritical, fumble: settled && result?.isFumble }" viewBox="0 0 100 100">
        <polygon
          class="face"
          points="50,4 89,26 89,74 50,96 11,74 11,26"
          stroke-linejoin="round"
        />
        <polygon
          class="facet"
          points="50,22 74,36 74,64 50,78 26,64 26,36"
          stroke-linejoin="round"
        />
      </svg>
      <span class="number tabular" :class="{ settled }">{{ shown }}</span>
    </div>
    <span class="anim-label">{{ label }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ActionRollResult } from '~/types/api'

const props = defineProps<{
  label: string
  /** null while the server is still rolling; the final roll once known. */
  result: ActionRollResult | null
}>()

/** Suspense digits cycle while result is null; the real total shows after. */
const cycling = ref(1)
let timer: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  timer = setInterval(() => {
    cycling.value = 1 + Math.floor(Math.random() * 20)
  }, 90)
})

onBeforeUnmount(() => {
  if (timer !== undefined) clearInterval(timer)
})

const settled = computed(() => props.result !== null)
const shown = computed(() => (props.result ? props.result.total : cycling.value))
</script>

<style scoped>
.anim-wrap {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  pointer-events: none;
  background: color-mix(in srgb, var(--bg) 45%, transparent);
  backdrop-filter: blur(2px);
  animation: anim-in 0.15s ease-out;
}

@keyframes anim-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.die-stage {
  position: relative;
  width: 110px;
  height: 110px;
  display: grid;
  place-items: center;
  filter: drop-shadow(0 12px 28px var(--shadow));
}

.die {
  position: absolute;
  inset: 0;
  animation: die-tumble 0.55s linear infinite;
}

.die .face {
  fill: var(--panel);
  stroke: var(--gold);
  stroke-width: 3;
}

.die .facet {
  fill: color-mix(in srgb, var(--gold) 12%, var(--panel));
  stroke: color-mix(in srgb, var(--gold) 45%, transparent);
  stroke-width: 1.5;
}

.die.settled {
  animation: die-settle 0.35s ease-out both;
}

.die.settled.crit .face {
  stroke: var(--gold-bright);
  fill: color-mix(in srgb, var(--gold) 22%, var(--panel));
}

.die.settled.fumble .face {
  stroke: var(--garnet);
  fill: color-mix(in srgb, var(--garnet) 16%, var(--panel));
}

@keyframes die-tumble {
  0% {
    transform: rotate(0deg) scale(1);
  }
  25% {
    transform: rotate(90deg) scale(0.92);
  }
  50% {
    transform: rotate(180deg) scale(1.04);
  }
  75% {
    transform: rotate(270deg) scale(0.94);
  }
  100% {
    transform: rotate(360deg) scale(1);
  }
}

@keyframes die-settle {
  0% {
    transform: rotate(-18deg) scale(1.14);
  }
  60% {
    transform: rotate(6deg) scale(0.97);
  }
  100% {
    transform: rotate(0deg) scale(1);
  }
}

.number {
  position: relative;
  font-size: 2rem;
  font-weight: 800;
  color: var(--ink-dim);
  transition: color 0.15s ease-out;
}

.number.settled {
  color: var(--gold-bright);
  animation: num-pop 0.3s ease-out;
}

@keyframes num-pop {
  0% {
    transform: scale(0.6);
  }
  70% {
    transform: scale(1.18);
  }
  100% {
    transform: scale(1);
  }
}

.anim-label {
  font-size: 0.85rem;
  font-weight: 700;
  color: var(--ink-dim);
  letter-spacing: 0.04em;
}
</style>
