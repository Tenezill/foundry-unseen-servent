import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureModulePlaced } from '../src/module-install.js';

const dirs: string[] = [];
function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'modinst-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeSrc(): string {
  const src = join(makeDir(), 'foundry-rest-api');
  mkdirSync(join(src, 'scripts'), { recursive: true });
  writeFileSync(join(src, 'module.json'), '{"id":"foundry-rest-api","version":"3.4.1"}', 'utf8');
  writeFileSync(join(src, 'scripts', 'module.js'), '// module', 'utf8');
  return src;
}

describe('ensureModulePlaced', () => {
  it('waits for felddy to initialize Data/', () => {
    const dataRoot = makeDir(); // no Data/ inside
    expect(ensureModulePlaced(makeSrc(), dataRoot)).toBe('foundry-not-ready');
  });

  it('copies the module once and is idempotent', () => {
    const dataRoot = makeDir();
    mkdirSync(join(dataRoot, 'Data'), { recursive: true });
    const src = makeSrc();
    expect(ensureModulePlaced(src, dataRoot)).toBe('placed');
    expect(existsSync(join(dataRoot, 'Data', 'modules', 'foundry-rest-api', 'module.json'))).toBe(true);
    expect(existsSync(join(dataRoot, 'Data', 'modules', 'foundry-rest-api', 'scripts', 'module.js'))).toBe(true);
    expect(ensureModulePlaced(src, dataRoot)).toBe('already-present');
  });

  it('never overwrites an existing install (operator may have updated it)', () => {
    const dataRoot = makeDir();
    const dest = join(dataRoot, 'Data', 'modules', 'foundry-rest-api');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'module.json'), '{"id":"foundry-rest-api","version":"9.9.9"}', 'utf8');
    expect(ensureModulePlaced(makeSrc(), dataRoot)).toBe('already-present');
    expect(readFileSync(join(dest, 'module.json'), 'utf8')).toContain('9.9.9');
  });

  // Task 8 review: on Linux, felddy/foundryvtt chowns /data to its own
  // runtime UID, which can differ from the sidecar's UID 3000 — cpSync
  // into Data/modules can then throw. ensureModulePlaced must report that
  // as a returned outcome, never as a thrown exception (a throw here used
  // to abort the whole converge pass before world-online steps ran).
  it('returns placement-failed (does not throw) on a destination I/O error', () => {
    const dataRoot = makeDir();
    const dataDir = join(dataRoot, 'Data');
    mkdirSync(dataDir, { recursive: true });
    // 'modules' exists as a FILE, not a directory: cpSync cannot create the
    // dest path underneath it (ENOTDIR) — reproduces the class of
    // destination I/O error a UID-mismatched /data mount raises,
    // platform-independently (no chmod required).
    writeFileSync(join(dataDir, 'modules'), 'not a directory', 'utf8');
    expect(() => ensureModulePlaced(makeSrc(), dataRoot)).not.toThrow();
    expect(ensureModulePlaced(makeSrc(), dataRoot)).toBe('placement-failed');
  });

  it.skipIf(process.platform === 'win32')(
    'returns placement-failed (does not throw) on EACCES from a read-only destination',
    () => {
      const dataRoot = makeDir();
      const modulesDir = join(dataRoot, 'Data', 'modules');
      mkdirSync(modulesDir, { recursive: true });
      chmodSync(modulesDir, 0o500); // no write permission: EACCES creating the module dir inside it
      try {
        expect(() => ensureModulePlaced(makeSrc(), dataRoot)).not.toThrow();
        expect(ensureModulePlaced(makeSrc(), dataRoot)).toBe('placement-failed');
      } finally {
        chmodSync(modulesDir, 0o700); // restore so afterEach's rmSync can clean up
      }
    },
  );
});
