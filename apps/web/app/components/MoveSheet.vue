<template>
  <div class="scrim" @click.self="emit('close')">
    <div class="modal-sheet" role="dialog" aria-modal="true" aria-label="Move token">
      <div class="head">
        <div class="head-text">
          <span class="title">Move</span>
          <span class="note">{{ speedFt }} {{ units }} speed · tap a square</span>
        </div>
        <button class="refresh" type="button" aria-label="Refresh positions" :disabled="busy" @click="emit('refresh')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M4 12a8 8 0 1 0 2-5.3M4 4v3h3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>

      <div class="grid-wrap">
        <div class="grid" :style="{ gridTemplateColumns: `repeat(${side}, 1fr)` }">
          <button
            v-for="cell in cells"
            :key="`${cell.cx},${cell.cy}`"
            type="button"
            class="cell"
            :class="cellClass(cell)"
            :disabled="!cell.selectable || busy"
            :aria-label="cellAria(cell)"
            @click="select(cell)"
          >
            <span v-if="cell.isCenter" class="me" aria-hidden="true">★</span>
            <span v-else-if="cell.other" class="dot" :class="dotClass(cell.other.disposition)" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div class="foot">
        <span class="dist">{{ selected ? `${distanceOf(selected)} ${units}` : '—' }}</span>
        <button class="move-btn" type="button" :disabled="!selected || busy" @click="confirm()">
          Move
        </button>
      </div>
      <button class="cancel" type="button" @click="emit('close')">Cancel</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { MovementCell, MovementOther, MovementView } from '~/types/api'

const props = defineProps<{ movement: MovementView; busy: boolean }>()
const emit = defineEmits<{
  (e: 'submit', cell: MovementCell): void
  (e: 'refresh'): void
  (e: 'close'): void
}>()

interface GridCell extends MovementCell {
  isCenter: boolean
  other?: MovementOther
  selectable: boolean
}

const speedFt = computed(() => props.movement.speedFt ?? 0)
const gridDistance = computed(() => props.movement.gridDistance ?? 5)
const units = computed(() => props.movement.gridUnits ?? 'ft')
/** Reachable radius in cells; the grid is (2r+1)². */
const radius = computed(() => Math.floor(speedFt.value / gridDistance.value))
const side = computed(() => radius.value * 2 + 1)

const selected = ref<MovementCell | null>(null)

const center = computed<MovementCell>(() => props.movement.token ?? { cx: 0, cy: 0 })

/** Occupied lookup: visible tokens by absolute cell. */
const otherAt = computed(() => {
  const map = new Map<string, MovementOther>()
  for (const o of props.movement.others ?? []) map.set(`${o.cx},${o.cy}`, o)
  return map
})

const cells = computed<GridCell[]>(() => {
  const out: GridCell[] = []
  const c = center.value
  for (let dy = -radius.value; dy <= radius.value; dy++) {
    for (let dx = -radius.value; dx <= radius.value; dx++) {
      const cx = c.cx + dx
      const cy = c.cy + dy
      const other = otherAt.value.get(`${cx},${cy}`)
      const isCenter = dx === 0 && dy === 0
      out.push({ cx, cy, isCenter, other, selectable: !isCenter && !other })
    }
  }
  return out
})

function distanceOf(cell: MovementCell): number {
  const c = center.value
  return Math.max(Math.abs(cell.cx - c.cx), Math.abs(cell.cy - c.cy)) * gridDistance.value
}

function select(cell: GridCell): void {
  if (!cell.selectable) return
  selected.value = { cx: cell.cx, cy: cell.cy }
}

function confirm(): void {
  if (selected.value) emit('submit', selected.value)
}

function cellClass(cell: GridCell): Record<string, boolean> {
  return {
    center: cell.isCenter,
    occupied: !!cell.other,
    selected: selected.value?.cx === cell.cx && selected.value?.cy === cell.cy,
  }
}

function dotClass(disposition: number): string {
  if (disposition === 1) return 'friendly'
  if (disposition === -1) return 'hostile'
  return 'neutral'
}

function cellAria(cell: GridCell): string {
  if (cell.isCenter) return 'Your position'
  if (cell.other) return `Occupied by ${cell.other.name ?? 'a creature'}`
  return `Move ${distanceOf(cell)} ${units.value}`
}
</script>

<style scoped>
.head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.head-text { display: flex; flex-direction: column; gap: 2px; flex: 1; }
.refresh { width: 36px; height: 36px; border-radius: 10px; border: 1px solid var(--line); background: var(--panel-2); color: var(--text-dim); display: flex; align-items: center; justify-content: center; }
.refresh svg { width: 18px; height: 18px; }
.title { font-weight: 700; font-size: 1.05rem; }
.note { color: var(--text-dim); font-size: 0.8rem; }

.grid-wrap { overflow: auto; max-height: 55vh; }
.grid { display: grid; gap: 2px; }
.cell {
  aspect-ratio: 1;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: color-mix(in srgb, var(--gold) 10%, var(--panel-2));
  display: flex; align-items: center; justify-content: center;
  padding: 0;
}
.cell:disabled { opacity: 0.9; }
.cell.center { background: color-mix(in srgb, var(--gold) 35%, var(--panel-2)); }
.cell.occupied { background: var(--panel); }
.cell.selected {
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  border-color: var(--gold-deep);
}
.me { color: var(--accent-ink); font-size: 0.7rem; }
.dot { width: 55%; height: 55%; border-radius: 50%; }
.dot.friendly { background: var(--success); }
.dot.hostile { background: var(--danger); }
.dot.neutral { background: var(--ink-dim); }

.foot { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
.dist { flex: 1; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.move-btn {
  min-height: 36px; padding: 0 20px; border-radius: 999px;
  font-weight: 700; font-size: 0.78rem; letter-spacing: 0.02em;
  border: 1px solid var(--gold-deep);
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  color: var(--accent-ink);
  box-shadow: 0 2px 8px color-mix(in srgb, var(--gold) 30%, transparent);
}
.move-btn:disabled { opacity: 0.55; box-shadow: none; }
.move-btn:active:not(:disabled) { transform: scale(0.96); }
.cancel {
  width: 100%; margin-top: 10px; min-height: var(--tap);
  background: none; border: none; color: var(--text-dim); font-weight: 600;
}
</style>
