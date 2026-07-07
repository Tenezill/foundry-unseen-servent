<template>
  <div class="conditions" aria-label="Active conditions">
    <span v-for="c in conditions" :key="c.id" class="badge">
      <img
        v-if="iconOf(c) && !failed[c.id]"
        class="icon"
        :src="iconOf(c)"
        alt=""
        aria-hidden="true"
        @error="failed[c.id] = true"
      />
      <span v-else class="dot" aria-hidden="true" />
      {{ c.label }}
    </span>
  </div>
</template>

<script setup lang="ts">
import type { Condition } from '@companion/adapter-sdk'

const props = defineProps<{ conditions: Condition[] }>()

const config = useRuntimeConfig()
const foundryBase = String(config.public.foundryBase || '')

const failed = reactive<Record<string, boolean>>({})

function iconOf(c: Condition): string | undefined {
  return foundryImgUrl(c.icon, foundryBase)
}
</script>

<style scoped>
.conditions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 12px 5px 8px;
  border-radius: 999px;
  font-size: 0.74rem;
  font-weight: 600;
  color: var(--garnet);
  background: color-mix(in srgb, var(--garnet) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--garnet) 34%, var(--line));
}

.icon {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  object-fit: cover;
  flex: none;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--garnet);
  box-shadow: 0 0 6px color-mix(in srgb, var(--garnet) 60%, transparent);
  flex: none;
}
</style>
