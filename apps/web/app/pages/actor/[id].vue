<template>
  <div class="sheet-root">
    <template v-if="sheet">
      <header class="sheet-head">
        <div class="head-row">
          <NuxtLink to="/" class="back" aria-label="Back to characters">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m14 6-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
            </svg>
          </NuxtLink>
          <ActorAvatar :name="sheet.name" :img="sheet.img" :size="38" />
          <h1 class="name">{{ sheet.name }}</h1>
          <ConnectionPill :state="conn" />
        </div>
        <div class="chips-row">
          <span v-for="stat in sheet.headline" :key="stat.id" class="chip">
            <span class="chip-value">{{ stat.value }}</span>
            <span class="chip-label">{{ stat.label }}</span>
            <span v-if="stat.sub" class="chip-sub">{{ stat.sub }}</span>
          </span>
        </div>
        <div v-if="offline" class="offline-banner">
          Offline — showing your last known sheet, read-only.
        </div>
      </header>

      <main class="sheet-main">
        <template v-for="section in activeSections" :key="section.id">
          <SectionStats v-if="section.kind === 'stats'" :section="section" />
          <SectionTracks
            v-else-if="section.kind === 'tracks'"
            :section="section"
            :resources="resMap"
            :busy="busy"
            :readonly="offline"
            @step="stepResource"
            @numpad="openNumpad"
          />
          <SectionList
            v-else
            :section="section"
            :resources="resMap"
            :busy="busy"
            :readonly="offline"
            @step="stepResource"
          />
        </template>
        <p v-if="activeSections.length === 0" class="tab-empty">Nothing on this tab.</p>
      </main>

      <nav class="tabbar" aria-label="Sheet sections">
        <button
          v-for="tab in visibleTabs"
          :key="tab.id"
          class="tab"
          type="button"
          :class="{ active: activeTab === tab.id }"
          :aria-current="activeTab === tab.id ? 'page' : undefined"
          @click="activeTab = tab.id"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="tab.icon" /></svg>
          <span>{{ tab.label }}</span>
        </button>
      </nav>

      <HpNumpad
        v-if="numpadResource"
        :resource="numpadResource"
        @apply="applyNumpad"
        @close="numpadFor = null"
      />
      <ConfirmDialog
        v-if="confirmState"
        :message="confirmState.message"
        @answer="answerConfirm"
      />
    </template>

    <SkeletonSheet v-else-if="loading" />

    <div v-else class="page load-error">
      <div class="card error-card">
        <p class="error-title">Couldn&rsquo;t load this character</p>
        <p class="error-body">{{ loadError }}</p>
        <button class="btn btn-accent" type="button" @click="reload">Try again</button>
        <NuxtLink to="/" class="btn">All characters</NuxtLink>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type {
  ResourceDescriptor,
  ResourceIntent,
  SheetSection,
  SheetViewModel,
} from '@companion/adapter-sdk'
import type { ApiErrorBody, SheetResponse } from '~/types/api'

const LARGE_DELTA = 10

type TabId = 'overview' | 'resources' | 'inventory' | 'spells'

interface TabDef {
  id: TabId
  label: string
  icon: string
}

const TABS: TabDef[] = [
  {
    id: 'overview',
    label: 'Overview',
    icon: 'M12 3 3 8v13h6v-6h6v6h6V8Z',
  },
  {
    id: 'resources',
    label: 'Resources',
    icon: 'M12 21C7 16.5 3 13.2 3 9.3 3 6.4 5.2 4.5 7.7 4.5c1.7 0 3.3.9 4.3 2.4 1-1.5 2.6-2.4 4.3-2.4 2.5 0 4.7 1.9 4.7 4.8 0 3.9-4 7.2-9 11.7Z',
  },
  {
    id: 'inventory',
    label: 'Inventory',
    icon: 'M7 7V5.5A2.5 2.5 0 0 1 9.5 3h5A2.5 2.5 0 0 1 17 5.5V7h3a1 1 0 0 1 1 1v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a1 1 0 0 1 1-1Zm2 0h6V5.5a.5.5 0 0 0-.5-.5h-5a.5.5 0 0 0-.5.5Z',
  },
  {
    id: 'spells',
    label: 'Spells',
    icon: 'M12 2l2.1 5.7L20 10l-5.9 2.3L12 18l-2.1-5.7L4 10l5.9-2.3Zm7 12 1.2 3 3 1.2-3 1.2-1.2 3-1.2-3-3-1.2 3-1.2Z',
  },
]

const route = useRoute()
const actorId = computed(() => String(route.params.id))
const { api, base } = useApi()
const toast = useToast()

