/**
 * Task 8 review regression: a module-placement failure (e.g. EACCES from a
 * UID-mismatched /data mount, felddy/foundryvtt on Linux) must never starve
 * the world-relaunch / session-convergence steps that follow it in the same
 * pass — keeping the world online is the sidecar's headline job, module
 * placement is best-effort. Drives runConvergePass end-to-end against the
 * FakeRelayServer, same idiom as provision.test.ts / session.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRelayServer } from './fake-relay-server.js';
import { RelayAuthClient } from '../src/relay-auth.js';
import { StatusWriter } from '../src/status.js';
import { writeKeyFileAtomic } from '../src/key-file.js';
import { runConvergePass, type ConvergePassDeps, type ConvergePassState } from '../src/main.js';

describe('runConvergePass', () => {
  let server: FakeRelayServer;
  let baseUrl: string;
  let dir: string;
  let keyFilePath: string;
  let status: StatusWriter;

  beforeEach(async () => {
    server = new FakeRelayServer();
    baseUrl = await server.start();
    dir = mkdtempSync(join(tmpdir(), 'converge-'));
    keyFilePath = join(dir, 'relay.env');
    status = new StatusWriter(join(dir, 'status.json'));
    server.keys.set('k-test', ['clients:read']);
    writeKeyFileAtomic(keyFilePath, 'k-test'); // valid key already persisted -> probe-only path
  });
  afterEach(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function deps(overrides: Partial<ConvergePassDeps> = {}): ConvergePassDeps {
    return {
      relay: new RelayAuthClient({ baseUrl, timeoutMs: 1000 }),
      status,
      email: 'ops@companion.local',
      password: 'acct-pass',
      foundryUrl: 'http://foundry:30000',
      gmUser: 'Gamemaster',
      gmPassword: 'gm-pass',
      adminKey: 'admin-key',
      foundryDataDir: join(dir, 'foundry-data'),
      moduleSrcDir: join(dir, 'module-src'),
      keyFilePath,
      authBackoffMs: 60_000,
      sessionBackoffMs: 60_000,
      log: { info: () => undefined, warn: () => undefined },
      ...overrides,
    };
  }

  function freshState(): ConvergePassState {
    return { lastAuthAttemptAt: 0, lastSessionAttemptAt: 0 };
  }

  /** Blocks ensureModulePlaced with a real, platform-independent I/O error:
   *  'modules' exists as a FILE, so cpSync cannot create a directory under
   *  it (ENOTDIR) — this is not mocked, ensureModulePlaced runs for real. */
  function foundryDataDirWithBlockedModules(): string {
    const foundryDataDir = join(dir, 'foundry-data');
    const dataDir = join(foundryDataDir, 'Data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'modules'), 'not a directory', 'utf8');
    return foundryDataDir;
  }

  it('module-placement failure does not starve world-online convergence', async () => {
    const foundryDataDir = foundryDataDirWithBlockedModules();
    server.clients = [{ clientId: 'fvtt_1', worldId: 'w1', worldTitle: 'W', isOnline: true }];

    await runConvergePass(deps({ foundryDataDir }), freshState());

    // Steps 3 (relaunch, skipped by ADMIN_RELAUNCH=false) and 4 (session
    // convergence) still ran despite the module-placement I/O error above.
    expect(status.current().phase).toBe('online');
  });

  it('a module-placement failure is recorded, not swallowed, and does not fall through to the generic error phase', async () => {
    const foundryDataDir = foundryDataDirWithBlockedModules();
    server.clients = []; // offline -> session-convergence path (needs-pairing by default verdict)
    const warnings: string[] = [];
    const log = { info: () => undefined, warn: (m: string) => warnings.push(m) };

    await runConvergePass(deps({ foundryDataDir, log }), freshState());

    expect(warnings.some((m) => m.includes('module placement failed'))).toBe(true);
    expect(status.current().phase).not.toBe('error'); // the pass did NOT abort into the catch-all
    expect(status.current().phase).toBe('needs-pairing'); // steps 3-4 ran through to completion
  });

  it('baseline sanity: with a working module source, placement succeeds and the world still goes online', async () => {
    const foundryDataDir = join(dir, 'foundry-data');
    mkdirSync(join(foundryDataDir, 'Data'), { recursive: true });
    const moduleSrcDir = join(dir, 'module-src');
    mkdirSync(moduleSrcDir, { recursive: true });
    writeFileSync(join(moduleSrcDir, 'module.json'), '{"id":"foundry-rest-api"}', 'utf8');
    server.clients = [{ clientId: 'fvtt_1', worldId: 'w1', worldTitle: 'W', isOnline: true }];

    await runConvergePass(deps({ foundryDataDir, moduleSrcDir }), freshState());

    expect(status.current().phase).toBe('online');
  });
});
