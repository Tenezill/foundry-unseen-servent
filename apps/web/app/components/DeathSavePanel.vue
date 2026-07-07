<template>
  <section class="ds card">
    <div class="ds-head">
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 2a7 7 0 0 0-7 7c0 2.4 1.2 4 2.5 5.3.5.5.5 1 .5 1.7v1a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-1c0-.7 0-1.2.5-1.7C17.8 13 19 11.4 19 9a7 7 0 0 0-7-7Zm-2.5 7a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm5 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2ZM9 20a1 1 0 0 1 1-1h4a1 1 0 0 1 0 2h-4a1 1 0 0 1-1-1Z" />
      </svg>
      <div>
        <h2 class="ds-title">Death Saves</h2>
        <p class="ds-note">You are dying — stabilize with three successes.</p>
      </div>
    </div>

    <div class="tracks">
      <div v-for="row in rows" :key="row.res.id" class="ds-row">
        <span class="ds-lab" :class="row.tone">{{ row.short }}</span>
        <div class="pips">
          <span
            v-for="n in 3"
            :key="n"
            class="pip"
            :class="[row.tone, { on: n <= row.res.value }]"
          />
        </div>
        <ResourceStepper
          :resource="row.res"
          :disabled="readonly"
          :busy="busy === row.res.id"
          compact
          @step="(id, dir) => emit('step', id, dir)"
        />
      </div>
    </div>

    <button
      class="roll"
      type="button"
      :class="{ pending: actionBusy }"
      :disabled="readonly || actionBusy"
      @click="emit('roll')"
    >
      Roll Death Save
    </button>
  </section>
</template>

<script setup lang="ts">
import type { ResourceDescriptor } from '@companion/adapter-sdk'

const props = defineProps<{
  success: ResourceDescriptor
  failure: ResourceDescriptor
  busy: string | null
  actionBusy: boolean
  readonly: boolean
}>()

const emit = defineEmits<{
  (e: 'step', resourceId: string, direction: 1 | -1): void
  (e: 'roll'): void
}>()

const rows = computed(() => [
  { res: props.success, short: 'Successes', tone: 'good' },
  { res: props.failure, short: 'Failures', tone: 'bad' },
])
</script>

<style scoped>
.ds {
  padding: 16px;
  margin-top: 4px;
  border-color: color-mix(in srgb, var(--garnet) 45%, var(--line));
  background: linear-gradient(180deg, color-mix(in srgb, var(--garnet) 12%, var(--panel)), var(--panel));
}

.ds-head {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 14px;
}

.ds-head svg {
  width: 30px;
  height: 30px;
  color: var(--garnet);
  flex: none;
}

.ds-title {
  font-family: var(--serif);
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--ink);
}

.ds-note {
  font-size: 0.76rem;
  color: var(--ink-dim);
}

.tracks {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ds-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ds-lab {
  flex: none;
  width: 78px;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.ds-lab.good {
  color: var(--jade);
}
.ds-lab.bad {
  color: var(--garnet);
}

.pips {
  flex: 1;
  display: flex;
  gap: 6px;
}

.pip {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1px solid var(--line);
  background: var(--panel-2);
}
.pip.on.good {
  background: var(--jade);
  border-color: var(--jade);
}
.pip.on.bad {
  background: var(--garnet);
  border-color: var(--garnet);
}

.roll {
  width: 100%;
  min-height: var(--tap);
  margin-top: 16px;
  border-radius: 12px;
  font-weight: 800;
  font-size: 0.95rem;
  letter-spacing: 0.02em;
  color: var(--accent-ink);
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  border: 1px solid var(--gold-deep);
  box-shadow: 0 2px 10px color-mix(in srgb, var(--gold) 35%, transparent);
}

.roll:active:not(:disabled) {
  transform: scale(0.98);
}

.pending {
  opacity: 0.6;
}
</style>
