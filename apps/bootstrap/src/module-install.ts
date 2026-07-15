/**
 * Pre-place the pinned foundry-rest-api module (spec §Bootstrap sidecar 2).
 * The payload is baked into the image at /opt/foundry-rest-api (Dockerfile,
 * release 3.4.1 per VERSIONS.md). Copy-only and never-overwrite: per-world
 * ENABLE stays a documented one-tick operator step, and an operator-updated
 * module dir is respected — we never write into the world settings DB.
 *
 * Must never throw (Task 8 review): on Linux, felddy/foundryvtt chowns
 * /data to its own runtime UID, which can differ from the sidecar's — the
 * cpSync below can then hit EACCES, and that mismatch does not self-heal.
 * The converge loop's headline job (keep the world online) does not depend
 * on module placement, so I/O failures here are reported back to the
 * caller as a value, never as an exception that could abort the pass.
 */
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type ModulePlacement = 'placed' | 'already-present' | 'foundry-not-ready' | 'placement-failed';

export function ensureModulePlaced(srcDir: string, foundryDataDir: string): ModulePlacement {
  try {
    const dataDir = join(foundryDataDir, 'Data');
    if (!existsSync(dataDir)) return 'foundry-not-ready'; // felddy has not initialized /data yet
    const dest = join(dataDir, 'modules', 'foundry-rest-api');
    if (existsSync(join(dest, 'module.json'))) return 'already-present';
    cpSync(srcDir, dest, { recursive: true });
    return 'placed';
  } catch {
    // Destination permission/ownership error (or any other I/O failure):
    // best-effort, retried next pass — never propagate.
    return 'placement-failed';
  }
}
