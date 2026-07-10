<template>
  <!-- eslint-disable-next-line vue/no-v-html -- SVG generated locally by uqr from our own string -->
  <div class="qr" role="img" :aria-label="`QR code: ${value}`" v-html="svg" />
</template>

<script setup lang="ts">
import { renderSVG } from 'uqr'

const props = defineProps<{ value: string }>()

const svg = computed(() => renderSVG(props.value, { ecc: 'M', border: 2 }))
</script>

<style scoped>
.qr {
  /* White quiet zone regardless of theme — scanners need the contrast. */
  background: #fff;
  border-radius: 12px;
  padding: 8px;
  width: min(240px, 70vw);
  margin: 0 auto;
}

.qr :deep(svg) {
  display: block;
  width: 100%;
  height: auto;
}
</style>
