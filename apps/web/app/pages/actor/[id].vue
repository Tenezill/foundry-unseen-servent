<template>
  <div class="sheet-root">
    <template v-if="sheet">
      <div class="frame" :class="{ 'with-carousel': carouselDockVisible }">
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
          <button
            v-if="movement?.onScene"
            class="tool"
            type="button"
            aria-label="Move token"
            :disabled="offline"
            @click="openMoveSheet()"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <button
            class="tool"
            type="button"
            :aria-label="rollAnimOn ? 'Turn off roll animation' : 'Turn on roll animation'"
            :class="{ 'tool-off': !rollAnimOn }"
            @click="rollAnimPref.toggle()"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M12 2 21 7v10l-9 5-9-5V7Z" stroke-linejoin="round" />
              <path d="M12 2v20M3 7l9 5 9-5" stroke-linejoin="round" opacity="0.55" />
              <path v-if="!rollAnimOn" d="M4 4l16 16" stroke-linecap="round" />
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

        <SheetHero :sheet="sheet" :conn="conn" :readonly="offline" @numpad="openNumpad" @action="onAction" @step="stepResource" />

        <ConcentrationBanner
          v-if="sheet.concentration"
          :label="sheet.concentration.label"
          :busy="actionBusy === 'concentration.end'"
          :readonly="offline"
          @end="onEndConcentration"
        />

        <ConditionBadges v-if="sheet.conditions?.length" :conditions="sheet.conditions" @action="onConditionAction" />

        <div v-if="offline" class="offline-banner">
          Offline — showing your last known sheet, read-only.
        </div>

        <main class="sheet-main">
          <SectionActions
            v-if="activeTab === actionsTabId"
            :actions="combatActions"
            :action-busy="actionBusy"
            :readonly="offline"
            :detail-ids="actionDetailIds"
            :crit-ids="critArmed"
            :slot-resources="slotResources"
            @action="onCombatAction"
            @detail="onCombatDetail"
          />

          <button
            v-if="activeTab === actionsTabId && rouseAction"
            class="rouse-btn btn btn-accent"
            type="button"
            :class="{ pending: actionBusy === rouseAction.id }"
            :disabled="offline || actionBusy !== null"
            @click="onRouse"
          >
            {{ rouseAction.label }}
          </button>

          <CombatantList
            v-if="activeTab === 'combat'"
            :combatants="encounter.combatants ?? []"
            :readonly="offline"
            @select="openCombatant"
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

          <button
            v-if="showCustomItemButton"
            class="lib-add"
            type="button"
            @click="openCustomItem"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke-linecap="round" />
            </svg>
            Add item
          </button>
          <p v-if="showCustomItemButton" class="gear-note">
            Removing items is GM-side for now — ask your GM to delete a mis-created one.
          </p>

          <SpellPrepSummary
            v-if="sheet?.spellPrep && spellSectionsOnTab.length > 0"
            :prepared="sheet.spellPrep.prepared"
            :base="sheet.spellPrep.base"
            :actor-id="actorId"
          />

          <div v-if="spellChips.length > 0" class="filter-chips spell-filters">
            <button
              v-for="chip in spellChips"
              :key="chip.id"
              type="button"
              class="chip"
              :class="{ active: chip.active }"
              @click="chip.toggle()"
            >
              {{ chip.label }}
            </button>
          </div>

          <template v-for="section in displaySections" :key="section.id">
            <SectionStats
              v-if="section.kind === 'stats'"
              :section="section"
              :variant="section.id === 'abilities' ? 'gems' : section.id === 'traits' || section.id === 'savenotes' ? 'rows' : 'cards'"
              :readonly="offline"
              :busy="actionBusy"
              @action="onAction"
            />
            <SectionTracks
              v-else-if="section.kind === 'tracks'"
              :section="section"
              :resources="resMap"
              :busy="busy"
              :box-busy="boxBusy"
              :readonly="offline"
              @step="stepResource"
              @numpad="openNumpad"
              @boxchange="submitBoxChange"
            />
            <SectionList
              v-else
              :section="section"
              :resources="resMap"
              :actions="actionMap"
              :busy="busy"
              :action-busy="actionBusy"
              :readonly="offline"
              :collapsible="section.kind === 'list' && !!section.header"
              :storage-key="section.kind === 'list' && section.header ? `fc:collapse:${actorId}:${section.id}` : undefined"
              :pips="pipsForSection(section)"
              @step="stepResource"
              @action="onAction"
              @detail="onDetail"
            />
          </template>

          <CurrencyWallet
            v-if="activeTab === 'inventory' && walletResources.length"
            :resources="walletResources"
            :busy="busy"
            :readonly="offline"
            @step="stepResource"
          />

          <p v-if="tabEmpty" class="tab-empty">Nothing on this tab.</p>
        </main>
      </div>

      <div v-if="carouselDockVisible" class="carousel-dock">
        <InitiativeCarousel
          :combatants="encounter.combatants ?? []"
          :round="encounter.round"
          :turn-combatant-id="encounter.turn?.combatantId ?? null"
          :actor-id="actorId"
          :can-end-turn="canEndTurn"
          @end-turn="onEndTurn"
          @collapse="carouselCollapsed = true"
        />
      </div>

      <button
        v-if="carouselPillVisible"
        type="button"
        class="carousel-pill"
        :class="{ 'your-turn': canEndTurn }"
        aria-label="Show turn order"
        @click="carouselCollapsed = false"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path :d="ICONS.combat" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>

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
      <CombatantHpSheet
        v-if="combatantFor"
        :combatant="combatantFor"
        :busy="combatantHpBusy"
        @apply="applyCombatantHp"
        @close="combatantForId = null"
      />
      <ActionSheet
        v-if="sheetAction"
        :action="sheetAction"
        :busy="actionBusy !== null"
        :slots-left="slotsLeft"
        @submit="onActionSubmit"
        @close="closeActionSheet"
      />
      <MoveSheet
        v-if="showMoveSheet && movement"
        :movement="movement"
        :busy="movementBusy"
        @submit="onMoveSubmit"
        @refresh="refreshMovement"
        @dash="onDash"
        @close="showMoveSheet = false"
      />
      <TargetPickerSheet
        v-if="targetPickerFor"
        :encounter="encounter"
        :party="party"
        @pick="onTargetPick"
        @close="targetPickerFor = null"
      />
      <CombatTargetSheet
        v-if="combatTargetFor"
        :encounter="encounter"
        :mode="combatTargetMode"
        :title="combatTargetTitle"
        @pick="onCombatTargetPick"
        @close="combatTargetFor = null"
      />
      <ActionOutcomeSheet
        v-if="actionOutcome"
        :outcome="actionOutcome.outcome"
        :label="actionOutcome.label"
        :heal-label="actionOutcome.heal"
        @close="actionOutcome = null"
      />
      <PoolRollSheet
        v-if="poolAction"
        :action="poolAction"
        :attributes="poolAttributes"
        :skills="poolSkills"
        :disciplines="poolDisciplines"
        :hunger="hungerValue"
        :busy="actionBusy !== null"
        @submit="onPoolSubmit"
        @close="poolActionId = null"
      />
      <CustomItemSheet
        v-if="customItemOpen"
        :types="sheet.customItems ?? []"
        :busy="customItemBusy"
        :error="customItemError"
        @submit="onCustomItemSubmit"
        @close="closeCustomItem"
      />
      <DetailDialog
        v-if="detailFor"
        :title="detailFor.title"
        :detail="detailFor.detail"
        :danger="detailFor.removable && !offline ? REMOVE_LABELS[detailFor.removable] ?? 'Remove' : undefined"
        :danger-busy="removeBusy"
        :locations="detailLocations"
        :move-busy="moveBusy"
        @danger="onRemove"
        @move="onMove"
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
      <RollAnimOverlay v-if="rollAnim" :label="rollAnim.label" :result="rollAnim.result" />
      <RollResultPill
        v-if="lastRoll"
        :result="lastRoll.result"
        :label="lastRoll.label"
        :display="lastRoll.display"
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

    <DiceTray
      v-if="sheet"
      :actor-id="actorId"
      :raised="carouselDockVisible"
      :readonly="conn === 'offline'"
      @rolling="startRollAnim('Dice roll')"
      @roll="onDiceRoll"
      @rollfail="cancelRollAnim"
    />
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
  Stat,
} from '@companion/adapter-sdk'
import type {
  ActionOutcome,
  ActionResponse,
  ActionRollResult,
  ApiErrorBody,
  EncounterHpResponse,
  EncounterView,
  LibraryPreviewResponse,
  LibrarySearchEntry,
  LibrarySearchResponse,
  MovementCell,
  MovementResponse,
  MovementView,
  PartyView,
  RollLogEntry,
  SheetResponse,
} from '~/types/api'

