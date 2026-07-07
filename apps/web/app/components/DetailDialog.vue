<template>
  <div class="scrim" @click.self="emit('close')">
    <div class="modal-sheet detail" role="dialog" aria-modal="true" :aria-label="title">
      <div class="head">
        <span class="title">{{ title }}</span>
        <button class="close" type="button" aria-label="Close" @click="emit('close')">✕</button>
      </div>
      <!-- eslint-disable-next-line vue/no-v-html -- sanitized world content -->
      <div class="body" v-html="clean" />
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ title: string; detail: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const clean = computed(() => sanitizeHtml(props.detail))
</script>

<style scoped>
.detail {
  max-height: 80dvh;
  overflow-y: auto;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  position: sticky;
  top: -20px;
  background: var(--panel);
  padding-top: 4px;
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

.body {
  font-size: 0.9rem;
  color: var(--ink-dim);
  line-height: 1.6;
  overflow-wrap: anywhere;
}

/* World description content: keep it readable, keep tokens in charge. */
.body :deep(p) {
  margin: 0 0 10px;
}
.body :deep(h1),
.body :deep(h2),
.body :deep(h3),
.body :deep(h4) {
  font-family: var(--serif);
  color: var(--ink);
  margin: 14px 0 6px;
  font-size: 1rem;
}
.body :deep(strong),
.body :deep(b) {
  color: var(--ink);
}
.body :deep(a) {
  color: var(--gold-bright);
}
.body :deep(ul),
.body :deep(ol) {
  margin: 0 0 10px;
  padding-left: 20px;
}
.body :deep(hr) {
  border: 0;
  border-top: 1px solid var(--line);
  margin: 12px 0;
}
.body :deep(table) {
  width: 100%;
  border-collapse: collapse;
  display: block;
  overflow-x: auto;
}
.body :deep(td),
.body :deep(th) {
  border: 1px solid var(--line);
  padding: 4px 8px;
  text-align: left;
}
.body :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
}
</style>
