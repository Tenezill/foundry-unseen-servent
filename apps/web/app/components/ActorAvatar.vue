<template>
  <span class="avatar" :style="{ width: size + 'px', height: size + 'px' }">
    <img
      v-if="img && !failed"
      :src="img"
      :alt="name"
      loading="lazy"
      @error="failed = true"
    />
    <span v-else class="initial" :style="{ fontSize: size * 0.42 + 'px' }">{{ initial }}</span>
  </span>
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{ name: string; img?: string; size?: number }>(), {
  img: undefined,
  size: 48,
})

const failed = ref(false)
watch(
  () => props.img,
  () => {
    failed.value = false
  },
)

const initial = computed(() => (props.name.trim().charAt(0) || '?').toUpperCase())
</script>

<style scoped>
.avatar {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  overflow: hidden;
  background: var(--accent-soft);
  border: 1px solid var(--line);
}

.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.initial {
  font-weight: 800;
  color: var(--accent);
}
</style>
