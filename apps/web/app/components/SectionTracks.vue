<template>
  <section>
    <h2 class="section-title">{{ section.label }}</h2>
    <div class="tracks">
      <TrackBoxes
        v-for="row in boxRows"
        :key="row.track.id"
        :track="row.track"
        :primary="row.primary"
        :aggravated="row.aggravated"
        :busy="boxBusy === row.track.id"
        :readonly="readonly"
        @change="(trackId, changes) => emit('boxchange', trackId, changes)"
      />
      <div v-for="res in tracked" :key="res.id" class="track card">
        <div class="track-head">
          <span class="track-label">{{ res.label }}</span>
          <button
            v-if="res.id === 'hp' && res.writable"
            class="numpad-btn"
            type="button"
            :disabled="readonly"
            @click="emit('numpad', res.id)"
          >
            Damage / Heal
          </button>
        </div>
        <div v-if="res.max !== undefined" class="bar" role="presentation">
          <div class="bar-fill" :style="{ width: pct(res) + '%' }" :data-low="pct(res) <= 25" />
        </div>
        <div class="track-body">
          <ResourceStepper
            v-if="res.writable"
            :resource="res"
            :disabled="readonly"
            :busy="busy === res.id"
            @step="(id, dir) => emit('step', id, dir)"
          />
          <span v-else class="ro-value">
            <b>{{ res.value }}</b><span v-if="res.max !== undefined" class="ro-max">/{{ res.max }}</span>
          </span>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { BoxTrackSpec, ResourceDescriptor, SheetSection } from '@companion/adapter-sdk'

const props = defineProps<{
  section: Extract<SheetSection, { kind: 'tracks' }>
  resources: Record<string, ResourceDescriptor>
  busy: string | null
  /** Id of the box track currently mid-write (M23; see TrackBoxes.vue —
   *  distinct from `busy`, which tracks single-resource stepper writes). */
  boxBusy: string | null
  readonly: boolean
}>()

const emit = defineEmits<{
  (e: 'step', resourceId: string, direction: 1 | -1): void
  (e: 'numpad', resourceId: string): void
  /** M23: a box-track tap resolved to one or two resource deltas — see
   *  [id].vue's submitBoxChange. */
  (e: 'boxchange', trackId: string, changes: Array<{ resourceId: string; amount: number; expected: number }>): void
}>()

// Box tracks (M23) render via TrackBoxes instead of the plain per-resource
// card below — resourceIds claimed by a boxTrack (primary + aggravated) are
// excluded from `tracked` so nothing double-renders. dnd5e sections never
// set `boxTracks`, so `claimedIds` is empty and `tracked` is unaffected.
const boxRows = computed(() =>
  (props.section.boxTracks ?? [])
    .map((track) => {
      const primary = props.resources[track.primaryId]
      if (!primary) return undefined
      const aggravated = track.aggravatedId ? props.resources[track.aggravatedId] : undefined
      return { track, primary, aggravated }
    })
    .filter(
      (r): r is { track: BoxTrackSpec; primary: ResourceDescriptor; aggravated: ResourceDescriptor | undefined } =>
        r !== undefined,
    ),
)

const claimedIds = computed(() => {
  const s = new Set<string>()
  for (const t of props.section.boxTracks ?? []) {
    s.add(t.primaryId)
    if (t.aggravatedId) s.add(t.aggravatedId)
  }
  return s
})

const tracked = computed(() =>
  props.section.resourceIds
    .map((id) => props.resources[id])
    .filter((r): r is ResourceDescriptor => r !== undefined && !claimedIds.value.has(r.id)),
)

function pct(res: ResourceDescriptor): number {
  if (res.max === undefined || res.max <= 0) return 0
  return Math.max(0, Math.min(100, (res.value / res.max) * 100))
}
</script>

<style scoped>
.tracks {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.track {
  padding: 12px 14px;
}

.track-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.track-label {
  font-weight: 700;
  font-size: 0.9rem;
}

.numpad-btn {
  min-height: 36px;
  padding: 0 14px;
  border-radius: 999px;
  font-size: 0.76rem;
  font-weight: 700;
  background: var(--accent-soft);
  color: var(--accent);
  border: 1px solid transparent;
}

.numpad-btn:active:not(:disabled) {
  transform: scale(0.96);
}

.bar {
  height: 6px;
  border-radius: 999px;
  background: var(--surface-2);
  overflow: hidden;
  margin-bottom: 10px;
}

.bar-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width 0.25s ease;
}

.bar-fill[data-low='true'] {
  background: var(--danger);
}

.track-body {
  display: flex;
  justify-content: center;
}

.ro-value {
  font-variant-numeric: tabular-nums;
  font-size: 1.05rem;
}

.ro-max {
  color: var(--text-dim);
  font-size: 0.85rem;
}
</style>
