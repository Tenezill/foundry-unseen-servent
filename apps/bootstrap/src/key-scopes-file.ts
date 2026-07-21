/**
 * relay.env.scopes.json sidecar: records the scopes involved in the last mint
 * of the adjacent key file, so `ensureKey` (provision.ts) can detect scope
 * DRIFT — a persisted key that predates a newly-required canonical scope
 * (e.g. `scene:read`/`canvas:write` added for token movement) — and re-mint
 * instead of keeping an under-scoped key forever.
 *
 * Two lists, not one (Critical review finding 2 on b0fca80):
 *  - `granted`: what the relay ACTUALLY minted, post drop-and-retry (e.g. an
 *    unknown system scope like `wod5e` rejected by some 3.4.1 builds — see
 *    relay-auth.ts mintKey / scopes.ts). Reality, for observability.
 *  - `requested`: the canonical list ATTEMPTED at mint time (GATEWAY_KEY_SCOPES
 *    as it stood then), regardless of what the relay ended up granting.
 *
 * Drift compares canonical scopes against `requested`, not `granted`. A relay
 * build that permanently rejects one canonical scope will never grant it, so
 * comparing against `granted` would re-mint on every single pass forever
 * (rate-limited /auth/* starves provisioning). Comparing against `requested`
 * converges after exactly one re-mint: once `requested` == the canonical list,
 * there is nothing left missing, even though `granted` still lacks the
 * rejected scope. Real drift (a NEW canonical scope added later) still shows
 * up as missing from the old `requested` list and forces the intended re-mint.
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

export interface KeyScopesRecord {
  /** The canonical scope list attempted at mint time (pre drop-and-retry). */
  requested: string[];
  /** The scopes the relay actually granted (post drop-and-retry). */
  granted: string[];
}

export function scopesFilePath(keyFilePath: string): string {
  return `${keyFilePath}.scopes.json`;
}

export function writeKeyScopesFileAtomic(
  keyFilePath: string,
  record: { requested: readonly string[]; granted: readonly string[] },
): void {
  const filePath = scopesFilePath(keyFilePath);
  const tmp = join(dirname(filePath), `.${basename(filePath)}.tmp`);
  const payload: KeyScopesRecord = { requested: [...record.requested], granted: [...record.granted] };
  writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* windows dev box: modes are advisory there; Linux is what matters */
  }
  renameSync(tmp, filePath);
}

/** The persisted {requested, granted} record, or null when the sidecar is
 *  missing, unreadable, corrupt, or not in the current {requested, granted}
 *  shape. That last case also covers the OLD granted-only array format this
 *  sidecar shipped with for one commit (b0fca80) — it never reached an
 *  install, but treating it like any other unrecognized shape costs nothing
 *  and keeps this reader robust against format drift generally.
 *
 *  Every install predates this sidecar the first time it runs post-upgrade,
 *  so `null` here is the expected steady state for a one-time migration —
 *  see ensureKey's comment in provision.ts, which treats null as "unknown
 *  scopes" and re-mints. */
export function readKeyScopesFile(keyFilePath: string): KeyScopesRecord | null {
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
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { requested, granted } = parsed as Record<string, unknown>;
  const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
  if (!isStringArray(requested) || !isStringArray(granted)) return null;
  return { requested, granted };
}
