<template>
  <div class="track-boxes card">
    <div class="tb-head">
      <span class="tb-label">{{ track.label }}</span>
      <span class="tb-count tabular">{{ filledCount }}/{{ track.max }}</span>
    </div>
    <div class="boxes" role="group" :aria-label="track.label">
      <button
        v-for="(state, i) in boxes"
        :key="i"
        type="button"
        class="box"
        :class="state"
        :disabled="readonly || busy"
        :aria-label="`${track.label} box ${i + 1}: ${state}`"
        @click="onTap(i)"
      >
        <span v-if="state === 'aggravated'" aria-hidden="true">✕</span>
        <span v-else-if="state === 'superficial'" aria-hidden="true">/</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { BoxTrackSpec, ResourceDescriptor } from '@companion/adapter-sdk'

/** One resource write for a box tap, submitted (possibly alongside a
 *  sibling change) as a plain `delta` intent by the page — see
 *  [id].vue's submitBoxChange. */
type BoxChange = { resourceId: string; amount: number; expected: number }

const props = withDefaults(
  defineProps<{
    track: BoxTrackSpec
    primary: ResourceDescriptor
    aggravated?: ResourceDescriptor
    busy?: boolean
    readonly?: boolean
  }>(),
  { busy: false, readonly: false },
)

const emit = defineEmits<{ (e: 'change', trackId: string, changes: BoxChange[]): void }>()

type BoxState = 'empty' | 'superficial' | 'aggravated' | 'filled'

// Fill order (M23 binding contract): aggravated boxes first (marked '✕'),
// then superficial ('/'), the rest empty. Two-state tracks (hunger, stains —
// no `aggravated` resource) fill plain boxes from `primary.value`.
const boxes = computed<BoxState[]>(() => {
  const max = Math.max(0, props.track.max)
  const out: BoxState[] = []
  if (props.aggravated) {
    const aggCount = Math.max(0, Math.min(props.aggravated.value, max))
    const supCount = Math.max(0, Math.min(props.primary.value, max - aggCount))
    for (let i = 0; i < max; i++) {
      if (i < aggCount) out.push('aggravated')
      else if (i < aggCount + supCount) out.push('superficial')
      else out.push('empty')
    }
  } else {
    const filled = Math.max(0, Math.min(props.primary.value, max))
    for (let i = 0; i < max; i++) out.push(i < filled ? 'filled' : 'empty')
  }
  return out
})

const filledCount = computed(() => boxes.value.filter((s) => s !== 'empty').length)

// Tap semantics (V5 tri-state cycle): empty -> +1 superficial; superficial
// -> that box becomes aggravated (superficial -1, aggravated +1); aggravated
// -> -1 aggravated (heal). Two-state: empty -> +1 primary; filled -> -1
// primary. Each change's `expected` is the pre-tap descriptor value so the
// gateway's optimistic-lock check (docs/API.md) still applies per write.
function onTap(index: number): void {
  if (props.readonly || props.busy) return
  const state = boxes.value[index]
  const changes: BoxChange[] = []
  if (props.aggravated) {
    if (state === 'aggravated') {
      changes.push({ resourceId: props.aggravated.id, amount: -1, expected: props.aggravated.value })
    } else if (state === 'superficial') {
      changes.push({ resourceId: props.primary.id, amount: -1, expected: props.primary.value })
      changes.push({ resourceId: props.aggravated.id, amount: 1, expected: props.aggravated.value })
    } else {
      changes.push({ resourceId: props.primary.id, amount: 1, expected: props.primary.value })
    }
  } else if (state === 'filled') {
    changes.push({ resourceId: props.primary.id, amount: -1, expected: props.primary.value })
  } else {
    changes.push({ resourceId: props.primary.id, amount: 1, expected: props.primary.value })
  }
  emit('change', props.track.id, changes)
}
</script>

<style scoped>
.track-boxes {
  padding: 12px 14px;
}

.tb-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.tb-label {
  font-weight: 700;
  font-size: 0.9rem;
}

.tb-count {
  color: var(--text-dim);
  font-size: 0.82rem;
}

.boxes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.box {
  width: 22px;
  height: 22px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--text-dim);
  font-weight: 800;
  font-size: 0.8rem;
  line-height: 1;
}

.box.superficial {
  background: color-mix(in srgb, var(--accent) 35%, var(--surface-2));
  border-color: var(--accent);
  color: var(--text);
}

.box.aggravated {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
}

.box.filled {
  background: var(--accent);
  border-color: var(--accent);
}

.box:active:not(:disabled) {
  transform: scale(0.92);
}

.box:disabled {
  opacity: 0.6;
}
</style>
