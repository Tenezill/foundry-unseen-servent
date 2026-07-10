<template>
  <div class="page admin">
    <header class="head">
      <h1>Player links</h1>
      <button v-if="state === 'console'" class="logout" type="button" @click="logout">Log out</button>
    </header>

    <!-- login -->
    <form v-if="state === 'login'" class="card login" @submit.prevent="login">
      <p class="hint">Enter the admin password from the gateway's <code>.env</code>.</p>
      <input
        v-model="password"
        type="password"
        class="pw"
        placeholder="Admin password"
        autocomplete="current-password"
      />
      <button class="btn btn-accent" type="submit" :disabled="busy || password === ''">Log in</button>
      <p v-if="loginError" class="error-text">{{ loginError }}</p>
    </form>

    <!-- feature disabled -->
    <div v-else-if="state === 'disabled'" class="card status">
      <p class="status-title">Admin access is not enabled on this server</p>
      <p class="hint">Set <code>ADMIN_PASSWORD</code> in the gateway's <code>.env</code> and restart it.</p>
    </div>

    <!-- console -->
    <template v-else-if="state === 'console'">
      <button class="btn btn-accent new-player" type="button" @click="openCreate">+ New player</button>

      <div v-if="players.length === 0" class="card status">
        <p class="hint">No players linked yet. Create the first invite.</p>
      </div>

      <div v-for="p in players" :key="p.name" class="card player-row">
        <div class="player-main">
          <span class="player-name">{{ p.name }} <span v-if="p.gm" class="gm-badge">GM</span></span>
          <span class="player-actors">{{ p.actors.map((a) => a.name ?? a.id).join(', ') }}</span>
        </div>
        <div class="row-actions">
          <button class="btn small" type="button" :disabled="busy" @click="rotate(p.name)">New link</button>
          <button class="btn small danger" type="button" :disabled="busy" @click="revoke(p.name)">Revoke</button>
        </div>
      </div>
    </template>

    <!-- new player sheet -->
    <div v-if="createOpen" class="scrim" @click.self="createOpen = false">
      <div class="modal-sheet" role="dialog" aria-modal="true" aria-label="New player">
        <h2 class="sheet-title">New player</h2>
        <input v-model="newName" class="pw" placeholder="Player name" />
        <input v-model="actorQuery" class="pw" placeholder="Search characters…" @input="searchActors" />
        <div v-if="actorResults.length" class="actor-results">
          <button
            v-for="a in actorResults"
            :key="a.id"
            class="actor-hit"
            type="button"
            @click="toggleActor(a)"
          >
            {{ selectedActors.some((s) => s.id === a.id) ? '✓ ' : '' }}{{ a.name }}
          </button>
        </div>
        <p v-if="selectedActors.length" class="hint">
          Linked: {{ selectedActors.map((a) => a.name).join(', ') }}
        </p>
        <button
          class="btn btn-accent"
          type="button"
          :disabled="busy || newName.trim() === '' || selectedActors.length === 0"
          @click="create"
        >
          Create invite
        </button>
      </div>
    </div>

    <!-- invite result (create + rotate) -->
    <div v-if="invite" class="scrim" @click.self="invite = null">
      <div class="modal-sheet" role="dialog" aria-modal="true" aria-label="Invite link">
        <h2 class="sheet-title">Invite for {{ invite.name }}</h2>
        <QrCode :value="invite.link" />
        <p class="invite-link">{{ invite.link }}</p>
        <button class="btn btn-accent" type="button" @click="copy">Copy link</button>
        <p class="hint once">Shown once — it isn't stored anywhere. Closing this discards it.</p>
        <button class="btn" type="button" @click="invite = null">Done</button>
      </div>
    </div>

    <ConfirmDialog
      v-if="confirmState"
      :message="confirmState.message"
      @answer="answerConfirm"
    />
  </div>
</template>

<script setup lang="ts">
import type { AdminActorsResponse, AdminInviteResponse, AdminPlayer, AdminPlayersResponse } from '~/types/api'

