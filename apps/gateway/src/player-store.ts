/**
 * Gateway-owned players.yaml: reads, atomic writes, hot reload (M18 spec).
 *
 * The gateway is the writer of record; hand edits are still legal and picked
 * up by the watcher, but comments do not survive a UI-driven rewrite (the
 * emitted header says so). Plaintext tokens exist only in the create/rotate
 * return values — never on disk, never in this class's state.
 */
import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { stringify } from 'yaml';
import { parsePlayers, sha256Hex, type Player } from './players.js';

export class PlayerStoreError extends Error {
  constructor(
    readonly code: 'DUPLICATE' | 'NOT_FOUND',
    message: string,
  ) {
    super(message);
  }
}

export interface StoreLog {
  warn(obj: object, msg: string): void;
}

const HEADER =
  '# Managed by the gateway (/admin console). Hand edits are picked up live,\n' +
  '# but comments do not survive a console-driven rewrite.\n';

export class FilePlayerStore {
  private players: readonly Player[];
  private watcher: FSWatcher | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  /** Mutations run strictly in sequence; a failed one does not block the next. */
  private writeQueue: Promise<unknown> = Promise.resolve();
  private log: StoreLog | null = null;

  constructor(private readonly filePath: string) {
    this.players = parsePlayers(readFileSync(filePath, 'utf8'));
  }

  list(): readonly Player[] {
    return this.players;
  }

  /** Re-read from disk; on a bad file keep the last good state. */
  reload(): void {
    try {
      this.players = parsePlayers(readFileSync(this.filePath, 'utf8'));
    } catch (err) {
      this.log?.warn({ err }, 'players file reload failed; keeping last good state');
    }
  }

  /** Watch the parent directory (atomic renames would orphan a file watch). */
  startWatching(log?: StoreLog): void {
    if (log) this.log = log;
    if (this.watcher) return;
    const base = basename(this.filePath);
    this.watcher = watch(dirname(this.filePath), (_event: string, filename: string | null) => {
      if (filename !== null && filename !== base) return;
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => this.reload(), 300);
    });
  }

  stopWatching(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
  }

  async create(name: string, actorIds: string[]): Promise<{ token: string; player: Player }> {
    return this.mutate(async () => {
      const lower = name.toLowerCase();
      if (this.players.some((p) => p.name.toLowerCase() === lower)) {
        throw new PlayerStoreError('DUPLICATE', `player "${name}" already exists`);
      }
      const token = randomBytes(24).toString('base64url');
      const player: Player = { name, tokenHash: sha256Hex(token), actorIds };
      await this.persist([...this.players, player]);
      return { token, player };
    });
  }

  async rotate(name: string): Promise<{ token: string }> {
    return this.mutate(async () => {
      const idx = this.players.findIndex((p) => p.name === name);
      if (idx === -1) throw new PlayerStoreError('NOT_FOUND', `no player "${name}"`);
      const token = randomBytes(24).toString('base64url');
      const next = this.players.map((p, i) => (i === idx ? { ...p, tokenHash: sha256Hex(token) } : p));
      await this.persist(next);
      return { token };
    });
  }

  async remove(name: string): Promise<void> {
    return this.mutate(async () => {
      if (!this.players.some((p) => p.name === name)) {
        throw new PlayerStoreError('NOT_FOUND', `no player "${name}"`);
      }
      await this.persist(this.players.filter((p) => p.name !== name));
    });
  }

  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(fn, fn);
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async persist(next: readonly Player[]): Promise<void> {
    const text = HEADER + stringify({ players: next });
    // Same validator as reads: never write a file the constructor could not load.
    parsePlayers(text);
    const tmp = join(dirname(this.filePath), `.${basename(this.filePath)}.tmp`);
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, this.filePath);
    this.players = next;
  }
}
