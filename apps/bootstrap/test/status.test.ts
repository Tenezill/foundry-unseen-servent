import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusWriter } from '../src/status.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('StatusWriter', () => {
  it('writes whitelisted-shape JSON atomically and tracks current()', () => {
    const dir = mkdtempSync(join(tmpdir(), 'status-'));
    dirs.push(dir);
    const f = join(dir, 'status.json');
    const w = new StatusWriter(f);
    expect(w.current().phase).toBe('starting');
    w.set('waiting-world', 'no world online yet');
    const onDisk = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
    expect(onDisk.phase).toBe('waiting-world');
    expect(onDisk.detail).toBe('no world online yet');
    expect(onDisk.error).toBeNull();
    expect(typeof onDisk.updatedAt).toBe('string');
    expect(readdirSync(dir)).toEqual(['status.json']); // no tmp leftover
    w.set('error', 'converge failed', { class: 'RelayAuthError', message: 'login failed' });
    expect(w.current().error).toEqual({ class: 'RelayAuthError', message: 'login failed' });
  });

  it('creates the parent directory if missing and never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'status-'));
    dirs.push(dir);
    const w = new StatusWriter(join(dir, 'nested', 'status.json'));
    w.set('online', 'world online'); // must not throw
    expect(w.current().phase).toBe('online');
  });
});
