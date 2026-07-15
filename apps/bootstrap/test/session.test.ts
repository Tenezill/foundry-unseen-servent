import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRelayServer } from './fake-relay-server.js';
import { RelayAuthClient } from '../src/relay-auth.js';
import { attemptSession, HEADLESS_SELF_PAIR, worldOnline, type SessionDeps } from '../src/session.js';

const log = { info: () => undefined, warn: () => undefined };

describe('session keeper', () => {
  let server: FakeRelayServer;
  let relay: RelayAuthClient;
  let key: string;

  beforeEach(async () => {
    server = new FakeRelayServer();
    const baseUrl = await server.start();
    relay = new RelayAuthClient({ baseUrl, timeoutMs: 1000 });
    server.keys.set('k-test', ['clients:read']);
    key = 'k-test';
  });
  afterEach(async () => {
    await server.stop();
  });

  function deps(): SessionDeps {
    return { relay, key, foundryUrl: 'http://foundry:30000', gmUser: 'Gamemaster', gmPassword: 'gm-pass', log };
  }

  it('worldOnline: online / offline / unreachable', async () => {
    server.clients = [{ clientId: 'fvtt_1', worldId: 'w1', worldTitle: 'W', isOnline: true }];
    expect(await worldOnline(relay, key)).toBe('online');
    (server.clients[0] as { isOnline: boolean }).isOnline = false;
    expect(await worldOnline(relay, key)).toBe('offline');
    await server.stop();
    expect(await worldOnline(relay, key)).toBe('unreachable');
  });

  it('offline client row + correct GM creds: handshake + start-session -> online', async () => {
    server.clients = [{ clientId: 'fvtt_1', worldId: 'w1', worldTitle: 'W', isOnline: false }];
    expect(await attemptSession(deps())).toBe('online');
    expect((server.clients[0] as { isOnline: boolean }).isOnline).toBe(true);
  });

  it('wrong GM password -> gm-login-failed', async () => {
    server.clients = [{ clientId: 'fvtt_1', worldId: 'w1', worldTitle: 'W', isOnline: false }];
    server.gmPassword = 'the-real-one';
    expect(await attemptSession(deps())).toBe('gm-login-failed');
  });

  it('zero client rows follows the Task 0(a) verdict switch', async () => {
    server.clients = [];
    server.sessionBringsOnline = false;
    const outcome = await attemptSession(deps());
    if (HEADLESS_SELF_PAIR) {
      // self-pair attempt ran; with no client to bring online it reports session-failed
      expect(outcome).toBe('session-failed');
    } else {
      expect(outcome).toBe('needs-pairing');
    }
  });

  it('relay down -> relay-unreachable', async () => {
    await server.stop();
    expect(await attemptSession(deps())).toBe('relay-unreachable');
  });
});
