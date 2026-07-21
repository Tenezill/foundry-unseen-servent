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
 *
 * Critical review fix (b0fca80 review, finding 1): main.ts's converge pass
 * used to run its OWN readPersistedKey + probeKey and only call ensureKey
 * when that probe was NOT valid — so a probe-valid key with a stale/missing
 * sidecar (exactly the scenario above) never reached this drift check at
 * all. `hasScopeDrift` below is exported so main.ts's probe branch can
 * consult it directly, alongside its own probe, without giving up its
 * unreachable/backoff branching (see main.ts's converge pass for the call
 * site and why a predicate — not routing through ensureKey unconditionally —
 * was the better fit there).
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

/** True when the sidecar is missing/corrupt/old-format (unknown scopes ->
 *  treated as full drift, the one-time post-upgrade migration) or when a
 *  canonical scope is absent from the persisted REQUESTED list — never the
 *  GRANTED list (see key-scopes-file.ts header for why: comparing against
 *  granted would re-mint forever on a relay build that permanently rejects
 *  one canonical scope, e.g. `wod5e`). Exported so main.ts's converge pass
 *  can consult it next to its own probe (Critical review fix, finding 1). */
export function hasScopeDrift(keyFilePath: string): boolean {
  const persisted = readKeyScopesFile(keyFilePath);
  if (persisted === null) return true;
  return missingScopes(persisted.requested, GATEWAY_KEY_SCOPES).length > 0;
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
      // Missing/unreadable/corrupt/old-format sidecar = unknown REQUESTED
      // scopes = drift. Every install predates this sidecar (it's new), so
      // this is the intended one-time migration: the first pass after
      // upgrading re-mints once, writes the sidecar, and every subsequent
      // pass is drift-free again (see hasScopeDrift for why REQUESTED, not
      // GRANTED, is what's compared).
      if (!hasScopeDrift(deps.keyFilePath)) return existing;
      const persisted = readKeyScopesFile(deps.keyFilePath);
      const missing =
        persisted === null ? [...GATEWAY_KEY_SCOPES] : missingScopes(persisted.requested, GATEWAY_KEY_SCOPES);
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
  writeKeyScopesFileAtomic(deps.keyFilePath, { requested: GATEWAY_KEY_SCOPES, granted: mintedScopes });
  const verdict = await deps.relay.probeKey(key);
  if (verdict !== 'valid') {
    throw new RelayAuthError(`freshly minted key failed its probe (${verdict})`, undefined, '/clients');
  }
  deps.status.set('key-ready', 'relay credentials ready');
  deps.log.info('gateway relay key minted and persisted');
  return key;
}
