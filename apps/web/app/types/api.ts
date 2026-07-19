/** Gateway API response shapes (docs/API.md). */
import type { ListItem, SheetViewModel } from '@companion/adapter-sdk'

export interface MeResponse {
  player: { name: string; actorIds: string[] }
}

export interface ActorSummary {
  id: string
  name: string
  img?: string
  systemId: string
}

export interface ActorsResponse {
  actors: ActorSummary[]
}

export interface SheetResponse {
  sheet: SheetViewModel
}

/** Roll outcome from POST /api/actors/:id/actions (null for e.g. equip). */
export interface ActionRollResult {
  total: number
  formula: string
  isCritical?: boolean
  isFumble?: boolean
  /** M23: not currently emitted by the gateway (no pool/rouse flavor field
   *  today) — forward-compatible field the pool sheet prefers over its own
   *  client-computed preview line, per the binding contract, if it ever is. */
  flavor?: string
}

export interface ActionResponse {
  result: ActionRollResult | null
  sheet: SheetViewModel
}

/** One client-side roll-history entry (in-memory, last ~20; not persisted). */
export interface RollLogEntry {
  id: number
  label: string
  total: number
  formula: string
  isCritical: boolean
  isFumble: boolean
}

export interface ApiErrorBody {
  error?: { code?: string; message?: string }
  /** 409 CONFLICT responses carry the fresh sheet. */
  sheet?: SheetViewModel
}

/** One hit from GET /api/actors/:id/library/:collection/search. */
export interface LibrarySearchEntry {
  uuid: string
  name: string
  img?: string
  pack?: string
}

export interface LibrarySearchResponse {
  results: LibrarySearchEntry[]
}

/** GET /api/actors/:id/library/:collection/preview — adapter-described entry. */
export interface LibraryPreviewResponse {
  preview: ListItem
}

// ---- admin console (M18) ----------------------------------------------------

export interface AdminPlayer {
  name: string
  gm: boolean
  actors: Array<{ id: string; name?: string }>
}

export interface AdminPlayersResponse {
  players: AdminPlayer[]
}

export interface AdminInviteResponse {
  token: string
  player?: { name: string; actorIds: string[]; gm: boolean }
}

export interface AdminActorsResponse {
  actors: Array<{ id: string; name: string; img?: string }>
}

/** Relay & Pairing panel: the relay account needed to approve a pairing
 *  request, plus the self-hosted URL where approvals happen. `account` is null
 *  until the bootstrap sidecar has written it; `pairBaseUrl` is null when
 *  RELAY_PUBLIC_URL is not configured. */
export interface AdminRelayResponse {
  account: { email: string; password: string } | null
  pairBaseUrl: string | null
}

// ---- encounters (M22) -------------------------------------------------------

/** One combatant as the gateway serializes it (docs/API.md, mirrors
 *  apps/gateway/src/encounters.ts). Exact hp is only ever attached to PCs —
 *  NPCs carry a derived `health` state instead, never both. */
export interface EncounterCombatantView {
  id: string
  actorId?: string
  name: string
  img?: string
  initiative: number | null
  isPC: boolean
  defeated: boolean
  health?: 'healthy' | 'wounded' | 'bloodied' | 'down'
  hp?: { value: number; max: number }
}

/** GET /api/encounter response body (bare, not envelope-wrapped) and the
 *  payload of every `event: encounter` SSE frame from /api/encounter/events. */
export interface EncounterView {
  active: boolean
  round?: number
  turn?: { combatantId: string | null }
  /** Initiative-desc order; hidden combatants already dropped. */
  combatants?: EncounterCombatantView[]
}

/** POST /api/encounter/combatants/:id/hp response. */
export interface EncounterHpResponse {
  encounter: EncounterView
}

/** GET /api/party — roster for the out-of-combat buff target picker. */
export interface PartyView {
  actors: Array<{ id: string; name?: string; img?: string }>
}
