/**
 * Pre-place the pinned foundry-rest-api module (spec §Bootstrap sidecar 2).
 * The payload is baked into the image at /opt/foundry-rest-api (Dockerfile,
 * release 3.4.1 per VERSIONS.md). Copy-only and never-overwrite: per-world
 * ENABLE stays a documented one-tick operator step, and an operator-updated
 * module dir is respected — we never write into the world settings DB.
 */
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type ModulePlacement = 'placed' | 'already-present' | 'foundry-not-ready';

export function ensureModulePlaced(srcDir: string, foundryDataDir: string): ModulePlacement {
  const dataDir = join(foundryDataDir, 'Data');
  if (!existsSync(dataDir)) return 'foundry-not-ready'; // felddy has not initialized /data yet
  const dest = join(dataDir, 'modules', 'foundry-rest-api');
  if (existsSync(join(dest, 'module.json'))) return 'already-present';
  cpSync(srcDir, dest, { recursive: true });
  return 'placed';
}
