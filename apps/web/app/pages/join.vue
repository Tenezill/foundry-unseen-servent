<template>
  <div class="page join">
    <div class="brand">
      <svg class="mark" viewBox="0 0 48 48" aria-hidden="true">
        <path d="M24 4 42 15v18L24 44 6 33V15Z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round" />
        <path d="M24 4v40M6 15l18 11 18-11M6 33l18-7 18 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" opacity="0.55" />
      </svg>
      <h1>Foundry&rsquo;s Unseen Servant</h1>
      <p class="tagline">Your character sheet, live from the table.</p>
    </div>

    <div v-if="state === 'checking'" class="status card">
      <span class="spinner" aria-hidden="true" />
      <p>Checking your invite&hellip;</p>
    </div>

    <div v-else-if="state === 'no-token'" class="status card">
      <p class="status-title">No invite found</p>
      <p class="status-body">
        Ask your game master for an invite link and open it on this device. It looks like
        <code>…/join#your-token</code>.
      </p>
    </div>

    <div v-else-if="state === 'invalid'" class="status card">
      <p class="status-title">This invite didn&rsquo;t work</p>
      <p class="status-body">
        The link may have expired or been revoked. Ask your game master for a fresh one.
      </p>
    </div>

    <div v-else-if="state === 'error'" class="status card">
      <p class="status-title">Can&rsquo;t reach the table</p>
      <p class="status-body">The server didn&rsquo;t answer. Check your connection and try again.</p>
      <button class="btn btn-accent retry" type="button" @click="validate">Try again</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { MeResponse } from '~/types/api'

type JoinState = 'checking' | 'no-token' | 'invalid' | 'error'

const state = ref<JoinState>('checking')
const { api } = useApi()

async function validate(): Promise<void> {
  state.value = 'checking'

  // Token arrives in the URL hash (#<token>) so it never hits server logs.
  const fromHash = window.location.hash.slice(1).trim()
  if (fromHash) {
    setToken(fromHash)
    history.replaceState(null, '', window.location.pathname)
  }

  const token = getToken()
  if (!token) {
    state.value = 'no-token'
    return
  }

  try {
    const me = await api<MeResponse>('/api/me')
    const ids = me.player.actorIds
    if (ids.length === 1 && ids[0]) {
      setLastActor(ids[0])
      await navigateTo(`/actor/${ids[0]}`, { replace: true })
    } else {
      await navigateTo('/', { replace: true })
    }
  } catch (err) {
    if (errorStatus(err) === 401) {
      clearToken()
      state.value = 'invalid'
    } else {
      state.value = 'error'
    }
  }
}

// Re-validate when only the hash changes (e.g. the invite link is pasted
// into the address bar while already sitting on /join — no remount happens).
function onHashChange(): void {
  if (window.location.hash.length > 1) void validate()
}

onMounted(() => {
  window.addEventListener('hashchange', onHashChange)
  void validate()
})

onBeforeUnmount(() => {
  window.removeEventListener('hashchange', onHashChange)
})
</script>

<style scoped>
.join {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 32px;
}

.brand {
  text-align: center;
}

.mark {
  width: 64px;
  height: 64px;
  color: var(--accent);
  margin-bottom: 12px;
}

.brand h1 {
  font-size: 1.5rem;
  font-weight: 800;
  letter-spacing: -0.01em;
}

.tagline {
  color: var(--text-dim);
  font-size: 0.9rem;
  margin-top: 4px;
}

.status {
  padding: 24px 20px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.status-title {
  font-weight: 800;
  font-size: 1.05rem;
}

.status-body {
  color: var(--text-dim);
  font-size: 0.88rem;
}

.status-body code {
  background: var(--surface-2);
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 0.82rem;
}

.retry {
  margin-top: 6px;
  width: 100%;
}

.spinner {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 3px solid var(--surface-2);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
