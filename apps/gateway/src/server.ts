/**
 * Production bootstrap: env config -> players.yaml -> real relay client ->
 * default adapter registry -> Fastify listen. Secrets (token, relay key)
 * are redacted from structured logs and never reach response bodies.
 *
 * Turnkey additions: the relay key may be file-sourced (RELAY_API_KEY_FILE,
 * hot-reloaded), the clientId may be auto-resolved (RELAY_CLIENT_ID=auto),
 * and any identity change (rotated key / re-resolved clientId) restarts
 * every relay-side stream. All boot waits are bounded — the gateway starts
 * degraded and converges (Global Constraints: converge, never restart).
 */
import { FoundryRelayClient, type RelayClientInfo } from '@companion/foundry-client';
import { loadConfig, redactUrlToken } from './config.js';
import { createDefaultRegistry } from './registry.js';
import { buildApp } from './app.js';
import { EncounterManager } from './encounters.js';
import { FilePlayerStore } from './player-store.js';
import { ApiKeySource } from './key-source.js';
import { ClientIdResolver } from './client-id-resolver.js';
import { readBootstrapStatus } from './status-file.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new FilePlayerStore(cfg.playersFile);

  // The relay client and manager must exist before buildApp (the manager
  // registers the /api/encounter* routes only when present), but their
  // logger should be the real app's once built — a mutable indirection
  // bridges the ordering.
  let logRef: { warn(obj: object, msg: string): void; debug(obj: object, msg: string): void } = {
    warn: () => undefined,
    debug: () => undefined,
  };

  // Key source: explicit RELAY_API_KEY wins (back-compat); otherwise the
  // sidecar-written file, legitimately absent at boot.
  const keySource = cfg.relayApiKeyFile !== undefined ? new ApiKeySource(cfg.relayApiKeyFile) : null;
  keySource?.startWatching({ warn: (obj, msg) => logRef.warn(obj, msg) });
  const apiKey = (): string => cfg.relayApiKey ?? keySource?.current() ?? '';

  // clientId provider <-> resolver cycle: the resolver probes via the relay
  // client, whose clientId provider reads the resolver. listClients ignores
  // the clientId param, so the late-bound reference is safe — providers are
  // only invoked per request, after both objects exist.
  let resolverRef: ClientIdResolver | null = null;
  const relay = new FoundryRelayClient({
    baseUrl: cfg.relayUrl,
    apiKey,
    clientId: () => resolverRef?.current() ?? '',
    log: { warn: (obj, msg) => logRef.warn(obj, msg) },
  });
  const resolver = new ClientIdResolver(cfg.relayClientId, {
    listClients: (): Promise<RelayClientInfo[]> => relay.listClients(),
    hasKey: () => apiKey() !== '',
    log: { warn: (obj, msg) => logRef.warn(obj, msg) },
  });
  resolverRef = resolver;

  const encounters = new EncounterManager({
    relay,
    log: {
      warn: (obj, msg) => logRef.warn(obj, msg),
      debug: (obj, msg) => logRef.debug(obj, msg),
    },
  });

  // Identity fan-out: a rotated key or a (re)resolved clientId restarts
  // every relay-side stream (buildApp handles LiveManager + gm-rolls; the
  // EncounterManager is restarted here — server owns its lifecycle).
  const identityListeners = new Set<() => void>();
  const fireIdentityChanged = (): void => {
    for (const cb of [...identityListeners]) cb();
  };
  keySource?.onChange(() => fireIdentityChanged());
  resolver.onChange(() => fireIdentityChanged());
  identityListeners.add(() => encounters.restartStream());

  // Adapter-selection fallback (Task 0 findings §6-2): the relay's per-actor
  // getEntity doc carries no systemId, so the gateway needs a default. An
  // explicit DEFAULT_SYSTEM_ID always wins (back-compat, checked against the
  // raw env — cfg.defaultSystemId already collapsed "unset" to "dnd5e", so
  // it can't tell the two apart on its own). Otherwise, once RELAY_CLIENT_ID
  // =auto has resolved a world, that world's OWN systemId is a far better
  // fallback than the hardcoded "dnd5e" default — this is what fixes a
  // wod5e actor being rendered through the dnd5e adapter. Passed as a
  // provider (mirrors the apiKey/clientId providers) so a resolution that
  // completes after buildApp still takes effect on the next request.
  const explicitDefaultSystemId = process.env.DEFAULT_SYSTEM_ID;
  const defaultSystemId = (): string =>
    explicitDefaultSystemId ?? resolver.resolvedWorld()?.systemId ?? cfg.defaultSystemId;

  const app = buildApp({
    relay,
    players: store,
    registry: createDefaultRegistry(),
    defaultSystemId,
    livePollMs: cfg.livePollMs,
    encounters,
    relayIdentityChanged: (cb) => {
      identityListeners.add(cb);
      return () => identityListeners.delete(cb);
    },
    worldStatus: () => resolver.healthView(),
    ...(cfg.statusFile !== undefined
      ? { bootstrapStatus: () => readBootstrapStatus(cfg.statusFile as string) }
      : {}),
    ...(cfg.adminPassword !== undefined ? { admin: { password: cfg.adminPassword, store } } : {}),
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.query.token',
          'token',
          '*.token',
          'apiKey',
          '*.apiKey',
        ],
        censor: '[redacted]',
      },
      serializers: {
        req(req: { method?: string; url?: string; ip?: string }) {
          return {
            method: req.method,
            url: typeof req.url === 'string' ? redactUrlToken(req.url) : req.url,
            remoteAddress: req.ip,
          };
        },
      },
    },
  });

  logRef = {
    warn: (obj, msg) => app.log.warn(obj, msg),
    debug: (obj, msg) => app.log.debug(obj, msg),
  };
  store.startWatching({ warn: (obj, msg) => app.log.warn(obj, msg) });

  const close = async (): Promise<void> => {
    store.stopWatching();
    keySource?.stopWatching();
    resolver.stop();
    encounters.stop();
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void close());
  process.on('SIGTERM', () => void close());

  // Bounded boot wait: with a file-sourced key, give the sidecar a moment
  // before serving degraded (M18 pattern — never hard-block).
  if (keySource !== null && cfg.relayApiKey === undefined) {
    const ok = await keySource.waitUntilAvailable(cfg.keyBootWaitMs);
    if (!ok) {
      app.log.warn({ waitedMs: cfg.keyBootWaitMs }, 'relay key file not present yet; starting degraded');
    }
  }

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  resolver.start();
  await encounters.start();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('gateway failed to start:', (err as Error).message);
  process.exit(1);
});
