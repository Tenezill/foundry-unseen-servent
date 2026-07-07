/** Test doubles: an in-memory relay and a tiny clamping SystemAdapter. */
import type {
  FoundryActorDoc,
  FoundryUpdate,
  ResourceDescriptor,
  ResourceIntent,
  SheetViewModel,
  SystemAdapter,
} from '@companion/adapter-sdk';
import { clamp, IntentError } from '@companion/adapter-sdk';
import type { RelayPort } from '../src/app.js';

/** Secret strings that must NEVER show up in any response body. */
export const FAKE_API_KEY = 'super-secret-relay-key-a1b2c3d4e5';
export const FAKE_RELAY_URL = 'http://relay-internal:3010';

function setPath(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let obj = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i] as string;
    if (typeof obj[key] !== 'object' || obj[key] === null) obj[key] = {};
    obj = obj[key] as Record<string, unknown>;
  }
  obj[parts[parts.length - 1] as string] = value;
}

export class FakeRelay implements RelayPort {
  readonly entities = new Map<string, Record<string, unknown>>();
  readonly updates: Array<{ uuid: string; data: Record<string, number | string | boolean> }> = [];
  /** Active world-level hooks subscriptions (one per open stream). */
  readonly hookSubscribers = new Set<(ev: { event: string; data: unknown }) => void>();
  /** hooks lists passed to subscribeHooks, in call order. */
  readonly hookSubscriptions: string[][] = [];
  /** When set, getEntity for this uuid throws an error embedding the secrets. */
  failUuid: string | null = null;
  listClientsError = false;

  async listClients(): Promise<unknown> {
    if (this.listClientsError) {
      throw new Error(`relay ${FAKE_RELAY_URL} unreachable (key ${FAKE_API_KEY})`);
    }
    return [{ clientId: 'fvtt_test', isOnline: true }];
  }

  async getEntity(uuid: string): Promise<Record<string, unknown> | null> {
    if (uuid === this.failUuid) {
      throw new Error(`relay GET ${FAKE_RELAY_URL}/get?uuid=${uuid} failed: x-api-key ${FAKE_API_KEY} rejected`);
    }
    const doc = this.entities.get(uuid);
    return doc === undefined ? null : (structuredClone(doc) as Record<string, unknown>);
  }

  /** Calls recorded as [systemPath, actorUuid, details]. */
  readonly systemDetailCalls: Array<[string, string, string[]]> = [];
  /** Response for getSystemDetails; error message embeds secrets when thrown. */
  systemDetails: unknown = {};
  systemDetailsError = false;

  async getSystemDetails(systemPath: string, actorUuid: string, details: string[]): Promise<unknown> {
    this.systemDetailCalls.push([systemPath, actorUuid, [...details]]);
    if (this.systemDetailsError) {
      throw new Error(`relay ${FAKE_RELAY_URL}/${systemPath} rejected key ${FAKE_API_KEY}`);
    }
    return structuredClone(this.systemDetails);
  }

  async updateEntity(uuid: string, data: Record<string, number | string | boolean>): Promise<void> {
    this.updates.push({ uuid, data });
    const m = /^Actor\.([^.]+)(?:\.Item\.([^.]+))?$/.exec(uuid);
    if (!m) throw new Error(`bad uuid ${uuid} (key ${FAKE_API_KEY})`);
    const actor = this.entities.get(`Actor.${m[1]}`);
    if (!actor) throw new Error(`no entity ${uuid} at ${FAKE_RELAY_URL}`);
    let target = actor;
    if (m[2] !== undefined) {
      const items = (actor.items ?? []) as Array<Record<string, unknown>>;
      const item = items.find((i) => i._id === m[2]);
      if (!item) throw new Error(`no item ${uuid}`);
      target = item;
    }
    for (const [path, value] of Object.entries(data)) setPath(target, path, value);
  }

  async subscribeHooks(
    hooks: string[],
    onEvent: (ev: { event: string; data: unknown }) => void,
    signal: AbortSignal,
  ): Promise<void> {
    this.hookSubscriptions.push([...hooks]);
    this.hookSubscribers.add(onEvent);
    return new Promise<void>((resolve) => {
      signal.addEventListener(
        'abort',
        () => {
          this.hookSubscribers.delete(onEvent);
          resolve();
        },
        { once: true },
      );
    });
  }

  /**
   * Simulate the relay pushing an `updateActor` hook event carrying the
   * (current) full actor document in args[0] — nested as data.data.args,
   * matching the M0 capture.
   */
  emitUpdateActor(actorId: string): void {
    const doc = this.entities.get(`Actor.${actorId}`);
    const payload = {
      data: { args: [doc !== undefined ? structuredClone(doc) : { _id: actorId }, {}, 'gm-user'] },
    };
    for (const onEvent of this.hookSubscribers) onEvent({ event: 'updateActor', data: payload });
  }

  /** Mutate a stored entity in place (dotted path). */
  mutate(uuid: string, dotted: string, value: unknown): void {
    const doc = this.entities.get(uuid);
    if (!doc) throw new Error(`no entity ${uuid}`);
    setPath(doc, dotted, value);
  }
}

interface FakeSystem {
  hp: { value: number; max: number };
  ac: number;
}

function descriptors(actor: FoundryActorDoc): ResourceDescriptor[] {
  const sys = actor.system as unknown as FakeSystem;
  const out: ResourceDescriptor[] = [
    { id: 'hp', label: 'HP', value: sys.hp.value, min: 0, max: sys.hp.max, writable: true, group: 'hp' },
    { id: 'ac', label: 'AC', value: sys.ac, writable: false },
  ];
  for (const item of actor.items ?? []) {
    const qty = (item.system as { quantity?: number }).quantity ?? 0;
    out.push({ id: `item.${item._id}.qty`, label: item.name, value: qty, min: 0, max: 99, writable: true });
  }
  return out;
}

export const fakeAdapter: SystemAdapter = {
  systemId: 'fake',
  toViewModel(actor: FoundryActorDoc): SheetViewModel {
    return {
      actorId: actor._id,
      systemId: 'fake',
      name: actor.name,
      headline: [],
      sections: [],
      resources: descriptors(actor),
    };
  },
  resources: descriptors,
  buildUpdate(actor: FoundryActorDoc, intent: ResourceIntent): FoundryUpdate {
    const desc = descriptors(actor).find((r) => r.id === intent.resourceId);
    if (!desc) throw new IntentError(`unknown resource ${intent.resourceId}`, 'UNKNOWN_RESOURCE');
    if (!desc.writable) throw new IntentError(`read-only resource ${intent.resourceId}`, 'READ_ONLY');
    const target = intent.kind === 'set' ? intent.value : desc.value + intent.amount;
    const value = clamp(target, desc.min, desc.max);
    if (intent.resourceId === 'hp') return { data: { 'system.hp.value': value } };
    const m = /^item\.(.+)\.qty$/.exec(intent.resourceId);
    if (m) return { itemId: m[1] as string, data: { 'system.quantity': value } };
    throw new IntentError(`unknown resource ${intent.resourceId}`, 'UNKNOWN_RESOURCE');
  },
};

export function actorDoc(id: string, name: string, hp: number, hpMax: number): Record<string, unknown> {
  return {
    _id: id,
    uuid: `Actor.${id}`,
    name,
    type: 'character',
    img: `icons/${id}.webp`,
    systemId: 'fake',
    system: { hp: { value: hp, max: hpMax }, ac: 15 },
    items: [{ _id: 'i1', name: 'Arrows', type: 'consumable', system: { quantity: 20 } }],
  };
}
