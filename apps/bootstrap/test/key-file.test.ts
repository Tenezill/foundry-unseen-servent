import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPersistedKey, writeKeyFileAtomic } from '../src/key-file.js';

const dirs: string[] = [];
function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'keyfile-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('key-file', () => {
  it('writes RELAY_API_KEY=<key> and reads it back', () => {
    const f = join(makeDir(), 'relay.env');
    writeKeyFileAtomic(f, 'abc-123');
    expect(readFileSync(f, 'utf8')).toBe('RELAY_API_KEY=abc-123\n');
    expect(readPersistedKey(f)).toBe('abc-123');
  });

  it('leaves no temp file behind (atomic rename)', () => {
    const dir = makeDir();
    const f = join(dir, 'relay.env');
    writeKeyFileAtomic(f, 'k1');
    writeKeyFileAtomic(f, 'k2');
    expect(readdirSync(dir)).toEqual(['relay.env']);
    expect(readPersistedKey(f)).toBe('k2');
  });

  it.skipIf(process.platform === 'win32')('sets mode 0600', () => {
    const f = join(makeDir(), 'relay.env');
    writeKeyFileAtomic(f, 'k');
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it('readPersistedKey: null on absent or unparseable', () => {
    expect(readPersistedKey(join(makeDir(), 'nope.env'))).toBeNull();
  });
});