/** One multi-resource write for a tri-state box track tap (M23): each entry
 *  is a plain `delta` intent, submitted sequentially — see submitBoxChange. */
type BoxChange = { resourceId: string; amount: number; expected: number }

const LARGE_DELTA = 10
const ROLL_HISTORY_MAX = 20

// TabId was a fixed dnd5e union; M23 adapter tabs (SheetViewModel.tabs) carry
// arbitrary system-declared ids (e.g. wod5e's 'rolls'/'disciplines'/'vitals'),
// so the *active tab* type widens to plain `string` — every literal
// comparison below still works. FallbackTabId keeps the old fixed union for
// the dnd5e-only heuristic (tabOf/sectionsByTab), whose Record<FallbackTabId,
// …> stays exactly indexable without the widened type reintroducing
// possibly-undefined lookups (noUncheckedIndexedAccess).
type TabId = string
type FallbackTabId = 'overview' | 'actions' | 'resources' | 'inventory' | 'spells' | 'combat'

interface TabDef {
  id: TabId
  label: string
  icon: string
}

/** Tab glyphs, shared between the fallback TABS array and iconFor() (M23),
 *  which picks a reasonable icon for adapter-declared tabs by id/label. */
const ICONS = {
  overview: 'M3 11l9-8 9 8M5 10v10h14V10',
  actions: 'M13 2 4 14h6l-1 8 9-12h-6z',
  combat: 'M12 2 3 6v6c0 5 4 8 9 10 5-2 9-5 9-10V6l-9-4Z',
  resources: 'M12 21s-7-4.5-7-10a4 4 0 0 1 8-1 4 4 0 0 1 8 1c0 5.5-7 10-7 10z',
  inventory: 'M4 7h16v13H4zM9 7V4h6v3',
  spells: 'M12 3l2 5 5 .5-4 3.5 1.5 5-4.5-3-4.5 3 1.5-5-4-3.5 5-.5z',
} as const

const TABS: TabDef[] = [
  { id: 'overview', label: 'Overview', icon: ICONS.overview },
  { id: 'actions', label: 'Actions', icon: ICONS.actions },
  { id: 'combat', label: 'Combat', icon: ICONS.combat },
  { id: 'resources', label: 'Vitals', icon: ICONS.resources },
  { id: 'inventory', label: 'Gear', icon: ICONS.inventory },
  { id: 'spells', label: 'Spells', icon: ICONS.spells },
]

/** Best-effort icon for an adapter-declared tab (M23): the hostsActions tab
 *  always gets the Actions glyph; everything else matches by id/label
 *  keyword, falling back to the Overview glyph. Purely cosmetic — the
 *  binding contract only requires tab order/routing, not icon choice. */
function iconFor(tab: { id: string; label: string; hostsActions?: boolean }): string {
  if (tab.hostsActions) return ICONS.actions
  const key = `${tab.id} ${tab.label}`.toLowerCase()
  if (/vital|health|track/.test(key)) return ICONS.resources
  if (/gear|invent|item|equip/.test(key)) return ICONS.inventory
  if (/spell|cantrip/.test(key)) return ICONS.spells
  return ICONS.overview
}

