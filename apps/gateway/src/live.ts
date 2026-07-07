/**
 * Live-update layer, shared across SSE clients.
 *
 * ONE world-level relay subscription (`/hooks/subscribe?hooks=updateActor`,
 * the channel M0 verified as working — per-actor `/actor/subscribe` delivers
 * nothing in relay 3.4.1) starts when the first SSE client attaches and is
 * aborted when the last one detaches. Each `updateActor` event carries the
 * full updated actor document in its `args[0]`; if an active watcher matches
 * that document's `_id`, the actor is re-fetched, the sheet rebuilt, and the
 * JSON fanned out to that actor's clients — only when it actually changed.
 *
 * If the hooks stream errors or closes, it is reconnected with exponential
 * backoff (reconnectMinMs..reconnectMaxMs); while the stream is down, every
 * watched actor is polled every `pollMs` as a fallback.
 */

export interface LiveLogger {
  warn(obj: unknown, msg?: string): void;
}

export interface LiveOptions {
  /** Fallback poll interval while the hooks stream is down. */
  pollMs: number;
  /** Fetch actor + build sheet; null when unavailable (skipped, no broadcast). */
  fetchSheetJson(actorId: string): Promise<string | null>;
  /** World-level relay hooks SSE stream; resolves/rejects when it ends. */
  subscribeHooks(
    hooks: string[],
    onEvent: (ev: { event: string; data: unknown }) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /** Reconnect backoff floor. Default 1000. */
  reconnectMinMs?: number;
  /** Reconnect backoff ceiling. Default 30000. */
  reconnectMaxMs?: number;
  log?: LiveLogger;
}

type Send = (sheetJson: string) => void;

const WATCHED_HOOKS = ['updateActor'];

/**
 * Pull the updated actor's `_id` out of a relay `updateActor` event payload.
 * The relay nests the hook args under `data.args` or `data.data.args`
 * depending on version (M0 findings §3), so defensively find the first array
 * named `args` anywhere in the payload; `args[0]` is the full actor document.
 */
export function extractUpdatedActorId(payload: unknown): string | null {
  const args = findArgsArray(payload, 0);
  if (!args || args.length === 0) return null;
  const doc = args[0];
  if (doc !== null && typeof doc === 'object' && !Array.isArray(doc)) {
    const id = (doc as Record<string, unknown>)._id;
    if (typeof id === 'string' && id !== '') return id;
  }
  return null;
}

function findArgsArray(node: unknown, depth: number): unknown[] | null {
  if (depth > 6 || node === null || typeof node !== 'object' || Array.isArray(node)) return null;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.args)) return obj.args;
  for (const value of Object.values(obj)) {
    const found = findArgsArray(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Per-actor fan-out state: attached clients + change-suppression baseline. */
class ActorWatcher {
  readonly clients = new Set<Send>();
  private stopped = false;
  private lastJson: string | null = null;
  private refreshing = false;
  private pendingRefresh = false;

  constructor(
    private readonly actorId: string,
    private readonly opts: LiveOptions,
  ) {}

  stop(): void {
    this.stopped = true;
  }

  /** Seed the change-detection baseline with the sheet a client was just sent. */
  primeIfEmpty(sheetJson: string): void {
    if (this.lastJson === null) this.lastJson = sheetJson;
  }

  /** Re-fetch + rebuild the sheet; broadcast only when the JSON changed. */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.pendingRefresh = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.pendingRefresh = false;
        let json: string | null = null;
        try {
          json = await this.opts.fetchSheetJson(this.actorId);
        } catch {
          json = null; // upstream hiccup: keep last state, try again on next event/poll
        }
        if (this.stopped) return;
        if (json !== null && json !== this.lastJson) {
          this.lastJson = json;
          for (const send of this.clients) send(json);
        }
      } while (this.pendingRefresh && !this.stopped);
    } finally {
      this.refreshing = false;
    }
  }
}

export class LiveManager {
  private readonly watchers = new Map<string, ActorWatcher>();
  private streamAc: AbortController | null = null;
  /** True while a subscribeHooks call is in flight (optimistically "up"). */
  private streamUp = false;

  constructor(private readonly opts: LiveOptions) {}

  /**
   * Attach an SSE client to the (shared) watcher for `actorId`.
   * The first attached client overall starts the world-level hooks stream;
   * returns a detach function — the stream is aborted on last detach.
   */
  attach(actorId: string, send: Send, initialSheetJson?: string): () => void {
    let watcher = this.watchers.get(actorId);
    if (!watcher) {
      watcher = new ActorWatcher(actorId, this.opts);
      this.watchers.set(actorId, watcher);
      this.ensureStream();
    }
    if (initialSheetJson !== undefined) watcher.primeIfEmpty(initialSheetJson);
    watcher.clients.add(send);
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      watcher.clients.delete(send);
      if (watcher.clients.size === 0) {
        watcher.stop();
        if (this.watchers.get(actorId) === watcher) this.watchers.delete(actorId);
        this.stopStreamIfIdle();
      }
    };
  }

  stopAll(): void {
    for (const w of this.watchers.values()) w.stop();
    this.watchers.clear();
    this.stopStreamIfIdle();
  }

  // ---- shared stream lifecycle ---------------------------------------------

  private ensureStream(): void {
    if (this.streamAc !== null) return;
    const ac = new AbortController();
    this.streamAc = ac;
    void this.streamLoop(ac);
    void this.pollLoop(ac.signal);
  }

  private stopStreamIfIdle(): void {
    if (this.watchers.size === 0 && this.streamAc !== null) {
      this.streamAc.abort();
      this.streamAc = null;
      this.streamUp = false;
    }
  }

  /** Reconnect loop with exponential backoff; polling covers the gaps. */
  private async streamLoop(ac: AbortController): Promise<void> {
    const minMs = this.opts.reconnectMinMs ?? 1_000;
    const maxMs = this.opts.reconnectMaxMs ?? 30_000;
    let backoff = minMs;
    const setUp = (up: boolean): void => {
      if (this.streamAc === ac) this.streamUp = up; // never clobber a successor stream's state
    };
    while (!ac.signal.aborted) {
      setUp(true);
      try {
        await this.opts.subscribeHooks(
          WATCHED_HOOKS,
          (ev) => {
            backoff = minMs; // any frame proves the connection is healthy
            if (ev.event !== 'updateActor') return;
            const actorId = extractUpdatedActorId(ev.data);
            if (actorId === null) return;
            const watcher = this.watchers.get(actorId);
            if (watcher) void watcher.refresh();
          },
          ac.signal,
        );
        if (!ac.signal.aborted) {
          this.opts.log?.warn({ backoffMs: backoff }, 'relay hooks stream closed; reconnecting');
        }
      } catch (err) {
        if (!ac.signal.aborted) {
          this.opts.log?.warn(
            { err: (err as Error).name, backoffMs: backoff },
            'relay hooks stream failed; reconnecting (polling meanwhile)',
          );
        }
      }
      setUp(false);
      if (ac.signal.aborted) return;
      await abortableDelay(backoff, ac.signal);
      backoff = Math.min(backoff * 2, maxMs);
    }
  }

  /** Fallback: while the hooks stream is down, poll every watched actor. */
  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await abortableDelay(this.opts.pollMs, signal);
      if (signal.aborted) return;
      if (this.streamUp) continue;
      await Promise.all([...this.watchers.values()].map((w) => w.refresh()));
    }
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
