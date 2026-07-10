/**
 * Gateway configuration from environment (docs/API.md "Gateway configuration").
 * RELAY_* values are secrets: they must never appear in any client-visible
 * response body or error message.
 */

export interface GatewayConfig {
  port: number;
  relayUrl: string;
  relayApiKey: string;
  relayClientId: string;
  playersFile: string;
  /** Adapter used when the relay doc does not carry a system id. */
  defaultSystemId: string;
  /** Poll interval for the live-update fallback when relay SSE fails. */
  livePollMs: number;
  /** Enables /api/admin/* when set. Unset/empty = admin surface disabled. */
  adminPassword?: string;
}

/**
 * The SSE route accepts ?token=<invite token>; pino's default request
 * serializer logs req.url verbatim, so the query value must be masked in a
 * custom serializer — `redact` paths cannot reach into a URL string.
 */
export function redactUrlToken(url: string): string {
  return url.replace(/([?&]token=)[^&#]*/gi, '$1[redacted]');
}

export function loadConfig(env: Record<string, string | undefined> = process.env): GatewayConfig {
  const required = (name: string): string => {
    const v = env[name];
    if (v === undefined || v === '') {
      throw new Error(`missing required env var ${name}`);
    }
    return v;
  };
  const int = (name: string, fallback: number): number => {
    const v = env[name];
    if (v === undefined || v === '') return fallback;
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`env var ${name} must be a positive integer`);
    }
    return n;
  };
  return {
    port: int('PORT', 8090),
    relayUrl: required('RELAY_URL'),
    relayApiKey: required('RELAY_API_KEY'),
    relayClientId: required('RELAY_CLIENT_ID'),
    playersFile: required('PLAYERS_FILE'),
    defaultSystemId: env.DEFAULT_SYSTEM_ID ?? 'dnd5e',
    livePollMs: int('LIVE_POLL_MS', 3000),
    ...(env.ADMIN_PASSWORD !== undefined && env.ADMIN_PASSWORD !== ''
      ? { adminPassword: env.ADMIN_PASSWORD }
      : {}),
  };
}