const sheet = ref<SheetViewModel | null>(null)
const loading = ref(true)
const loadError = ref('')
const conn = ref<'live' | 'reconnecting' | 'offline'>('reconnecting')
const activeTab = ref<TabId>('overview')
const busy = ref<string | null>(null)
const numpadFor = ref<string | null>(null)
const confirmState = ref<{ message: string; resolve: (ok: boolean) => void } | null>(null)

const offline = computed(() => conn.value === 'offline')

const resMap = computed<Record<string, ResourceDescriptor>>(() => {
  const m: Record<string, ResourceDescriptor> = {}
  for (const r of sheet.value?.resources ?? []) m[r.id] = r
  return m
})

const numpadResource = computed(() =>
  numpadFor.value ? (resMap.value[numpadFor.value] ?? null) : null,
)

/** System-agnostic tab routing: tracks -> Resources; lists by id/label keyword. */
function tabOf(section: SheetSection): TabId {
  if (section.kind === 'tracks') return 'resources'
  if (section.kind === 'stats') return 'overview'
  const key = `${section.id} ${section.label}`.toLowerCase()
  if (/spell|cantrip/.test(key)) return 'spells'
  if (/invent|item|equip|gear|loot/.test(key)) return 'inventory'
  return 'overview'
}

const sectionsByTab = computed<Record<TabId, SheetSection[]>>(() => {
  const groups: Record<TabId, SheetSection[]> = {
    overview: [],
    resources: [],
    inventory: [],
    spells: [],
  }
  for (const section of sheet.value?.sections ?? []) groups[tabOf(section)].push(section)
  return groups
})

const visibleTabs = computed(() =>
  TABS.filter((t) => t.id === 'overview' || sectionsByTab.value[t.id].length > 0),
)

const activeSections = computed(() => sectionsByTab.value[activeTab.value])

watch(visibleTabs, (tabs) => {
  if (!tabs.some((t) => t.id === activeTab.value)) activeTab.value = 'overview'
})

/* ---- sheet state -------------------------------------------------------- */

function applySheet(next: SheetViewModel): void {
  sheet.value = next
  loading.value = false
  saveCachedSheet(actorId.value, next)
}

async function fetchSheet(): Promise<void> {
  try {
    const res = await api<SheetResponse>(`/api/actors/${actorId.value}/sheet`)
    applySheet(res.sheet)
  } catch (err) {
    const status = errorStatus(err)
    if (status === 401) {
      clearToken()
      await navigateTo('/join', { replace: true })
      return
    }
    if (!sheet.value) {
      loading.value = false
      loadError.value =
        status === 404
          ? 'This character is not linked to your invite.'
          : 'The table is unreachable right now.'
    }
  }
}

function reload(): void {
  loading.value = true
  loadError.value = ''
  void fetchSheet()
  connectEvents()
}

/* ---- intents ------------------------------------------------------------ */

function askConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState.value = { message, resolve }
  })
}

function answerConfirm(ok: boolean): void {
  confirmState.value?.resolve(ok)
  confirmState.value = null
}

async function submitIntent(intent: ResourceIntent, delta: number, label: string): Promise<void> {
  if (offline.value || busy.value) return
  if (Math.abs(delta) >= LARGE_DELTA) {
    const sign = delta > 0 ? '+' : '−'
    const ok = await askConfirm(`Apply ${sign}${Math.abs(delta)} to ${label}?`)
    if (!ok) return
  }
  busy.value = intent.resourceId
  try {
    const res = await api<SheetResponse>(`/api/actors/${actorId.value}/intents`, {
      method: 'POST',
      body: intent,
    })
    applySheet(res.sheet)
  } catch (err) {
    const status = errorStatus(err)
    const data = errorData<ApiErrorBody>(err)
    if (status === 409 && data?.sheet) {
      applySheet(data.sheet)
      toast.show('Value changed elsewhere — sheet refreshed')
    } else if (status === 401) {
      clearToken()
      await navigateTo('/join', { replace: true })
    } else if (status === 429) {
      toast.show('Slow down — too many changes at once')
    } else {
      toast.show('Change didn’t go through. Try again.')
    }
  } finally {
    busy.value = null
  }
}

function stepResource(resourceId: string, direction: 1 | -1): void {
  const res = resMap.value[resourceId]
  if (!res || !res.writable) return
  const amount = (res.step ?? 1) * direction
  void submitIntent(
    { kind: 'delta', resourceId, amount, expected: res.value },
    amount,
    res.label,
  )
}

function openNumpad(resourceId: string): void {
  numpadFor.value = resourceId
}