type AdminState = 'login' | 'disabled' | 'console'

const { adminApi } = useAdminApi()
const toast = useToast()

const state = ref<AdminState>('login')
const password = ref('')
const loginError = ref('')
const busy = ref(false)
const players = ref<AdminPlayer[]>([])
const confirmState = ref<{ message: string; resolve: (ok: boolean) => void } | null>(null)

const createOpen = ref(false)
const newName = ref('')
const actorQuery = ref('')
const actorResults = ref<Array<{ id: string; name: string }>>([])
const selectedActors = ref<Array<{ id: string; name: string }>>([])

const invite = ref<{ name: string; link: string } | null>(null)

function askConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState.value = { message, resolve }
  })
}

function answerConfirm(ok: boolean): void {
  confirmState.value?.resolve(ok)
  confirmState.value = null
}

async function loadPlayers(): Promise<void> {
  const res = await adminApi<AdminPlayersResponse>('/api/admin/players')
  players.value = res.players
  state.value = 'console'
}

async function boot(): Promise<void> {
  if (!getAdminSecret()) {
    state.value = 'login'
    return
  }
  try {
    await loadPlayers()
  } catch (err) {
    const status = errorStatus(err)
    if (status === 404) state.value = 'disabled'
    else {
      clearAdminSecret()
      state.value = 'login'
    }
  }
}

async function login(): Promise<void> {
  busy.value = true
  loginError.value = ''
  setAdminSecret(password.value)
  try {
    await loadPlayers()
    password.value = ''
  } catch (err) {
    clearAdminSecret()
    const status = errorStatus(err)
    if (status === 401) {
      loginError.value = 'Wrong password.'
    } else if (status === 404) {
      loginError.value = 'Admin access is not enabled on this server.'
    } else {
      loginError.value = "Couldn't reach the server."
    }
  } finally {
    busy.value = false
  }
}

function logout(): void {
  clearAdminSecret()
  players.value = []
  // Close every overlay: a modal must not survive into the login screen
  // (the invite sheet may still hold a shown-once token).
  createOpen.value = false
  invite.value = null
  confirmState.value?.resolve(false)
  confirmState.value = null
  state.value = 'login'
}

/** Any 401 mid-session drops the credential back to the login state. */
async function guarded<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (err) {
    if (errorStatus(err) === 401) {
      logout()
      toast.show('Session expired — log in again.')
      return null
    }
    throw err
  }
}

