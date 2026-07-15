/**
 * Gateway configuration from environment (docs/API.md "Gateway configuration").
 * RELAY_* values are secrets: they must never appear in any client-visible
 * response body or error message.
 */

export interface GatewayConfig {
  port: number;
  relayUrl: string;
  /** Explicit key (back-compat). When both this and relayApiKeyFile are set,
   *  the explicit key wins and the file is ignored. */
  relayApiKey?: string;
  /** Turnkey: path to the sidecar-written relay.env, hot-reloaded via
   *  ApiKeySource; legitimately absent at boot. */
  relayApiKeyFile?: string;
  /** 'auto' or an explicit fvtt_… world client id. */
  relayClientId: string;
  /** Bounded boot wait for the key file before starting degraded. */
  keyBootWaitMs: number;
  playersFile: string;
  /** Adapter used when the relay doc does not carry a system id. */
  defaultSystemId: string;
  /** Poll interval for the live-update fallback when relay SSE fails. */
  livePollMs: number;
  /** Enables /api/admin/* when set. Unset/empty = admin surface disabled. */
  adminPassword?: string;
  /** Turnkey: sidecar status.json merged into /healthz when set. */
  statusFile?: string;
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
  const relayApiKey = env.RELAY_API_KEY;
  const relayApiKeyFile = env.RELAY_API_KEY_FILE;
  const hasExplicitKey = relayApiKey !== undefined && relayApiKey !== '';
  const hasKeyFile = relayApiKeyFile !== undefined && relayApiKeyFile !== '';
  if (!hasExplicitKey && !hasKeyFile) {
    throw new Error('missing required env var RELAY_API_KEY (or RELAY_API_KEY_FILE)');
  }
  return {
    port: int('PORT', 8090),
    relayUrl: required('RELAY_URL'),
    ...(hasExplicitKey ? { relayApiKey: relayApiKey as string } : {}),
    ...(hasKeyFile && !hasExplicitKey ? { relayApiKeyFile: relayApiKeyFile as string } : {}),
    // 'auto' (turnkey; also the default when unset/empty) or an explicit
    // fvtt_… id (back-compat — behaves exactly as before).
    relayClientId:
      env.RELAY_CLIENT_ID === undefined || env.RELAY_CLIENT_ID === '' || env.RELAY_CLIENT_ID === 'auto'
        ? 'auto'
        : env.RELAY_CLIENT_ID,
    keyBootWaitMs: int('KEY_BOOT_WAIT_MS', 15_000),
    playersFile: required('PLAYERS_FILE'),
    defaultSystemId: env.DEFAULT_SYSTEM_ID ?? 'dnd5e',
    livePollMs: int('LIVE_POLL_MS', 3000),
    ...(env.ADMIN_PASSWORD !== undefined && env.ADMIN_PASSWORD !== ''
      ? { adminPassword: env.ADMIN_PASSWORD }
      : {}),
    ...(env.STATUS_FILE !== undefined && env.STATUS_FILE !== '' ? { statusFile: env.STATUS_FILE } : {}),
  };
}
