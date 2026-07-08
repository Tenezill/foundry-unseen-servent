<template>
  <div class="sheet-root">
    <template v-if="sheet">
      <div class="frame">
        <div class="toolbar">
          <NuxtLink to="/" class="tool back" aria-label="Back to characters">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m14 6-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </NuxtLink>
          <span class="tool-spacer" />
          <button class="tool" type="button" aria-label="Roll history" @click="showLog = true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M12 8v4l3 2M4 12a8 8 0 1 0 2-5.3M4 4v3h3" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <button class="tool" type="button" :aria-label="isDark ? 'Switch to light theme' : 'Switch to dark theme'" @click="theme.toggle()">
            <svg v-if="isDark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke-linecap="round" />
            </svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" stroke-linejoin="round" />
            </svg>
          </button>
        </div>

        <SheetHero :sheet="sheet" :conn="conn" :readonly="offline" @numpad="openNumpad" @action="onAction" />

        <ConcentrationBanner
          v-if="sheet.concentration"
          :label="sheet.concentration.label"
          :busy="actionBusy === 'concentration.end'"
          :readonly="offline"
          @end="onEndConcentration"
        />

        <ConditionBadges v-if="sheet.conditions?.length" :conditions="sheet.conditions" />

        <div v-if="offline" class="offline-banner">
          Offline — showing your last known sheet, read-only.
        </div>

        <main class="sheet-main">
          <SectionActions
            v-if="activeTab === 'actions'"
            :actions="combatActions"
            :action-busy="actionBusy"
            :readonly="offline"
            @action="onCombatAction"
          />

          <template v-if="activeTab === 'resources'">
            <RestControls
              v-if="hasRest"
              :has-short="!!actionMap['rest.short']"
              :has-long="!!actionMap['rest.long']"
              :busy="actionBusy"
              :readonly="offline"
              @rest="onRest"
            />
            <DeathSavePanel
              v-if="dying && deathSuccess && deathFailure"
              :success="deathSuccess"
              :failure="deathFailure"
              :busy="busy"
              :action-busy="actionBusy === 'deathsave.roll'"
              :readonly="offline"
              @step="stepResource"
              @roll="onDeathSave"
            />
          </template>

          <button
            v-if="tabAddEntry && !offline"
            class="lib-add"
            type="button"
            @click="openLibrary(tabAddEntry.id)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke-linecap="round" />
            </svg>
            {{ tabAddEntry.label }}
          </button>

          <template v-for="section in renderableSections" :key="section.id">
            <SectionStats
              v-if="section.kind === 'stats'"
              :section="section"
              :variant="section.id === 'abilities' ? 'gems' : 'cards'"
              :readonly="offline"
              :busy="actionBusy"
              @action="onAction"
            />
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
              :actions="actionMap"
              :busy="busy"
              :action-busy="actionBusy"
              :readonly="offline"
              @step="stepResource"
              @action="onAction"
              @detail="onDetail"
            />
          </template>

          <CurrencyWallet
            v-if="activeTab === 'resources' && walletResources.length"
            :resources="walletResources"
            :busy="busy"
            :readonly="offline"
            @step="stepResource"
          />

          <p v-if="tabEmpty" class="tab-empty">Nothing on this tab.</p>
        </main>
      </div>

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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path :d="tab.icon" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>{{ tab.label }}</span>
        </button>
      </nav>

      <HpNumpad
        v-if="numpadResource"
        :resource="numpadResource"
        @apply="applyNumpad"
        @close="numpadFor = null"
      />
      <ActionSheet
        v-if="sheetAction"
        :action="sheetAction"
        :busy="actionBusy !== null"
        @submit="onActionSubmit"
        @close="actionSheetFor = null"
      />
      <DetailDialog
        v-if="detailFor"
        :title="detailFor.title"
        :detail="detailFor.detail"
        :danger="detailFor.removable && !offline ? REMOVE_LABELS[detailFor.removable] ?? 'Remove' : undefined"
        :danger-busy="removeBusy"
        @danger="onRemove"
        @close="detailFor = null"
      />
      <LibrarySearch
        v-if="libraryCollection"
        :add-label="libraryAddLabel"
        :results="libResults"
        :preview="libPreview"
        :preview-uuid="libPreviewUuid"
        :known-names="knownNames"
        :busy="libBusy"
        :searching="libSearching"
        @search="onLibrarySearch"
        @preview="onLibraryPreview"
        @add="onLibraryAdd"
        @back="libPreview = null"
        @close="closeLibrary"
      />
      <RollLog v-if="showLog" :entries="rollHistory" @close="showLog = false" />
      <RollResultPill
        v-if="lastRoll"
        :result="lastRoll.result"
        :label="lastRoll.label"
        @dismiss="dismissRoll"
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
  ActionDescriptor,
  ActionIntent,
  ListItem,
  ResourceDescriptor,
  ResourceIntent,
  SheetSection,
  SheetViewModel,
} from '@companion/adapter-sdk'
import type {
  ActionResponse,
  ActionRollResult,
  ApiErrorBody,
  LibraryPreviewResponse,
  LibrarySearchEntry,
  LibrarySearchResponse,
  RollLogEntry,
  SheetResponse,
} from '~/types/api'

