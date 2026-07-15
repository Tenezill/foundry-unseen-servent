/**
 * Keep-the-world-online pass (spec §Bootstrap sidecar 3). The REST module
 * only runs inside a logged-in GM browser; the relay ships a headless Chrome
 * that logs in itself via POST /session-handshake + /start-session
 * (docs/RELAY.md, docs/HOSTING.md B4a; payloads Task 0 findings §4).
 *
 * HEADLESS_SELF_PAIR is the Task 0(a) verdict (findings §1): whether a
 * NEVER-paired ("virgin") world can be brought online headlessly. When
 * false, zero client rows -> 'needs-pairing' (the status page guides the
 * accepted one-time browser pairing); the handshake still runs for a
 * once-paired-but-offline client row.
 */
import type { RelayAuthClient } from './relay-auth.js';

// Task 0 findings §1: the fully-headless self-pair of a VIRGIN world (zero
// client rows) could NOT be verified in this environment (the available key
// lacked session:manage). NO-GO default. Flip to true only after the
// operator-host verification described in findings §1 passes.
export const HEADLESS_SELF_PAIR = false;

export type SessionOutcome = 'online' | 'needs-pairing' | 'gm-login-failed' | 'relay-unreachable' | 'session-failed';

export async function worldOnline(relay: RelayAuthClient, key: string): Promise<'online' | 'offline' | 'unreachable'> {
  try {
    const clients = await relay.listClients(key);
    return clients.some((c) => c.isOnline === true) ? 'online' : 'offline';
  } catch {
    return 'unreachable';
  }
}

export interface SessionDeps {
  relay: RelayAuthClient;
  key: string;
  /** Reachable FROM THE RELAY CONTAINER, e.g. http://foundry:30000. */
  foundryUrl: string;
  gmUser: string;
  gmPassword: string;
  log: { info(msg: string): void; warn(msg: string): void };
}

export async function attemptSession(deps: SessionDeps): Promise<SessionOutcome> {
  let clients: Array<{ isOnline: boolean }>;
  try {
    clients = await deps.relay.listClients(deps.key);
  } catch {
    return 'relay-unreachable';
  }
  if (clients.some((c) => c.isOnline === true)) return 'online';
  if (clients.length === 0 && !HEADLESS_SELF_PAIR) return 'needs-pairing';

  let hs: { status: number; body: Record<string, unknown> };
  try {
    hs = await deps.relay.sessionHandshake(deps.key, deps.foundryUrl, deps.gmUser);
  } catch {
    return 'relay-unreachable';
  }
  if (hs.status < 200 || hs.status >= 300) {
    deps.log.warn(`session-handshake failed (${hs.status}) — Foundry warming or at the setup screen?`);
    return 'session-failed';
  }
  let started: { status: number; body: Record<string, unknown> };
  try {
    started = await deps.relay.startSession(deps.key, hs.body, deps.gmPassword);
  } catch {
    return 'relay-unreachable';
  }
  if (started.status >= 200 && started.status < 300) {
    // Trust /clients, not the response: confirm the world actually flipped.
    return (await worldOnline(deps.relay, deps.key)) === 'online' ? 'online' : 'session-failed';
  }
  const msg = typeof started.body.error === 'string' ? started.body.error : '';
  if (started.status === 401 || /credential|password|login/i.test(msg)) return 'gm-login-failed';
  deps.log.warn(`start-session failed (${started.status})`);
  return 'session-failed';
}
