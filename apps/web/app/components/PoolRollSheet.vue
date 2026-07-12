<template>
  <div class="scrim" @click.self="emit('close')">
    <div class="modal-sheet" role="dialog" aria-modal="true" :aria-label="`Roll ${action.label}`">
      <div class="head">
        <span class="title">{{ action.label }}</span>
        <span class="note">Rolls in Foundry as your character</span>
      </div>

      <label class="field">
        <span class="field-label">Attribute</span>
        <select v-model="attributeId" class="select" :disabled="busy">
          <option v-for="stat in attributes" :key="stat.id" :value="stat.id">
            {{ stat.label }} ({{ stat.value }})
          </option>
        </select>
      </label>

      <label class="field">
        <span class="field-label">Second</span>
        <select v-model="secondId" class="select" :disabled="busy">
          <option value="">None</option>
          <optgroup v-if="skills.length" label="Skills">
            <option v-for="stat in skills" :key="stat.id" :value="stat.id">
              {{ stat.label }} ({{ stat.value }})
            </option>
          </optgroup>
          <optgroup v-if="disciplines.length" label="Disciplines">
            <option v-for="stat in disciplines" :key="stat.id" :value="stat.id">
              {{ stat.label }} ({{ stat.value }})
            </option>
          </optgroup>
        </select>
      </label>

      <div class="field">
        <span class="field-label">Modifier</span>
        <div class="stepper">
          <button
            class="step-btn"
            type="button"
            :disabled="busy || modifier <= MIN_MODIFIER"
            aria-label="Decrease modifier"
            @click="modifier = Math.max(MIN_MODIFIER, modifier - 1)"
          >
            &minus;
          </button>
          <span class="mod-value tabular">{{ modifier > 0 ? '+' : '' }}{{ modifier }}</span>
          <button
            class="step-btn"
            type="button"
            :disabled="busy || modifier >= MAX_MODIFIER"
            aria-label="Increase modifier"
            @click="modifier = Math.min(MAX_MODIFIER, modifier + 1)"
          >
            +
          </button>
        </div>
      </div>

      <p class="preview">{{ preview }}</p>

      <button class="opt" type="button" :disabled="busy" @click="confirm">
        {{ busy ? 'Rolling…' : 'Roll' }}
      </button>
      <button class="cancel" type="button" :disabled="busy" @click="emit('close')">Cancel</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ActionDescriptor, ActionIntent, Stat } from '@companion/adapter-sdk'

const MIN_MODIFIER = -5
const MAX_MODIFIER = 5

const props = defineProps<{
  action: ActionDescriptor
  /** Dots stats from the `attributes` section, ids prefixed `attr.`. */
  attributes: Stat[]
  /** Dots stats from the `skills` section, ids prefixed `skill.`. */
  skills: Stat[]
  /** Dots stats from the `discipline-ratings` section, ids prefixed `disc.`. */
  disciplines: Stat[]
  /** Current hunger resource value (display-only preview input). */
  hunger: number
  busy: boolean
}>()

const emit = defineEmits<{
  (e: 'submit', intent: ActionIntent, preview: string): void
  (e: 'close'): void
}>()

// Pre-fill from the tapped descriptor's default pairing (M23 Task 6/7): an
// attribute tap has pool.skill undefined (attribute-only), a skill tap
// defaults attr.dexterity + that skill, a power tap defaults attr.resolve +
// its discipline rating. The player may still repick either component.
const attributeId = ref(props.action.pool?.attribute ?? props.attributes[0]?.id ?? '')
const secondId = ref(props.action.pool?.skill ?? '')
const modifier = ref(0)

function numVal(stat: Stat | undefined): number {
  return stat && typeof stat.value === 'number' ? stat.value : 0
}

const selectedAttribute = computed(() => props.attributes.find((s) => s.id === attributeId.value))
const selectedSecond = computed(() => {
  if (!secondId.value) return undefined
  return (
    props.skills.find((s) => s.id === secondId.value) ??
    props.disciplines.find((s) => s.id === secondId.value)
  )
})

// Display-only preview — the adapter recomputes dice/hunger authoritatively
// from the actor's live values when the intent is submitted.
const dice = computed(() =>
  Math.max(1, numVal(selectedAttribute.value) + numVal(selectedSecond.value) + modifier.value),
)
const hungerDice = computed(() => Math.min(Math.max(props.hunger, 0), dice.value))

const preview = computed(() => {
  const attr = selectedAttribute.value
  const second = selectedSecond.value
  const attrPart = `${attr?.label ?? '?'} ${numVal(attr)}`
  const secondPart = second ? ` + ${second.label} ${numVal(second)}` : ''
  return `${attrPart}${secondPart} = ${dice.value} dice, ${hungerDice.value} hunger`
})

function confirm(): void {
  if (props.busy) return
  const intent: ActionIntent = {
    kind: 'pool',
    actionId: props.action.id,
    attribute: attributeId.value,
    ...(secondId.value ? { skill: secondId.value } : {}),
    ...(modifier.value !== 0 ? { modifier: modifier.value } : {}),
  }
  emit('submit', intent, preview.value)
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

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.field-label {
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-dim);
}

.select {
  width: 100%;
  min-height: 44px;
  padding: 0 12px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--ink);
  font-size: 0.92rem;
}

.select:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--gold) 45%, transparent);
}

.stepper {
  display: flex;
  align-items: center;
  gap: 10px;
}

.step-btn {
  min-width: var(--tap);
  min-height: var(--tap);
  border-radius: 12px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  font-size: 1.2rem;
  font-weight: 700;
  color: var(--text);
}

.step-btn:active:not(:disabled) {
  transform: scale(0.94);
  background: var(--accent-soft);
}

.mod-value {
  min-width: 44px;
  text-align: center;
  font-weight: 700;
  font-size: 1rem;
}

.preview {
  margin: 6px 0 16px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  font-size: 0.86rem;
  color: var(--ink-dim);
  text-align: center;
}

.opt {
  width: 100%;
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

.cancel {
  display: block;
  width: 100%;
  min-height: var(--tap);
  margin-top: 8px;
  color: var(--text-dim);
  font-weight: 600;
}
</style>
