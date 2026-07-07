/**
 * Production bootstrap: env config -> players.yaml -> real relay client ->
 * default adapter registry -> Fastify listen. Secrets (token, relay key)
 * are redacted from structured logs and never reach response bodies.
 */
import { FoundryRelayClient } from '@companion/foundry-client';
import { loadConfig, redactUrlToken } from './config.js';
import { loadPlayers } from './players.js';
import { createDefaultRegistry } from './registry.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const players = loadPlayers(cfg.playersFile);
  const relay = new FoundryRelayClient({
    baseUrl: cfg.relayUrl,
    apiKey: cfg.relayApiKey,
    clientId: cfg.relayClientId,
  });

  const app = buildApp({
    relay,
    players,
    registry: createDefaultRegistry(),
    defaultSystemId: cfg.defaultSystemId,
    livePollMs: cfg.livePollMs,
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

  const close = async (): Promise<void> => {
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void close());
  process.on('SIGTERM', () => void close());

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('gateway failed to start:', (err as Error).message);
  process.exit(1);
});