/** Which tab surfaces the "add" button for each library collection. */
const COLLECTION_TAB: Record<string, TabId> = {
  spells: 'spells',
  // Feats are added once in a blue moon — parked on Vitals, off the front
  // page (2026-07-18 request).
  feats: 'resources',
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
const detailFor = ref<{
  title: string
  detail: string
  itemId?: string
  removable?: string
  moveActionId?: string
  currentContainerId?: string | null
} | null>(null)
const showLog = ref(false)

const offline = computed(() => conn.value === 'offline')

/* ---- token movement (Move sheet) ---------------------------------------- */
const movement = ref<MovementView | null>(null)
const showMoveSheet = ref(false)
const movementBusy = ref(false)

/** Silent refresh: failure just hides/keeps the toolbar button — movement is
 *  an optional affordance, never an error the player must see. */
async function refreshMovement(): Promise<void> {
  try {
    const res = await api<MovementResponse>(`/api/actors/${actorId.value}/movement`)
    movement.value = res.movement
  } catch {
    movement.value = null
  }
}

function openMoveSheet(): void {
  if (offline.value) return
  showMoveSheet.value = true
  void refreshMovement()   // stale-while-revalidate: sheet opens on cached view
}

async function onMoveSubmit(cell: MovementCell): Promise<void> {
  if (offline.value || movementBusy.value) return
  movementBusy.value = true
  try {
    const res = await api<MovementResponse>(`/api/actors/${actorId.value}/movement`, {
      method: 'POST',
      body: cell,
    })
    movement.value = res.movement
    showMoveSheet.value = false
    toast.show('Move sent to the table')
  } catch (err) {
    const status = errorStatus(err)
    if (status === 409) {
      toast.show('That square is taken or the scene changed — refreshed')
      void refreshMovement()
    } else if (status === 422) {
      toast.show('Out of range')
    } else if (status === 401) {
      clearToken()
      await navigateTo('/join', { replace: true })
    } else {
      toast.show('Move didn’t go through. Try again.')
    }
  } finally {
    movementBusy.value = false
  }
}

/** Dash (2026-07-22 §F4): doubles the per-turn movement budget once per
 *  turn; the response IS the fresh movement view, same as a move/refresh. */
async function onDash(): Promise<void> {
  if (offline.value || movementBusy.value) return
  movementBusy.value = true
  try {
    const res = await api<MovementResponse>(`/api/actors/${actorId.value}/movement/dash`, {
      method: 'POST',
    })
    movement.value = res.movement
  } catch (err) {
    const status = errorStatus(err)
    if (status === 409) {
      toast.show('Can’t dash right now — refreshed')
      void refreshMovement()
    } else if (status === 401) {
      clearToken()
      await navigateTo('/join', { replace: true })
    } else {
      toast.show('Dash didn’t go through. Try again.')
    }
  } finally {
    movementBusy.value = false
  }
}

/* ---- M22 encounter mirror ------------------------------------------------ */

const encounter = ref<EncounterView>({ active: false })
const encounterActive = computed(() => encounter.value.active === true)
/** The carousel needs the freshest possible turn order — hide it whenever the
 *  combat stream itself isn't confirmed live, on top of the general offline
 *  treatment. The COMBAT tab is coarser (a list, not a live turn pointer) and
 *  follows the app's usual offline idiom instead: it keeps showing the last
 *  known roster, read-only, rather than vanishing on every reconnect blip. */
const showCarousel = computed(() => encounterActive.value && combatConn.value === 'live')

/** Connection-independent "is the viewed actor the acting combatant?" —
 *  derived purely from the encounter mirror, which only changes on a real SSE
 *  frame (never on a reconnect blip). Used for the carousel your-turn
 *  auto-expand so a connection flap does not manufacture a false turn edge. */
const myTurnActive = computed(() => {
  const turnId = encounter.value.turn?.combatantId
  if (!turnId) return false
  const acting = encounter.value.combatants?.find((c) => c.id === turnId)
  return acting?.actorId === actorId.value
})

/** End-turn button gate (2026-07-22 §F4): only the acting combatant's OWN
 *  player, viewing THAT actor's sheet, sees the button — and only while the
 *  combat mirror is confirmed live (a stale/reconnecting mirror could be
 *  wrong about whose turn it is). */
const canEndTurn = computed(() => combatConn.value === 'live' && myTurnActive.value)

/** Combat carousel collapse (2026-07-23): the player can hide the initiative
 *  dock to reclaim vertical space; a floating pill restores it. In-memory only
 *  — reset to expanded when combat ends (so a new combat opens expanded) and
 *  auto-expanded once when it becomes the viewer's own turn. */
const carouselCollapsed = ref(false)
const carouselDockVisible = computed(() => showCarousel.value && !carouselCollapsed.value)
const carouselPillVisible = computed(() => showCarousel.value && carouselCollapsed.value)

/* Combat ended -> next combat opens expanded. encounter.value only changes on a
 * real SSE frame (disconnects flip combatConn, never the active flag), so this
 * true->false edge is a genuine end, not a reconnect blip. */
watch(encounterActive, (now, was) => {
  if (was && !now) carouselCollapsed.value = false
})

/* Your turn arrived -> reopen once (edge-triggered off the connection-
 * independent turn signal, so a reconnect blip mid-turn does not re-expand a
 * carousel the player deliberately collapsed). */
watch(myTurnActive, (now, prev) => {
  if (now && !prev) carouselCollapsed.value = false
})

const turnEndBusy = ref(false)

/** Single tap, no confirm (spec). 409 ("no active encounter" / "turn already
 *  advanced") is a race the combat SSE mirror self-heals from — refresh
 *  silently; everything else gets the standard error toast. */
async function onEndTurn(): Promise<void> {
  if (offline.value || turnEndBusy.value) return
  turnEndBusy.value = true
  try {
    await api<{ ok: true }>('/api/encounter/turn/end', { method: 'POST' })
  } catch (err) {
    const status = errorStatus(err)
    if (status === 409) {
      /* self-heals via connectCombatEvents — nothing to show */
    } else if (status === 401) {
      clearToken()
      await navigateTo('/join', { replace: true })
    } else {
      toast.show('Couldn’t end your turn. Try again.')
    }
  } finally {
    turnEndBusy.value = false
  }
}

const combatantForId = ref<string | null>(null)
const combatantHpBusy = ref(false)
const combatantFor = computed(() => encounter.value.combatants?.find((c) => c.id === combatantForId.value) ?? null)

const isDark = computed(() => {
  void theme.choice.value // recompute when the override changes
  return theme.effective() === 'dark'
})

/* ---- M23 wod5e theme stamp -----------------------------------------------
 * main.css keys its `[data-system='wod5e']` override block off an attribute
 * on <html>, not a class scoped to this page's root element: ToastHost (see
 * app.vue) renders as a *sibling* of <NuxtPage>, not a descendant of
 * `.sheet-root`, so stamping the page root would leave toasts un-themed
 * while a wod5e sheet is open. documentElement mirrors exactly how
 * useTheme.ts already stamps `data-theme` there.
 *
 * Driven off the sheet's systemId (not a mount/unmount lifecycle) so it
 * self-corrects if the same mounted instance ever serves a different actor
 * (dnd5e <-> wod5e swap) without a full remount — and cleared in
 * onBeforeUnmount below for the case where it does unmount (leaving /,
 * navigating to another route). */
const systemId = computed(() => sheet.value?.systemId ?? null)

watch(
  systemId,
  (id) => {
    if (id) document.documentElement.dataset.system = id
    else delete document.documentElement.dataset.system
  },
  { immediate: true },
)

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

/* ---- target picker (2026-07-19) -------------------------------------------
 * Creature-targetable buff casts (Bless, Aid, Mage Armor, Shield of Faith…)
 * open this picker BEFORE casting; self-only buffs (Shield) keep
 * auto-applying to the caster, untouched. Target first, then — if the spell
 * also has a multi-level slot choice — the existing ActionSheet upcast
 * picker; pendingTargetActorId carries the choice across that second sheet. */
const targetPickerFor = ref<string | null>(null)
const party = ref<PartyView | null>(null)
const pendingTargetActorId = ref<string | undefined>(undefined)

/** Lazy + cached: only fetched the first time a targetable cast opens the
 *  picker with no active encounter. Left null on failure so the picker's
 *  "Loading party…" hint stays honest and a later reopen retries. */
async function loadParty(): Promise<void> {
  if (party.value !== null) return
  try {
    party.value = await api<PartyView>('/api/party')
  } catch {
    /* leave null — reopening the picker retries */
  }
}

/** Best-known display name for a chosen target: the live combat roster
 *  first (freshest for an active encounter), else the party roster. */
function targetNameFor(targetActorId: string | undefined): string | undefined {
  if (!targetActorId) return undefined
  return (
    encounter.value.combatants?.find((c) => c.actorId === targetActorId)?.name ??
    party.value?.actors.find((a) => a.id === targetActorId)?.name
  )
}

/** "<label>" unchanged for self; "<label> on <target name>" once a non-self
 *  target is known — feeds the roll/toast label and roll-history entry. */
function castLabel(label: string, targetActorId: string | undefined): string {
  if (!targetActorId) return label
  const name = targetNameFor(targetActorId)
  return name ? `${label} on ${name}` : label
}

function openTargetPicker(actionId: string): void {
  targetPickerFor.value = actionId
  if (!encounterActive.value) void loadParty()
}

function closeActionSheet(): void {
  actionSheetFor.value = null
  pendingTargetActorId.value = undefined
  pendingTargetTokenUuids.value = undefined
}

/* ---- in-combat targeted actions (2026-07-22) -----------------------------
 * Actions whose descriptor carries `targeting` (weapon attacks, save spells,
 * targeted heals) open CombatTargetSheet instead of executing directly —
 * but only while a live encounter mirror is actually up: offline/reconnecting
 * combat state must never dead-end a tap, so those fall through to today's
 * untargeted flow. `targeting` and the buff-cast `targetable` flag never
 * co-exist on one descriptor (buffs are always effectType 'utility'), so
 * there's no ordering conflict between the two pickers. */
const combatTargetFor = ref<string | null>(null)
const pendingTargetTokenUuids = ref<string[] | undefined>(undefined)
const actionOutcome = ref<{ outcome: ActionOutcome; label: string; heal?: boolean } | null>(null)

const combatTargetAction = computed(() =>
  combatTargetFor.value ? (actionMap.value[combatTargetFor.value] ?? null) : null,
)
const combatTargetMode = computed<'single' | 'multiple'>(
  () => combatTargetAction.value?.targeting?.mode ?? 'single',
)
const combatTargetTitle = computed(() => {
  const action = combatTargetAction.value
  if (!action) return 'Choose target'
  return `${action.label} — choose target${combatTargetMode.value === 'multiple' ? 's' : ''}`
})

/** True only when a targeted action should intercept today's flow: live
 *  combat mirror confirmed AND the descriptor declares `targeting`. */
function canTargetInCombat(action: ActionDescriptor): boolean {
  return !!action.targeting && encounterActive.value && combatConn.value === 'live'
}

/** Opens the combat target sheet for a targetable attack/cast/use; returns
 *  whether it did, so callers can fall through to their existing behavior
 *  otherwise (mirrors the targetable-buff `openTargetPicker` short-circuit). */
function tryOpenCombatTargeting(actionId: string, action: ActionDescriptor): boolean {
  if (!canTargetInCombat(action)) return false
  combatTargetFor.value = actionId
  return true
}

/** After tokens are picked: a cast with a multi-level slot choice opens the
 *  existing upcast picker next (tokens carried via pendingTargetTokenUuids,
 *  consumed in onActionSubmit); everything else (attacks, single/no-slot
 *  casts, uses) submits immediately with the chosen targets. */
function onCombatTargetPick(tokenUuids: string[]): void {
  const actionId = combatTargetFor.value
  combatTargetFor.value = null
  if (!actionId) return
  const action = actionMap.value[actionId]
  if (!action) return
  if (action.kind === 'cast') {
    if (action.slotLevels !== undefined && action.slotLevels.length > 1) {
      pendingTargetTokenUuids.value = tokenUuids
      actionSheetFor.value = actionId
      return
    }
    if (action.slotLevels?.length === 0) return
    const slotLevel = action.slotLevels?.length === 1 ? action.slotLevels[0] : undefined
    void submitAction(
      {
        kind: 'cast',
        actionId,
        ...(slotLevel !== undefined ? { slotLevel } : {}),
        targetTokenUuids: tokenUuids,
      },
      action.label,
      action.effectType,
    )
    return
  }
  if (action.kind === 'attack') {
    void submitAction({ kind: 'attack', actionId, targetTokenUuids: tokenUuids }, action.label, action.effectType)
    return
  }
  if (action.kind === 'use') {
    void submitAction({ kind: 'use', actionId, targetTokenUuids: tokenUuids }, action.label, action.effectType)
  }
}

/** After a target is chosen: a multi-level slot choice opens the existing
 *  upcast picker next (target carried via pendingTargetActorId, consumed in
 *  onActionSubmit); otherwise cast immediately with whatever single/absent
 *  slot level the descriptor already resolved. */
function onTargetPick(targetActorId: string | null): void {
  const actionId = targetPickerFor.value
  targetPickerFor.value = null
  if (!actionId) return
  const action = actionMap.value[actionId]
  if (!action || action.kind !== 'cast') return
  const resolvedTarget = targetActorId ?? undefined
  if (action.slotLevels !== undefined && action.slotLevels.length > 1) {
    pendingTargetActorId.value = resolvedTarget
    actionSheetFor.value = actionId
    return
  }
  if (action.slotLevels?.length === 0) return
  const slotLevel = action.slotLevels?.length === 1 ? action.slotLevels[0] : undefined
  void submitAction(
    {
      kind: 'cast',
      actionId,
      ...(slotLevel !== undefined ? { slotLevel } : {}),
      ...(resolvedTarget ? { targetActorId: resolvedTarget } : {}),
    },
    castLabel(action.label, resolvedTarget),
    action.effectType,
  )
}

/* ---- M8 derived vitals -------------------------------------------------- */

const hpValue = computed(() => resMap.value.hp?.value ?? 1)
const dying = computed(() => hpValue.value <= 0)
const deathSuccess = computed(() => resMap.value['deathsaves.success'])
const deathFailure = computed(() => resMap.value['deathsaves.failure'])
const hasRest = computed(() => !!actionMap.value['rest.short'] || !!actionMap.value['rest.long'])
const walletResources = computed(() =>
  (sheet.value?.resources ?? []).filter((r) => r.group === 'currency'),
)

/** Container sections double as the move-target list. */
const containerOptions = computed(() =>
  (sheet.value?.sections ?? [])
    .filter(
      (s): s is Extract<SheetSection, { kind: 'list' }> =>
        s.kind === 'list' && s.header !== undefined && s.id.startsWith('inventory.'),
    )
    .map((s) => ({ id: s.id.slice('inventory.'.length), label: s.label })),
)

const detailLocations = computed(() => {
  const d = detailFor.value
  if (!d?.moveActionId || offline.value) return undefined
  const current = d.currentContainerId ?? null
  return [
    { id: null as string | null, label: 'Carried', current: current === null },
    ...containerOptions.value
      .filter((c) => c.id !== d.itemId) // an item can't move into itself
      .map((c) => ({ id: c.id as string | null, label: c.label, current: current === c.id })),
  ]
})

/* ---- tab routing -------------------------------------------------------- */

function tabOf(section: SheetSection): FallbackTabId {
  if (section.kind === 'tracks') return 'resources'
  const key = `${section.id} ${section.label}`.toLowerCase()
  // Gear-scoped stats (M12 'gearstats') live on the Gear tab with the list.
  if (section.kind === 'stats') {
    return /invent|item|equip|gear|loot/.test(key) ? 'inventory' : 'overview'
  }
  if (/^inventory\./.test(section.id)) return 'inventory'
  if (/spell|cantrip/.test(key)) return 'spells'
  if (/invent|item|equip|gear|loot/.test(key)) return 'inventory'
  return 'overview'
}

const sectionsByTab = computed<Record<FallbackTabId, SheetSection[]>>(() => {
  const groups: Record<FallbackTabId, SheetSection[]> = {
    overview: [],
    actions: [],
    combat: [],
    resources: [],
    inventory: [],
    spells: [],
  }
  for (const section of sheet.value?.sections ?? []) groups[tabOf(section)].push(section)
  return groups
})

/* ---- M23 adapter-declared tabs ------------------------------------------
 * When sheet.tabs is non-empty, tab bar + section routing come EXCLUSIVELY
 * from it (binding contract 1): tab order as given, sectionIds per tab,
 * and whichever tab has hostsActions:true hosts the Actions UI. Absent ->
 * the tabOf()/sectionsByTab heuristic above stays untouched (dnd5e
 * pixel-identical). The transient COMBAT tab is appended in both modes. */

const usingAdapterTabs = computed(() => (sheet.value?.tabs?.length ?? 0) > 0)

const sectionsById = computed<Record<string, SheetSection>>(() => {
  const m: Record<string, SheetSection> = {}
  for (const s of sheet.value?.sections ?? []) m[s.id] = s
  return m
})

/* ---- M23 pool roll sheet -------------------------------------------------- */

const poolActionId = ref<string | null>(null)

const poolAction = computed(() => {
  const a = poolActionId.value ? actionMap.value[poolActionId.value] : undefined
  return a && a.kind === 'pool' ? a : null
})

/** Dots stats for the pool sheet's pickers, sourced from the sections the
 *  wod5e adapter declares (M23 binding contract) — id-prefix filtered so
 *  non-dots entries (humanity rides along in `attributes`) never leak in. */
function dotsStatsOf(sectionId: string, prefix: string): Stat[] {
  const section = sectionsById.value[sectionId]
  if (!section || section.kind !== 'stats') return []
  return section.stats.filter((s) => s.id.startsWith(prefix))
}

const poolAttributes = computed(() => dotsStatsOf('attributes', 'attr.'))
const poolSkills = computed(() => dotsStatsOf('skills', 'skill.'))
const poolDisciplines = computed(() => dotsStatsOf('discipline-ratings', 'disc.'))
const hungerValue = computed(() => resMap.value.hunger?.value ?? 0)

/* ---- M23 rouse check + custom items --------------------------------------- */

const rouseAction = computed(() => {
  const a = actionMap.value['rouse']
  return a && a.kind === 'rouse' ? a : null
})

const customItemOpen = ref(false)
const customItemBusy = ref(false)
const customItemError = ref<string | null>(null)

const showCustomItemButton = computed(
  () => activeTab.value === 'gear' && !offline.value && (sheet.value?.customItems?.length ?? 0) > 0,
)

function openCustomItem(): void {
  customItemError.value = null
  customItemOpen.value = true
}

function closeCustomItem(): void {
  customItemOpen.value = false
  customItemError.value = null
}

/** Id of the tab that renders the Actions UI: the adapter's hostsActions
 *  tab in adapter-tabs mode, else the fallback's literal 'actions' tab. */
const actionsTabId = computed<TabId>(
  () => (usingAdapterTabs.value ? sheet.value?.tabs?.find((t) => t.hostsActions)?.id : undefined) ?? 'actions',
)

const combatActions = computed(() =>
  (sheet.value?.actions ?? []).filter(
    // 'damage' isn't a group of its own (SectionActions renders it as a
    // second button on the matching attack row) but must be present here
    // so that row can find its companion descriptor.
    (a) => a.kind === 'attack' || a.kind === 'cast' || a.kind === 'use' || a.kind === 'damage',
  ),
)

/** M17: Actions-tab info disclosure. The list sections already carry every
 *  description, and action ids embed the Foundry item id — a row's detail
 *  is a lookup away, no new data over the wire. */
const ACTION_ITEM_ID = /^(?:item|spell|feature)\.([^.]+)\./

const detailByItemId = computed(() => {
  const m = new Map<string, { title: string; detail: string }>()
  for (const section of sheet.value?.sections ?? []) {
    if (section.kind !== 'list') continue
    for (const item of section.items) {
      if (item.detail) m.set(item.id, { title: item.label, detail: item.detail })
    }
  }
  return m
})

const actionDetailIds = computed(() => {
  const s = new Set<string>()
  for (const a of combatActions.value) {
    const itemId = ACTION_ITEM_ID.exec(a.id)?.[1]
    if (itemId && detailByItemId.value.has(itemId)) s.add(a.id)
  }
  return s
})

function onCombatDetail(actionId: string): void {
  const itemId = ACTION_ITEM_ID.exec(actionId)?.[1]
  const entry = itemId ? detailByItemId.value.get(itemId) : undefined
  if (!entry) return
  detailFor.value = { title: entry.title, detail: entry.detail }
}

const visibleTabs = computed<TabDef[]>(() => {
  if (usingAdapterTabs.value) {
    const base: TabDef[] = (sheet.value?.tabs ?? []).map((t) => ({
      id: t.id,
      label: t.label,
      icon: iconFor(t),
    }))
    if (encounterActive.value) base.push({ id: 'combat', label: 'Combat', icon: ICONS.combat })
    return base
  }
  return TABS.filter((t) => {
    if (t.id === 'overview') return true
    if (t.id === 'actions') return combatActions.value.length > 0
    if (t.id === 'combat') return encounterActive.value
    // TABS is the fixed fallback array — every id is a FallbackTabId.
    return sectionsByTab.value[t.id as FallbackTabId].length > 0
  })
})

const activeSections = computed<SheetSection[]>(() => {
  if (usingAdapterTabs.value) {
    const tab = sheet.value?.tabs?.find((t) => t.id === activeTab.value)
    if (!tab) return []
    return tab.sectionIds
      .map((id) => sectionsById.value[id])
      .filter((s): s is SheetSection => s !== undefined)
  }
  // Non-adapter branch: activeTab is constrained to a FallbackTabId here,
  // since visibleTabs' watch (below) only ever sets it to a TABS entry.
  return sectionsByTab.value[activeTab.value as FallbackTabId] ?? []
})

/** The library collection whose add-button belongs on the active tab, if any. */
const tabAddEntry = computed(() =>
  (sheet.value?.library ?? []).find((c) => COLLECTION_TAB[c.id] === activeTab.value),
)

/** Death saves and currency are rendered by dedicated M8 panels, not inline. */
const renderableSections = computed(() =>
  activeSections.value.filter((s) => s.id !== 'deathsaves' && s.id !== 'currency'),
)

/* ---- spell filters (2026-07-18): level chips + ritual/concentration ------ */

const SPELL_SECTION_RE = /^spells\.l(\d)$/

const spellLevelFilter = ref<string | null>(null)
const spellRitualOnly = ref(false)
const spellConcOnly = ref(false)

/** The per-level spell sections on the active tab (empty on non-spell tabs). */
const spellSectionsOnTab = computed(() =>
  renderableSections.value.filter((s) => s.kind === 'list' && SPELL_SECTION_RE.test(s.id)),
)

interface SpellChip {
  id: string
  label: string
  active: boolean
  toggle: () => void
}

const spellChips = computed<SpellChip[]>(() => {
  if (spellSectionsOnTab.value.length === 0) return []
  return [
    {
      id: 'all',
      label: 'All',
      active: spellLevelFilter.value === null && !spellRitualOnly.value && !spellConcOnly.value,
      toggle: () => {
        spellLevelFilter.value = null
        spellRitualOnly.value = false
        spellConcOnly.value = false
      },
    },
    ...spellSectionsOnTab.value.map((s) => {
      const lvl = SPELL_SECTION_RE.exec(s.id)?.[1] ?? '0'
      return {
        id: s.id,
        label: lvl === '0' ? 'Cantrip' : `Lvl ${lvl}`,
        active: spellLevelFilter.value === s.id,
        toggle: () => {
          spellLevelFilter.value = spellLevelFilter.value === s.id ? null : s.id
        },
      }
    }),
    {
      id: 'ritual',
      label: '📖 Ritual',
      active: spellRitualOnly.value,
      toggle: () => {
        spellRitualOnly.value = !spellRitualOnly.value
      },
    },
    {
      id: 'conc',
      label: '🧠 Conc.',
      active: spellConcOnly.value,
      toggle: () => {
        spellConcOnly.value = !spellConcOnly.value
      },
    },
  ]
})

/** renderableSections with the spell filters applied (level chip narrows to
 *  one section; ritual/conc narrow rows by their tags; emptied sections
 *  drop out). Pass-through everywhere but the Spells tab. */
const displaySections = computed<SheetSection[]>(() => {
  if (spellSectionsOnTab.value.length === 0) return renderableSections.value
  const tagFiltered = spellRitualOnly.value || spellConcOnly.value
  return renderableSections.value
    .filter((s) => !SPELL_SECTION_RE.test(s.id) || spellLevelFilter.value === null || s.id === spellLevelFilter.value)
    .map((s) => {
      if (s.kind !== 'list' || !SPELL_SECTION_RE.test(s.id) || !tagFiltered) return s
      const items = s.items.filter(
        (i) =>
          (!spellRitualOnly.value || (i.tags ?? []).includes('ritual')) &&
          (!spellConcOnly.value || (i.tags ?? []).includes('concentration')),
      )
      return { ...s, items }
    })
    .filter((s) => s.kind !== 'list' || !SPELL_SECTION_RE.test(s.id) || s.items.length > 0)
})

const tabEmpty = computed(() => {
  if (activeTab.value === actionsTabId.value || activeTab.value === 'combat') return false
  if (renderableSections.value.length > 0) return false
  if (activeTab.value === 'resources' && (hasRest.value || dying.value)) return false
  if (activeTab.value === 'inventory' && walletResources.value.length > 0) return false
  return true
})

// Reset to the landing tab (the first entry — adapter tabs or the fallback
// TABS array, both start with an overview-ish tab) whenever the current
// active tab drops out of the visible list: a fresh actor load, an adapter
// swap (dnd5e <-> wod5e), or a content change that hides today's tab.
watch(visibleTabs, (tabs) => {
  if (!tabs.some((t) => t.id === activeTab.value)) activeTab.value = tabs[0]?.id ?? 'overview'
})

/* ---- sheet state -------------------------------------------------------- */

function applySheet(next: SheetViewModel): void {
  sheet.value = next
  loading.value = false
  saveCachedSheet(actorId.value, next)
}

/** The current token cannot access this actor (e.g. the device switched to
 *  another player's invite): drop the stale cached render — it must not keep
 *  masquerading as a working sheet — and land on the error card. */
function showNotLinked(): void {
  clearCachedSheet(actorId.value)
  sheet.value = null
  loading.value = false
  loadError.value = 'This character is not linked to your invite.'
}

async function fetchSheet(): Promise<void> {
  try {
    const res = await api<SheetResponse>(`/api/actors/${actorId.value}/sheet`)
    applySheet(res.sheet)
    void refreshMovement()
  } catch (err) {
    const status = errorStatus(err)
    if (status === 401) {
      clearToken()
      await navigateTo('/join', { replace: true })
      return
    }
    if (status === 404) {
      showNotLinked()
      return
    }
    if (!sheet.value) {
      loading.value = false
      loadError.value = 'The table is unreachable right now.'
    }
  }
}

function reload(): void {
  loading.value = true
  loadError.value = ''
  void fetchSheet()
  connectEvents()
  connectCombatEvents()
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

/** M23: a tri-state box-track tap (TrackBoxes.vue) needs up to two resource
 *  writes (e.g. superficial -1 + aggravated +1) — the gateway's intents
 *  endpoint only ever takes one ResourceIntent per call (docs/API.md), so
 *  these submit sequentially. Each change targets a DIFFERENT resourceId
 *  (computed from the pre-tap sheet), so the second call's `expected` can't
 *  be invalidated by the first — a genuine 409 here only happens from a
 *  concurrent edit by someone else, same as any other write, and aborts the
 *  remaining changes and refreshes from the fresh sheet like submitIntent. */
const boxBusy = ref<string | null>(null)

async function submitBoxChange(trackId: string, changes: BoxChange[]): Promise<void> {
  if (offline.value || boxBusy.value || changes.length === 0) return
  boxBusy.value = trackId
  try {
    for (const change of changes) {
      const res = await api<SheetResponse>(`/api/actors/${actorId.value}/intents`, {
        method: 'POST',
        body: {
          kind: 'delta',
          resourceId: change.resourceId,
          amount: change.amount,
          expected: change.expected,
        } satisfies ResourceIntent,
      })
      applySheet(res.sheet)
    }
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
    boxBusy.value = null
  }
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

const lastRoll = ref<{ result: ActionRollResult; label: string; display?: string } | null>(null)
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

type EffectType = 'damage' | 'heal' | 'utility'

/* ---- nat-20 crit memory (2026-07-18) ------------------------------------
 * When an attack (weapon) or cast (attack spell) roll comes back
 * `isCritical` — Foundry's own nat-20 detection on the captured attack
 * roll — the paired `.damage` action is "armed": its Dmg button turns into
 * a Crit button and the damage intent carries `critical: true`, which the
 * adapter turns into doubled damage dice (standard 5e rule). The flag is
 * consumed by that damage roll and overwritten by the next attack. */
const critArmed = ref<Set<string>>(new Set())

function updateCritArmed(intent: ActionIntent, result: ActionRollResult): void {
  if (intent.kind === 'attack' || intent.kind === 'cast') {
    const damageId = intent.actionId.replace(/\.(attack|cast)$/, '.damage')
    // Only arm ids that really have a Dmg button — heal/utility casts also
    // report rolls, and the relay's formula-roll crit flag is noisy for
    // non-d20 dice.
    if (!actionMap.value[damageId]) return
    const next = new Set(critArmed.value)
    if (result.isCritical === true) next.add(damageId)
    else next.delete(damageId)
    critArmed.value = next
  } else if (intent.kind === 'damage') {
    if (critArmed.value.has(intent.actionId)) {
      const next = new Set(critArmed.value)
      next.delete(intent.actionId)
      critArmed.value = next
    }
    if (intent.actionId in castLevels.value) {
      const next = { ...castLevels.value }
      delete next[intent.actionId]
      castLevels.value = next
    }
  }
}

/** Remaining slots per level, for the upcast picker labels. */
const slotsLeft = computed<Record<number, number>>(() => {
  const out: Record<number, number> = {}
  for (const r of sheet.value?.resources ?? []) {
    const m = /^slots\.([1-9])$/.exec(r.id)
    if (m) out[Number(m[1])] = r.value
  }
  return out
})

/** `slots.*` resources (2026-07-19), feeding SlotPips on the Actions tab —
 *  SectionActions consumes this prop directly (component-local pipsFor, per
 *  task-7 brief); the Spells tab instead gets ready-made pips per section
 *  from pipsForLevel below, so the derivation rule lives in exactly two
 *  places, not three. */
const slotResources = computed<ResourceDescriptor[]>(() =>
  (sheet.value?.resources ?? []).filter((r) => r.id.startsWith('slots.')),
)

/** Slot pips for one spell level (own pool + pact, when the pact pool casts
 *  at this level or higher) — the Spells tab's per-level SectionList headers. */
function pipsForLevel(lvl: number): Array<{ value: number; max: number; pact?: boolean }> {
  if (lvl === 0) return []
  const out: Array<{ value: number; max: number; pact?: boolean }> = []
  const own = slotResources.value.find((r) => r.id === `slots.${lvl}`)
  if (own && own.max !== undefined) out.push({ value: own.value, max: own.max })
  const pact = slotResources.value.find((r) => r.id === 'slots.pact')
  if (pact && pact.max !== undefined && pact.level !== undefined && pact.level >= lvl) {
    out.push({ value: pact.value, max: pact.max, pact: true })
  }
  return out
}

/** Pips for a rendered section, when it's one of the per-level `spells.l<N>`
 *  sections (see SPELL_SECTION_RE below); undefined elsewhere. */
function pipsForSection(section: SheetSection): Array<{ value: number; max: number; pact?: boolean }> | undefined {
  const m = SPELL_SECTION_RE.exec(section.id)
  return m ? pipsForLevel(Number(m[1])) : undefined
}

/** Upcast memory (2026-07-19): the level each spell was last cast at, keyed
 *  by its damage-action id — the companion Dmg roll sends it so the display
 *  dice scale. Consumed by that roll; overwritten by the next cast. */
const castLevels = ref<Record<string, number>>({})

/** M15: heal -> "+N HP", damage (weapon or spell) -> "N dmg", everything
 *  else keeps today's plain total. Only the displayed label changes —
 *  haptics/history/critical styling below are untouched. */
function effectDisplay(result: ActionRollResult, effectType: EffectType | undefined): string | undefined {
  if (effectType === 'heal') return `+${result.total} HP`
  if (effectType === 'damage') return `${result.total} dmg`
  return undefined
}

/** Prepend a roll to the session history (newest first), capped at the max. */
function pushHistory(entry: Omit<RollLogEntry, 'id'>): void {
  rollHistory.value.unshift({ id: ++rollSeq, ...entry })
  if (rollHistory.value.length > ROLL_HISTORY_MAX) {
    rollHistory.value = rollHistory.value.slice(0, ROLL_HISTORY_MAX)
  }
}

/* ---- roll animation (2026-07-18): suspense overlay between tap & result --
 * Dice are rolled server-side, so the overlay masks the round-trip: it spins
 * from submit, holds a minimum so it never flashes, reveals the real total,
 * then hands off to the existing pill/history/haptics presentation. Gated by
 * the fc:rollAnim preference AND prefers-reduced-motion (useRollAnim). */

const rollAnimPref = useRollAnim()
const rollAnimOn = computed(() => rollAnimPref.on.value)
/** Intent kinds that reliably return a client-side roll result. */
const ROLL_ANIM_KINDS = new Set(['check', 'save', 'attack', 'damage'])
const ROLL_ANIM_MIN_MS = 900
const ROLL_ANIM_REVEAL_MS = 700
const ROLL_ANIM_MAX_MS = 15_000

const rollAnim = ref<{ label: string; result: ActionRollResult | null } | null>(null)
let rollAnimStart = 0
let rollAnimTimer: ReturnType<typeof setTimeout> | undefined

function startRollAnim(label: string): void {
  if (!rollAnimPref.enabled()) return
  if (rollAnimTimer !== undefined) clearTimeout(rollAnimTimer)
  rollAnim.value = { label, result: null }
  rollAnimStart = Date.now()
  // Safety net: a hung request must never leave the overlay spinning forever.
  rollAnimTimer = setTimeout(cancelRollAnim, ROLL_ANIM_MAX_MS)
}

function cancelRollAnim(): void {
  if (rollAnimTimer !== undefined) {
    clearTimeout(rollAnimTimer)
    rollAnimTimer = undefined
  }
  rollAnim.value = null
}

/** Reveal `result` in the active overlay, then run the presentation. With no
 *  overlay active (animation off, or the action wasn't animated) the
 *  presentation runs immediately — behavior identical to before. */
function finishRollAnim(result: ActionRollResult, then: () => void): void {
  if (!rollAnim.value) {
    then()
    return
  }
  if (rollAnimTimer !== undefined) clearTimeout(rollAnimTimer)
  const wait = Math.max(0, ROLL_ANIM_MIN_MS - (Date.now() - rollAnimStart))
  rollAnimTimer = setTimeout(() => {
    if (!rollAnim.value) {
      rollAnimTimer = undefined
      then()
      return
    }
    rollAnim.value = { ...rollAnim.value, result }
    rollAnimTimer = setTimeout(() => {
      rollAnim.value = null
      rollAnimTimer = undefined
      then()
    }, ROLL_ANIM_REVEAL_MS)
  }, wait)
}

function showRoll(result: ActionRollResult, label: string, effectType?: EffectType): void {
  finishRollAnim(result, () => presentRoll(result, label, effectType))
}

function presentRoll(result: ActionRollResult, label: string, effectType?: EffectType): void {
  lastRoll.value = { result, label, display: effectDisplay(result, effectType) }
  pushHistory({
    label,
    total: result.total,
    formula: result.formula,
    isCritical: result.isCritical === true,
    isFumble: result.isFumble === true,
  })
  haptics(result)
  if (rollTimer !== undefined) clearTimeout(rollTimer)
  rollTimer = setTimeout(() => (lastRoll.value = null), 6000)
}

/** Dice-tray rolls carry no crit/fumble semantics; they still belong in the
 *  session's roll history. The tray shows its own inline result + toast, so we
 *  only record it here (no floating lastRoll card) — after the overlay's
 *  reveal, when the animation is on. */
function onDiceRoll(entry: { formula: string; total: number }): void {
  finishRollAnim({ formula: entry.formula, total: entry.total }, () =>
    pushHistory({ label: 'Dice roll', total: entry.total, formula: entry.formula, isCritical: false, isFumble: false }),
  )
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
      actionSheetFor.value = actionId
      break
    case 'cast':
      if (tryOpenCombatTargeting(actionId, action)) break
      if (action.targetable) openTargetPicker(actionId)
      else actionSheetFor.value = actionId
      break
    case 'attack':
      if (tryOpenCombatTargeting(actionId, action)) break
      actionSheetFor.value = actionId
      break
    case 'damage': {
      const crit = critArmed.value.has(actionId)
      const lvl = castLevels.value[actionId]
      void submitAction(
        { kind: 'damage', actionId, ...(crit ? { critical: true } : {}), ...(lvl !== undefined ? { slotLevel: lvl } : {}) },
        `${action.label} — ${crit ? 'Critical Damage' : 'Damage'}`,
      )
      break
    }
    case 'use':
      if (tryOpenCombatTargeting(actionId, action)) break
      void submitAction({ kind: 'use', actionId }, action.label, action.effectType)
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
    case 'grip':
      void submitAction(
        { kind: 'grip', actionId, grip: action.grip === 'twoHanded' ? 'oneHanded' : 'twoHanded' },
        action.label,
      )
      break
    case 'pool':
      // M23: open the pool roll sheet, pre-filled with this descriptor's
      // default pairing (and the tapped stat, since the descriptor's
      // default IS the tapped stat — see poolAttributeActions/
      // poolSkillActions/poolPowerActions in the wod5e adapter). The
      // player confirms (or repicks) in onPoolSubmit below.
      poolActionId.value = actionId
      break
  }
}

function onCombatAction(actionId: string): void {
  if (offline.value || actionBusy.value) return
  const action = actionMap.value[actionId]
  if (!action) return
  if (action.kind === 'cast') {
    if (tryOpenCombatTargeting(actionId, action)) return
    if (action.targetable) {
      openTargetPicker(actionId)
      return
    }
    if (action.slotLevels === undefined) {
      void submitAction({ kind: 'cast', actionId }, action.label, action.effectType)
      return
    }
    if (action.slotLevels.length === 0) return
    if (action.slotLevels.length === 1) {
      void submitAction({ kind: 'cast', actionId, slotLevel: action.slotLevels[0] }, action.label, action.effectType)
      return
    }
    actionSheetFor.value = actionId
    return
  }
  onAction(actionId)
}

function onActionSubmit(intent: ActionIntent): void {
  const action = actionMap.value[intent.actionId]
  actionSheetFor.value = null
  const targetActorId = pendingTargetActorId.value
  pendingTargetActorId.value = undefined
  const targetTokenUuids = pendingTargetTokenUuids.value
  pendingTargetTokenUuids.value = undefined
  let finalIntent: ActionIntent = intent.kind === 'cast' && targetActorId ? { ...intent, targetActorId } : intent
  if (
    targetTokenUuids &&
    (finalIntent.kind === 'attack' || finalIntent.kind === 'cast' || finalIntent.kind === 'use')
  ) {
    finalIntent = { ...finalIntent, targetTokenUuids }
  }
  const label =
    intent.kind === 'cast' ? castLabel(action?.label ?? 'Roll', targetActorId) : (action?.label ?? 'Roll')
  void submitAction(finalIntent, label, action?.effectType)
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

async function onConditionAction(actionId: string): Promise<void> {
  if (offline.value || actionBusy.value) return
  const action = actionMap.value[actionId]
  if (!action || action.kind !== 'endeffect') return
  const label = action.label.replace(/^End /, '')
  const ok = await askConfirm(`Remove ${label}?`)
  if (!ok) return
  void submitAction({ kind: 'endeffect', actionId }, action.label)
}

/** M23: pool rolls and the Rouse check are wod5e's "successes counted, no
 *  total" mechanic — a RollResultPill (built for d20 totals/crits) doesn't
 *  fit, so both surface their outcome as a toast instead of submitAction's
 *  showRoll path (binding contract). */

/** For these wod5e `cs>=6` formulas the gateway's `result.total` IS the
 *  success count (Task 0 finding), not a d20-style total — so once the
 *  action response comes back we can tell the player the real outcome
 *  instead of just repeating the pre-roll preview. */
function successSuffix(total: number | undefined): string {
  return total !== undefined ? ` — ${total} success${total === 1 ? '' : 'es'}` : ''
}

async function onPoolSubmit(intent: ActionIntent, preview: string): Promise<void> {
  if (offline.value || actionBusy.value || intent.kind !== 'pool') return
  actionBusy.value = intent.actionId
  try {
    const res = await api<ActionResponse>(`/api/actors/${actorId.value}/actions`, {
      method: 'POST',
      body: intent,
    })
    applySheet(res.sheet)
    toast.show(`${res.result?.flavor ?? preview}${successSuffix(res.result?.total)}`)
    poolActionId.value = null
  } catch (err) {
    const status = errorStatus(err)
    if (status === 401) {
      clearToken()
      await navigateTo('/join', { replace: true })
    } else if (status === 404) {
      // Ownership check: this token doesn't own the actor (device switched
      // to another player's invite). Retrying can never succeed — stop
      // pretending the cached sheet works.
      showNotLinked()
    } else if (status === 403 || status === 422) {
      toast.show('That action isn’t available right now.')
      void fetchSheet()
    } else if (status === 429) {
      toast.show('Slow down — too many actions at once')
    } else {
      toast.show('The table didn’t respond. Try again.')
    }
    // Error keeps the sheet open (binding contract) — poolActionId untouched.
  } finally {
    actionBusy.value = null
  }
}

async function onRouse(): Promise<void> {
  const action = rouseAction.value
  if (offline.value || actionBusy.value || !action) return
  actionBusy.value = action.id
  try {
    const res = await api<ActionResponse>(`/api/actors/${actorId.value}/actions`, {
      method: 'POST',
      body: { kind: 'rouse', actionId: action.id },
    })
    applySheet(res.sheet)
    toast.show(
      `${action.label} rolled${successSuffix(res.result?.total)} — see Foundry chat. On failure: +1 Hunger (mark it on Vitals)`,
    )
  } catch (err) {
    const status = errorStatus(err)
    if (status === 401) {
      clearToken()
      await navigateTo('/join', { replace: true })
    } else if (status === 404) {
      // Ownership check: this token doesn't own the actor (device switched
      // to another player's invite). Retrying can never succeed — stop
      // pretending the cached sheet works.
      showNotLinked()
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

async function onCustomItemSubmit(input: {
  name: string
  type: string
  damage?: number
  description?: string
}): Promise<void> {
  if (customItemBusy.value) return
  customItemBusy.value = true
  customItemError.value = null
  try {
    const res = await api<SheetResponse>(`/api/actors/${actorId.value}/items`, {
      method: 'POST',
      body: input,
    })
    applySheet(res.sheet)
    toast.show(`${input.name} added`)
    closeCustomItem()
  } catch (err) {
    const status = errorStatus(err)
    if (status === 401) {
      clearToken()
      await navigateTo('/join', { replace: true })
    } else if (status === 422) {
      const data = errorData<ApiErrorBody>(err)
      customItemError.value = data?.error?.message ?? 'Check the form and try again.'
    } else if (status === 429) {
      toast.show('Slow down — too many changes at once')
    } else {
      toast.show('That didn’t go through. Try again.')
    }
  } finally {
    customItemBusy.value = false
  }
}

function onDetail(item: ListItem): void {
  // Open the sheet when there is a description to read OR a reachable remove
  // action to host — description-less gear/feats are still removable (M13).
  // The actions map tells us whether a move descriptor exists (M19).
  const moveActionId =
    !offline.value && actionMap.value[`item.${item.id}.move`] ? `item.${item.id}.move` : undefined
  if (!item.detail && !(item.removable && !offline.value) && !moveActionId) return
  detailFor.value = {
    title: item.label,
    detail: item.detail ?? '',
    itemId: item.id,
    ...(item.removable ? { removable: item.removable } : {}),
    ...(moveActionId ? { moveActionId, currentContainerId: item.containerId ?? null } : {}),
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
const moveBusy = ref(false)

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
    if (s.kind === 'list' && s.header?.removable === cid) names.push(s.header.label)
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

async function onMove(targetId: string | null): Promise<void> {
  const d = detailFor.value
  if (!d?.moveActionId || moveBusy.value || offline.value) return
  const destination = targetId === null ? 'Carried' : containerOptions.value.find((c) => c.id === targetId)?.label ?? 'container'
  moveBusy.value = true
  try {
    const res = await api<ActionResponse>(`/api/actors/${actorId.value}/actions`, {
      method: 'POST',
      body: { kind: 'move', actionId: d.moveActionId, containerId: targetId },
    })
    applySheet(res.sheet)
    detailFor.value = null
    toast.show(`${d.title} → ${destination}`)
  } catch {
    toast.show('Couldn’t move that.')
  } finally {
    moveBusy.value = false
  }
}

async function submitAction(intent: ActionIntent, label: string, effectType?: EffectType): Promise<void> {
  if (offline.value || actionBusy.value) return
  actionBusy.value = intent.actionId
  if (ROLL_ANIM_KINDS.has(intent.kind)) startRollAnim(label)
  try {
    const res = await api<ActionResponse>(`/api/actors/${actorId.value}/actions`, {
      method: 'POST',
      body: intent,
    })
    applySheet(res.sheet)
    if (intent.kind === 'cast' && intent.slotLevel !== undefined) {
      castLevels.value = { ...castLevels.value, [intent.actionId.replace(/\.cast$/, '.damage')]: intent.slotLevel }
    }
    if (res.outcome) {
      // Targeted attack/cast/use (2026-07-22): the per-target outcome sheet
      // replaces the roll pill entirely, even when `result` also carries the
      // attack roll total (docs/API.md) — no dice-roll overlay for this path.
      cancelRollAnim()
      actionOutcome.value = { outcome: res.outcome, label, heal: effectType === 'heal' }
      return
    }
    if (res.result) {
      updateCritArmed(intent, res.result)
      // Weapon damage rolls carry their effect via the intent kind itself
      // (no effectType on 'damage' descriptors — Attacks stays unfiltered).
      // 'heal' from a cast/use descriptor is always a genuine heal roll —
      // every heal-type item routes through a client-computed formula,
      // never through a bare use-spell/use-feature. But a 'damage' *cast*
      // (e.g. Guiding Bolt) still falls through to use-spell, whose
      // auto-executed roll is the ATTACK (to-hit) roll, not damage — the
      // relay has no spell-damage-roll capability (same gap as weapons).
      // Item USES are different: a damage-classified item (Bead of Force)
      // returns its client-computed damage roll, so its descriptor
      // effectType IS trustworthy — only spell casts must suppress it.
      const itemDamageUse =
        intent.kind === 'use' && intent.actionId.startsWith('item.') && effectType === 'damage'
      const effect =
        intent.kind === 'damage' || itemDamageUse ? 'damage' : effectType === 'heal' ? 'heal' : undefined
      showRoll(res.result, label, effect)
      return
    }
    cancelRollAnim() // animated kind but no client-side roll came back
    switch (intent.kind) {
      case 'equip':
        toast.show(`${label} ${intent.equipped ? 'equipped' : 'unequipped'}`)
        break
      case 'attune':
        toast.show(`${label} ${intent.attuned ? 'attuned' : 'attunement ended'}`)
        break
      case 'grip':
        toast.show(`${label} — ${intent.grip === 'twoHanded' ? 'two-handed' : 'one-handed'}`)
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
      case 'endeffect':
        toast.show(`${label.replace(/^End /, '')} removed`)
        break
      default:
        toast.show(`${label} done — see Foundry chat`)
    }
  } catch (err) {
    cancelRollAnim()
    const status = errorStatus(err)
    if (status === 401) {
      clearToken()
      await navigateTo('/join', { replace: true })
    } else if (status === 404) {
      // Ownership check: this token doesn't own the actor (device switched
      // to another player's invite). Retrying can never succeed — stop
      // pretending the cached sheet works.
      showNotLinked()
    } else if (
      status === 409 &&
      'targetTokenUuids' in intent &&
      intent.targetTokenUuids &&
      intent.targetTokenUuids.length > 0
    ) {
      // Targeted attack/cast/use with no active encounter (combat ended or
      // the mirror lagged behind the tap) — the sheet is already fresh, just
      // explain why the targeted action didn't go through. Untargeted 409s
      // (e.g. a stale hp write, dash/movement conflicts handled elsewhere)
      // fall through to the generic copy below — this message would be
      // actively misleading for them.
      toast.show('No active encounter — that target picker just closed.')
    } else if (status === 403 || status === 422) {
      const msg = errorData<ApiErrorBody>(err)?.error?.message
      if (msg && /Allow Execute JS/i.test(msg)) toast.show(msg)
      else toast.show('That action isn’t available right now.')
      void fetchSheet()
    } else if (status === 429) {
      toast.show('Slow down — too many actions at once')
    } else if (
      status === 502 &&
      'targetTokenUuids' in intent &&
      intent.targetTokenUuids &&
      intent.targetTokenUuids.length > 0
    ) {
      // A targeted orchestration's relay timeout is never retried — Foundry
      // may already have applied damage — so the gateway's message must
      // reach the player verbatim rather than the usual generic copy.
      // Untargeted 502s (e.g. remove-effect, generic upstream errors) fall
      // through to the pre-existing generic copy below.
      const msg = errorData<ApiErrorBody>(err)?.error?.message
      toast.show(msg ?? 'The table didn’t respond. Try again.')
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

/** Second, independent EventSource for the M22 encounter mirror — own
 *  connection, own backoff state, closed on unmount alongside the sheet
 *  stream but otherwise unrelated to it (a hiccup on one stream must not
 *  affect the other). */
let esCombat: EventSource | null = null
let combatRetries = 0
let combatReconnectTimer: ReturnType<typeof setTimeout> | undefined
const combatConn = ref<'live' | 'reconnecting' | 'offline'>('reconnecting')

function closeCombatEvents(): void {
  esCombat?.close()
  esCombat = null
  if (combatReconnectTimer !== undefined) clearTimeout(combatReconnectTimer)
  combatReconnectTimer = undefined
}

function connectCombatEvents(): void {
  closeCombatEvents()
  if (!navigator.onLine) {
    combatConn.value = 'offline'
    return
  }
  const token = getToken() ?? ''
  esCombat = new EventSource(`${base}/api/encounter/events?token=${encodeURIComponent(token)}`)
  esCombat.onopen = () => {
    combatConn.value = 'live'
    combatRetries = 0
  }
  esCombat.addEventListener('encounter', (event) => {
    combatConn.value = 'live'
    combatRetries = 0
    try {
      encounter.value = JSON.parse((event as MessageEvent<string>).data) as EncounterView
    } catch {
      /* malformed frame — keep current encounter mirror */
    }
  })
  esCombat.onerror = () => {
    closeCombatEvents()
    if (!navigator.onLine) {
      combatConn.value = 'offline'
      return
    }
    combatConn.value = 'reconnecting'
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(combatRetries, 5))
    combatRetries += 1
    combatReconnectTimer = setTimeout(connectCombatEvents, delay)
  }
}

function openCombatant(id: string): void {
  if (offline.value) return
  combatantForId.value = id
}

async function applyCombatantHp(delta: number): Promise<void> {
  const target = combatantFor.value
  if (!target || combatantHpBusy.value || delta === 0) return
  combatantHpBusy.value = true
  try {
    const res = await api<EncounterHpResponse>(`/api/encounter/combatants/${target.id}/hp`, {
      method: 'POST',
      body: { kind: 'delta', amount: delta },
    })
    encounter.value = res.encounter
    toast.show(`${Math.abs(delta)} ${delta < 0 ? 'dmg' : 'heal'} → ${target.name}`)
    combatantForId.value = null
  } catch (err) {
    const status = errorStatus(err)
    if (status === 401) {
      clearToken()
      await navigateTo('/join', { replace: true })
    } else if (status === 429) {
      toast.show('Slow down — too many changes at once')
    } else {
      toast.show('Change didn’t go through. Try again.')
    }
    // Error keeps the sheet open (brief) — combatantForId stays set so the
    // player can retry or cancel explicitly.
  } finally {
    combatantHpBusy.value = false
  }
}

function onOnline(): void {
  conn.value = 'reconnecting'
  retries = 0
  void fetchSheet()
  connectEvents()
  combatConn.value = 'reconnecting'
  combatRetries = 0
  connectCombatEvents()
}

function onOffline(): void {
  conn.value = 'offline'
  closeEvents()
  combatConn.value = 'offline'
  closeCombatEvents()
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
    combatConn.value = 'offline'
    loading.value = false
    if (!sheet.value) loadError.value = 'You are offline and no saved sheet exists yet.'
    return
  }

  void fetchSheet()
  connectEvents()
  connectCombatEvents()
})

onBeforeUnmount(() => {
  if (rollTimer !== undefined) clearTimeout(rollTimer)
  if (rollAnimTimer !== undefined) clearTimeout(rollAnimTimer)
  closeEvents()
  closeCombatEvents()
  window.removeEventListener('online', onOnline)
  window.removeEventListener('offline', onOffline)
  delete document.documentElement.dataset.system
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

.frame.with-carousel {
  padding-bottom: calc(170px + var(--safe-bottom));
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

/* Roll-animation toggle in its OFF state (slashed d20). */
.tool-off {
  color: var(--ink-faint);
  opacity: 0.75;
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

/* Spell filter chips (2026-07-18) — same look as the Actions tab's. */
.filter-chips {
  display: flex;
  gap: 8px;
  padding: 10px 2px;
  overflow-x: auto;
}

.chip {
  flex: none;
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 0.76rem;
  font-weight: 600;
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--ink-dim);
}

.chip.active {
  border-color: var(--gold-deep);
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  color: var(--accent-ink);
}

.lib-add svg {
  width: 16px;
  height: 16px;
}

.lib-add:active {
  transform: scale(0.98);
}

.gear-note {
  margin-top: 8px;
  font-size: 0.74rem;
  color: var(--ink-faint);
  text-align: center;
}

.rouse-btn {
  width: 100%;
  min-height: 52px;
  margin-top: 4px;
}

.rouse-btn.pending {
  opacity: 0.55;
}

/* ---- combat carousel dock (M22) ---- */

.carousel-dock {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 68px;
  z-index: 39;
  max-width: 480px;
  margin: 0 auto;
  padding: 8px 16px;
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-top: 1px solid var(--line);
}

/* ---- collapsed-carousel restore pill (2026-07-23) ---- */

.carousel-pill {
  position: fixed;
  right: 14px;
  bottom: calc(84px + var(--safe-bottom));
  z-index: 39;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 999px;
  border: 1px solid var(--gold-deep);
  background: linear-gradient(180deg, var(--gold-bright), var(--gold));
  color: var(--accent-ink);
  box-shadow: 0 4px 14px color-mix(in srgb, var(--gold) 34%, transparent);
}

.carousel-pill svg {
  width: 24px;
  height: 24px;
}

.carousel-pill:active {
  transform: scale(0.94);
}

.carousel-pill.your-turn {
  animation: pill-pulse 1.4s ease-in-out infinite;
}

@keyframes pill-pulse {
  0%, 100% {
    box-shadow: 0 4px 14px color-mix(in srgb, var(--gold) 34%, transparent);
  }
  50% {
    box-shadow: 0 4px 14px color-mix(in srgb, var(--gold) 34%, transparent),
      0 0 0 4px color-mix(in srgb, var(--gold-bright) 45%, transparent);
  }
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
