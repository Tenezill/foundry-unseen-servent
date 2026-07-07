<template>
  <section>
    <h2 class="section-title">{{ section.label }}</h2>
    <div class="list card">
      <div v-for="item in section.items" :key="item.id" class="row">
        <ActorAvatar :name="item.label" :img="item.img" :size="40" />
        <div class="row-main">
          <span class="row-label">{{ item.label }}</span>
          <span v-if="item.sub" class="row-sub">{{ item.sub }}</span>
          <span v-if="item.tags?.length" class="tags">
            <span v-for="tag in item.tags" :key="tag" class="tag">{{ tag }}</span>
          </span>
        </div>
        <ResourceStepper
          v-if="item.resourceId && resources[item.resourceId]"
          :resource="resources[item.resourceId]!"
          :disabled="readonly || !resources[item.resourceId]!.writable"
          :busy="busy === item.resourceId"
          compact
          @step="(id, dir) => emit('step', id, dir)"
        />
      </div>
      <p v-if="section.items.length === 0" class="empty">Nothing here yet.</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { ResourceDescriptor, SheetSection } from '@companion/adapter-sdk'

defineProps<{
  section: Extract<SheetSection, { kind: 'list' }>
  resources: Record<string, ResourceDescriptor>
  busy: string | null
  readonly: boolean
}>()

const emit = defineEmits<{ (e: 'step', resourceId: string, direction: 1 | -1): void }>()
</script>

<style scoped>
.list {
  overflow: hidden;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  min-height: 60px;
}

.row + .row {
  border-top: 1px solid var(--line);
}

.row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.row-label {
  font-weight: 600;
  font-size: 0.92rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-sub {
  font-size: 0.76rem;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tags {
  display: flex;
  gap: 4px;
  margin-top: 2px;
  flex-wrap: wrap;
}

.tag {
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 2px 7px;
  border-radius: 999px;
}

.empty {
  padding: 20px;
  text-align: center;
  color: var(--text-dim);
  font-size: 0.85rem;
}
</style>
