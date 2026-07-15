/**
 * RELAY_CLIENT_ID=auto (turnkey): resolve the world clientId from the relay's
 * single online world, cache it BY WORLD ID, and never silently switch worlds
 * (a silent switch would send player writes into the wrong world). A wrong or
 * offline clientId makes relay requests STALL rather than error
 * (docs/RELAY.md), so resolution is driven by this bounded probe loop — never
 * by organic request failure.
 *
 * Policy: 0 online -> degrade + report. >1 online -> REFUSE + report (an
 * orphaned second pairing is a real state; the operator disambiguates with an
 * explicit RELAY_CLIENT_ID). Exactly 1 -> resolve + cache. With a cache: only
 * ever follow the SAME worldId; a fresh clientId for that worldId (re-pair)
 * is adopted and emitted; a different world is never adopted mid-run. The
 * cache is process-lifetime — a restart re-resolves from scratch.
 *
 * Task 0 findings §6-2: the relay's per-actor getEntity doc carries no
 * systemId, so the gateway falls back to defaultSystemId for adapter
 * selection. GET /clients DOES report systemId (and worldTitle) for the
 * resolved world, so this resolver captures both alongside the clientId
 * cache. They are exposed via resolvedWorld() (NOT via healthView() /
 * WorldHealth, which is the client-safe /healthz projection and must stay
 * exactly as specified — adding fields there would also change its shape
 * for the /healthz consumer prematurely). Task 4/5 wire resolvedWorld()
 * into adapter selection and (if ever needed) the health surface; this task
 * only captures and exposes it.
 */
import type { RelayClientInfo } from '@companion/foundry-client';

export type ResolveReason =
  | 'explicit'
  | 'resolved'
  | 'key-unavailable'
  | 'relay-unreachable'
  | 'no-world-online'
  | 'multiple-worlds-online'
  | 'world-offline';

/** Client-safe world state for /healthz — carries NO clientId, ever. */
export interface WorldHealth {
  state: 'online' | 'waiting' | 'blocked';
  worldTitle?: string;
  reason?: Exclude<ResolveReason, 'explicit' | 'resolved'>;
}

/** The resolved world's identity (Task 0 §6-2: systemId isn't available on
 *  the per-actor getEntity doc, only here) — for Task 4/5 adapter selection. */
export interface ResolvedWorld {
  worldId: string;
  worldTitle: string;
  systemId: string;
}

export interface ResolverDeps {
  listClients(): Promise<RelayClientInfo[]>;
  /** False while the file-sourced key has not appeared yet. */
  hasKey(): boolean;
  /** Probe interval. Default 5000. */
  probeMs?: number;
  /** Bound for each listClients call (M18 pattern). Default 3000. */
  probeTimeoutMs?: number;
  log?: { warn(obj: object, msg: string): void };
}

export class ClientIdResolver {
  private readonly explicitId: string | null;
  private cache: { worldId: string; clientId: string; worldTitle: string; systemId: string } | null = null;
  private reason: ResolveReason;
  private readonly listeners = new Set<(clientId: string) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private probing = false;

  constructor(
    clientIdConfig: string,
    private readonly deps: ResolverDeps,
  ) {
    this.explicitId = clientIdConfig === 'auto' ? null : clientIdConfig;
    this.reason = this.explicitId !== null ? 'explicit' : 'no-world-online';
  }

  /** The clientId requests should use RIGHT NOW; '' while unresolved (the
   *  relay rejects it fast; callers already degrade on failed requests). */
  current(): string {
    if (this.explicitId !== null) return this.explicitId;
    return this.cache?.clientId ?? '';
  }

  /** Fires whenever current() changes value (first resolve + re-pairs). */
  onChange(cb: (clientId: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Null in explicit mode (nothing to report); /healthz omits the field. */
  healthView(): WorldHealth | null {
    if (this.explicitId !== null) return null;
    switch (this.reason) {
      case 'resolved':
        return { state: 'online', worldTitle: (this.cache as { worldTitle: string }).worldTitle };
      case 'multiple-worlds-online':
        return { state: 'blocked', reason: 'multiple-worlds-online' };
      case 'world-offline':
        return {
          state: 'waiting',
          reason: 'world-offline',
          ...(this.cache !== null ? { worldTitle: this.cache.worldTitle } : {}),
        };
      case 'key-unavailable':
      case 'relay-unreachable':
      case 'no-world-online':
        return { state: 'waiting', reason: this.reason };
      default:
        return { state: 'waiting', reason: 'no-world-online' };
    }
  }

  /** The resolved world's systemId/worldTitle (Task 0 §6-2), for Task 4/5
   *  adapter selection. Null until a first successful resolution; sticky
   *  thereafter — mirrors current()'s "never switch worlds" cache. */
  resolvedWorld(): ResolvedWorld | null {
    if (this.cache === null) return null;
    return { worldId: this.cache.worldId, worldTitle: this.cache.worldTitle, systemId: this.cache.systemId };
  }

  start(): void {
    if (this.explicitId !== null || this.timer !== null) return;
    void this.probeOnce();
    this.timer = setInterval(() => void this.probeOnce(), this.deps.probeMs ?? 5_000);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One bounded resolution pass (doubles as the world health probe).
   *  Concurrent calls coalesce: a pass already in flight makes this a no-op. */
  async probeOnce(): Promise<void> {
    if (this.explicitId !== null || this.probing) return;
    this.probing = true;
    try {
      if (!this.deps.hasKey()) {
        this.reason = 'key-unavailable';
        return;
      }
      let clients: RelayClientInfo[] | null;
      try {
        clients = await Promise.race([
          this.deps.listClients(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), this.deps.probeTimeoutMs ?? 3_000)),
        ]);
      } catch (err) {
        this.deps.log?.warn({ err: (err as Error).message }, 'clientId probe: relay unreachable');
        this.reason = 'relay-unreachable';
        return;
      }
      if (clients === null) {
        this.reason = 'relay-unreachable';
        return;
      }
      const online = clients.filter((c) => c.isOnline === true);
      if (this.cache !== null) {
        // Never switch worlds: only ever follow the SAME worldId, even if a
        // different world is the only one online now.
        const same = online.find((c) => c.worldId === (this.cache as { worldId: string }).worldId);
        if (same === undefined) {
          this.reason = 'world-offline';
          return;
        }
        if (same.clientId !== this.cache.clientId) {
          // Same world re-paired under a fresh clientId (relay DB reset /
          // re-pair) — following it is not a world switch.
          this.cache = {
            worldId: same.worldId,
            clientId: same.clientId,
            worldTitle: same.worldTitle,
            systemId: same.systemId,
          };
          this.emit(same.clientId);
        } else {
          // Same world, same clientId — refresh worldTitle/systemId in case
          // they changed (e.g. a world rename) without treating it as a
          // clientId change.
          this.cache = { ...this.cache, worldTitle: same.worldTitle, systemId: same.systemId };
        }
        this.reason = 'resolved';
        return;
      }
      if (online.length === 0) {
        this.reason = 'no-world-online';
        return;
      }
      if (online.length > 1) {
        this.deps.log?.warn({ count: online.length }, 'clientId probe: multiple worlds online; refusing to pick');
        this.reason = 'multiple-worlds-online';
        return;
      }
      const only = online[0] as RelayClientInfo;
      this.cache = { worldId: only.worldId, clientId: only.clientId, worldTitle: only.worldTitle, systemId: only.systemId };
      this.reason = 'resolved';
      this.emit(only.clientId);
    } finally {
      this.probing = false;
    }
  }

  private emit(clientId: string): void {
    for (const cb of [...this.listeners]) cb(clientId);
  }
}
