import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
});
