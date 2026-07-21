/**
 * relay.env.scopes.json sidecar: records the exact scope list minted into the
 * adjacent key file, so `ensureKey` (provision.ts) can detect scope DRIFT —
 * a persisted key that predates a newly-required canonical scope (e.g.
 * `scene:read`/`canvas:write` added for token movement) — and re-mint instead
 * of keeping an under-scoped key forever.
 *
 * Kept OUT of the key file itself: the gateway's key-source.ts hot-reloads
 * relay.env expecting either `RELAY_API_KEY=<key>` or a bare key on its own
 * line (see parseKeyFile there). Teaching that reader about JSON/scopes would
 * break the hot-reload contract, so the scope list lives in a sidecar next to
 * it instead. Written atomically (same-directory temp + rename), same as
 * writeKeyFileAtomic in key-file.ts.
 */
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function scopesFilePath(keyFilePath: string): string {
  return `${keyFilePath}.scopes.json`;
}

export function writeKeyScopesFileAtomic(keyFilePath: string, scopes: readonly string[]): void {
  const filePath = scopesFilePath(keyFilePath);
  const tmp = join(dirname(filePath), `.${basename(filePath)}.tmp`);
  writeFileSync(tmp, `${JSON.stringify([...scopes])}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* windows dev box: modes are advisory there; Linux is what matters */
  }
  renameSync(tmp, filePath);
}

/** The persisted scope list, or null when the sidecar is missing, unreadable,
 *  or not a well-formed JSON array of strings. Every install predates this
 *  sidecar the first time it runs post-upgrade, so `null` here is the
 *  expected steady state for a one-time migration — see ensureKey's comment
 *  in provision.ts, which treats null as "unknown scopes" and re-mints. */
export function readKeyScopesFile(keyFilePath: string): string[] | null {
  let text: string;
  try {
    text = readFileSync(scopesFilePath(keyFilePath), 'utf8');
  } catch {
    return null; // missing sidecar (pre-migration install, or wiped alongside the key)
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null; // corrupt sidecar: treat exactly like a missing one
  }
  if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === 'string')) return null;
  return parsed;
}
