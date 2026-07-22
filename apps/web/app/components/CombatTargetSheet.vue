<template>
  <div class="scrim" @click.self="emit('close')">
    <div class="modal-sheet" role="dialog" aria-modal="true" :aria-label="title">
      <div class="head">
        <span class="title">{{ title }}</span>
      </div>
      <div class="list card">
        <button
          v-for="c in encounter?.combatants ?? []"
          :key="c.id"
          class="row"
          type="button"
          :disabled="!c.tokenUuid"
          @click="c.tokenUuid && toggle(c.tokenUuid)"
        >
          <ActorAvatar :name="c.name" :img="foundryImgUrl(c.img, foundryBase)" :size="36" />
          <span class="row-main">
            <span class="row-label" :class="{ strike: c.defeated }">{{ c.name }}</span>
          </span>
          <span v-if="c.health" class="health-dot" :class="`health-${c.health}`" aria-hidden="true" />
          <svg
            v-if="mode === 'multiple' && c.tokenUuid && picked.has(c.tokenUuid)"
            class="check"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.4"
            aria-hidden="true"
          >
            <path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <p v-if="!encounter?.combatants?.length" class="empty-hint">No combatants.</p>
      </div>
      <button
        v-if="mode === 'multiple'"
        class="confirm btn btn-accent"
        type="button"
        :disabled="picked.size === 0"
        @click="confirm"
      >
        Confirm ({{ picked.size }})
      </button>
      <button class="cancel" type="button" @click="emit('close')">Cancel</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { EncounterView } from '~/types/api'

const props = defineProps<{
  encounter: EncounterView | null
  mode: 'single' | 'multiple'
  title: string
}>()

const emit = defineEmits<{
  (e: 'pick', tokenUuids: string[]): void
  (e: 'close'): void
}>()

const config = useRuntimeConfig()
const foundryBase = String(config.public.foundryBase || '')

const picked = ref<Set<string>>(new Set())

function toggle(tokenUuid: string): void {
  if (props.mode === 'single') {
    emit('pick', [tokenUuid])
    return
  }
  const next = new Set(picked.value)
  if (next.has(tokenUuid)) next.delete(tokenUuid)
  else next.add(tokenUuid)
  picked.value = next
}

function confirm(): void {
  if (picked.value.size === 0) return
  emit('pick', [...picked.value])
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

.list {
  overflow: hidden;
  max-height: 50vh;
  overflow-y: auto;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  min-height: 56px;
  width: 100%;
  text-align: left;
}

.row:disabled {
  opacity: 0.5;
}

.row + .row {
  border-top: 1px solid var(--line);
}

.row:active:not(:disabled) {
  background: color-mix(in srgb, var(--gold) 8%, transparent);
}

.row-main {
  flex: 1;
  min-width: 0;
}

.row-label {
  font-weight: 600;
  font-size: 0.95rem;
  color: var(--ink);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-label.strike {
  text-decoration: line-through;
  color: var(--ink-faint);
}

.health-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ink-faint);
}

.health-dot.health-wounded {
  background: color-mix(in srgb, var(--garnet) 70%, var(--ink-dim));
}

.health-dot.health-bloodied,
.health-dot.health-down {
  background: var(--garnet);
}

.check {
  flex: none;
  width: 20px;
  height: 20px;
  color: var(--gold-bright);
}

.empty-hint {
  color: var(--text-dim);
  font-size: 0.85rem;
  padding: 12px 14px;
  font-style: italic;
}

.confirm {
  display: block;
  width: 100%;
  min-height: var(--tap);
  margin-top: 10px;
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