const LARGE_DELTA = 10
const ROLL_HISTORY_MAX = 20

type TabId = 'overview' | 'actions' | 'resources' | 'inventory' | 'spells'

interface TabDef {
  id: TabId
  label: string
  icon: string
}

const TABS: TabDef[] = [
  { id: 'overview', label: 'Overview', icon: 'M3 11l9-8 9 8M5 10v10h14V10' },
  { id: 'actions', label: 'Actions', icon: 'M13 2 4 14h6l-1 8 9-12h-6z' },
  { id: 'resources', label: 'Vitals', icon: 'M12 21s-7-4.5-7-10a4 4 0 0 1 8-1 4 4 0 0 1 8 1c0 5.5-7 10-7 10z' },
  { id: 'inventory', label: 'Gear', icon: 'M4 7h16v13H4zM9 7V4h6v3' },
  { id: 'spells', label: 'Spells', icon: 'M12 3l2 5 5 .5-4 3.5 1.5 5-4.5-3-4.5 3 1.5-5-4-3.5 5-.5z' },
]

/** Which tab surfaces the "add" button for each library collection. */
const COLLECTION_TAB: Record<string, TabId> = {
  spells: 'spells',
  feats: 'overview',
  gear: 'inventory',
}

/** Destructive detail-action label per collection (labels-only vocab). */
const REMOVE_LABELS: Record<string, string> = {
  spells: 'Forget spell',
  feats: 'Remove feat',
  gear: 'Remove item',
}

const route = useRoute()
const actorId = computed(() => String(route.params.id))
const { api, base } = useApi()
const toast = useToast()
const theme = useTheme()

const sheet = ref<SheetViewModel | null>(null)
const loading = ref(true)
const loadError = ref('')
const conn = ref<'live' | 'reconnecting' | 'offline'>('reconnecting')
const activeTab = ref<TabId>('overview')
const busy = ref<string | null>(null)
const numpadFor = ref<string | null>(null)
const confirmState = ref<{ message: string; resolve: (ok: boolean) => void } | null>(null)
const detailFor = ref<{ title: string; detail: string; itemId?: string; removable?: string } | null>(null)
const showLog = ref(false)

const offline = computed(() => conn.value === 'offline')

const isDark = computed(() => {
  void theme.choice.value // recompute when the override changes
  return theme.effective() === 'dark'
})

const resMap = computed<Record<string, ResourceDescriptor>>(() => {
  const m: Record<string, ResourceDescriptor> = {}
  for (const r of sheet.value?.resources ?? []) m[r.id] = r
  return m
})

const numpadResource = computed(() =>
  numpadFor.value ? (resMap.value[numpadFor.value] ?? null) : null,
)

const actionMap = computed<Record<string, ActionDescriptor>>(() => {
  const m: Record<string, ActionDescriptor> = {}
  for (const a of sheet.value?.actions ?? []) m[a.id] = a
  return m
})

const actionBusy = ref<string | null>(null)
const actionSheetFor = ref<string | null>(null)

const sheetAction = computed(() =>
  actionSheetFor.value ? (actionMap.value[actionSheetFor.value] ?? null) : null,
)

/* ---- M8 derived vitals -------------------------------------------------- */

const hpValue = computed(() => resMap.value.hp?.value ?? 1)
const dying = computed(() => hpValue.value <= 0)
const deathSuccess = computed(() => resMap.value['deathsaves.success'])
const deathFailure = computed(() => resMap.value['deathsaves.failure'])
const hasRest = computed(() => !!actionMap.value['rest.short'] || !!actionMap.value['rest.long'])
const walletResources = computed(() =>
  (sheet.value?.resources ?? []).filter((r) => r.group === 'currency'),
)

/* ---- tab routing -------------------------------------------------------- */

