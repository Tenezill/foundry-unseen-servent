import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiKeySource, parseKeyFile } from '../src/key-source.js';

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('parseKeyFile', () => {
  it('takes the first RELAY_API_KEY= line', () => {
    expect(parseKeyFile('RELAY_API_KEY=abc123\n')).toBe('abc123');
    expect(parseKeyFile('# minted 2026-07-15\nRELAY_API_KEY=k-1\nRELAY_API_KEY=k-2\n')).toBe('k-1');
    expect(parseKeyFile('RELAY_API_KEY=has$ym-bo_ls\n')).toBe('has$ym-bo_ls');
  });
  it('accepts a bare-key file (no = anywhere)', () => {
    expect(parseKeyFile('  bare-key-123  \n')).toBe('bare-key-123');
  });
  it('rejects empty/other content', () => {
    expect(parseKeyFile('')).toBeNull();
    expect(parseKeyFile('OTHER=x\n')).toBeNull();
    expect(parseKeyFile('RELAY_API_KEY=\n')).toBeNull();
  });
});

describe('ApiKeySource', () => {
  const sources: ApiKeySource[] = [];
  const dirs: string[] = [];
  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'keysrc-'));
    dirs.push(dir);
    return dir;
  }
  function makeSource(filePath: string): ApiKeySource {
    const src = new ApiKeySource(filePath, { pollMs: 50 });
    sources.push(src);
    return src;
  }
  afterEach(() => {
    for (const s of sources.splice(0)) s.stopWatching();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('tolerates the file being absent at boot and picks it up when it appears', async () => {
    const dir = makeDir();
    const file = join(dir, 'relay.env');
    const src = makeSource(file);
    const seen: string[] = [];
    src.onChange((k) => seen.push(k));
    src.startWatching();
    expect(src.current()).toBeNull();
    writeFileSync(file, 'RELAY_API_KEY=first-key\n', 'utf8');
    await waitFor(() => src.current() === 'first-key');
    expect(seen).toEqual(['first-key']);
  });

  it('hot-reloads on an atomic rename rotation and emits exactly once per change', async () => {
    const dir = makeDir();
    const file = join(dir, 'relay.env');
    writeFileSync(file, 'RELAY_API_KEY=first-key\n', 'utf8');
    const src = makeSource(file);
    const seen: string[] = [];
    src.onChange((k) => seen.push(k));
    src.startWatching();
    expect(src.current()).toBe('first-key'); // synchronous initial read
    const tmp = join(dir, '.relay.env.tmp');
    writeFileSync(tmp, 'RELAY_API_KEY=second-key\n', 'utf8');
    renameSync(tmp, file); // the sidecar's atomic-write shape
    await waitFor(() => src.current() === 'second-key');
    expect(seen).toEqual(['second-key']); // no spurious event for the initial read
  });

  it('keeps the last good key when the file goes missing or unparseable', async () => {
    const dir = makeDir();
    const file = join(dir, 'relay.env');
    writeFileSync(file, 'RELAY_API_KEY=good-key\n', 'utf8');
    const src = makeSource(file);
    src.startWatching();
    expect(src.current()).toBe('good-key');
    rmSync(file);
    await new Promise((r) => setTimeout(r, 150)); // a few poll cycles
    expect(src.current()).toBe('good-key');
    writeFileSync(file, 'garbage without a key\n', 'utf8');
    await new Promise((r) => setTimeout(r, 150));
    expect(src.current()).toBe('good-key');
  });

  it('survives a parent directory that does not exist yet', async () => {
    const dir = makeDir();
    const nested = join(dir, 'not-yet');
    const file = join(nested, 'relay.env');
    const src = makeSource(file);
    src.startWatching(); // must not throw
    expect(src.current()).toBeNull();
    mkdirSync(nested);
    writeFileSync(file, 'RELAY_API_KEY=late-key\n', 'utf8');
    await waitFor(() => src.current() === 'late-key');
  });

  it('waitUntilAvailable resolves true on appearance and false on timeout', async () => {
    const dir = makeDir();
    const file = join(dir, 'relay.env');
    const src = makeSource(file);
    src.startWatching();
    const miss = await src.waitUntilAvailable(100);
    expect(miss).toBe(false);
    const hitP = src.waitUntilAvailable(3000);
    writeFileSync(file, 'RELAY_API_KEY=k\n', 'utf8');
    expect(await hitP).toBe(true);
  });
});
