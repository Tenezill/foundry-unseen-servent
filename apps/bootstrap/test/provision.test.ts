import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRelayServer } from './fake-relay-server.js';
import { RelayAuthClient, RelayAuthError } from '../src/relay-auth.js';
import { StatusWriter } from '../src/status.js';
import { ensureKey } from '../src/provision.js';
import { readPersistedKey, writeKeyFileAtomic } from '../src/key-file.js';
import { readKeyScopesFile, scopesFilePath, writeKeyScopesFileAtomic } from '../src/key-scopes-file.js';
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

  describe('scope drift', () => {
    it('mint path writes the sidecar with the exact scopes minted, requested == granted', async () => {
      await ensureKey(deps());
      expect(readKeyScopesFile(keyFilePath)).toEqual({
        requested: [...GATEWAY_KEY_SCOPES],
        granted: [...GATEWAY_KEY_SCOPES],
      });
    });

    it('mint path writes GRANTED as the ACTUAL (post-drop) scopes, but REQUESTED stays the full canonical list', async () => {
      server.rejectScopes.add('wod5e');
      await ensureKey(deps());
      const record = readKeyScopesFile(keyFilePath);
      expect(record?.granted).not.toContain('wod5e');
      expect(record?.granted).toContain('dnd5e');
      expect(record?.granted).toContain('entity:read');
      // requested always records what was ATTEMPTED (the canonical list),
      // not what was granted — this is what lets the drift check converge
      // after one re-mint even though the relay keeps dropping wod5e.
      expect(record?.requested).toEqual([...GATEWAY_KEY_SCOPES]);
    });

    it('THE LOOP TEST: a relay that permanently drops a canonical scope does not re-mint forever', async () => {
      server.rejectScopes.add('wod5e');

      // Pass 1: fresh sidecar means drift (missing/unreadable) -> mints.
      // mintKey's own drop-and-retry means this ONE logical mint takes two
      // POST /auth/api-keys attempts (rejected wod5e, then without it).
      await ensureKey(deps());
      const mintAttemptsAfterPass1 = server.mintedScopes.length;
      const authCallsAfterPass1 = server.authCalls.length;
      expect(mintAttemptsAfterPass1).toBe(2);

      // Pass 2: same relay (still drops wod5e), fresh ensureKey call reading
      // the sidecar pass 1 just wrote. Before the fix, comparing canonical
      // scopes against GRANTED would find wod5e missing forever and re-mint
      // every pass; comparing against REQUESTED converges here.
      const key = await ensureKey(deps());

      expect(key).toBe('key-1'); // no second mint -> still the pass-1 key
      expect(server.mintedScopes.length).toBe(mintAttemptsAfterPass1); // mint ran exactly once, in pass 1
      expect(server.authCalls.length).toBe(authCallsAfterPass1); // zero additional /auth/* traffic in pass 2
    });

    it('key file format untouched by the sidecar: still ONLY RELAY_API_KEY=<key>', async () => {
      await ensureKey(deps());
      expect(readFileSync(keyFilePath, 'utf8')).toMatch(/^RELAY_API_KEY=[^\n]+\n$/);
    });

    it('valid key + sidecar matching canonical scopes: kept, zero re-mint', async () => {
      await ensureKey(deps());
      const mintsAfterFirst = server.mintedScopes.length;
      const again = await ensureKey(deps());
      expect(again).toBe('key-1');
      expect(server.mintedScopes.length).toBe(mintsAfterFirst);
    });

    it('valid key + sidecar missing a canonical scope (from REQUESTED): re-mints with the full canonical list, sidecar rewritten', async () => {
      await ensureKey(deps());
      const dropped = GATEWAY_KEY_SCOPES.filter((s) => s !== 'canvas:write');
      writeKeyScopesFileAtomic(keyFilePath, { requested: dropped, granted: dropped });
      const mintsBefore = server.mintedScopes.length;

      const key = await ensureKey(deps());

      expect(key).toBe('key-2');
      expect(server.mintedScopes.length).toBe(mintsBefore + 1);
      expect(server.mintedScopes[server.mintedScopes.length - 1]).toEqual([...GATEWAY_KEY_SCOPES]);
      expect(readKeyScopesFile(keyFilePath)).toEqual({
        requested: [...GATEWAY_KEY_SCOPES],
        granted: [...GATEWAY_KEY_SCOPES],
      });
      expect(readPersistedKey(keyFilePath)).toBe('key-2');
    });

    it('valid key + NO sidecar (pre-migration install): re-mints once and writes the sidecar', async () => {
      await ensureKey(deps());
      rmSync(scopesFilePath(keyFilePath), { force: true });

      const key = await ensureKey(deps());

      expect(key).toBe('key-2');
      expect(readKeyScopesFile(keyFilePath)).toEqual({
        requested: [...GATEWAY_KEY_SCOPES],
        granted: [...GATEWAY_KEY_SCOPES],
      });
    });

    it('valid key + corrupt sidecar JSON: re-mints', async () => {
      await ensureKey(deps());
      writeFileSync(scopesFilePath(keyFilePath), '{ not valid json', 'utf8');

      const key = await ensureKey(deps());

      expect(key).toBe('key-2');
      expect(readKeyScopesFile(keyFilePath)).toEqual({
        requested: [...GATEWAY_KEY_SCOPES],
        granted: [...GATEWAY_KEY_SCOPES],
      });
    });

    it('valid key + old granted-only array sidecar (the just-shipped b0fca80 format): treated as unrecognized -> re-mints', async () => {
      await ensureKey(deps());
      // The b0fca80 shape: a bare JSON array, not {requested, granted}. Never
      // reached an install, but readKeyScopesFile must be robust to it too.
      writeFileSync(scopesFilePath(keyFilePath), `${JSON.stringify([...GATEWAY_KEY_SCOPES])}\n`, 'utf8');

      const key = await ensureKey(deps());

      expect(key).toBe('key-2');
      expect(readKeyScopesFile(keyFilePath)).toEqual({
        requested: [...GATEWAY_KEY_SCOPES],
        granted: [...GATEWAY_KEY_SCOPES],
      });
    });
  });
});
