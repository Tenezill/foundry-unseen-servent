<template>
  <div class="scrim" @click.self="emit('close')">
    <div class="modal-sheet" role="dialog" aria-modal="true" aria-label="Add item">
      <div class="head">
        <span class="title">Add item</span>
        <button class="close" type="button" aria-label="Close" @click="emit('close')">✕</button>
      </div>

      <p v-if="displayError" class="err">{{ displayError }}</p>

      <label class="field">
        <span class="field-label">Name</span>
        <input v-model="name" class="input" type="text" maxlength="120" placeholder="Item name" :disabled="busy" />
      </label>

      <label class="field">
        <span class="field-label">Type</span>
        <select v-model="selectedType" class="select" :disabled="busy">
          <option v-for="t in types" :key="t.type" :value="t.type">{{ t.label }}</option>
        </select>
      </label>

      <div v-if="showDamage" class="field">
        <span class="field-label">Damage</span>
        <div class="stepper">
          <button
            class="step-btn"
            type="button"
            :disabled="busy || damage <= 0"
            aria-label="Decrease damage"
            @click="damage = Math.max(0, damage - 1)"
          >
            &minus;
          </button>
          <span class="mod-value tabular">{{ damage }}</span>
          <button
            class="step-btn"
            type="button"
            :disabled="busy || damage >= 10"
            aria-label="Increase damage"
            @click="damage = Math.min(10, damage + 1)"
          >
            +
          </button>
        </div>
      </div>

      <label class="field">
        <span class="field-label">Description (optional)</span>
        <textarea
          v-model="description"
          class="textarea"
          rows="3"
          maxlength="2000"
          placeholder="Notes about this item…"
          :disabled="busy"
        />
      </label>

      <button class="add" type="button" :disabled="busy" @click="submit">
        {{ busy ? 'Adding…' : 'Add item' }}
      </button>
      <button class="cancel" type="button" :disabled="busy" @click="emit('close')">Cancel</button>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  types: Array<{ type: string; label: string; hasDamage: boolean }>
  busy: boolean
  /** Server-side (422) validation message from the last submit, if any. */
  error?: string | null
}>()

const emit = defineEmits<{
  (
    e: 'submit',
    input: { name: string; type: string; damage?: number; description?: string },
  ): void
  (e: 'close'): void
}>()

const name = ref('')
const selectedType = ref(props.types[0]?.type ?? '')
const damage = ref(0)
const description = ref('')
const localError = ref<string | null>(null)

const displayError = computed(() => localError.value ?? props.error ?? null)

const showDamage = computed(
  () => props.types.find((t) => t.type === selectedType.value)?.hasDamage === true,
)

watch(showDamage, (show) => {
  if (!show) damage.value = 0
})

function submit(): void {
  if (props.busy) return
  const trimmed = name.value.trim()
  if (trimmed === '') {
    localError.value = 'Name is required.'
    return
  }
  localError.value = null
  const input: { name: string; type: string; damage?: number; description?: string } = {
    name: trimmed,
    type: selectedType.value,
  }
  if (showDamage.value) input.damage = damage.value
  const desc = description.value.trim()
  if (desc !== '') input.description = desc
  emit('submit', input)
}
</script>

<style scoped>
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.title {
  font-family: var(--serif);
  font-weight: 700;
  font-size: 1.1rem;
  color: var(--ink);
}

.close {
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  color: var(--ink-dim);
  border: 1px solid var(--line);
  font-size: 0.9rem;
}

.err {
  margin-bottom: 12px;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--danger-soft);
  color: var(--garnet);
  font-size: 0.82rem;
  font-weight: 600;
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

.input,
.select,
.textarea {
  width: 100%;
  padding: 0 12px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--ink);
  font-size: 0.92rem;
  font-family: inherit;
}

.input,
.select {
  min-height: 44px;
}

.textarea {
  padding: 10px 12px;
  resize: vertical;
}

.input:focus,
.select:focus,
.textarea:focus {
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
  min-width: 32px;
  text-align: center;
  font-weight: 700;
  font-size: 1rem;
}

.add {
  width: 100%;
  min-height: 52px;
  border-radius: 12px;
  font-weight: 800;
  font-size: 1rem;
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  color: var(--accent-ink);
  border: 1px solid var(--gold-deep);
  box-shadow: 0 2px 8px color-mix(in srgb, var(--gold) 30%, transparent);
}

.add:active:not(:disabled) {
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
