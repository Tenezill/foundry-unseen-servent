<template>
  <div v-if="mode" class="install card">
    <img class="badge" src="/icons/icon-192.png" alt="" aria-hidden="true" />
    <div class="body">
      <p class="title">Put it on your home screen</p>
      <p v-if="mode === 'native'" class="hint">One tap — opens full-screen like a real app.</p>
      <p v-else class="hint">Tap <strong>Share</strong> <span aria-hidden="true">⎋</span> then <strong>Add to Home Screen</strong>.</p>
    </div>
    <button v-if="mode === 'native'" class="btn btn-accent" type="button" @click="install()">Install</button>
    <button class="close" type="button" aria-label="Dismiss install hint" @click="dismiss()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M6 6l12 12M18 6 6 18" stroke-linecap="round" />
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
const { mode, install, dismiss } = useInstallPrompt()
</script>

<style scoped>
.install {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  margin-top: 16px;
}

.badge {
  width: 44px;
  height: 44px;
  flex: none;
}

.body {
  flex: 1;
  min-width: 0;
}

.title {
  font-weight: 700;
  font-size: 0.9rem;
}

.hint {
  font-size: 0.78rem;
  color: var(--ink-dim);
  margin-top: 2px;
}

.btn {
  flex: none;
  padding: 8px 16px;
}

.close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  color: var(--ink-faint);
}

.close svg {
  width: 16px;
  height: 16px;
}
</style>
