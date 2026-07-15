/**
 * The converge loop (spec §Bootstrap sidecar): an always-on state machine
 * that never exits — every pass is idempotent, every failure is retried
 * with backoff, restart: unless-stopped re-converges after crashes.
 * Ordering per pass: key -> module placement -> world relaunch -> session.
 * /auth traffic is gated by AUTH_BACKOFF_MS (relay throttle, Pitfall 1);
 * session attempts by SESSION_BACKOFF_MS (each spawns a headless-Chrome
 * login, Pitfall 13). Secrets are never logged.
 *
 * Module placement is best-effort (Task 8 review): on Linux, felddy's
 * runtime UID can differ from the sidecar's, so ensureModulePlaced's cpSync
 * can hit EACCES and the ownership mismatch never self-heals. A placement
 * failure must never starve the world relaunch / session steps that
 * follow — keeping the world online is the sidecar's one job; module
 * placement is retried, best-effort, every pass.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

export interface ConvergePassDeps {
  relay: RelayAuthClient;
  status: StatusWriter;
  email: string;
  password: string;
  foundryUrl: string;
  gmUser: string;
  gmPassword: string;
  adminKey: string;
  foundryDataDir: string;
  moduleSrcDir: string;
  keyFilePath: string;
  authBackoffMs: number;
  sessionBackoffMs: number;
  log: { info(msg: string): void; warn(msg: string): void };
}

export interface ConvergePassState {
  lastAuthAttemptAt: number;
  lastSessionAttemptAt: number;
}

/**
 * One pass of the converge loop. Exported for tests; main()'s for(;;) is the
 * only production caller. Never throws — a failed pass is caught and
 * reflected in status/logs so the loop retries on the next tick.
 */
export async function runConvergePass(deps: ConvergePassDeps, state: ConvergePassState): Promise<void> {
  try {
    // 1. Key: steady path is probe-only (no /auth traffic, no throttle).
    let key = readPersistedKey(deps.keyFilePath);
    const probed = key !== null ? await deps.relay.probeKey(key) : 'invalid';
    if (probed !== 'valid') {
      if (probed === 'unreachable') {
        deps.status.set('waiting-relay', 'relay not reachable yet');
        key = null;
      } else if (Date.now() - state.lastAuthAttemptAt < deps.authBackoffMs) {
        deps.status.set('waiting-relay', 'backing off before the next auth attempt (relay /auth throttle)');
        key = null;
      } else {
        state.lastAuthAttemptAt = Date.now();
        key = await ensureKey({
          relay: deps.relay,
          email: deps.email,
          password: deps.password,
          keyFilePath: deps.keyFilePath,
          status: deps.status,
          log: deps.log,
        });
      }
    }

    if (key !== null) {
      // 2. Module pre-placement (idempotent; waits for felddy's /data init).
      // Best-effort: ensureModulePlaced never throws (module-install.ts),
      // but this is deliberately its own try/catch too — a module-placement
      // problem must be recorded and NEVER prevent steps 3-4 from running.
      try {
        const placement = ensureModulePlaced(deps.moduleSrcDir, deps.foundryDataDir);
        if (placement === 'placed') {
          deps.status.set('placing-module', 'foundry-rest-api module installed');
          deps.log.info('foundry-rest-api module placed into the Foundry data volume');
        } else if (placement === 'placement-failed') {
          deps.log.warn('module placement failed (permission or I/O error); world convergence continues');
          deps.status.set(
            'placing-module',
            'module placement failed (will retry); world convergence continues',
            { class: 'ModulePlacementWarning', message: 'ensureModulePlaced returned placement-failed' },
          );
        }
      } catch (err) {
        const e = err as Error;
        deps.log.warn(`module placement threw unexpectedly: ${e.message}`);
        deps.status.set('placing-module', 'module placement failed unexpectedly; world convergence continues', {
          class: e.name ?? 'Error',
          message: e.message,
        });
      }

      // 3. World relaunch after reboot (Task 0(b)-gated; best-effort).
      await relaunchWorldIfIdle({
        foundryUrl: deps.foundryUrl,
        adminKey: deps.adminKey,
        foundryDataDir: deps.foundryDataDir,
        log: deps.log,
      });

      // 4. Session convergence (bounded attempt rate — Pitfall 13).
      const online = await worldOnline(deps.relay, key);
      if (online === 'online') {
        deps.status.set('online', 'world online');
      } else if (online === 'unreachable') {
        deps.status.set('waiting-relay', 'relay unreachable');
      } else if (Date.now() - state.lastSessionAttemptAt >= deps.sessionBackoffMs) {
        state.lastSessionAttemptAt = Date.now();
        deps.status.set('starting-session', 'attempting a headless GM session');
        const outcome = await attemptSession({
          relay: deps.relay,
          key,
          foundryUrl: deps.foundryUrl,
          gmUser: deps.gmUser,
          gmPassword: deps.gmPassword,
          log: deps.log,
        });
        switch (outcome) {
          case 'online':
            deps.status.set('online', 'world online');
            break;
          case 'needs-pairing':
            deps.status.set('needs-pairing', 'one-time browser pairing required');
            break;
          case 'gm-login-failed':
            deps.status.set('gm-login-failed', 'headless GM login rejected');
            break;
          case 'relay-unreachable':
            deps.status.set('waiting-relay', 'relay unreachable');
            break;
          case 'session-failed':
            deps.status.set('waiting-world', 'no world online yet — create/launch your world in Foundry');
            break;
        }
      }
      // between session attempts: keep the last sticky status untouched
    }
  } catch (err) {
    const e = err as Error;
    const cls = e instanceof RelayAuthError ? e.name : (e.name ?? 'Error');
    deps.status.set('error', 'converge pass failed; retrying', { class: cls, message: e.message });
    deps.log.warn(`converge pass failed: ${e.message}`);
  }
}

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

  const deps: ConvergePassDeps = {
    relay,
    status,
    email,
    password,
    foundryUrl,
    gmUser,
    gmPassword,
    adminKey,
    foundryDataDir,
    moduleSrcDir,
    keyFilePath,
    authBackoffMs,
    sessionBackoffMs,
    log,
  };
  const state: ConvergePassState = { lastAuthAttemptAt: 0, lastSessionAttemptAt: 0 };

  for (;;) {
    await runConvergePass(deps, state);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// Only auto-run when executed directly (tsx src/main.ts / the Docker CMD) —
// importing runConvergePass etc. for tests must not trigger a real boot.
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error('bootstrap failed to start:', (err as Error).message);
    process.exit(1);
  });
}
