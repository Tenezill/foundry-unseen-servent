<template>
  <div class="scrim" @click.self="emit('close')">
    <div class="modal-sheet" role="dialog" aria-modal="true" :aria-label="action.label">
      <div class="head">
        <span class="title">{{ action.label }}</span>
        <span class="note">Rolls in Foundry as your character</span>
      </div>

      <div v-if="action.kind === 'check' || action.kind === 'save' || action.kind === 'attack'" class="options">
        <button class="opt" type="button" :disabled="busy" @click="roll()">Roll</button>
        <button class="opt adv" type="button" :disabled="busy" @click="roll('advantage')">
          Advantage
        </button>
        <button class="opt dis" type="button" :disabled="busy" @click="roll('disadvantage')">
          Disadvantage
        </button>
      </div>

      <div v-else-if="action.kind === 'cast'" class="options">
        <button
          v-if="action.slotLevels === undefined"
          class="opt"
          type="button"
          :disabled="busy"
          @click="cast()"
        >
          Cast
        </button>
        <template v-else>
          <button
            v-for="lvl in action.slotLevels"
            :key="lvl"
            class="opt"
            type="button"
            :disabled="busy"
            @click="cast(lvl)"
          >
            Cast at {{ ordinal(lvl) }} level{{ props.slotsLeft?.[lvl] !== undefined ? ` · ${props.slotsLeft[lvl]} left` : '' }}
          </button>
          <p v-if="action.slotLevels.length === 0" class="none">
            No spell slots left for this spell.
          </p>
        </template>
      </div>

      <button class="cancel" type="button" @click="emit('close')">Cancel</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ActionDescriptor, ActionIntent } from '@companion/adapter-sdk'

const props = defineProps<{ action: ActionDescriptor; busy: boolean; slotsLeft?: Record<number, number> }>()

const emit = defineEmits<{
  (e: 'submit', intent: ActionIntent): void
  (e: 'close'): void
}>()

function roll(mode?: 'advantage' | 'disadvantage'): void {
  if (props.action.kind !== 'check' && props.action.kind !== 'save' && props.action.kind !== 'attack') return
  emit('submit', {
    kind: props.action.kind,
    actionId: props.action.id,
    ...(mode !== undefined ? { mode } : {}),
  })
}

function cast(slotLevel?: number): void {
  if (props.action.kind !== 'cast') return
  emit('submit', {
    kind: 'cast',
    actionId: props.action.id,
    ...(slotLevel !== undefined ? { slotLevel } : {}),
  })
}

function ordinal(n: number): string {
  const suffix = n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'
  return `${n}${suffix}`
}
</script>

<style scoped>
.head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 14px;
}

.title {
  font-weight: 800;
  font-size: 1.05rem;
}

.note {
  font-size: 0.76rem;
  color: var(--text-dim);
}

.options {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.opt {
  min-height: 52px;
  border-radius: 12px;
  font-weight: 800;
  font-size: 1rem;
  background: var(--accent);
  color: var(--accent-ink);
  border: 1px solid transparent;
}

.opt:active:not(:disabled) {
  transform: scale(0.98);
}

.opt.adv {
  background: var(--success-soft);
  color: var(--success);
}

.opt.dis {
  background: var(--danger-soft);
  color: var(--danger);
}

.none {
  padding: 16px 4px;
  text-align: center;
  color: var(--text-dim);
  font-size: 0.88rem;
}

.cancel {
  display: block;
  width: 100%;
  min-height: var(--tap);
  margin-top: 10px;
  color: var(--text-dim);
  font-weight: 600;
}
</style>
