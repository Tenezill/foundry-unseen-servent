import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { readBootstrapStatus } from '../src/status-file.js';
import { createRegistry } from '../src/registry.js';
import { FakeRelay, fakeAdapter, memoryPlayers } from './fakes.js';

const dirs: string[] = [];
function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'statusf-'));
  dirs.push(dir);
  const f = join(dir, 'status.json');
  writeFileSync(f, content, 'utf8');
  return f;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('readBootstrapStatus — whitelist', () => {
  it('passes only whitelisted fields through', () => {
    const f = tmpFile(
      JSON.stringify({
        phase: 'waiting-world',
        detail: 'create your world',
        error: null,
        updatedAt: '2026-07-15T12:00:00Z',
        apiKey: 'LEAKED-KEY',
        clientId: 'fvtt_LEAKED',
        anything: { nested: true },
      }),
    );
    expect(readBootstrapStatus(f)).toEqual({
      phase: 'waiting-world',
      detail: 'create your world',
      error: null,
      updatedAt: '2026-07-15T12:00:00Z',
    });
  });
  it('null on absent file, malformed JSON, or missing phase', () => {
    expect(readBootstrapStatus(join(tmpdir(), 'does-not-exist-xyz', 'status.json'))).toBeNull();
    expect(readBootstrapStatus(tmpFile('{not json'))).toBeNull();
    expect(readBootstrapStatus(tmpFile(JSON.stringify({ detail: 'no phase' })))).toBeNull();
  });
  it('error object is itself whitelisted', () => {
    const f = tmpFile(
      JSON.stringify({ phase: 'error', error: { class: 'RelayAuthError', message: 'login failed', stack: 'SECRET' } }),
    );
    expect(readBootstrapStatus(f)).toEqual({ phase: 'error', error: { class: 'RelayAuthError', message: 'login failed' } });
  });
});

describe('/healthz — merged turnkey view', () => {
  function makeApp(opts: { relay?: FakeRelay; worldStatus?: () => import('../src/client-id-resolver.js').WorldHealth | null; statusFile?: string; healthTimeoutMs?: number } = {}) {
    const relay = opts.relay ?? new FakeRelay();
    return {
      relay,
      app: buildApp({
        relay,
        players: memoryPlayers([]),
        registry: createRegistry([fakeAdapter]),
        ...(opts.worldStatus !== undefined ? { worldStatus: opts.worldStatus } : {}),
        ...(opts.statusFile !== undefined
          ? { bootstrapStatus: () => readBootstrapStatus(opts.statusFile as string) }
          : {}),
        ...(opts.healthTimeoutMs !== undefined ? { healthTimeoutMs: opts.healthTimeoutMs } : {}),
      }),
    };
  }

  it('keeps the exact legacy shape when no turnkey deps are wired', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({ ok: true, relay: 'connected' });
  });

  it('merges world + bootstrap fields and never exposes a clientId', async () => {
    const f = tmpFile(JSON.stringify({ phase: 'online', detail: 'world online', error: null, updatedAt: 'x' }));
    const { app } = makeApp({
      worldStatus: () => ({ state: 'online', worldTitle: 'My World' }),
      statusFile: f,
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({
      ok: true,
      relay: 'connected',
      world: { state: 'online', worldTitle: 'My World' },
      bootstrap: { phase: 'online', detail: 'world online', error: null, updatedAt: 'x' },
    });
    expect(res.body).not.toContain('fvtt_');
  });

  it('omits world/bootstrap when their providers return null', async () => {
    const { app } = makeApp({ worldStatus: () => null, statusFile: join(tmpdir(), 'nope', 'status.json') });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({ ok: true, relay: 'connected' });
  });

  it('bounds the relay probe: a hanging listClients reports disconnected within the budget', async () => {
    const relay = new FakeRelay();
    relay.hangListClients = true;
    const { app } = makeApp({ relay, healthTimeoutMs: 100 });
    const start = Date.now();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(Date.now() - start).toBeLessThan(1500);
    expect(res.json()).toEqual({ ok: true, relay: 'disconnected' });
  });
});
