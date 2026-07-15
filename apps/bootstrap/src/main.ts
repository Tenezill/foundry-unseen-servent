/**
 * The converge loop (spec §Bootstrap sidecar): an always-on state machine
 * that never exits — every pass is idempotent, every failure is retried
 * with backoff, restart: unless-stopped re-converges after crashes.
 * Ordering per pass: key -> module placement -> world relaunch -> session.
 * /auth traffic is gated by AUTH_BACKOFF_MS (relay throttle, Pitfall 1);
 * session attempts by SESSION_BACKOFF_MS (each spawns a headless-Chrome
 * login, Pitfall 13). Secrets are never logged.
 */
import { join } from 'node:path';
import { RelayAuthClient, RelayAuthError } from './relay-auth.js';
import { StatusWriter } from './status.js';
import { ensureKey } from './provision.js';
import { attemptSession, worldOnline } from './session.js';
import { ensureModulePlaced } from './module-install.js';
import { relaunchWorldIfIdle } from './foundry-admin.js';
import { startStatusPage } from './status-page.js';
import { readPersistedKey } from './key-file.js';

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`missing required env var ${name}`);
  return v;
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`env var ${name} must be a positive integer`);
  return n;
}

const log = {
  info: (msg: string): void => console.log(JSON.stringify({ level: 'info', msg })),
  warn: (msg: string): void => console.log(JSON.stringify({ level: 'warn', msg })),
};

async function main(): Promise<void> {
  const relayUrl = requiredEnv('RELAY_URL');
  const email = requiredEnv('RELAY_ACCOUNT_EMAIL');
  const password = requiredEnv('RELAY_ACCOUNT_PASSWORD');
  const foundryUrl = requiredEnv('FOUNDRY_URL');
  const gmUser = requiredEnv('FOUNDRY_GM_USER');
  const gmPassword = requiredEnv('FOUNDRY_GM_PASSWORD');
  const adminKey = requiredEnv('FOUNDRY_ADMIN_KEY');
  const runtimeDir = process.env.RUNTIME_DIR ?? '/run/companion';
  const foundryDataDir = process.env.FOUNDRY_DATA_DIR ?? '/foundry-data';
  const moduleSrcDir = process.env.MODULE_SRC_DIR ?? '/opt/foundry-rest-api';
  const statusPort = intEnv('STATUS_PORT', 8321);
  const pollMs = intEnv('POLL_MS', 10_000);
  const authBackoffMs = intEnv('AUTH_BACKOFF_MS', 60_000);
  const sessionBackoffMs = intEnv('SESSION_BACKOFF_MS', 60_000);

  const keyFilePath = join(runtimeDir, 'relay.env');
  const status = new StatusWriter(join(runtimeDir, 'status.json'));
  const relay = new RelayAuthClient({ baseUrl: relayUrl });
  startStatusPage(statusPort, () => status.current());
  log.info(`bootstrap sidecar up; status page on :${statusPort}`);

  let lastAuthAttemptAt = 0;
  let lastSessionAttemptAt = 0;

  for (;;) {
    try {
      // 1. Key: steady path is probe-only (no /auth traffic, no throttle).
      let key = readPersistedKey(keyFilePath);
      const probed = key !== null ? await relay.probeKey(key) : 'invalid';
      if (probed !== 'valid') {
        if (probed === 'unreachable') {
          status.set('waiting-relay', 'relay not reachable yet');
          key = null;
        } else if (Date.now() - lastAuthAttemptAt < authBackoffMs) {
          status.set('waiting-relay', 'backing off before the next auth attempt (relay /auth throttle)');
          key = null;
        } else {
          lastAuthAttemptAt = Date.now();
          key = await ensureKey({ relay, email, password, keyFilePath, status, log });
        }
      }

      if (key !== null) {
        // 2. Module pre-placement (idempotent; waits for felddy's /data init).
        const placement = ensureModulePlaced(moduleSrcDir, foundryDataDir);
        if (placement === 'placed') {
          status.set('placing-module', 'foundry-rest-api module installed');
          log.info('foundry-rest-api module placed into the Foundry data volume');
        }

        // 3. World relaunch after reboot (Task 0(b)-gated; best-effort).
        await relaunchWorldIfIdle({ foundryUrl, adminKey, foundryDataDir, log });

        // 4. Session convergence (bounded attempt rate — Pitfall 13).
        const online = await worldOnline(relay, key);
        if (online === 'online') {
          status.set('online', 'world online');
        } else if (online === 'unreachable') {
          status.set('waiting-relay', 'relay unreachable');
        } else if (Date.now() - lastSessionAttemptAt >= sessionBackoffMs) {
          lastSessionAttemptAt = Date.now();
          status.set('starting-session', 'attempting a headless GM session');
          const outcome = await attemptSession({ relay, key, foundryUrl, gmUser, gmPassword, log });
          switch (outcome) {
            case 'online':
              status.set('online', 'world online');
              break;
            case 'needs-pairing':
              status.set('needs-pairing', 'one-time browser pairing required');
              break;
            case 'gm-login-failed':
              status.set('gm-login-failed', 'headless GM login rejected');
              break;
            case 'relay-unreachable':
              status.set('waiting-relay', 'relay unreachable');
              break;
            case 'session-failed':
              status.set('waiting-world', 'no world online yet — create/launch your world in Foundry');
              break;
          }
        }
        // between session attempts: keep the last sticky status untouched
      }
    } catch (err) {
      const e = err as Error;
      const cls = e instanceof RelayAuthError ? e.name : (e.name ?? 'Error');
      status.set('error', 'converge pass failed; retrying', { class: cls, message: e.message });
      log.warn(`converge pass failed: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main().catch((err) => {
  console.error('bootstrap failed to start:', (err as Error).message);
  process.exit(1);
});
