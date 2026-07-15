/**
 * File-sourced relay API key (turnkey stack): the bootstrap sidecar mints the
 * key at runtime and writes `relay.env` on the shared volume; this source
 * reads it, tolerates it being ABSENT AT BOOT (unlike FilePlayerStore, whose
 * constructor throws on a missing file — deliberately not reused), watches
 * for changes (parent-dir watch: atomic renames orphan a file watch —
 * player-store.ts precedent), and keeps the last good key when the file is
 * deleted or momentarily unparseable mid-rotation.
 *
 * fs.watch events are not guaranteed for writes arriving from ANOTHER
 * container on a shared volume, so a poll backstops the watcher; reload() is
 * idempotent and emits only on an actual key change, so watch+poll overlap
 * is harmless.
 */
import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';

export interface KeySourceLog {
  warn(obj: object, msg: string): void;
}

/** Parse relay.env: first `RELAY_API_KEY=<value>` line wins; a file that is
 *  just a bare key (single line, no `=`) is accepted too. Null = no key. */
export function parseKeyFile(text: string): string | null {
  for (const line of text.split('\n')) {
    const m = /^RELAY_API_KEY=(.+)$/.exec(line.trim());
    if (m !== null && m[1] !== undefined && m[1] !== '') return m[1];
  }
  const trimmed = text.trim();
  if (trimmed !== '' && !trimmed.includes('=') && !/\s/.test(trimmed)) return trimmed;
  return null;
}

export class ApiKeySource {
  private key: string | null = null;
  private watcher: FSWatcher | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private watchRetryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<(key: string) => void>();
  private log: KeySourceLog | null = null;

  constructor(
    private readonly filePath: string,
    private readonly opts: { pollMs?: number } = {},
  ) {}

  /** The last good key, or null when none has ever been read. */
  current(): string | null {
    return this.key;
  }

  /** Fires only on a subsequent key CHANGE (after the boot-time read).
   *  The boot-time read never emits onChange, even to already-subscribed
   *  listeners: onChange signals a live rotation, not the initial state. */
  onChange(cb: (key: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Bounded boot wait (M18 pattern — never hard-block): true as soon as a
   *  key exists, false after timeoutMs (the gateway then starts degraded). */
  waitUntilAvailable(timeoutMs: number): Promise<boolean> {
    if (this.key !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(false);
      }, timeoutMs);
      const off = this.onChange(() => {
        clearTimeout(timer);
        off();
        resolve(true);
      });
    });
  }

  /** Synchronous initial read + parent-dir watch + poll backstop. A missing
   *  file OR missing parent dir is fine — both are retried/polled. The
   *  boot-time read never emits onChange (even to already-subscribed
   *  listeners): onChange signals a live rotation, not the initial state. */
  startWatching(log?: KeySourceLog): void {
    if (this.watcher !== null || this.pollTimer !== null) return;
    if (log !== undefined) this.log = log;
    this.initialRead();
    this.tryWatch();
    if (this.watcher === null && this.watchRetryTimer === null) {
      this.watchRetryTimer = setInterval(() => {
        this.tryWatch();
        if (this.watcher !== null && this.watchRetryTimer !== null) {
          clearInterval(this.watchRetryTimer);
          this.watchRetryTimer = null;
        }
      }, 1_000);
    }
    if (this.pollTimer === null) {
      this.pollTimer = setInterval(() => this.reload(), this.opts.pollMs ?? 5_000);
    }
  }

  stopWatching(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.reloadTimer !== null) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.watchRetryTimer !== null) {
      clearInterval(this.watchRetryTimer);
      this.watchRetryTimer = null;
    }
  }

  /** Re-read; keep last good on absence/unparseable; emit only on change. */
  reload(): void {
    let text: string;
    try {
      text = readFileSync(this.filePath, 'utf8');
    } catch {
      return; // absent (boot, or the mid-rotate rename window): keep last good
    }
    const parsed = parseKeyFile(text);
    if (parsed === null) {
      this.log?.warn({ file: this.filePath }, 'relay key file present but unparseable; keeping last good key');
      return;
    }
    if (parsed === this.key) return;
    this.key = parsed;
    for (const cb of [...this.listeners]) cb(parsed);
  }

  /** Silent counterpart to reload() used only for the synchronous boot-time
   *  read inside startWatching(): sets the key without emitting onChange. */
  private initialRead(): void {
    try {
      const text = readFileSync(this.filePath, 'utf8');
      const parsed = parseKeyFile(text);
      if (parsed !== null) this.key = parsed;
    } catch {
      // absent at boot: fine, key stays null until a later reload() finds it
    }
  }

  private tryWatch(): void {
    if (this.watcher !== null) return;
    const base = basename(this.filePath);
    try {
      this.watcher = watch(dirname(this.filePath), (_event: string, filename: string | null) => {
        if (filename !== null && filename !== base) return;
        if (this.reloadTimer !== null) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => this.reload(), 300);
      });
    } catch {
      this.watcher = null; // parent dir missing: retry timer + poll cover it
    }
  }
}