function applyNumpad(delta: number): void {
  const target = numpadResource.value
  numpadFor.value = null
  if (!target) return
  void submitIntent(
    { kind: 'delta', resourceId: target.id, amount: delta, expected: target.value },
    delta,
    target.label,
  )
}

/* ---- live updates (SSE) -------------------------------------------------- */

let es: EventSource | null = null
let retries = 0
let reconnectTimer: ReturnType<typeof setTimeout> | undefined

function closeEvents(): void {
  es?.close()
  es = null
  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
  reconnectTimer = undefined
}

function connectEvents(): void {
  closeEvents()
  if (!navigator.onLine) {
    conn.value = 'offline'
    return
  }
  const token = getToken() ?? ''
  es = new EventSource(
    `${base}/api/actors/${actorId.value}/events?token=${encodeURIComponent(token)}`,
  )
  es.onopen = () => {
    conn.value = 'live'
    retries = 0
  }
  es.addEventListener('sheet', (event) => {
    conn.value = 'live'
    retries = 0
    try {
      applySheet(JSON.parse((event as MessageEvent<string>).data) as SheetViewModel)
    } catch {
      /* malformed frame — keep current sheet */
    }
  })
  es.onerror = () => {
    closeEvents()
    if (!navigator.onLine) {
      conn.value = 'offline'
      return
    }
    conn.value = 'reconnecting'
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(retries, 5))
    retries += 1
    reconnectTimer = setTimeout(connectEvents, delay)
  }
}

function onOnline(): void {
  conn.value = 'reconnecting'
  retries = 0
  void fetchSheet()
  connectEvents()
}

function onOffline(): void {
  conn.value = 'offline'
  closeEvents()
}

/* ---- lifecycle ------------------------------------------------------------ */

onMounted(() => {
  if (!getToken()) {
    void navigateTo('/join', { replace: true })
    return
  }
  setLastActor(actorId.value)

  const cached = loadCachedSheet(actorId.value)
  if (cached) {
    sheet.value = cached
    loading.value = false
  }

  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)

  if (!navigator.onLine) {
    conn.value = 'offline'
    loading.value = false
    if (!sheet.value) loadError.value = 'You are offline and no saved sheet exists yet.'
    return
  }

  void fetchSheet()
  connectEvents()
})

onBeforeUnmount(() => {
  closeEvents()
  window.removeEventListener('online', onOnline)
  window.removeEventListener('offline', onOffline)
})
</script>

<style scoped>
.sheet-root {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
}

/* ---- header ---- */

.sheet-head {
  position: sticky;
  top: 0;
  z-index: 30;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--line);
  padding: calc(10px + var(--safe-top)) 16px 10px;
}

.head-row {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 560px;
  margin: 0 auto;
}

.back {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  margin-left: -8px;
  border-radius: 12px;
  color: var(--text-dim);
}

.back svg {
  width: 22px;
  height: 22px;
}

.name {
  flex: 1;
  min-width: 0;
  font-size: 1.1rem;
  font-weight: 800;
  letter-spacing: -0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chips-row {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding: 10px 0 2px;
  max-width: 560px;
  margin: 0 auto;
  scrollbar-width: none;
}

.chips-row::-webkit-scrollbar {
  display: none;
}

.offline-banner {
  max-width: 560px;
  margin: 10px auto 0;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 0.78rem;
  font-weight: 600;
  text-align: center;
}

/* ---- content ---- */

.sheet-main {
  flex: 1;
  width: 100%;
  max-width: 560px;
  margin: 0 auto;
  padding: 4px 16px calc(96px + var(--safe-bottom));
}

.tab-empty {
  text-align: center;
  color: var(--text-dim);
  font-size: 0.88rem;
  padding: 48px 12px;
}

/* ---- bottom tabs ---- */

.tabbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 40;
  display: flex;
  justify-content: center;
  gap: 4px;
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-top: 1px solid var(--line);
  padding: 6px 8px calc(6px + var(--safe-bottom));
}

.tab {
  flex: 1;
  max-width: 132px;
  min-height: 52px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  border-radius: 12px;
  color: var(--text-dim);
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.03em;
}

.tab svg {
  width: 22px;
  height: 22px;
  fill: currentColor;
}

.tab.active {
  color: var(--accent);
  background: var(--accent-soft);
}

/* ---- error state ---- */

.load-error {
  display: flex;
  align-items: center;
}

.error-card {
  width: 100%;
  padding: 26px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  text-align: center;
}

.error-title {
  font-weight: 800;
  font-size: 1.05rem;
}

.error-body {
  color: var(--text-dim);
  font-size: 0.88rem;
}
</style>
