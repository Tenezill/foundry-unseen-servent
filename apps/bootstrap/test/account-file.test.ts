import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeRelayAccountFile } from '../src/account-file.js';

const dirs: string[] = [];
function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'acctfile-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('account-file', () => {
  it('writes email + password as JSON the gateway reader accepts', () => {
    const f = join(makeDir(), 'relay-account.json');
    writeRelayAccountFile(f, { email: 'bootstrap@companion.local', password: 's3cret' });
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({
      email: 'bootstrap@companion.local',
      password: 's3cret',
    });
  });

  it('leaves no temp file behind (atomic rename) and overwrites cleanly', () => {
    const dir = makeDir();
    const f = join(dir, 'relay-account.json');
    writeRelayAccountFile(f, { email: 'a@x', password: 'p1' });
    writeRelayAccountFile(f, { email: 'b@x', password: 'p2' });
    expect(readdirSync(dir)).toEqual(['relay-account.json']);
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ email: 'b@x', password: 'p2' });
  });

  it.skipIf(process.platform === 'win32')('sets mode 0600', () => {
    const f = join(makeDir(), 'relay-account.json');
    writeRelayAccountFile(f, { email: 'a@x', password: 'p' });
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });
});
