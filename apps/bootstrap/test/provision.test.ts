import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRelayServer } from './fake-relay-server.js';
import { RelayAuthClient, RelayAuthError } from '../src/relay-auth.js';
import { StatusWriter } from '../src/status.js';
import { ensureKey } from '../src/provision.js';
import { readPersistedKey, writeKeyFileAtomic } from '../src/key-file.js';
import { GATEWAY_KEY_SCOPES } from '../src/scopes.js';

const log = { info: () => undefined, warn: () => undefined };

describe('ensureKey', () => {
  let server: FakeRelayServer;
  let baseUrl: string;
  let dir: string;
  let keyFilePath: string;
  let status: StatusWriter;

  beforeEach(async () => {
    server = new FakeRelayServer();
    baseUrl = await server.start();
    dir = mkdtempSync(join(tmpdir(), 'prov-'));
    keyFilePath = join(dir, 'relay.env');
    status = new StatusWriter(join(dir, 'status.json'));
  });
  afterEach(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function deps() {
    return {
      relay: new RelayAuthClient({ baseUrl, timeoutMs: 1000 }),
      email: 'ops@companion.local',
      password: 'acct-pass',
      keyFilePath,
      status,
      log,
    };
  }

  it('fresh relay DB: registers, logs in, mints with the EXACT canonical scopes, persists', async () => {
    const key = await ensureKey(deps());
    expect(key).toBe('key-1');
    expect(readPersistedKey(keyFilePath)).toBe('key-1');
    expect(server.mintedScopes[0]).toEqual([...GATEWAY_KEY_SCOPES]);
    expect(GATEWAY_KEY_SCOPES).toContain('encounter:read'); // the HOSTING.md:149 omission, fixed at the source
    expect(GATEWAY_KEY_SCOPES).toContain('execute-js'); // dnd5e upcasting mints out of the box
    expect(status.current().phase).toBe('key-ready');
  });

  it('relay rejects an unknown system scope (wod5e): drops only it and re-mints', async () => {
    server.rejectScopes.add('wod5e');
    const key = await ensureKey(deps());
    expect(key).toBe('key-1');
    expect(server.mintedScopes.length).toBe(2); // first attempt rejected, second succeeds
    const finalScopes = server.mintedScopes[1] ?? [];
    expect(finalScopes).not.toContain('wod5e');
    expect(finalScopes).toContain('dnd5e'); // supported system scope preserved
    expect(finalScopes).toContain('entity:read');
    expect(status.current().phase).toBe('key-ready');
  });

  it('valid persisted key: returns it with ZERO /auth calls (probe only)', async () => {
    await ensureKey(deps());
    const authCallsAfterFirst = server.authCalls.length;
    const again = await ensureKey(deps());
    expect(again).toBe('key-1');
    expect(server.authCalls.length).toBe(authCallsAfterFirst); // no /auth traffic at all
  });

  it('register conflict (account exists) falls through to login', async () => {
    server.accounts.set('ops@companion.local', 'acct-pass');
    const key = await ensureKey(deps());
    expect(key).toBe('key-1');
    expect(server.authCalls).toContain('/auth/register');
    expect(server.authCalls).toContain('/auth/login');
  });

  it('stale key vs fresh relay DB (401 probe): re-mints and overwrites the file', async () => {
    writeKeyFileAtomic(keyFilePath, 'key-from-wiped-db');
    const key = await ensureKey(deps());
    expect(key).toBe('key-1');
    expect(readPersistedKey(keyFilePath)).toBe('key-1');
  });

  it('auth throttle (429) raises RelayAuthError with status 429 (caller backs off)', async () => {
    server.throttleAuth = true;
    await expect(ensureKey(deps())).rejects.toMatchObject({ name: 'RelayAuthError', status: 429 });
  });

  it('relay unreachable: throws without touching the persisted file', async () => {
    writeKeyFileAtomic(keyFilePath, 'existing-key');
    await server.stop();
    await expect(ensureKey(deps())).rejects.toBeInstanceOf(RelayAuthError);
    expect(readPersistedKey(keyFilePath)).toBe('existing-key');
  });

  it('wrong account password after conflict: login fails with a named error', async () => {
    server.accounts.set('ops@companion.local', 'DIFFERENT-pass');
    await expect(ensureKey(deps())).rejects.toMatchObject({ name: 'RelayAuthError', endpoint: '/auth/login' });
  });
});
