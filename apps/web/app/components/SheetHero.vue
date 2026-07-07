<template>
  <section class="hero">
    <svg class="hero-grain" aria-hidden="true">
      <filter id="hero-grain-f">
        <feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" />
      </filter>
      <rect width="100%" height="100%" filter="url(#hero-grain-f)" />
    </svg>

    <ConnectionPill class="hero-live" :state="conn" />

    <svg class="corner tl" viewBox="0 0 46 46" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M4 22 Q4 4 22 4 M4 14 Q4 8 10 6 M12 4 Q18 4 20 9" /><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" /></svg>
    <svg class="corner tr" viewBox="0 0 46 46" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M4 22 Q4 4 22 4 M4 14 Q4 8 10 6 M12 4 Q18 4 20 9" /><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" /></svg>
    <svg class="corner bl" viewBox="0 0 46 46" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M4 22 Q4 4 22 4 M4 14 Q4 8 10 6 M12 4 Q18 4 20 9" /><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" /></svg>
    <svg class="corner br" viewBox="0 0 46 46" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M4 22 Q4 4 22 4 M4 14 Q4 8 10 6 M12 4 Q18 4 20 9" /><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" /></svg>

    <div class="hero-top">
      <div class="medallion">
        <svg class="ring" viewBox="0 0 92 92" fill="none" aria-hidden="true">
          <circle cx="46" cy="46" r="44" stroke="currentColor" stroke-width="2" />
          <circle cx="46" cy="46" r="39" stroke="currentColor" stroke-width="1" opacity=".6" />
          <g fill="currentColor"><circle cx="46" cy="3" r="2.4" /><circle cx="46" cy="89" r="2.4" /><circle cx="3" cy="46" r="2.4" /><circle cx="89" cy="46" r="2.4" /></g>
        </svg>
        <div class="art">
          <img v-if="portrait && !imgFailed" :src="portrait" :alt="sheet.name" @error="imgFailed = true" />
          <span v-else class="glyph" aria-hidden="true">{{ glyph }}</span>
        </div>
      </div>
      <div class="name-block">
        <h1 class="charname">{{ sheet.name }}</h1>
        <div class="subtitle">
          <b>{{ subtitle }}</b>
        </div>
      </div>
    </div>

    <div v-if="hp" class="hp">
      <div class="hp-head">
        <span class="lab">Hit Points</span>
        <span class="hp-val tabular">
          <span class="cur" :data-down="hp.value <= 0">{{ hp.value }}</span>
          <span v-if="hp.max !== undefined" class="max"> / {{ hp.max }}</span>
          <span v-if="tempHp > 0" class="temp">+{{ tempHp }} temp</span>
        </span>
      </div>
      <div class="bar"><span :style="{ '--pct': hpPct + '%' }" /></div>
      <div class="hp-actions">
        <button class="dmg" type="button" :disabled="readonly" @click="emit('numpad', 'hp')">− Damage</button>
        <button class="heal" type="button" :disabled="readonly" @click="emit('numpad', 'hp')">+ Heal</button>
      </div>
    </div>

    <div v-if="cluster.length" class="cluster tabular">
      <div v-for="stat in cluster" :key="stat.id" class="stat" :class="{ shield: stat.id === 'ac' }">
        <svg v-if="stat.id === 'ac'" viewBox="0 0 40 44" fill="currentColor" aria-hidden="true"><path d="M20 2 L36 8 V22 C36 33 29 39 20 42 C11 39 4 33 4 22 V8 Z" /></svg>
        <div class="big">{{ stat.value }}</div>
        <div class="cap">{{ stat.label }}</div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { ResourceDescriptor, SheetViewModel, Stat } from '@companion/adapter-sdk'

const props = defineProps<{
  sheet: SheetViewModel
  conn: 'live' | 'reconnecting' | 'offline'
  readonly: boolean
}>()

const emit = defineEmits<{ (e: 'numpad', resourceId: string): void }>()

const config = useRuntimeConfig()
const foundryBase = String(config.public.foundryBase || '')

const imgFailed = ref(false)
watch(
  () => props.sheet.img,
  () => {
    imgFailed.value = false
  },
)

const portrait = computed(() => foundryImgUrl(props.sheet.img, foundryBase))

const isCaster = computed(() => props.sheet.sections.some((s) => s.id === 'spells'))
const glyph = computed(() => (isCaster.value ? '✦' : '⚔'))

/** Class/level line for the subtitle (falls back to the system id). */
const subtitle = computed(() => {
  const cls = props.sheet.headline.find((s) => s.id === 'class')
  if (cls) return String(cls.value)
  return props.sheet.systemId
})

