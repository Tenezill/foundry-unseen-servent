import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRelayAccount } from '../src/relay-account.js';

const dirs: string[] = [];
function tmpFile(contents: string): string {
  const d = mkdtempSync(join(tmpdir(), 'gw-relay-acct-'));
  dirs.push(d);
  const f = join(d, 'relay-account.json');
  writeFileSync(f, contents, 'utf8');
  return f;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('readRelayAccount', () => {
  it('returns email + password from a well-formed file', () => {
    const f = tmpFile(JSON.stringify({ email: 'bootstrap@companion.local', password: 's3cret' }));
    expect(readRelayAccount(f)).toEqual({ email: 'bootstrap@companion.local', password: 's3cret' });
  });

  it('drops unknown keys — only email and password pass through', () => {
    const f = tmpFile(JSON.stringify({ email: 'e@x', password: 'p', apiKey: 'LEAK', extra: 1 }));
    expect(readRelayAccount(f)).toEqual({ email: 'e@x', password: 'p' });
  });

  it('returns null for an absent file', () => {
    expect(readRelayAccount(join(tmpdir(), 'does-not-exist-xyz', 'nope.json'))).toBeNull();
  });

  it.each([
    ['not json', '{not json'],
    ['a json array', '[]'],
    ['a bare string', '"hi"'],
    ['missing password', JSON.stringify({ email: 'e@x' })],
    ['missing email', JSON.stringify({ password: 'p' })],
    ['empty email', JSON.stringify({ email: '', password: 'p' })],
    ['empty password', JSON.stringify({ email: 'e@x', password: '' })],
    ['non-string password', JSON.stringify({ email: 'e@x', password: 123 })],
  ])('returns null for %s', (_label, contents) => {
    expect(readRelayAccount(tmpFile(contents))).toBeNull();
  });
});