function tabOf(section: SheetSection): TabId {
  if (section.kind === 'tracks') return 'resources'
  const key = `${section.id} ${section.label}`.toLowerCase()
  // Gear-scoped stats (M12 'gearstats') live on the Gear tab with the list.
  if (section.kind === 'stats') {
    return /invent|item|equip|gear|loot/.test(key) ? 'inventory' : 'overview'
  }
  if (/spell|cantrip/.test(key)) return 'spells'
  if (/invent|item|equip|gear|loot/.test(key)) return 'inventory'
  return 'overview'
}

const sectionsByTab = computed<Record<TabId, SheetSection[]>>(() => {
  const groups: Record<TabId, SheetSection[]> = {
    overview: [],
    actions: [],
    resources: [],
    inventory: [],
    spells: [],
  }
  for (const section of sheet.value?.sections ?? []) groups[tabOf(section)].push(section)
  return groups
})

const combatActions = computed(() =>
  (sheet.value?.actions ?? []).filter(
    (a) => a.kind === 'attack' || a.kind === 'cast' || a.kind === 'use',
  ),
)

const visibleTabs = computed(() =>
  TABS.filter((t) => {
    if (t.id === 'overview') return true
    if (t.id === 'actions') return combatActions.value.length > 0
    return sectionsByTab.value[t.id].length > 0
  }),
)

const activeSections = computed(() => sectionsByTab.value[activeTab.value])

/** The library collection whose add-button belongs on the active tab, if any. */
const tabAddEntry = computed(() =>
  (sheet.value?.library ?? []).find((c) => COLLECTION_TAB[c.id] === activeTab.value),
)

/** Death saves and currency are rendered by dedicated M8 panels, not inline. */
const renderableSections = computed(() =>
  activeSections.value.filter((s) => s.id !== 'deathsaves' && s.id !== 'currency'),
)

const tabEmpty = computed(() => {
  if (activeTab.value === 'actions') return false
  if (renderableSections.value.length > 0) return false
  if (activeTab.value === 'resources' && (walletResources.value.length > 0 || hasRest.value || dying.value)) {
    return false
  }
  return true
})

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

/* ---- roll results, history & haptics (M6/M8) ---------------------------- */

const lastRoll = ref<{ result: ActionRollResult; label: string } | null>(null)
const rollHistory = ref<RollLogEntry[]>([])
let rollSeq = 0
let rollTimer: ReturnType<typeof setTimeout> | undefined

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

function haptics(result: ActionRollResult): void {
  if (prefersReducedMotion() || typeof navigator === 'undefined' || !navigator.vibrate) return
  try {
    if (result.isCritical) navigator.vibrate([0, 40, 30, 40])
    else if (result.isFumble) navigator.vibrate([0, 60])
    else navigator.vibrate(12)
  } catch {
    /* vibration unsupported / blocked — ignore */
  }
}

function showRoll(result: ActionRollResult, label: string): void {
  lastRoll.value = { result, label }
  rollHistory.value.unshift({
    id: ++rollSeq,
    label,
    total: result.total,
    formula: result.formula,
    isCritical: result.isCritical === true,
    isFumble: result.isFumble === true,
  })
  if (rollHistory.value.length > ROLL_HISTORY_MAX) {
    rollHistory.value = rollHistory.value.slice(0, ROLL_HISTORY_MAX)
  }
  haptics(result)
  if (rollTimer !== undefined) clearTimeout(rollTimer)
  rollTimer = setTimeout(() => (lastRoll.value = null), 6000)
}

function dismissRoll(): void {
  if (rollTimer !== undefined) clearTimeout(rollTimer)
  rollTimer = undefined
  lastRoll.value = null
}

/* ---- actions (M6/M8) ---------------------------------------------------- */

function onAction(actionId: string): void {
  if (offline.value || actionBusy.value) return
  const action = actionMap.value[actionId]
  if (!action) return
  switch (action.kind) {
    case 'check':
    case 'save':
    case 'cast':
      actionSheetFor.value = actionId
      break
    case 'attack':
      void submitAction({ kind: 'attack', actionId }, action.label)
      break
    case 'use':
      void submitAction({ kind: 'use', actionId }, action.label)
      break
    case 'equip':
      void submitAction(
        { kind: 'equip', actionId, equipped: !(action.equipped ?? false) },
        action.label,
      )
      break
    case 'prepare':
      void submitAction(
        { kind: 'prepare', actionId, prepared: !(action.prepared ?? false) },
        action.label,
      )
      break
    case 'attune':
      void submitAction(
        { kind: 'attune', actionId, attuned: !(action.attuned ?? false) },
        action.label,
      )
      break
  }
}

