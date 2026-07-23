<template>
  <div class="carousel" role="group" aria-label="Turn order">
    <div class="round chip">
      <span class="chip-value tabular">{{ round ?? '–' }}</span>
      <span class="chip-label">Round</span>
    </div>
    <div class="track">
      <div
        v-for="c in windowCombatants"
        :key="c.id"
        class="slot"
        :class="[c.health ? `health-${c.health}` : '', { current: c.id === turnCombatantId, own: c.actorId === actorId }]"
      >
        <div class="medallion">
          <ActorAvatar :name="c.name" :img="foundryImgUrl(c.img, foundryBase)" :size="52" />
          <span v-if="c.actorId === actorId" class="own-mark" aria-hidden="true">★</span>
        </div>
        <span class="init tabular">{{ c.initiative ?? '–' }}</span>
        <span class="name">{{ c.name }}</span>
        <span v-if="c.isPC && c.hp" class="hp-cap tabular">{{ c.hp.value }}/{{ c.hp.max }}</span>
      </div>
    </div>

    <button v-if="canEndTurn" type="button" class="end-turn" @click="emit('endTurn')">
      End turn <span aria-hidden="true">▸</span>
    </button>
    <button type="button" class="collapse-btn" aria-label="Hide turn order" @click="emit('collapse')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="m6 9 6 6 6-6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import type { EncounterCombatantView } from '~/types/api'

const props = defineProps<{
  combatants: EncounterCombatantView[]
  round?: number
  turnCombatantId: string | null
  actorId: string
  /** True when the viewing actor is the acting combatant (2026-07-22 turn
   *  flow) — shows the compact "End turn" button at the carousel's edge. */
  canEndTurn: boolean
}>()

const emit = defineEmits<{
  (e: 'endTurn'): void
  (e: 'collapse'): void
}>()

const config = useRuntimeConfig()
const foundryBase = String(config.public.foundryBase || '')

/** Current combatant + next 4, wrapping the initiative-desc list; never more
 *  slots than combatants (so a short roster doesn't repeat itself). */
const windowCombatants = computed(() => {
  const list = props.combatants
  if (list.length === 0) return []
  const startIdx = Math.max(0, list.findIndex((c) => c.id === props.turnCombatantId))
  const count = Math.min(5, list.length)
  const out: EncounterCombatantView[] = []
  for (let i = 0; i < count; i++) out.push(list[(startIdx + i) % list.length]!)
  return out
})
</script>

<style scoped>
.carousel {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.round {
  flex: none;
}

.track {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 10px;
  overflow-x: auto;
  padding: 4px 2px;
  scrollbar-width: none;
}

.track::-webkit-scrollbar {
  display: none;
}

.slot {
  flex: none;
  width: 64px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  text-align: center;
}

.medallion {
  position: relative;
}

.own-mark {
  position: absolute;
  top: -4px;
  right: -4px;
  font-size: 0.7rem;
  color: var(--gold-bright);
  filter: drop-shadow(0 1px 2px var(--shadow));
}

.slot.current .medallion :deep(.avatar) {
  box-shadow: 0 0 0 3px var(--gold-bright), 0 0 12px color-mix(in srgb, var(--gold) 60%, transparent);
}

.slot.health-wounded .medallion :deep(.avatar) {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--garnet) 55%, transparent);
}

.slot.health-bloodied .medallion :deep(.avatar) {
  box-shadow: 0 0 0 2px var(--garnet);
}

.slot.health-down .medallion :deep(.avatar) {
  box-shadow: 0 0 0 2px var(--garnet-deep);
  filter: grayscale(70%);
  opacity: 0.7;
}

.slot.current.health-wounded .medallion :deep(.avatar),
.slot.current.health-bloodied .medallion :deep(.avatar),
.slot.current.health-down .medallion :deep(.avatar) {
  box-shadow: 0 0 0 3px var(--gold-bright), 0 0 12px color-mix(in srgb, var(--gold) 60%, transparent);
}

.init {
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--ink-dim);
}

.name {
  font-size: 0.68rem;
  font-weight: 600;
  color: var(--ink);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hp-cap {
  font-size: 0.6rem;
  color: var(--ink-faint);
}

/* ---- end-turn button (2026-07-22) ---- */

.end-turn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-height: 32px;
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0.02em;
  white-space: nowrap;
  border: 1px solid var(--gold-deep);
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  color: var(--accent-ink);
  box-shadow: 0 2px 8px color-mix(in srgb, var(--gold) 30%, transparent);
}

.end-turn:active {
  transform: scale(0.95);
}

/* ---- collapse button (2026-07-23) ---- */

.collapse-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 999px;
  color: var(--ink-faint);
}

.collapse-btn svg {
  width: 18px;
  height: 18px;
}

.collapse-btn:active {
  color: var(--gold);
  transform: scale(0.95);
}
</style>
