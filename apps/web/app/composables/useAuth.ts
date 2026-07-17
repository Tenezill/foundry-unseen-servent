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

/** Evict a cached sheet — e.g. when the current token turns out not to own
 *  the actor (device switched to another player's invite): the stale render
 *  must not keep masquerading as a working sheet. */
export function clearCachedSheet(actorId: string): void {
  try {
    localStorage.removeItem(sheetKey(actorId))
  } catch {
    /* noop */
  }
}

const ADMIN_KEY = 'fc:admin'

export function getAdminSecret(): string | null {
  return safeGet(ADMIN_KEY)
}

export function setAdminSecret(secret: string): void {
  safeSet(ADMIN_KEY, secret)
}

export function clearAdminSecret(): void {
  try {
    localStorage.removeItem(ADMIN_KEY)
  } catch {
    /* noop */
  }
}