function onCombatAction(actionId: string): void {
  if (offline.value || actionBusy.value) return
  const action = actionMap.value[actionId]
  if (!action) return
  if (action.kind === 'cast') {
    if (action.slotLevels === undefined) {
      void submitAction({ kind: 'cast', actionId }, action.label)
      return
    }
    if (action.slotLevels.length === 0) return
  }
  onAction(actionId)
}

function onActionSubmit(intent: ActionIntent): void {
  const label = actionMap.value[intent.actionId]?.label ?? 'Roll'
  actionSheetFor.value = null
  void submitAction(intent, label)
}

async function onRest(kind: 'short' | 'long'): Promise<void> {
  if (offline.value || actionBusy.value) return
  const actionId = kind === 'long' ? 'rest.long' : 'rest.short'
  if (!actionMap.value[actionId]) return
  if (kind === 'long') {
    const ok = await askConfirm('Take a long rest? Restores HP, slots, and abilities.')
    if (!ok) return
  }
  void submitAction({ kind: 'rest', actionId }, kind === 'long' ? 'Long Rest' : 'Short Rest')
}

function onDeathSave(): void {
  if (offline.value || actionBusy.value) return
  if (!actionMap.value['deathsave.roll']) return
  void submitAction({ kind: 'deathsave', actionId: 'deathsave.roll' }, 'Death Save')
}

function onEndConcentration(): void {
  if (offline.value || actionBusy.value) return
  const label = sheet.value?.concentration?.label ?? 'Concentration'
  void submitAction({ kind: 'endconcentration', actionId: 'concentration.end' }, `End ${label}`)
}

function onDetail(item: ListItem): void {
  // Open the sheet when there is a description to read OR a reachable remove
  // action to host — description-less gear/feats are still removable (M13).
  if (!item.detail && !(item.removable && !offline.value)) return
  detailFor.value = {
    title: item.label,
    detail: item.detail ?? '',
    itemId: item.id,
    ...(item.removable ? { removable: item.removable } : {}),
  }
}

/* ---- library: search -> preview -> add / remove ------------------------- */

/** Active library collection id (null = search sheet closed). */
const libraryCollection = ref<string | null>(null)
const libResults = ref<LibrarySearchEntry[]>([])
const libPreview = ref<ListItem | null>(null)
const libPreviewUuid = ref<string | null>(null)
const libBusy = ref(false)
const libSearching = ref(false)
const removeBusy = ref(false)

const libraryAddLabel = computed(
  () =>
    (sheet.value?.library ?? []).find((c) => c.id === libraryCollection.value)?.label ?? 'Add',
)

/** Names already on the sheet for the active collection (case-insensitive hint). */
const knownNames = computed(() => {
  const cid = libraryCollection.value
  if (!cid) return []
  const names: string[] = []
  for (const s of sheet.value?.sections ?? []) {
    if (s.kind === 'list') for (const i of s.items) if (i.removable === cid) names.push(i.label)
  }
  return names
})

function openLibrary(collection: string): void {
  libResults.value = []
  libPreview.value = null
  libPreviewUuid.value = null
  libraryCollection.value = collection
}

function closeLibrary(): void {
  libraryCollection.value = null
  libPreview.value = null
  libPreviewUuid.value = null
}

async function onLibrarySearch(q: string): Promise<void> {
  const collection = libraryCollection.value
  if (!collection || q.trim() === '') {
    libResults.value = []
    return
  }
  libSearching.value = true
  try {
    const res = await api<LibrarySearchResponse>(
      `/api/actors/${actorId.value}/library/${collection}/search?q=${encodeURIComponent(q.trim())}`,
    )
    libResults.value = res.results
  } catch {
    toast.show('Search failed. Try again.')
  } finally {
    libSearching.value = false
  }
}

async function onLibraryPreview(uuid: string): Promise<void> {
  const collection = libraryCollection.value
  if (!collection) return
  libBusy.value = true
  try {
    const res = await api<LibraryPreviewResponse>(
      `/api/actors/${actorId.value}/library/${collection}/preview?uuid=${encodeURIComponent(uuid)}`,
    )
    libPreview.value = res.preview
    libPreviewUuid.value = uuid
  } catch {
    toast.show('Couldn’t load that entry.')
  } finally {
    libBusy.value = false
  }
}

async function onLibraryAdd(uuid: string): Promise<void> {
  const collection = libraryCollection.value
  if (!collection) return
  libBusy.value = true
  const name = libPreview.value?.label ?? 'entry'
  try {
    const res = await api<SheetResponse>(`/api/actors/${actorId.value}/library/${collection}/add`, {
      method: 'POST',
      body: { uuid },
    })
    applySheet(res.sheet)
    toast.show(`Added ${name}`)
    closeLibrary()
  } catch {
    toast.show('That didn’t go through. Try again.')
  } finally {
    libBusy.value = false
  }
}

