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

/**
 * updateActor covers direct actor edits (HP, currency…). The embedded-item
 * hooks cover the DM adding loot, deleting items, or editing item fields —
 * none of which fire updateActor, so without them the sheet would only catch
 * up on the next poll-gap or reconnect.
 */
const WATCHED_HOOKS = ['updateActor', 'createItem', 'updateItem', 'deleteItem'];
const ITEM_HOOKS = new Set(['createItem', 'updateItem', 'deleteItem']);

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

/**
 * Pull the PARENT actor's id out of a createItem/updateItem/deleteItem event.
 * `args[0]` is the embedded item document: prefer its serialized
 * `parent._id`, fall back to parsing the `Actor.<id>.Item.<id>` uuid.
 * World-level items (no actor parent) yield null.
 */
export function extractItemParentActorId(payload: unknown): string | null {
  const args = findArgsArray(payload, 0);
  if (!args || args.length === 0) return null;
  const doc = args[0];
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const item = doc as Record<string, unknown>;
  const parent = item.parent;
  if (parent !== null && typeof parent === 'object' && !Array.isArray(parent)) {
    const id = (parent as Record<string, unknown>)._id;
    if (typeof id === 'string' && id !== '') return id;
  }
  if (typeof item.uuid === 'string') {
    const m = /^Actor\.([^.]+)\.Item\./.exec(item.uuid);
    if (m) return m[1] as string;
  }
  return null;
}

/**
 * A partial upstream read (relay returning the actor doc while Foundry is
 * mid-write on its embedded items) drops EVERY item-derived section at once —
 * all spell levels, inventory, features, actions. This threshold distinguishes
 * that wholesale collapse from a normal edit: a single user action changes one
 * item and so removes at most one section, which is broadcast immediately.
 */
const MIN_VANISHED_SECTIONS = 2;

/**
 * Section ids of a rebuilt sheet, or null when `json` is not a sheet document
 * with a `sections` array (keeps the guard inert for non-sheet payloads).
 */
export function sheetSectionIds(json: string): Set<string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const sections = (parsed as Record<string, unknown>).sections;
  if (!Array.isArray(sections)) return null;
  const ids = new Set<string>();
  for (const section of sections) {
    if (section !== null && typeof section === 'object') {
      const id = (section as Record<string, unknown>).id;
      if (typeof id === 'string') ids.add(id);
    }
  }
  return ids;
}

/**
 * True when `next` looks like a partial read of `prev`: whole sections vanished
 * (>= MIN_VANISHED_SECTIONS) and none appeared. A superset or a single-section
 * drop is a legitimate change, not a suspicious collapse.
 */
export function isSuspiciousSectionLoss(prev: Set<string>, next: Set<string>): boolean {
  for (const id of next) if (!prev.has(id)) return false; // gained a section -> real change
  let lost = 0;
  for (const id of prev) if (!next.has(id)) lost++;
  return lost >= MIN_VANISHED_SECTIONS;
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
  /** Section ids of the last broadcast sheet, for the section-loss guard. */
  private lastSectionIds: Set<string> | null = null;
  /** A suspicious partial sheet held back once; broadcast if it recurs. */
  private suspectJson: string | null = null;
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
    if (this.lastJson === null) {
      this.lastJson = sheetJson;
      this.lastSectionIds = sheetSectionIds(sheetJson);
    }
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
          const newSectionIds = sheetSectionIds(json);
          if (
            this.lastSectionIds !== null &&
            newSectionIds !== null &&
            json !== this.suspectJson &&
            isSuspiciousSectionLoss(this.lastSectionIds, newSectionIds)
          ) {
            // Whole content sections vanished at once — almost certainly a
            // partial relay read while Foundry was mid-write. Keep the last
            // good sheet; if the SAME reduced sheet arrives again it is treated
            // as a real change and broadcast on that next pass.
            this.suspectJson = json;
            this.opts.log?.warn(
              {
                actorId: this.actorId,
                lost: [...this.lastSectionIds].filter((id) => !newSectionIds.has(id)),
              },
              'live: suppressing suspicious partial sheet (sections vanished); awaiting confirmation',
            );
          } else {
            this.suspectJson = null;
            this.lastJson = json;
            if (newSectionIds !== null) this.lastSectionIds = newSectionIds;
            for (const send of this.clients) send(json);
          }
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

  /** Abort + re-open the shared hooks stream — the relay identity (api key
   *  or clientId) changed, so the open stream belongs to the old identity.
   *  No-op when idle: the next attach opens a fresh stream anyway. */
  restartStream(): void {
    if (this.streamAc === null) return;
    this.streamAc.abort();
    this.streamAc = null;
    this.streamUp = false;
    this.ensureStream();
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
            const actorId =
              ev.event === 'updateActor'
                ? extractUpdatedActorId(ev.data)
                : ITEM_HOOKS.has(ev.event)
                  ? extractItemParentActorId(ev.data)
                  : null;
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
