/** Token + per-actor persistence in localStorage (client-only app, ssr:false). */
import type { SheetViewModel } from '@companion/adapter-sdk'

const TOKEN_KEY = 'fc:token'
const LAST_ACTOR_KEY = 'fc:lastActor'
const sheetKey = (actorId: string) => `fc:sheet:${actorId}`

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private mode / quota — degrade silently */
  }
}

export function getToken(): string | null {
  return safeGet(TOKEN_KEY)
}

export function setToken(token: string): void {
  safeSet(TOKEN_KEY, token)
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* noop */
  }
}

export function getLastActor(): string | null {
  return safeGet(LAST_ACTOR_KEY)
}

export function setLastActor(actorId: string): void {
  safeSet(LAST_ACTOR_KEY, actorId)
}

export function loadCachedSheet(actorId: string): SheetViewModel | null {
  const raw = safeGet(sheetKey(actorId))
  if (!raw) return null
  try {
    return JSON.parse(raw) as SheetViewModel
  } catch {
    return null
  }
}

export function saveCachedSheet(actorId: string, sheet: SheetViewModel): void {
  safeSet(sheetKey(actorId), JSON.stringify(sheet))
}
