<template>
  <div class="dice-tray">
    <transition name="tray">
      <div v-if="open" class="panel card" role="dialog" aria-label="Roll dice">
        <div class="head">
          <span class="title">Roll Dice</span>
          <button class="x" type="button" aria-label="Close" @click="open = false">✕</button>
        </div>

        <p class="pool" :class="{ empty: !hasDice && modifier === 0 }">
          {{ hasDice || modifier !== 0 ? formula : 'Tap dice to build a roll' }}
        </p>

        <div v-if="lastResult" class="result">
          <span class="r-formula">{{ lastResult.formula }}</span>
          <span class="r-total">{{ lastResult.total }}</span>
        </div>

        <div class="grid">
          <button v-for="d in DICE" :key="d" type="button" class="die" @click="add(d)">
            d{{ d }}
            <span v-if="counts[d]" class="badge">{{ counts[d] }}</span>
          </button>
        </div>

        <div class="mod">
          <span class="mod-label">Modifier</span>
          <button type="button" class="step" aria-label="Decrease modifier" @click="modifier--">−</button>
          <span class="mod-val tabular">{{ modifier >= 0 ? '+' : '−' }}{{ Math.abs(modifier) }}</span>
          <button type="button" class="step" aria-label="Increase modifier" @click="modifier++">+</button>
        </div>

        <div class="acts">
          <button type="button" class="btn ghost" :disabled="!hasDice && modifier === 0" @click="clearPool">Clear</button>
          <button type="button" class="btn roll" :disabled="!hasDice || busy || readonly" @click="roll">
            {{ busy ? 'Rolling…' : 'Roll' }}
          </button>
        </div>
      </div>
    </transition>

    <button class="fab" type="button" :aria-label="open ? 'Close dice tray' : 'Open dice tray'" @click="open = !open">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <path d="M12 2 21 7v10l-9 5-9-5V7z" stroke-linejoin="round" />
        <path d="M12 12v10M3 7l9 5 9-5" stroke-linejoin="round" opacity="0.55" />
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ actorId: string; readonly?: boolean }>()

const DICE = [20, 12, 100, 10, 8, 6, 4] as const
const counts = reactive<Record<number, number>>({})
const modifier = ref(0)
const open = ref(false)
const busy = ref(false)
const lastResult = ref<{ formula: string; total: number } | null>(null)

const { api } = useApi()
const toast = useToast()

const hasDice = computed(() => DICE.some((d) => (counts[d] ?? 0) > 0))

const formula = computed(() => {
  const terms = DICE.filter((d) => (counts[d] ?? 0) > 0).map((d) => `${counts[d]}d${d}`)
  let f = terms.join(' + ')
  if (modifier.value > 0) f += `${f ? ' + ' : ''}${modifier.value}`
  else if (modifier.value < 0) f += `${f ? ' - ' : '-'}${Math.abs(modifier.value)}`
  return f
})

function add(d: number): void {
  counts[d] = (counts[d] ?? 0) + 1
}

function clearPool(): void {
  for (const d of DICE) counts[d] = 0
  modifier.value = 0
  lastResult.value = null
}

async function roll(): Promise<void> {
  if (!hasDice.value || busy.value) return
  busy.value = true
  try {
    const res = await api<{ result: { formula: string; total: number } | null }>(
      `/api/actors/${props.actorId}/roll`,
      { method: 'POST', body: { formula: formula.value, flavor: 'Dice roll' } },
    )
    if (res.result) {
      lastResult.value = res.result
      toast.show(`🎲 ${res.result.formula} = ${res.result.total}`)
    } else {
      toast.show('Rolled — see Foundry')
    }
  } catch (err) {
    if (errorStatus(err) === 401) {
      clearToken()
      await navigateTo('/join', { replace: true })
      return
    }
    toast.show('Roll didn’t go through. Try again.')
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.dice-tray {
  position: fixed;
  left: 14px;
  bottom: calc(84px + env(safe-area-inset-bottom, 0px));
  z-index: 60;
}

.fab {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  border: 1px solid var(--gold-deep);
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  color: var(--accent-ink);
  box-shadow: 0 6px 18px color-mix(in srgb, var(--gold) 34%, transparent);
}

.fab svg {
  width: 26px;
  height: 26px;
}

.fab:active {
  transform: scale(0.94);
}

.panel {
  position: absolute;
  left: 0;
  bottom: 62px;
  width: min(84vw, 300px);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.title {
  font-weight: 800;
  font-size: 0.95rem;
}

.x {
  color: var(--ink-dim);
  font-size: 1rem;
  padding: 4px;
}

.pool {
  font-weight: 700;
  font-size: 0.95rem;
  min-height: 1.2em;
  text-align: center;
}

.pool.empty {
  color: var(--ink-dim);
  font-weight: 500;
  font-size: 0.85rem;
}

.result {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--gold) 14%, var(--panel-2));
  border: 1px solid var(--gold-deep);
}

.r-formula {
  font-size: 0.82rem;
  color: var(--ink-dim);
}

.r-total {
  font-weight: 800;
  font-size: 1.3rem;
  color: var(--gold-bright);
}

.grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.die {
  position: relative;
  aspect-ratio: 1;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--ink);
  font-weight: 700;
  font-size: 0.82rem;
}

.die:active {
  transform: scale(0.94);
  border-color: var(--gold-deep);
}

.badge {
  position: absolute;
  top: -6px;
  right: -6px;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 999px;
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  color: var(--accent-ink);
  font-size: 0.7rem;
  font-weight: 800;
  display: grid;
  place-items: center;
}

.mod {
  display: flex;
  align-items: center;
  gap: 10px;
}

.mod-label {
  flex: 1;
  font-size: 0.82rem;
  color: var(--ink-dim);
}

.step {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--ink);
  font-size: 1.1rem;
  font-weight: 700;
}

.mod-val {
  min-width: 34px;
  text-align: center;
  font-weight: 800;
}

.acts {
  display: flex;
  gap: 8px;
}

.btn {
  flex: 1;
  min-height: 40px;
  border-radius: 999px;
  font-weight: 800;
  font-size: 0.82rem;
}

.btn.ghost {
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--ink-dim);
}

.btn.roll {
  border: 1px solid var(--gold-deep);
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  color: var(--accent-ink);
}

.btn:disabled {
  opacity: 0.5;
}

.btn:active:not(:disabled) {
  transform: scale(0.97);
}

.tray-enter-active,
.tray-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.tray-enter-from,
.tray-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
