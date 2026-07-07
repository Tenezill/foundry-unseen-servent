<template>
  <section class="wallet card">
    <h2 class="wallet-title">Wallet</h2>
    <div class="coins">
      <div v-for="coin in coins" :key="coin.res.id" class="coin">
        <span class="denom" :class="coin.tone">{{ coin.denom }}</span>
        <span class="amt tabular">{{ coin.res.value }}</span>
        <div class="adj">
          <button
            type="button"
            aria-label="Decrease"
            :disabled="readonly || busy !== null || atMin(coin.res)"
            @click="emit('step', coin.res.id, -1)"
          >
            −
          </button>
          <button
            type="button"
            aria-label="Increase"
            :disabled="readonly || busy !== null"
            @click="emit('step', coin.res.id, 1)"
          >
            +
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { ResourceDescriptor } from '@companion/adapter-sdk'

const props = defineProps<{
  resources: ResourceDescriptor[]
  busy: string | null
  readonly: boolean
}>()

const emit = defineEmits<{ (e: 'step', resourceId: string, direction: 1 | -1): void }>()

const ORDER = ['pp', 'gp', 'ep', 'sp', 'cp']
const TONE: Record<string, string> = { pp: 'pp', gp: 'gp', ep: 'ep', sp: 'sp', cp: 'cp' }

const coins = computed(() =>
  props.resources
    .map((res) => {
      const denom = res.id.split('.').pop() ?? res.id
      return { res, denom: denom.toUpperCase(), tone: TONE[denom] ?? 'gp', order: ORDER.indexOf(denom) }
    })
    .sort((a, b) => (a.order < 0 ? 99 : a.order) - (b.order < 0 ? 99 : b.order)),
)

function atMin(res: ResourceDescriptor): boolean {
  return res.min !== undefined && res.value <= res.min
}
</script>

<style scoped>
.wallet {
  padding: 14px;
}

.wallet-title {
  font-family: var(--serif);
  font-size: 0.86rem;
  font-weight: 700;
  color: var(--ink);
  margin-bottom: 12px;
}

.coins {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(84px, 1fr));
  gap: 8px;
}

.coin {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 10px 6px;
  border-radius: 11px;
  background: var(--panel-2);
  border: 1px solid var(--line);
}

.denom {
  font-size: 0.6rem;
  font-weight: 800;
  letter-spacing: 0.1em;
}
.denom.pp { color: var(--ink-dim); }
.denom.gp { color: var(--gold-bright); }
.denom.ep { color: var(--jade); }
.denom.sp { color: var(--ink-dim); }
.denom.cp { color: var(--garnet); }

.amt {
  font-size: 1.25rem;
  font-weight: 700;
}

.adj {
  display: flex;
  gap: 6px;
}

.adj button {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: var(--panel);
  border: 1px solid var(--line);
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--ink);
}

.adj button:active:not(:disabled) {
  transform: scale(0.94);
  background: var(--accent-soft);
}
</style>
