/**
 * Key lifecycle (spec §Bootstrap sidecar 1): relay keys are shown once, so
 * "reuse" means persist + probe-validate + re-mint ONLY on 401/403 OR on
 * scope drift. This self-heals the wiped-independently case: fresh relay DB
 * + stale key file -> probe 401 -> re-mint; fresh key file + intact DB ->
 * probe 200 -> zero /auth traffic (the throttle budget is never touched on
 * the steady path) — UNLESS the persisted key's scopes (tracked in the
 * relay.env.scopes.json sidecar, key-scopes-file.ts) have drifted behind
 * GATEWAY_KEY_SCOPES, e.g. a stack update adds `scene:read`/`canvas:write`
 * for token movement and an existing install's key predates them: probe
 * still passes (the key IS valid), but the new endpoints would 403/502 —
 * so drift forces a re-mint even on a probe-valid key.
 */
import { GATEWAY_KEY_SCOPES } from './scopes.js';
import { readPersistedKey, writeKeyFileAtomic } from './key-file.js';
import { readKeyScopesFile, writeKeyScopesFileAtomic } from './key-scopes-file.js';
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

/** Canonical scopes absent from a persisted scope list; empty = no drift.
 *  Extra scopes on the persisted list (beyond canonical) are fine — only a
 *  MISSING canonical scope is drift. */
function missingScopes(persisted: readonly string[], canonical: readonly string[]): string[] {
  return canonical.filter((s) => !persisted.includes(s));
}

/** One provisioning pass; throws on unreachable/throttled/login failure —
 *  the caller (main loop) retries with backoff on the next tick. */
export async function ensureKey(deps: ProvisionDeps): Promise<string> {
  const existing = readPersistedKey(deps.keyFilePath);
  if (existing !== null) {
    const verdict = await deps.relay.probeKey(existing);
    if (verdict === 'unreachable') {
      throw new RelayAuthError('relay unreachable during key probe', undefined, '/clients');
    }
    if (verdict === 'valid') {
      // Missing/unreadable/corrupt sidecar = unknown scopes = drift. Every
      // install predates this sidecar (it's new), so this is the intended
      // one-time migration: the first pass after upgrading re-mints once,
      // writes the sidecar, and every subsequent pass is drift-free again.
      const persistedScopes = readKeyScopesFile(deps.keyFilePath);
      const missing = persistedScopes === null ? [...GATEWAY_KEY_SCOPES] : missingScopes(persistedScopes, GATEWAY_KEY_SCOPES);
      if (missing.length === 0) return existing;
      deps.log.warn(`persisted relay key missing required scopes (${missing.join(', ')}); re-minting`);
    } else {
      deps.log.warn('persisted relay key rejected (stale key vs fresh relay DB?); re-minting');
    }
  }
  deps.status.set('provisioning-account', 'registering the relay account');
  const reg = await deps.relay.register(deps.email, deps.password);
  if (reg === 'throttled') throw new RelayAuthError('auth throttled', 429, '/auth/register');
  const bearer = await deps.relay.login(deps.email, deps.password);
  deps.status.set('minting-key', 'minting the gateway API key');
  const { key, scopes: mintedScopes } = await deps.relay.mintKey(bearer, 'companion-gateway', GATEWAY_KEY_SCOPES);
  writeKeyFileAtomic(deps.keyFilePath, key);
  writeKeyScopesFileAtomic(deps.keyFilePath, mintedScopes);
  const verdict = await deps.relay.probeKey(key);
  if (verdict !== 'valid') {
    throw new RelayAuthError(`freshly minted key failed its probe (${verdict})`, undefined, '/clients');
  }
  deps.status.set('key-ready', 'relay credentials ready');
  deps.log.info('gateway relay key minted and persisted');
  return key;
}