const hp = computed<ResourceDescriptor | undefined>(() =>
  props.sheet.resources.find((r) => r.id === 'hp'),
)
const tempHp = computed(() => props.sheet.resources.find((r) => r.id === 'hp.temp')?.value ?? 0)
const hpPct = computed(() => {
  const h = hp.value
  if (!h || h.max === undefined || h.max <= 0) return 0
  return Math.max(0, Math.min(100, (h.value / h.max) * 100))
})

/** The vitals cluster: every headline stat except the class/level line. */
const cluster = computed<Stat[]>(() => props.sheet.headline.filter((s) => s.id !== 'class'))
</script>

<style scoped>
.hero {
  position: relative;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--panel) 92%, var(--gold)) 0%,
    var(--panel) 42%
  );
  padding: 20px 18px 18px;
  overflow: hidden;
  box-shadow: 0 10px 30px var(--shadow);
}

.hero-grain {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0.05;
  pointer-events: none;
  mix-blend-mode: overlay;
}

.hero-live {
  position: absolute;
  top: 14px;
  right: 14px;
  z-index: 2;
}

.corner {
  position: absolute;
  width: 44px;
  height: 44px;
  color: var(--gold);
  opacity: 0.8;
  pointer-events: none;
}
.corner.tl { top: 6px; left: 6px; }
.corner.tr { top: 6px; right: 6px; transform: scaleX(-1); }
.corner.bl { bottom: 6px; left: 6px; transform: scaleY(-1); }
.corner.br { bottom: 6px; right: 6px; transform: scale(-1, -1); }

.hero-top {
  display: flex;
  gap: 16px;
  align-items: center;
  position: relative;
  padding-right: 56px;
}

.medallion {
  flex: none;
  width: 88px;
  height: 88px;
  position: relative;
}

.ring {
  position: absolute;
  inset: 0;
  color: var(--gold);
}

.art {
  position: absolute;
  inset: 9px;
  border-radius: 50%;
  background: radial-gradient(circle at 38% 32%, #40506b, #1a2233 70%);
  display: grid;
  place-items: center;
  overflow: hidden;
  box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.6);
}

.art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.glyph {
  font-size: 38px;
  color: var(--gold-bright);
  filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.5));
}

.name-block {
  min-width: 0;
}

.charname {
  font-family: var(--serif);
  font-size: 1.7rem;
  line-height: 1.05;
  margin: 0 0 4px;
  letter-spacing: 0.01em;
  text-wrap: balance;
  color: var(--ink);
}

.subtitle {
  color: var(--ink-dim);
  font-size: 0.9rem;
}
.subtitle b {
  color: var(--gold-bright);
  font-weight: 600;
}

/* ---- HP garnet meter ---- */
.hp {
  margin-top: 18px;
  background: color-mix(in srgb, var(--panel-2) 70%, transparent);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px 14px;
}
.hp-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 8px;
}
.hp-head .lab {
  font-size: 0.7rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ink-dim);
}
.hp-val {
  font-size: 1.05rem;
}
.hp-val .cur {
  font-size: 1.6rem;
  font-weight: 700;
  color: var(--ink);
}
.hp-val .cur[data-down='true'] {
  color: var(--garnet);
}
.hp-val .max {
  color: var(--ink-faint);
}
.hp-val .temp {
  color: var(--jade);
  font-weight: 600;
  font-size: 0.95rem;
  margin-left: 8px;
}
.bar {
  height: 10px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--garnet-deep) 55%, var(--bg));
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--garnet-deep) 70%, var(--line));
}
.bar > span {
  display: block;
  height: 100%;
  width: var(--pct, 0%);
  background: linear-gradient(90deg, var(--garnet-deep), var(--garnet));
  box-shadow: 0 0 12px color-mix(in srgb, var(--garnet) 60%, transparent);
  transition: width 0.4s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.hp-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.hp-actions button {
  flex: 1;
  min-height: var(--tap);
  border-radius: 9px;
  font-weight: 700;
  font-size: 0.82rem;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--ink);
  letter-spacing: 0.02em;
}
.hp-actions button:active:not(:disabled) {
  transform: scale(0.97);
}
.hp-actions .dmg {
  border-color: color-mix(in srgb, var(--garnet) 50%, var(--line));
  color: var(--garnet);
}
.hp-actions .heal {
  border-color: color-mix(in srgb, var(--jade) 50%, var(--line));
  color: var(--jade);
}

/* ---- vitals cluster ---- */
.cluster {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-top: 12px;
}
.stat {
  position: relative;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 11px;
  padding: 10px 4px 8px;
  text-align: center;
}
.stat .big {
  font-size: 1.35rem;
  font-weight: 700;
}
.stat .cap {
  font-size: 0.56rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-faint);
  margin-top: 2px;
}
.shield svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  color: var(--gold);
  opacity: 0.16;
}
.shield .big {
  position: relative;
  color: var(--gold-bright);
}
</style>
