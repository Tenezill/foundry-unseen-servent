/**
 * Key lifecycle (spec §Bootstrap sidecar 1): relay keys are shown once, so
 * "reuse" means persist + probe-validate + re-mint ONLY on 401/403. This
 * self-heals the wiped-independently case: fresh relay DB + stale key file
 * -> probe 401 -> re-mint; fresh key file + intact DB -> probe 200 -> zero
 * /auth traffic (the throttle budget is never touched on the steady path).
 */
import { GATEWAY_KEY_SCOPES } from './scopes.js';
import { readPersistedKey, writeKeyFileAtomic } from './key-file.js';
import { RelayAuthClient, RelayAuthError } from './relay-auth.js';
import type { StatusWriter } from './status.js';

export interface ProvisionDeps {
  relay: RelayAuthClient;
  email: string;
  password: string;
  keyFilePath: string;
  status: StatusWriter;
  log: { info(msg: string): void; warn(msg: string): void };
}

/** One provisioning pass; throws on unreachable/throttled/login failure —
 *  the caller (main loop) retries with backoff on the next tick. */
export async function ensureKey(deps: ProvisionDeps): Promise<string> {
  const existing = readPersistedKey(deps.keyFilePath);
  if (existing !== null) {
    const verdict = await deps.relay.probeKey(existing);
    if (verdict === 'valid') return existing;
    if (verdict === 'unreachable') {
      throw new RelayAuthError('relay unreachable during key probe', undefined, '/clients');
    }
    deps.log.warn('persisted relay key rejected (stale key vs fresh relay DB?); re-minting');
  }
  deps.status.set('provisioning-account', 'registering the relay account');
  const reg = await deps.relay.register(deps.email, deps.password);
  if (reg === 'throttled') throw new RelayAuthError('auth throttled', 429, '/auth/register');
  const bearer = await deps.relay.login(deps.email, deps.password);
  deps.status.set('minting-key', 'minting the gateway API key');
  const key = await deps.relay.mintKey(bearer, 'companion-gateway', GATEWAY_KEY_SCOPES);
  writeKeyFileAtomic(deps.keyFilePath, key);
  const verdict = await deps.relay.probeKey(key);
  if (verdict !== 'valid') {
    throw new RelayAuthError(`freshly minted key failed its probe (${verdict})`, undefined, '/clients');
  }
  deps.status.set('key-ready', 'relay credentials ready');
  deps.log.info('gateway relay key minted and persisted');
  return key;
}
