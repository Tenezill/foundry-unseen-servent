<template>
  <div class="app-root">
    <NuxtPwaManifest />
    <NuxtPage />
    <ToastHost />
  </div>
</template>

<script setup lang="ts">
// App shell: pages + global toast outlet. All state lives in pages/composables.
onMounted(() => {
  applyStoredTheme()
})
</script>