function openCreate(): void {
  newName.value = ''
  actorQuery.value = ''
  actorResults.value = []
  selectedActors.value = []
  createOpen.value = true
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
function searchActors(): void {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(async () => {
    const q = actorQuery.value.trim()
    if (q === '') {
      actorResults.value = []
      return
    }
    try {
      const res = await guarded(() =>
        adminApi<AdminActorsResponse>(`/api/admin/actors?q=${encodeURIComponent(q)}`),
      )
      if (res) actorResults.value = res.actors
    } catch {
      toast.show('Character search failed.')
    }
  }, 250)
}

function toggleActor(a: { id: string; name: string }): void {
  const i = selectedActors.value.findIndex((s) => s.id === a.id)
  if (i === -1) selectedActors.value.push(a)
  else selectedActors.value.splice(i, 1)
}

function joinLink(token: string): string {
  return `${location.origin}/join#${token}`
}

async function create(): Promise<void> {
  busy.value = true
  try {
    const res = await guarded(() =>
      adminApi<AdminInviteResponse>('/api/admin/players', {
        method: 'POST',
        body: { name: newName.value.trim(), actorIds: selectedActors.value.map((a) => a.id) },
      }),
    )
    if (!res) return
    createOpen.value = false
    invite.value = { name: newName.value.trim(), link: joinLink(res.token) }
    // The invite itself succeeded — a failing list refresh must not relabel
    // it as failed. A 401 here still drops the credential (guarded → logout).
    try {
      await guarded(() => loadPlayers())
    } catch {
      /* refresh failed — console keeps the stale list */
    }
  } catch (err) {
    toast.show(errorStatus(err) === 409 ? 'That name already exists.' : 'Couldn’t create the invite.')
  } finally {
    busy.value = false
  }
}

async function rotate(name: string): Promise<void> {
  const ok = await askConfirm(`Create a new link for ${name}? The old link stops working immediately.`)
  if (!ok) return
  busy.value = true
  try {
    const res = await guarded(() =>
      adminApi<AdminInviteResponse>(`/api/admin/players/${encodeURIComponent(name)}/rotate`, { method: 'POST' }),
    )
    if (res) invite.value = { name, link: joinLink(res.token) }
  } catch {
    toast.show('Couldn’t rotate the link.')
  } finally {
    busy.value = false
  }
}

async function revoke(name: string): Promise<void> {
  const ok = await askConfirm(`Revoke ${name}'s access? This cuts them off immediately.`)
  if (!ok) return
  busy.value = true
  try {
    const res = await guarded(async () => {
      await adminApi(`/api/admin/players/${encodeURIComponent(name)}`, { method: 'DELETE' })
      return true
    })
    if (res) {
      toast.show(`Revoked ${name}`)
      // The revoke itself succeeded — a failing list refresh must not relabel
      // it as failed. A 401 here still drops the credential (guarded → logout).
      try {
        await guarded(() => loadPlayers())
      } catch {
        /* refresh failed — console keeps the stale list */
      }
    }
  } catch {
    toast.show('Couldn’t revoke that player.')
  } finally {
    busy.value = false
  }
}

async function copy(): Promise<void> {
  if (!invite.value) return
  try {
    await navigator.clipboard.writeText(invite.value.link)
    toast.show('Link copied')
  } catch {
    toast.show('Copy failed — long-press the link to copy it manually.')
  }
}

onMounted(() => void boot())

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})
</script>

<style scoped>
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 4px 20px;
}

.head h1 {
  font-size: 1.35rem;
  font-weight: 800;
  letter-spacing: -0.01em;
}

.logout {
  color: var(--text-dim);
  font-size: 0.85rem;
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 6px 12px;
}

.login,
.status {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}

.status-title {
  font-weight: 700;
}

.hint {
  color: var(--text-dim);
  font-size: 0.85rem;
}

.error-text {
  color: var(--garnet);
  font-size: 0.85rem;
}

.pw {
  min-height: 44px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: transparent;
  color: inherit;
  padding: 0 12px;
  font-size: 1rem;
}

.new-player {
  width: 100%;
  margin-bottom: 12px;
}

.player-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  margin-bottom: 10px;
}

.player-name {
  font-weight: 700;
}

.gm-badge {
  font-size: 0.7rem;
  font-weight: 800;
  color: var(--gold-bright);
  border: 1px solid currentcolor;
  border-radius: 6px;
  padding: 1px 5px;
  margin-left: 4px;
  vertical-align: middle;
}

.player-actors {
  display: block;
  color: var(--text-dim);
  font-size: 0.8rem;
  margin-top: 2px;
}

.row-actions {
  display: flex;
  gap: 8px;
  flex: none;
}

.btn.small {
  font-size: 0.8rem;
  padding: 8px 10px;
}

.btn.danger {
  color: var(--garnet);
  border-color: color-mix(in srgb, var(--garnet) 34%, transparent);
}

.sheet-title {
  font-family: var(--serif);
  font-size: 1.15rem;
  margin-bottom: 12px;
}

.modal-sheet {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.actor-results {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 30dvh;
  overflow-y: auto;
}

.actor-hit {
  text-align: left;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 12px;
}

.invite-link {
  font-size: 0.8rem;
  color: var(--text-dim);
  overflow-wrap: anywhere;
  text-align: center;
}

.once {
  text-align: center;
}
</style>
