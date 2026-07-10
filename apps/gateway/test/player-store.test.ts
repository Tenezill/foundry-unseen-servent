import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePlayerStore, PlayerStoreError } from '../src/player-store.js';
import { parsePlayers, sha256Hex, verifyToken } from '../src/players.js';

const INITIAL = `players:
  - name: Anna
    tokenHash: "${sha256Hex('anna-token')}"
    actorIds: ["a1"]
    gm: true
`;

async function makeStore(): Promise<{ store: FilePlayerStore; file: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'player-store-'));
  const file = join(dir, 'players.yaml');
  await writeFile(file, INITIAL, 'utf8');
  return { store: new FilePlayerStore(file), file, dir };
}

describe('FilePlayerStore', () => {
  it('loads the file at construction and lists entries', async () => {
    const { store } = await makeStore();
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({ name: 'Anna', actorIds: ['a1'], gm: true });
  });

  it('throws at construction on an invalid file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'player-store-'));
    const file = join(dir, 'players.yaml');
    await writeFile(file, 'players: nope', 'utf8');
    expect(() => new FilePlayerStore(file)).toThrow();
  });

  it('create appends an entry, returns a verifying token, writes a loadable file with header', async () => {
    const { store, file, dir } = await makeStore();
    const { token, player } = await store.create('Ben', ['b1', 'b2']);
    expect(player).toEqual({ name: 'Ben', tokenHash: sha256Hex(token), actorIds: ['b1', 'b2'] });
    expect(verifyToken(store.list(), token)?.name).toBe('Ben');
    const text = await readFile(file, 'utf8');
    expect(text.startsWith('# Managed by the gateway')).toBe(true);
    expect(parsePlayers(text)).toHaveLength(2);
    expect(text).not.toContain(token); // plaintext never at rest
    const leftovers = (await readdir(dir)).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]); // atomic write cleaned up
  });

  it('create rejects duplicate names case-insensitively and leaves the file unchanged', async () => {
    const { store, file } = await makeStore();
    await expect(store.create('anna', ['x'])).rejects.toMatchObject({ code: 'DUPLICATE' });
    await expect(store.create('anna', ['x'])).rejects.toBeInstanceOf(PlayerStoreError);
    expect(parsePlayers(await readFile(file, 'utf8'))).toHaveLength(1);
  });

  it('rotate replaces the hash: old token dies, new token verifies', async () => {
    const { store } = await makeStore();
    const { token } = await store.rotate('Anna');
    expect(verifyToken(store.list(), 'anna-token')).toBeNull();
    expect(verifyToken(store.list(), token)?.name).toBe('Anna');
    expect(store.list()[0]?.gm).toBe(true); // other fields survive
  });

  it('rotate/remove of an unknown name throw NOT_FOUND', async () => {
    const { store } = await makeStore();
    await expect(store.rotate('Nobody')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.remove('Nobody')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('remove deletes the entry and persists', async () => {
    const { store, file } = await makeStore();
    await store.create('Ben', ['b1']);
    await store.remove('Anna');
    expect(store.list().map((p) => p.name)).toEqual(['Ben']);
    expect(parsePlayers(await readFile(file, 'utf8'))).toHaveLength(1);
  });

  it('reload picks up external edits; an invalid edit keeps the last good state', async () => {
    const { store, file } = await makeStore();
    await writeFile(
      file,
      `${INITIAL}  - name: Handmade\n    tokenHash: "${sha256Hex('hand')}"\n    actorIds: ["h1"]\n`,
      'utf8',
    );
    store.reload();
    expect(store.list()).toHaveLength(2);
    await writeFile(file, 'players: garbage', 'utf8');
    store.reload();
    expect(store.list()).toHaveLength(2); // last good state kept
  });

  it('watcher reloads after an external write (debounced)', async () => {
    const { store, file } = await makeStore();
    store.startWatching();
    try {
      await writeFile(
        file,
        `${INITIAL}  - name: Watched\n    tokenHash: "${sha256Hex('w')}"\n    actorIds: ["w1"]\n`,
        'utf8',
      );
      await vi.waitFor(() => expect(store.list()).toHaveLength(2), { timeout: 3000, interval: 100 });
    } finally {
      store.stopWatching();
    }
  });

  it('serializes concurrent mutations — no lost writes', async () => {
    const { store, file } = await makeStore();
    await Promise.all([1, 2, 3, 4, 5].map((n) => store.create(`P${n}`, [`x${n}`])));
    expect(store.list()).toHaveLength(6);
    expect(parsePlayers(await readFile(file, 'utf8'))).toHaveLength(6);
  });
});
