/** Thin $fetch wrapper: gateway base URL + bearer token on every request. */

export interface ApiRequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
}

export function useApi() {
  const config = useRuntimeConfig()
  const base = config.public.apiBase || ''

  async function api<T>(path: string, opts: ApiRequestOptions = {}): Promise<T> {
    return await $fetch<T>(`${base}${path}`, {
      method: opts.method ?? 'GET',
      body: opts.body as Record<string, unknown> | undefined,
      headers: { authorization: `Bearer ${getToken() ?? ''}` },
    })
  }

  return { api, base }
}

/** Best-effort extraction of an HTTP status from a $fetch error. */
export function errorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } }
  for (const s of [e.status, e.statusCode, e.response?.status]) {
    if (typeof s === 'number') return s
  }
  return undefined
}

/** The parsed JSON body a $fetch error carries (FetchError#data). */
export function errorData<T>(err: unknown): T | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  return (err as { data?: T }).data
}
