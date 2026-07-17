/**
 * relay-account.json on the shared companion-runtime volume: the sidecar hands
 * the relay account (email + password) to the gateway so the admin "Relay &
 * Pairing" panel can show the operator which credentials approve a pairing
 * request. Written atomically (same-directory temp + rename — same fs is
 * guaranteed by the volume, a cross-dir rename could EXDEV) so the gateway
 * never reads a torn file. Mode 0600 (Global Constraints); writeFileSync's mode
 * is masked by the process umask, so chmod enforces it explicitly.
 */
import { chmodSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function writeRelayAccountFile(
  filePath: string,
  account: { email: string; password: string },
): void {
  const tmp = join(dirname(filePath), `.${basename(filePath)}.tmp`);
  const body = JSON.stringify({ email: account.email, password: account.password }) + '\n';
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* windows dev box: modes are advisory there; Linux is what matters */
  }
  renameSync(tmp, filePath);
}
