<template>
  <span v-if="max > 8" class="pips text" :class="{ pact }">{{ value }}/{{ max }}</span>
  <span v-else class="pips" :class="{ pact }" :title="pact ? 'Pact slots' : 'Spell slots'" aria-hidden="false"
        :aria-label="`${value} of ${max} ${pact ? 'pact ' : ''}slots left`">
    <span v-for="i in max" :key="i" class="pip" :class="{ filled: i <= value }" />
  </span>
</template>

<script setup lang="ts">
defineProps<{ value: number; max: number; pact?: boolean }>()
</script>

<style scoped>
.pips { display: inline-flex; gap: 3px; align-items: center; }
.pips.text { font-size: 0.7rem; font-weight: 700; color: var(--gold); }
.pip {
  width: 9px; height: 9px; border-radius: 2px;
  border: 1px solid color-mix(in srgb, var(--gold) 55%, transparent);
  background: transparent;
}
.pip.filled { background: linear-gradient(180deg, var(--gold-bright), var(--gold)); border-color: var(--gold-deep); }
.pips.pact .pip { border-radius: 50%; border-color: color-mix(in srgb, var(--garnet) 60%, transparent); }
.pips.pact .pip.filled { background: var(--garnet); border-color: var(--garnet); }
.pips.pact.text { color: var(--garnet); }
</style>
