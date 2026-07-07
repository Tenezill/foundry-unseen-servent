<template>
  <div class="page">
    <header class="head">
      <h1>Choose your character</h1>
      <p v-if="playerName" class="hello">Signed in as {{ playerName }}</p>
    </header>

    <div v-if="loading" class="cards">
      <span v-for="i in 2" :key="i" class="skel card-skel" />
    </div>

    <div v-else-if="error" class="error card">
      <p>{{ error }}</p>
      <button class="btn btn-accent" type="button" @click="load">Try again</button>
    </div>

    <div v-else class="cards">
      <button
        v-for="actor in sortedActors"
        :key="actor.id"
        class="actor-card card"
        type="button"
        @click="pick(actor.id)"
      >
        <ActorAvatar :name="actor.name" :img="actor.img" :size="56" />
        <span class="actor-main">
          <span class="actor-name">{{ actor.name }}</span>
          <span class="actor-sys">{{ actor.systemId }}</span>
        </span>
        <span v-if="actor.id === lastActor" class="last-badge">Last played</span>
        <svg class="chev" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
      </button>
      <p v-if="actors.length === 0" class="empty">
        No characters are linked to your invite yet. Ask your game master.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ActorsResponse, ActorSummary, MeResponse } from '~/types/api'

const { api } = useApi()

const loading = ref(true)
const error = ref('')
const actors = ref<ActorSummary[]>([])
const playerName = ref('')
const lastActor = ref<string | null>(null)

const sortedActors = computed(() => {
  const last = lastActor.value
  if (!last) return actors.value
  return [...actors.value].sort((a, b) => (a.id === last ? -1 : b.id === last ? 1 : 0))
})

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [list, me] = await Promise.all([
      api<ActorsResponse>('/api/actors'),
      api<MeResponse>('/api/me'),
    ])
    actors.value = list.actors
    playerName.value = me.player.name
  } catch (err) {
    if (errorStatus(err) === 401) {
      clearToken()
      await navigateTo('/join', { replace: true })
      return
    }
    error.value = 'Could not load your characters. Check your connection.'
  } finally {
    loading.value = false
  }
}

async function pick(actorId: string): Promise<void> {
  setLastActor(actorId)
  await navigateTo(`/actor/${actorId}`)
}

onMounted(() => {
  if (!getToken()) {
    void navigateTo('/join', { replace: true })
    return
  }
  lastActor.value = getLastActor()
  void load()
})
</script>

<style scoped>
.head {
  padding: 16px 4px 20px;
}

.head h1 {
  font-size: 1.35rem;
  font-weight: 800;
  letter-spacing: -0.01em;
}

.hello {
  color: var(--text-dim);
  font-size: 0.85rem;
  margin-top: 2px;
}

.cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.card-skel {
  height: 84px;
  display: block;
}

.actor-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px;
  min-height: 84px;
  width: 100%;
  text-align: left;
  transition: transform 0.06s ease;
}

.actor-card:active {
  transform: scale(0.985);
}

.actor-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.actor-name {
  font-size: 1.05rem;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actor-sys {
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-dim);
}

.last-badge {
  flex: none;
  font-size: 0.64rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 4px 9px;
  border-radius: 999px;
}

.chev {
  width: 20px;
  height: 20px;
  color: var(--text-dim);
  flex: none;
}

.error {
  padding: 24px 20px;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 14px;
  color: var(--text-dim);
}

.empty {
  text-align: center;
  color: var(--text-dim);
  font-size: 0.88rem;
  padding: 24px 12px;
}
</style>
