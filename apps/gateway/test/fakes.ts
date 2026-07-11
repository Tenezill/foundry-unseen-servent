/** Test doubles: an in-memory relay and a tiny clamping SystemAdapter. */
import type {
  ActionDescriptor,
  ActionIntent,
  FoundryActorDoc,
  FoundryUpdate,
  RelayAction,
  ResourceDescriptor,
  ResourceIntent,
  SheetViewModel,
  SystemAdapter,
} from '@companion/adapter-sdk';
import { clamp, IntentError } from '@companion/adapter-sdk';
import type { RawRoll, RelayEncounter } from '@companion/foundry-client';
import type { PlayersPort, RelayPort } from '../src/app.js';
import type { Player } from '../src/players.js';

/** Secret strings that must NEVER show up in any response body. */
export const FAKE_API_KEY = 'super-secret-relay-key-a1b2c3d4e5';
export const FAKE_RELAY_URL = 'http://relay-internal:3010';

/** Wrap a fixed array as the live player source buildApp now expects. */
export function memoryPlayers(players: Player[]): PlayersPort {
  return { list: () => players };
}

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
  /** When set, getEntity for this uuid returns a promise that never settles
   *  (M22: exercises the EncounterManager's bounded-fetch degrade path —
   *  `failUuid`'s synchronous throw doesn't cover a genuinely stalled relay). */
  hangUuid: string | null = null;
  /**
   * M22 cache-swap bug simulation: this FakeRelay is instant and keyed
   * correctly, so genuine concurrent cross-wiring (the live-verified relay
   * bug — see foundry-client's getEntity comment) can't happen here by
   * accident. When set, the NEXT getEntity(when) call returns
   * `returnUuidInstead`'s stored doc rather than its own (one-shot, then
   * clears — mirrors the real bug's intermittency), letting tests prove
   * the manager degrades instead of being poisoned by a mismatched entity.
   */
  crossWire: { when: string; returnUuidInstead: string } | null = null;
  listClientsError = false;

  async listClients(): Promise<unknown> {
    if (this.listClientsError) {
      throw new Error(`relay ${FAKE_RELAY_URL} unreachable (key ${FAKE_API_KEY})`);
    }
    return [{ clientId: 'fvtt_test', isOnline: true }];
  }

  /** Every uuid getEntity was called with, in call order (M22: lets tests
   *  assert a hook-driven cache update did NOT trigger a re-fetch). */
  readonly getEntityCalls: string[] = [];

  async getEntity(uuid: string): Promise<Record<string, unknown> | null> {
    this.getEntityCalls.push(uuid);
    if (uuid === this.failUuid) {
      throw new Error(`relay GET ${FAKE_RELAY_URL}/get?uuid=${uuid} failed: x-api-key ${FAKE_API_KEY} rejected`);
    }
    if (uuid === this.hangUuid) return new Promise(() => undefined); // never settles
    if (this.crossWire !== null && uuid === this.crossWire.when) {
      const wrongUuid = this.crossWire.returnUuidInstead;
      this.crossWire = null;
      const wrongDoc = this.entities.get(wrongUuid);
      return wrongDoc === undefined ? null : (structuredClone(wrongDoc) as Record<string, unknown>);
    }
    const doc = this.entities.get(uuid);
    return doc === undefined ? null : (structuredClone(doc) as Record<string, unknown>);
  }

  // ---- encounters (M22) -----------------------------------------------------

  /** Combats returned by getEncounters(); tests seed this for start()/reseed. */
  encounters: RelayEncounter[] = [];
  readonly getEncountersCalls: number[] = [];
  /** When true, getEncounters never settles (M22: a relay-side stalled
   *  /encounters — live-verified 408 after 10s — must not clobber state). */
  hangEncounters = false;

  async getEncounters(): Promise<RelayEncounter[]> {
    this.getEncountersCalls.push(this.getEncountersCalls.length);
    if (this.hangEncounters) return new Promise(() => undefined); // never settles
    return structuredClone(this.encounters);
  }

  /** Enders for the currently open hooks streams (abort or failHookStreams). */
  private readonly hookStreamEnders: Array<(err?: Error) => void> = [];

  /** Simulate the relay dropping every open hooks stream (M22, live-verified:
   *  the relay closes /hooks/subscribe mid-burst; undici surfaces it to the
   *  subscriber as `TypeError: terminated`). Subscribers see a rejection,
   *  exactly like the real wire. */
  failHookStreams(err: Error = Object.assign(new TypeError('terminated'), { name: 'TypeError' })): void {
    for (const end of this.hookStreamEnders.splice(0)) end(err);
  }

  /** Simulate the relay ending every open hooks stream cleanly (EOF). */
  closeHookStreams(): void {
    for (const end of this.hookStreamEnders.splice(0)) end();
  }

  /** Simulate the relay pushing an `updateCombat`/`createCombat` hook-event
   *  carrying the full Combat doc in args[0] (Task 0 §2b nesting, mirrors
   *  emitUpdateActor). */
  emitUpdateCombat(combatDoc: Record<string, unknown>): void {
    const payload = { data: { args: [structuredClone(combatDoc), {}, {}, 'gm'] } };
    for (const onEvent of this.hookSubscribers) onEvent({ event: 'updateCombat', data: payload });
  }

  /** Simulate the relay pushing a `deleteCombat` hook-event; args[0] is just
   *  the deleted combat's `_id` per Foundry's deleteDocument hook shape. */
  emitDeleteCombat(id: string): void {
    const payload = { data: { args: [{ _id: id }, {}, {}, 'gm'] } };
    for (const onEvent of this.hookSubscribers) onEvent({ event: 'deleteCombat', data: payload });
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

  // ---- actions (M6) --------------------------------------------------------

  /** When set, rollFormula/useAbility/equipItem throw errors embedding secrets. */
  actionError = false;
  readonly rollCalls: Array<{ actorUuid: string; formula: string; flavor: string }> = [];
  rollResult: { formula: string; total: number; isCritical?: boolean; isFumble?: boolean } = {
    formula: '1d20 + 6',
    total: 17,
    isCritical: false,
    isFumble: false,
  };
  readonly useAbilityCalls: Array<{
    endpoint: 'use-item' | 'use-spell' | 'use-feature';
    actorUuid: string;
    itemUuid: string;
    opts: { slotLevel?: number };
  }> = [];
  /** Response for useAbility (the relay's `data` payload, roll nested under `roll`). */
  useAbilityResult: Record<string, unknown> = {};
  readonly equipCalls: Array<{ actorUuid: string; itemUuid: string; equipped: boolean }> = [];

  private throwActionError(endpoint: string): never {
    throw new Error(`relay POST ${FAKE_RELAY_URL}/${endpoint} rejected key ${FAKE_API_KEY}`);
  }

  async rollFormula(
    actorUuid: string,
    formula: string,
    flavor: string,
  ): Promise<{ formula: string; total: number; [key: string]: unknown }> {
    this.rollCalls.push({ actorUuid, formula, flavor });
    if (this.actionError) this.throwActionError('roll');
    return structuredClone(this.rollResult);
  }

  /** When true, useAbility throws a RelayError-shaped 408 (the relay's
   *  timeout while Foundry's usage workflow waits on optional UI, e.g. an
   *  area item's template prompt — M16). */
  useAbilityTimeout = false;

  async useAbility(
    endpoint: 'use-item' | 'use-spell' | 'use-feature',
    actorUuid: string,
    itemUuid: string,
    opts: { slotLevel?: number } = {},
  ): Promise<Record<string, unknown>> {
    this.useAbilityCalls.push({ endpoint, actorUuid, itemUuid, opts: { ...opts } });
    if (this.useAbilityTimeout) {
      const err = new Error(`relay /dnd5e/${endpoint} -> 408: request timed out`) as Error & { status: number };
      err.name = 'RelayError';
      err.status = 408;
      throw err;
    }
    if (this.actionError) this.throwActionError(`dnd5e/${endpoint}`);
    return structuredClone(this.useAbilityResult);
  }

  async equipItem(actorUuid: string, itemUuid: string, equipped: boolean): Promise<void> {
    this.equipCalls.push({ actorUuid, itemUuid, equipped });
    if (this.actionError) this.throwActionError('dnd5e/equip-item');
  }

  readonly attuneCalls: Array<{ actorUuid: string; itemUuid: string; attuned: boolean }> = [];

  async attuneItem(actorUuid: string, itemUuid: string, attuned: boolean): Promise<void> {
    this.attuneCalls.push({ actorUuid, itemUuid, attuned });
    if (this.actionError) this.throwActionError('dnd5e/attune-item');
  }

  readonly actorCommandCalls: Array<{
    endpoint: 'short-rest' | 'long-rest' | 'death-save' | 'break-concentration';
    actorUuid: string;
  }> = [];
  /** Response for actorCommand (the relay's `data` payload; empty by default). */
  actorCommandResult: Record<string, unknown> = {};

  async actorCommand(
    endpoint: 'short-rest' | 'long-rest' | 'death-save' | 'break-concentration',
    actorUuid: string,
  ): Promise<Record<string, unknown>> {
    this.actorCommandCalls.push({ endpoint, actorUuid });
    if (this.actionError) this.throwActionError(`dnd5e/${endpoint}`);
    return structuredClone(this.actorCommandResult);
  }

  // ---- library (search / give / delete) ------------------------------------

  /** Entries returned by search(); tests seed this. */
  searchResults: Array<{
    uuid: string;
    id: string;
    name: string;
    img?: string;
    documentType: string;
    [key: string]: unknown;
  }> = [];
  readonly searchCalls: Array<{ query?: string; filter?: string; limit?: number }> = [];

  async search(opts: { query?: string; filter?: string; limit?: number }): Promise<typeof this.searchResults> {
    this.searchCalls.push({ ...opts });
    if (this.actionError) this.throwActionError('search');
    return structuredClone(this.searchResults);
  }

  readonly giveCalls: Array<{ toUuid: string; itemUuid: string }> = [];

  /** Copies the referenced entity's doc into the target actor's items. */
  async giveItem(toUuid: string, itemUuid: string): Promise<void> {
    this.giveCalls.push({ toUuid, itemUuid });
    if (this.actionError) this.throwActionError('give');
    const src = this.entities.get(itemUuid);
    const target = this.entities.get(toUuid);
    if (!src || !target) throw new Error(`give: missing ${!src ? itemUuid : toUuid}`);
    const items = (target.items ?? []) as Array<Record<string, unknown>>;
    items.push({ ...structuredClone(src), _id: `given-${this.giveCalls.length}` });
    target.items = items;
  }

  readonly deleteCalls: string[] = [];

  async deleteEntity(uuid: string): Promise<void> {
    this.deleteCalls.push(uuid);
    if (this.actionError) this.throwActionError('delete');
    const m = /^Actor\.([^.]+)\.Item\.([^.]+)$/.exec(uuid);
    if (!m) throw new Error(`delete: unsupported uuid ${uuid}`);
    const actor = this.entities.get(`Actor.${m[1]}`);
    if (!actor) throw new Error(`delete: no entity ${uuid}`);
    actor.items = ((actor.items ?? []) as Array<Record<string, unknown>>).filter((i) => i._id !== m[2]);
  }

  // ---- GM roll feed (M9) ---------------------------------------------------

  /** Rolls returned by getRolls, newest first. */
  rolls: RawRoll[] = [];
  readonly getRollsCalls: number[] = [];
  /** Active roll-stream subscriptions (one per open stream). */
  readonly rollSubscribers = new Set<(roll: RawRoll) => void>();

  async getRolls(limit = 50): Promise<RawRoll[]> {
    this.getRollsCalls.push(limit);
    if (this.actionError) this.throwActionError('rolls');
    return structuredClone(this.rolls.slice(0, limit));
  }

  async subscribeRolls(onRoll: (roll: RawRoll) => void, signal: AbortSignal): Promise<void> {
    this.rollSubscribers.add(onRoll);
    return new Promise<void>((resolve) => {
      signal.addEventListener(
        'abort',
        () => {
          this.rollSubscribers.delete(onRoll);
          resolve();
        },
        { once: true },
      );
    });
  }

  /** Simulate the relay pushing one live roll to every open roll stream. */
  emitRoll(roll: RawRoll): void {
    for (const onRoll of this.rollSubscribers) onRoll(structuredClone(roll));
  }

  async subscribeHooks(
    hooks: string[],
    onEvent: (ev: { event: string; data: unknown }) => void,
    signal: AbortSignal,
  ): Promise<void> {
    this.hookSubscriptions.push([...hooks]);
    this.hookSubscribers.add(onEvent);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const end = (err?: Error): void => {
        if (settled) return;
        settled = true;
        this.hookSubscribers.delete(onEvent);
        if (err) reject(err);
        else resolve();
      };
      this.hookStreamEnders.push(end);
      signal.addEventListener('abort', () => end(), { once: true });
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

/** Fixed action list (M6): one check, one attack item, one leveled cast, one equip, one attune. */
function actionList(_actor: FoundryActorDoc): ActionDescriptor[] {
  return [
    { id: 'skill.ath', label: 'Athletics', kind: 'check' },
    { id: 'item.i1.attack', label: 'Arrows', kind: 'attack' },
    { id: 'spell.s1.cast', label: 'Zap', kind: 'cast', slotLevels: [1, 2] },
    { id: 'item.i1.equip', label: 'Arrows', kind: 'equip', equipped: false },
    { id: 'item.i1.attune', label: 'Arrows', kind: 'attune', attuned: false },
    { id: 'spell.s1.prepare', label: 'Zap', kind: 'prepare', prepared: false },
    { id: 'item.i1.move', label: 'Arrows', kind: 'move' },
    { id: 'rest.short', label: 'Short Rest', kind: 'rest' },
    { id: 'rest.long', label: 'Long Rest', kind: 'rest' },
    { id: 'deathsave.roll', label: 'Death Save', kind: 'deathsave' },
    { id: 'concentration.end', label: 'End Concentration', kind: 'endconcentration' },
  ];
}

export const fakeAdapter: SystemAdapter = {
  systemId: 'fake',
  library: [
    {
      id: 'spells',
      label: 'Learn spell',
      searchFilter: 'documentType:Item,subType:spell',
      canAdd: (doc) => doc.type === 'spell',
      canRemove: (item) => item.type === 'spell',
      describe: (doc) => ({ id: String(doc._id ?? 'preview'), label: String(doc.name ?? '?'), sub: 'spell' }),
    },
    {
      id: 'feats',
      label: 'Add feat',
      searchFilter: 'documentType:Item,subType:feat',
      canAdd: (doc) => doc.type === 'feat',
      canRemove: (item) => item.type === 'feat',
      describe: (doc) => ({ id: String(doc._id ?? 'preview'), label: String(doc.name ?? '?'), sub: 'feat' }),
    },
    {
      id: 'gear',
      label: 'Add item',
      // No single subType covers physical items -> broad Item filter; the
      // search route relies on canAdd to drop spells/feats from the hits.
      searchFilter: 'documentType:Item',
      canAdd: (doc) => doc.type === 'weapon' || doc.type === 'consumable' || doc.type === 'equipment',
      canRemove: (item) => item.type === 'weapon' || item.type === 'consumable' || item.type === 'equipment',
      describe: (doc) => ({ id: String(doc._id ?? 'preview'), label: String(doc.name ?? '?'), sub: String(doc.type ?? 'item') }),
    },
  ],
  toViewModel(actor: FoundryActorDoc): SheetViewModel {
    return {
      actorId: actor._id,
      systemId: 'fake',
      name: actor.name,
      headline: [],
      sections: [],
      resources: descriptors(actor),
      library: [
        { id: 'spells', label: 'Learn spell' },
        { id: 'feats', label: 'Add feat' },
      ],
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
  actions: actionList,
  buildAction(actor: FoundryActorDoc, intent: ActionIntent): RelayAction {
    const desc = actionList(actor).find((a) => a.id === intent.actionId);
    if (!desc || desc.kind !== intent.kind) {
      throw new IntentError(`unknown action ${intent.actionId}`, 'UNKNOWN_RESOURCE');
    }
    switch (intent.kind) {
      case 'check':
      case 'save':
        return { endpoint: 'roll', formula: '1d20 + 6', flavor: desc.label };
      case 'attack':
        return { endpoint: 'use-item', itemId: 'i1' };
      case 'damage':
        return { endpoint: 'roll', formula: '1d8 + 3', flavor: desc.label };
      case 'use':
        return { endpoint: 'use-feature', itemId: 'f1' };
      case 'cast':
        if (intent.slotLevel !== undefined && !(desc.slotLevels ?? []).includes(intent.slotLevel)) {
          throw new IntentError(`illegal slot level ${intent.slotLevel}`, 'INVALID');
        }
        return {
          endpoint: 'use-spell',
          itemId: 's1',
          ...(intent.slotLevel !== undefined ? { slotLevel: intent.slotLevel } : {}),
        };
      case 'equip':
        return { endpoint: 'equip-item', itemId: 'i1', equipped: intent.equipped };
      case 'attune':
        return { endpoint: 'attune-item', itemId: 'i1', attuned: intent.attuned };
      case 'prepare':
        return { endpoint: 'update-item', itemId: 's1', data: { 'system.prepared': intent.prepared ? 1 : 0 } };
      case 'move':
        return {
          endpoint: 'update-item',
          itemId: intent.actionId.slice('item.'.length, -'.move'.length),
          data: { 'system.container': intent.containerId ?? '' },
        };
      case 'rest':
        return { endpoint: intent.actionId === 'rest.long' ? 'long-rest' : 'short-rest' };
      case 'deathsave':
        return { endpoint: 'death-save' };
      case 'endconcentration':
        return { endpoint: 'break-concentration' };
    }
  },
};

/** The same adapter with no action support at all (M6 rule: every action -> 403). */
export const actionlessAdapter: SystemAdapter = (() => {
  const { actions: _actions, buildAction: _buildAction, ...rest } = fakeAdapter;
  return rest;
})();

export function actorDoc(id: string, name: string, hp: number, hpMax: number): Record<string, unknown> {
  return {
    _id: id,
    uuid: `Actor.${id}`,
    name,
    type: 'character',
    img: `icons/${id}.webp`,
    systemId: 'fake',
    system: { hp: { value: hp, max: hpMax }, ac: 15 },
    items: [
      { _id: 'i1', name: 'Arrows', type: 'consumable', system: { quantity: 20 } },
      { _id: 's1', name: 'Zap', type: 'spell', system: {} },
      { _id: 'ft1', name: 'Lucky', type: 'feat', system: {} },
    ],
  };
}
