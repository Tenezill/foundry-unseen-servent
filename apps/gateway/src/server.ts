/**
 * Production bootstrap: env config -> players.yaml -> real relay client ->
 * default adapter registry -> Fastify listen. Secrets (token, relay key)
 * are redacted from structured logs and never reach response bodies.
 */
import { FoundryRelayClient } from '@companion/foundry-client';
import { loadConfig, redactUrlToken } from './config.js';
import { createDefaultRegistry } from './registry.js';
import { buildApp } from './app.js';
import { EncounterManager } from './encounters.js';
import { FilePlayerStore } from './player-store.js';

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
  const relay = new FoundryRelayClient({
    baseUrl: cfg.relayUrl,
    apiKey: cfg.relayApiKey ?? '',
    clientId: cfg.relayClientId,
    log: { warn: (obj, msg) => logRef.warn(obj, msg) },
  });
  const encounters = new EncounterManager({
    relay,
    log: {
      warn: (obj, msg) => logRef.warn(obj, msg),
      debug: (obj, msg) => logRef.debug(obj, msg),
    },
  });

  const app = buildApp({
    relay,
    players: store,
    registry: createDefaultRegistry(),
    defaultSystemId: cfg.defaultSystemId,
    livePollMs: cfg.livePollMs,
    encounters,
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
    encounters.stop();
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void close());
  process.on('SIGTERM', () => void close());

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  await encounters.start();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('gateway failed to start:', (err as Error).message);
  process.exit(1);
});
