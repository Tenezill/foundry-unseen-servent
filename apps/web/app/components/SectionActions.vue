<template>
  <section v-for="group in groups" :key="group.id">
    <h2 class="section-title">{{ group.label }}</h2>
    <div v-if="group.id === 'spells'" class="filter-chips">
      <button
        v-for="chip in SPELL_FILTERS"
        :key="chip.id"
        type="button"
        class="chip"
        :class="{ active: spellFilter === chip.id }"
        @click="spellFilter = chip.id"
      >
        {{ chip.label }}
      </button>
    </div>
    <div class="list card">
      <div v-for="action in visibleActions(group)" :key="action.id" class="row">
        <span class="ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path :d="group.icon" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </span>
        <div class="row-main">
          <span class="row-label">{{ action.label }}</span>
          <span v-if="noSlots(action)" class="row-sub">No spell slots left</span>
        </div>
        <button
          class="act-btn"
          type="button"
          :class="{ pending: actionBusy === action.id }"
          :disabled="readonly || actionBusy !== null || noSlots(action)"
          @click="emit('action', action.id)"
        >
          {{ group.verb }}
        </button>
        <button
          v-if="group.id === 'attacks' && damageOf(action)"
          class="act-btn secondary"
          type="button"
          :class="{ pending: actionBusy === damageOf(action)?.id }"
          :disabled="readonly || actionBusy !== null"
          @click="emit('action', damageOf(action)!.id)"
        >
          Dmg
        </button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { ActionDescriptor } from '@companion/adapter-sdk'

const props = defineProps<{
  /** Pre-filtered attack/cast/use actions, in sheet order. */
  actions: ActionDescriptor[]
  actionBusy: string | null
  readonly: boolean
}>()

const emit = defineEmits<{
  (e: 'action', actionId: string): void
}>()

const GROUP_DEFS = [
  { id: 'attacks', label: 'Attacks', kind: 'attack', group: undefined, verb: 'Attack', icon: 'M14.5 3.5 21 10l-2 2-6.5-6.5ZM3 21l7-7M6.5 17.5 3 21' },
  { id: 'spells', label: 'Spells', kind: 'cast', group: undefined, verb: 'Cast', icon: 'M12 3l1.8 4.9L18.8 9l-4.9 1.8L12 15.7 10.2 10.8 5.2 9l5-1.1ZM18 15l.9 2.4 2.4.9-2.4.9L18 22l-.9-2.4-2.4-.9 2.4-.9Z' },
  { id: 'features', label: 'Features', kind: 'use', group: undefined, verb: 'Use', icon: 'M13 2 4 14h6l-1 8 9-12h-6z' },
  { id: 'items', label: 'Items', kind: 'use', group: 'items', verb: 'Use', icon: 'M10 2h4v3.2l2.5 4.2A6 6 0 0 1 12 22a6 6 0 0 1-4.5-12.6L10 5.2Z' },
] as const

/** Non-empty groups only — kind AND group hint must match. */
const groups = computed(() =>
  GROUP_DEFS.map((def) => ({
    ...def,
    actions: props.actions.filter((a) => a.kind === def.kind && a.group === def.group),
  })).filter((g) => g.actions.length > 0),
)

function noSlots(action: ActionDescriptor): boolean {
  return action.kind === 'cast' && action.slotLevels !== undefined && action.slotLevels.length === 0
}

/** Filter chips on the Spells list only (M15) — single-select, default All. */
const SPELL_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'damage', label: '⚔️ Atk' },
  { id: 'heal', label: '⚕️ Heal' },
  { id: 'utility', label: '⚙️ Util' },
] as const

const spellFilter = ref<(typeof SPELL_FILTERS)[number]['id']>('all')

function visibleActions(group: (typeof groups.value)[number]): ActionDescriptor[] {
  if (group.id !== 'spells' || spellFilter.value === 'all') return group.actions
  return group.actions.filter((a) => a.effectType === spellFilter.value)
}

/** 'damage' isn't its own group (see combatActions in [id].vue) — it rides
 *  along in `actions` so each attack row can find its companion roll. */
const damageById = computed(() => {
  const m = new Map<string, ActionDescriptor>()
  for (const a of props.actions) if (a.kind === 'damage') m.set(a.id, a)
  return m
})

function damageOf(action: ActionDescriptor): ActionDescriptor | undefined {
  return damageById.value.get(action.id.replace(/\.attack$/, '.damage'))
}
</script>

<style scoped>
.list {
  overflow: hidden;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  min-height: 60px;
}

.row + .row {
  border-top: 1px solid var(--line);
}

.ico {
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--gold) 16%, var(--panel-2));
  color: var(--gold-bright);
}

.ico svg {
  width: 18px;
  height: 18px;
}

.row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.row-label {
  font-weight: 600;
  font-size: 0.95rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-sub {
  font-size: 0.76rem;
  color: var(--ink-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.act-btn {
  flex: none;
  min-height: 36px;
  padding: 0 16px;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  border: 1px solid var(--gold-deep);
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  color: var(--accent-ink);
  box-shadow: 0 2px 8px color-mix(in srgb, var(--gold) 30%, transparent);
}

.act-btn.secondary {
  padding: 0 12px;
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--ink-dim);
  box-shadow: none;
}

.filter-chips {
  display: flex;
  gap: 8px;
  padding: 0 2px 10px;
  overflow-x: auto;
}

.chip {
  flex: none;
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 0.76rem;
  font-weight: 600;
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--ink-dim);
}

.chip.active {
  border-color: var(--gold-deep);
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  color: var(--accent-ink);
}

.act-btn:active:not(:disabled) {
  transform: scale(0.96);
}

.pending {
  opacity: 0.55;
}
</style>
