<template>
  <div class="toast-host" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="t in toasts" :key="t.id" class="toast">{{ t.message }}</div>
    </TransitionGroup>
  </div>
</template>

<script setup lang="ts">
const { toasts } = useToast()
</script>

<style scoped>
.toast-host {
  position: fixed;
  left: 0;
  right: 0;
  bottom: calc(84px + var(--safe-bottom));
  z-index: 80;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
  padding: 0 16px;
}

.toast {
  background: var(--surface-2);
  border: 1px solid var(--line);
  color: var(--text);
  font-size: 0.85rem;
  padding: 10px 16px;
  border-radius: 999px;
  box-shadow: var(--shadow);
  max-width: 100%;
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
