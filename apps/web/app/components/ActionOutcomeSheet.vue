<template>
  <div class="scrim" @click.self="emit('close')">
    <div class="modal-sheet" role="dialog" aria-modal="true" :aria-label="`${label} results`">
      <div class="head">
        <span class="title">{{ label }}</span>
        <span v-if="outcome.attack" class="attack-line" :class="{ crit: outcome.attack.isCritical, fumble: outcome.attack.isFumble }">
          {{ outcome.attack.total }} to hit
          <template v-if="outcome.attack.isCritical"> — CRIT!</template>
          <template v-else-if="outcome.attack.isFumble"> — FUMBLE</template>
        </span>
      </div>

      <div class="list card">
        <div v-for="t in outcome.targets" :key="t.tokenUuid" class="row">
          <span class="row-main">
            <span class="row-label">{{ t.name }}</span>
            <span v-if="damageLine(t)" class="dmg-line">
              {{ damageLine(t) }}
              <span v-if="tagFor(t) === 'resisted'" class="tag resisted">resisted</span>
              <span v-else-if="tagFor(t) === 'immune'" class="tag immune">immune</span>
            </span>
            <span v-else-if="t.save" class="dmg-line">DC {{ t.save.dc }} — rolled {{ t.save.total }}</span>
          </span>
          <span class="badge" :class="badgeClass(t.outcome)">{{ badgeLabel(t) }}</span>
        </div>
        <p v-if="outcome.targets.length === 0" class="empty-hint">No targets.</p>
      </div>

      <button class="cancel" type="button" @click="emit('close')">Close</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ActionOutcome, ActionOutcomeTarget } from '~/types/api'

const props = defineProps<{ outcome: ActionOutcome; label: string; healLabel?: boolean }>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const BADGE_LABELS: Record<ActionOutcomeTarget['outcome'], string> = {
  hit: 'Hit',
  miss: 'Miss',
  'save-failed': 'Save failed',
  'save-passed': 'Save passed',
  applied: 'Applied',
  gone: 'Gone',
}

function badgeLabel(t: ActionOutcomeTarget): string {
  if (t.outcome === 'applied' && props.healLabel) return 'Healed'
  return BADGE_LABELS[t.outcome]
}

function badgeClass(outcome: ActionOutcomeTarget['outcome']): string {
  if (outcome === 'hit' || outcome === 'save-failed') return 'bad'
  if (outcome === 'miss' || outcome === 'save-passed') return 'neutral'
  if (outcome === 'applied') return 'good'
  return 'neutral'
}

function rolledSum(t: ActionOutcomeTarget): number {
  return t.damage?.rolled.reduce((sum, r) => sum + r.value, 0) ?? 0
}

/** "resisted" once applied undercuts the rolled total but isn't zero;
 *  "immune" when a hit/failed-save still applied nothing. */
function tagFor(t: ActionOutcomeTarget): 'resisted' | 'immune' | undefined {
  if (!t.damage) return undefined
  const sum = rolledSum(t)
  if (t.damage.applied === 0 && (t.outcome === 'hit' || t.outcome === 'save-failed')) return 'immune'
  if (t.damage.applied < sum && t.damage.applied > 0) return 'resisted'
  return undefined
}

function damageLine(t: ActionOutcomeTarget): string | undefined {
  if (!t.damage) return undefined
  const parts = t.damage.rolled.map((r) => `${r.value} ${r.type}`).join(' + ')
  return `${parts} → ${t.damage.applied} applied`
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

.attack-line {
  font-size: 0.85rem;
  font-weight: 700;
  color: var(--ink-dim);
}

.attack-line.crit {
  color: var(--gold-bright);
}

.attack-line.fumble {
  color: var(--garnet);
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
}

.row + .row {
  border-top: 1px solid var(--line);
}

.row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
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

.dmg-line {
  font-size: 0.78rem;
  color: var(--ink-dim);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.tag {
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 1px 6px;
  border-radius: 999px;
}

.tag.resisted {
  color: var(--ink-dim);
  background: var(--panel-2);
}

.tag.immune {
  color: var(--garnet);
  background: var(--danger-soft);
}

.badge {
  flex: none;
  font-size: 0.76rem;
  font-weight: 700;
  padding: 4px 10px;
  border-radius: 999px;
}

.badge.bad {
  color: var(--garnet);
  background: var(--danger-soft);
}

.badge.good {
  color: var(--success);
  background: var(--success-soft);
}

.badge.neutral {
  color: var(--ink-dim);
  background: var(--panel-2);
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