async function onRemove(): Promise<void> {
  const target = detailFor.value
  if (!target?.itemId || !target.removable || removeBusy.value) return
  const ok = await askConfirm(`Remove ${target.title}? This removes it from your sheet.`)
  if (!ok) return
  removeBusy.value = true
  try {
    const res = await api<SheetResponse>(
      `/api/actors/${actorId.value}/library/${target.removable}/${target.itemId}`,
      { method: 'DELETE' },
    )
    applySheet(res.sheet)
    detailFor.value = null
    toast.show(`Removed ${target.title}`)
  } catch {
    toast.show('Couldn’t remove that.')
  } finally {
    removeBusy.value = false
  }
}

async function submitAction(intent: ActionIntent, label: string): Promise<void> {
  if (offline.value || actionBusy.value) return
  actionBusy.value = intent.actionId
  try {
    const res = await api<ActionResponse>(`/api/actors/${actorId.value}/actions`, {
      method: 'POST',
      body: intent,
    })
    applySheet(res.sheet)
    if (res.result) {
      showRoll(res.result, label)
      return
    }
    switch (intent.kind) {
      case 'equip':
        toast.show(`${label} ${intent.equipped ? 'equipped' : 'unequipped'}`)
        break
      case 'attune':
        toast.show(`${label} ${intent.attuned ? 'attuned' : 'attunement ended'}`)
        break
      case 'rest':
        toast.show(`${label} complete`)
        break
      case 'endconcentration':
        toast.show('Concentration ended')
        break
      case 'deathsave':
        toast.show('Death save rolled — see Foundry chat')
        break
      default:
        toast.show(`${label} done — see Foundry chat`)
    }
  } catch (err) {
    const status = errorStatus(err)
    if (status === 401) {
      clearToken()
      await navigateTo('/join', { replace: true })
    } else if (status === 403 || status === 422) {
      toast.show('That action isn’t available right now.')
      void fetchSheet()
    } else if (status === 429) {
      toast.show('Slow down — too many actions at once')
    } else {
      toast.show('The table didn’t respond. Try again.')
    }
  } finally {
    actionBusy.value = null
  }
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
  if (rollTimer !== undefined) clearTimeout(rollTimer)
  closeEvents()
  window.removeEventListener('online', onOnline)
  window.removeEventListener('offline', onOffline)
})
</script>

<style scoped>
.sheet-root {
  min-height: 100dvh;
}

.frame {
  max-width: 480px;
  margin: 0 auto;
  padding: calc(10px + var(--safe-top)) 16px calc(100px + var(--safe-bottom));
}

/* ---- top toolbar ---- */

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 12px;
  color: var(--ink-dim);
  border: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel) 70%, transparent);
}

.tool:active {
  transform: scale(0.95);
  color: var(--gold);
}

.tool svg {
  width: 20px;
  height: 20px;
}

.back {
  margin-left: -2px;
}

.tool-spacer {
  flex: 1;
}

/* ---- content ---- */

.sheet-main {
  width: 100%;
}

.offline-banner {
  margin-top: 12px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--garnet);
  font-size: 0.78rem;
  font-weight: 600;
  text-align: center;
}

.tab-empty {
  text-align: center;
  color: var(--ink-dim);
  font-size: 0.88rem;
  padding: 48px 12px;
}

.lib-add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  margin-top: 14px;
  border-radius: 12px;
  font-size: 0.85rem;
  font-weight: 700;
  color: var(--gold-bright);
  background: color-mix(in srgb, var(--gold) 10%, transparent);
  border: 1px dashed color-mix(in srgb, var(--gold) 40%, transparent);
}

.lib-add svg {
  width: 16px;
  height: 16px;
}

.lib-add:active {
  transform: scale(0.98);
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
  gap: 2px;
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-top: 1px solid var(--line);
  padding: 8px 6px calc(8px + var(--safe-bottom));
}

.tab {
  flex: 1;
  max-width: 92px;
  min-height: 52px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  border-radius: 12px;
  color: var(--ink-faint);
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.tab svg {
  width: 20px;
  height: 20px;
}

.tab.active {
  color: var(--gold);
  background: color-mix(in srgb, var(--gold) 12%, transparent);
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
  font-family: var(--serif);
  font-weight: 700;
  font-size: 1.1rem;
}

.error-body {
  color: var(--ink-dim);
  font-size: 0.88rem;
}
</style>
