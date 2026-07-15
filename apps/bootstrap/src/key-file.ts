/**
 * relay.env on the shared companion-runtime volume: the sidecar's handoff to
 * the gateway (RELAY_API_KEY_FILE). Written atomically — same-directory temp
 * file + rename (same fs is guaranteed by the volume; a cross-dir rename
 * could EXDEV) — so the gateway's watcher never sees a torn write. Mode 0600
 * (Global Constraints); writeFileSync's mode is masked by the process umask,
 * so chmod enforces it explicitly.
 */
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function writeKeyFileAtomic(filePath: string, key: string): void {
  const tmp = join(dirname(filePath), `.${basename(filePath)}.tmp`);
  writeFileSync(tmp, `RELAY_API_KEY=${key}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* windows dev box: modes are advisory there; Linux is what matters */
  }
  renameSync(tmp, filePath);
}

/** The persisted key, or null when the file is absent/unparseable. */
export function readPersistedKey(filePath: string): string | null {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    const m = /^RELAY_API_KEY=(.+)$/.exec(line.trim());
    if (m !== null && m[1] !== undefined && m[1] !== '') return m[1];
  }
  return null;
}
