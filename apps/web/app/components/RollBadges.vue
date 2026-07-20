<template>
  <span v-if="advantage || disadvantage" class="roll-badges">
    <span v-if="advantage" class="badge adv" title="Advantage" aria-label="Advantage">A</span>
    <span v-if="disadvantage" class="badge dis" title="Disadvantage" aria-label="Disadvantage">D</span>
  </span>
</template>

<script setup lang="ts">
defineProps<{ advantage?: boolean; disadvantage?: boolean }>()
</script>

<style scoped>
.roll-badges {
  display: inline-flex;
  gap: 3px;
  margin-top: 2px;
}

.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  font-size: 0.58rem;
  font-weight: 800;
  line-height: 1;
  /* hex-die silhouette */
  clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
}

.badge.adv {
  background: #3fb950;
  color: #052e0e;
}

.badge.dis {
  background: #f85149;
  color: #2b0606;
}
</style>
