<template>
  <div class="scrim" @click.self="emit('close')">
    <div class="modal-sheet book" role="dialog" aria-modal="true" aria-label="Learn a spell">
      <div class="head">
        <span class="title">{{ preview ? preview.label : 'Learn a spell' }}</span>
        <button class="close" type="button" aria-label="Close" @click="emit('close')">✕</button>
      </div>

      <template v-if="!preview">
        <input
          ref="inputEl"
          v-model="query"
          class="search"
          type="search"
          placeholder="Search your world’s compendia…"
          autocomplete="off"
          spellcheck="false"
        />
        <div class="results">
          <button
            v-for="entry in results"
            :key="entry.uuid"
            class="result"
            type="button"
            :disabled="busy"
            @click="emit('preview', entry.uuid)"
          >
            <ActorAvatar :name="entry.name" :img="entry.img" :size="34" />
            <span class="result-main">
              <span class="result-name">{{ entry.name }}</span>
              <span v-if="entry.pack" class="result-pack">{{ entry.pack }}</span>
            </span>
          </button>
          <p v-if="searching" class="hint">Searching…</p>
          <p v-else-if="query.trim() !== '' && results.length === 0" class="hint">
            No spells found for “{{ query.trim() }}”.
          </p>
          <p v-else-if="query.trim() === ''" class="hint">
            Type a spell name — anything the GM’s world knows can be learned.
          </p>
        </div>
      </template>

      <template v-else>
        <p v-if="preview.sub" class="preview-sub">{{ preview.sub }}</p>
        <p v-if="alreadyKnown" class="known">Already in the spellbook.</p>
        <!-- eslint-disable-next-line vue/no-v-html -- sanitized world content -->
        <div v-if="previewDetail" class="preview-body" v-html="previewDetail" />
        <div class="actions">
          <button class="back" type="button" :disabled="busy" @click="emit('back')">Back</button>
          <button
            class="learn"
            type="button"
            :class="{ pending: busy }"
            :disabled="busy"
            @click="previewUuid && emit('learn', previewUuid)"
          >
            Learn
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ListItem } from '@companion/adapter-sdk'
import type { SpellSearchEntry } from '~/types/api'

const props = defineProps<{
  results: SpellSearchEntry[]
  preview: ListItem | null
  /** uuid of the previewed entry (emitted back on Learn). */
  previewUuid: string | null
  /** Names of spells already on the sheet (case-insensitive hint). */
  knownNames: string[]
  busy: boolean
  searching: boolean
}>()

const emit = defineEmits<{
  (e: 'search', q: string): void
  (e: 'preview', uuid: string): void
  (e: 'learn', uuid: string): void
  (e: 'back'): void
  (e: 'close'): void
}>()

const query = ref('')
const inputEl = ref<HTMLInputElement | null>(null)
let debounce: ReturnType<typeof setTimeout> | undefined

watch(query, (q) => {
  if (debounce !== undefined) clearTimeout(debounce)
  debounce = setTimeout(() => emit('search', q), 300)
})

onMounted(() => inputEl.value?.focus())
onBeforeUnmount(() => {
  if (debounce !== undefined) clearTimeout(debounce)
})

const previewDetail = computed(() => (props.preview?.detail ? sanitizeHtml(props.preview.detail) : ''))

const alreadyKnown = computed(() => {
  const label = props.preview?.label.toLowerCase()
  return label !== undefined && props.knownNames.some((n) => n.toLowerCase() === label)
})
</script>

<style scoped>
.book {
  max-height: 80dvh;
  display: flex;
  flex-direction: column;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.title {
  font-family: var(--serif);
  font-weight: 700;
  font-size: 1.15rem;
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

.search {
  width: 100%;
  min-height: 44px;
  padding: 0 14px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--ink);
  font-size: 0.95rem;
}

.search:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--gold) 45%, transparent);
}

.results {
  margin-top: 10px;
  overflow-y: auto;
  min-height: 120px;
}

.result {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 6px;
  text-align: left;
  border-radius: 10px;
}

.result:active {
  background: var(--panel-2);
}

.result + .result {
  border-top: 1px solid var(--line);
}

.result-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.result-name {
  font-weight: 600;
  font-size: 0.92rem;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-pack {
  font-size: 0.72rem;
  color: var(--ink-dim);
}

.hint {
  padding: 18px 4px;
  text-align: center;
  color: var(--ink-dim);
  font-size: 0.85rem;
}

.preview-sub {
  font-size: 0.8rem;
  color: var(--ink-dim);
  margin-bottom: 8px;
}

.known {
  font-size: 0.78rem;
  font-weight: 700;
  color: var(--gold-bright);
  background: color-mix(in srgb, var(--gold) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--gold) 30%, transparent);
  border-radius: 10px;
  padding: 6px 10px;
  margin-bottom: 8px;
}

.preview-body {
  overflow-y: auto;
  font-size: 0.9rem;
  color: var(--ink-dim);
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.preview-body :deep(p) {
  margin: 0 0 10px;
}

.actions {
  display: flex;
  gap: 10px;
  margin-top: 14px;
}

.back {
  flex: 1;
  min-height: 44px;
  border-radius: 12px;
  color: var(--ink-dim);
  border: 1px solid var(--line);
  background: var(--panel-2);
  font-weight: 600;
}

.learn {
  flex: 2;
  min-height: 44px;
  border-radius: 12px;
  font-weight: 700;
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  color: var(--accent-ink);
  border: 1px solid var(--gold-deep);
  box-shadow: 0 2px 8px color-mix(in srgb, var(--gold) 30%, transparent);
}

.learn:active:not(:disabled),
.back:active:not(:disabled) {
  transform: scale(0.98);
}

.pending {
  opacity: 0.55;
}
</style>
