<template>
  <div class="scrim" @click.self="emit('close')">
    <div class="modal-sheet" role="dialog" aria-modal="true" aria-label="Choose a target">
      <div class="head">
        <span class="title">Cast on…</span>
      </div>
      <div class="list card">
        <button class="row self" type="button" @click="emit('pick', null)">
          <span class="row-label">Yourself</span>
        </button>
        <template v-if="encounter?.active">
          <button
            v-for="c in encounter.combatants ?? []"
            :key="c.id"
            class="row"
            type="button"
            :disabled="!c.actorId"
            @click="c.actorId && emit('pick', c.actorId)"
          >
            <ActorAvatar :name="c.name" :img="foundryImgUrl(c.img, foundryBase)" :size="36" />
            <span class="row-label" :class="{ strike: c.defeated }">{{ c.name }}</span>
          </button>
        </template>
        <template v-else>
          <button
            v-for="a in party?.actors ?? []"
            :key="a.id"
            class="row"
            type="button"
            @click="emit('pick', a.id)"
          >
            <ActorAvatar :name="a.name ?? a.id" :img="foundryImgUrl(a.img, foundryBase)" :size="36" />
            <span class="row-label">{{ a.name ?? a.id }}</span>
          </button>
          <p v-if="!party" class="empty-hint">Loading party…</p>
        </template>
      </div>
      <button class="cancel" type="button" @click="emit('close')">Cancel</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { EncounterView, PartyView } from '~/types/api'

defineProps<{ encounter: EncounterView | null; party: PartyView | null }>()

const emit = defineEmits<{
  (e: 'pick', targetActorId: string | null): void
  (e: 'close'): void
}>()

const config = useRuntimeConfig()
const foundryBase = String(config.public.foundryBase || '')
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

.empty-hint {
  color: var(--text-dim);
  font-size: 0.85rem;
  padding: 12px 14px;
  font-style: italic;
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
