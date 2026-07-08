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
