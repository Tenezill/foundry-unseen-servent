<template>
  <div class="prep">
    <div class="prep-text">
      <span class="lab">Prepared</span>
      <span class="tally tabular" :class="{ over }">
        <span class="cur">{{ prepared }}</span>
        <span class="sep">/</span>
        <span class="max">{{ denom }}</span>
      </span>
    </div>
    <div class="prep-adjust">
      <button
        class="step"
        type="button"
        aria-label="Lower prepared limit"
        @click="bump(-1)"
      >
        −
      </button>
      <button
        class="step"
        type="button"
        aria-label="Raise prepared limit"
        @click="bump(1)"
      >
        +
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  prepared: number
  base: number
  actorId: string
}>()

const storageKey = computed(() => `fc:prepoffset:${props.actorId}`)
const offset = ref(0)

onMounted(() => {
  try {
    const raw = localStorage.getItem(storageKey.value)
    if (raw !== null) {
      const n = Number.parseInt(raw, 10)
      if (Number.isFinite(n)) offset.value = n
    }
  } catch {
    /* private mode — default offset 0 */
  }
})

const denom = computed(() => Math.max(0, props.base + offset.value))
const over = computed(() => props.prepared > denom.value)

function bump(delta: number): void {
  offset.value += delta
  try {
    localStorage.setItem(storageKey.value, String(offset.value))
  } catch {
    /* noop */
  }
}
</script>

<style scoped>
.prep {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  padding: 10px 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: color-mix(in srgb, var(--panel-2) 70%, transparent);
}

.prep-text {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.lab {
  font-size: 0.7rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ink-dim);
}

.tally {
  font-size: 1.2rem;
  font-weight: 700;
  color: var(--ink);
}

.tally .cur {
  color: var(--gold-bright);
}

.tally .sep,
.tally .max {
  color: var(--ink-faint);
}

.tally.over .cur {
  color: var(--garnet);
}

.prep-adjust {
  display: flex;
  gap: 6px;
}

.step {
  min-width: var(--tap);
  min-height: var(--tap);
  border-radius: 9px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--ink);
  font-size: 1.1rem;
  font-weight: 700;
  line-height: 1;
}

.step:active {
  transform: scale(0.95);
}
</style>
