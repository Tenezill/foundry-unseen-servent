/**
 * Typed wrapper over the ThreeHats foundryvtt-rest-api-relay (v3.x, Go).
 * This is the ONLY package that knows relay URLs, API keys, and endpoint
 * shapes. Endpoint reference: relay repo `docs/md/api/*.md`, pinned in
 * VERSIONS.md; live-verified in docs/M0-findings.md.
 */

export interface RelayConfig {
  /** e.g. http://relay:3010 — never exposed to clients */
  baseUrl: string;
  /** scoped API key (entity:read, entity:write, search, events:subscribe,
   *  clients:read, …). A function is re-read on every request so a rotated
   *  key takes effect without a restart (turnkey stack). */
  apiKey: string | (() => string);
  /** Foundry world client id, e.g. fvtt_3a9f1c2e4b7d8e0f. A function is
   *  re-read on every request; it may return '' while unresolved — the
   *  request then fails fast relay-side and the caller degrades. */
  clientId: string | (() => string);
  /** Optional structured-log sink for defensive warnings (e.g. cross-wired
   *  GET /get responses — see getEntity). Silent no-op if omitted. */
  log?: { warn(obj: object, msg: string): void };
}

export interface RelayClientInfo {
  clientId: string;
  worldId: string;
  worldTitle: string;
  foundryVersion: string;
  systemId: string;
  isOnline: boolean;
}

export interface SearchOptions {
  query?: string;
  /** simple ("Actor") or compound ("documentType:Item,subType:weapon") */
  filter?: string;
  limit?: number;
  /** return only uuid,id,name,img,documentType */
  minified?: boolean;
}

export interface SearchResultEntry {
  uuid: string;
  id: string;
  name: string;
  img?: string;
  documentType: string;
  [key: string]: unknown;
}

export class RelayError extends Error {
  constructor(
    message: string,
    public readonly status: number | undefined,
    public readonly endpoint: string,
  ) {
    super(message);
    this.name = 'RelayError';
  }
}

/** An actor-changed push event from the relay SSE stream. */
export interface ActorEvent {
  actorUuid: string;
  /** raw event payload as sent by the relay */
  data: unknown;
}

/** A raw roll record from GET /rolls or the /rolls/subscribe stream. */
export interface RawRoll {
  id: string;
  messageId?: string;
  speaker?: { actor?: string; alias?: string };
  user?: { id?: string; name?: string } | null;
  flavor?: string;
  rollTotal?: number;
  formula?: string;
  isCritical?: boolean;
  isFumble?: boolean;
  timestamp?: number;
  [key: string]: unknown;
}

/** Result of a /roll or /dnd5e use-* roll, as returned by the relay. */
export interface RollResult {
  formula: string;
  total: number;
  isCritical?: boolean;
  isFumble?: boolean;
  [key: string]: unknown;
}

export interface TargetedUseOptions {
  targetTokenUuids: string[];
  slotKey?: string;
  mode?: 'advantage' | 'disadvantage';
}

export interface TargetedDamagePart {
  type: string;
  value: number;
}

export interface TargetedUseTargetResult {
  tokenUuid: string;
  name: string;
  outcome: 'hit' | 'miss' | 'save-failed' | 'save-passed' | 'applied' | 'gone';
  save?: { total: number; dc: number };
  damage?: { rolled: TargetedDamagePart[]; applied: number };
}

export interface TargetedUseResult {
  attack: { total: number; formula: string; isCritical: boolean; isFumble: boolean } | null;
  targets: TargetedUseTargetResult[];
}

/** A named SSE event from the relay hooks stream. */
export interface HookEvent {
  /** SSE event name, e.g. "updateActor", "connected" */
  event: string;
  /** parsed data payload; hook events carry {data:{args:[<updated doc>, <diff>, …]}} */
  data: unknown;
}

export interface RelayCombatant {
  id: string;
  name: string;
  tokenUuid?: string;
  actorUuid?: string;
  img?: string | null;
  initiative?: number | null;
  hidden?: boolean;
  defeated?: boolean;
}

export interface RelayEncounter {
  id: string;
  name?: string;
  round: number;
  turn: number;
  current: boolean;
  combatants: RelayCombatant[];
}

/** Scene document subset from GET /scene (relay returns Scene.toObject(true)).
 *  Live-verified against relay 3.4.1: there is NO separate canvas-documents
 *  HTTP route in any spelling — placeable tokens ride along embedded on the
 *  scene document itself (Foundry's own Scene.toObject() shape), so `tokens`
 *  is read from here, not fetched separately. */
export interface RelayScene {
  _id: string;
  name?: string;
  /** Foundry v13 nests grid config: type 1 = square; size = px per cell. */
  grid?: { type?: number; size?: number; distance?: number; units?: string };
  /** Embedded TokenDocument collection (Scene.toObject() nests it here — no
   *  separate canvas route exists on the relay). */
  tokens?: RelayCanvasToken[];
  [key: string]: unknown;
}

/** TokenDocument.toObject() subset — an entry of the scene's embedded `tokens`
 *  collection (there is no separate GET /get-canvas-documents route on the
 *  relay; tokens ride along on the scene document — see RelayScene.tokens).
 *  x/y are canvas px of the token's TOP-LEFT corner; width/height are in grid squares. */
export interface RelayCanvasToken {
  _id: string;
  name?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  hidden?: boolean;
  /** -1 hostile, 0 neutral, 1 friendly, -2 secret. */
  disposition?: number;
  actorId?: string | null;
  [key: string]: unknown;
}

/**
 * The execute-js activation script both castAtSlot and useWithoutTemplate
 * run: dnd5e's own activity.use, mirroring the relay module's use-* flow
 * (v13 path) plus two additions the module lacks — an explicit paying slot
 * (when `slotKey` is given) and suppression of measured-template placement.
 * dnd5e 5.3.3 `_prepareUsageConfig` (live-read 2026-07-20):
 *   `config.create.measuredTemplate ??= !!this.target.template.type && this.target.prompt`
 * — headless there is no one to click the canvas, so the default BLOCKS the
 * whole use() promise until the relay 408s (5-8s). An explicit `false`
 * survives the `??=`; the chat card still carries its own place-template
 * button for the GM. Attack-type activities also capture the to-hit roll
 * (same dnd5e.rollAttackV2 hook the module uses) and return it as { roll }.
 * Only validated ids/slot keys are interpolated, via JSON.stringify —
 * callers can never inject script text.
 */
function activationScript(itemUuid: string, slotKey?: string): string {
  const usage =
    slotKey !== undefined
      ? `{ subsequentActions: false, consume: { spellSlot: true }, spell: { slot: ${JSON.stringify(slotKey)} }, create: { measuredTemplate: false } }`
      : `{ subsequentActions: false, create: { measuredTemplate: false } }`;
  return [
    `const item = await fromUuid(${JSON.stringify(itemUuid)});`,
    `if (!item) throw new Error('item not found');`,
    `const activities = item.system?.activities;`,
    `const activity = activities?.size > 0 ? [...activities.values()][0] : null;`,
    `if (!activity) throw new Error('item has no activity');`,
    `let attackRoll = null;`,
    `const hookId = Hooks.once('dnd5e.rollAttackV2', (rolls) => { if (rolls?.length) attackRoll = rolls[0]; });`,
    `try {`,
    `  const hasAttack = typeof activity.rollAttack === 'function';`,
    `  const usage = ${usage};`,
    `  const useResult = await activity.use(usage, { configure: false }, {});`,
    `  if (!useResult) throw new Error('cast could not be performed');`,
    `  if (hasAttack) await activity.rollAttack({}, { configure: false }, {});`,
    `} finally { Hooks.off('dnd5e.rollAttackV2', hookId); }`,
    `return attackRoll ? { roll: { total: attackRoll.total, formula: attackRoll.formula, isCritical: attackRoll.isCritical ?? false, isFumble: attackRoll.isFumble ?? false } } : {};`,
  ].join('\n');
}

/**
 * The execute-js orchestration for targeted attacks/saves/heals (2026-07-22
 * combat-targeting spec): set user targets (best-effort, chat-card cosmetics
 * only) → activity.use() (Foundry consumes slots/uses/ammo, template
 * placement suppressed) → attack roll (dnd5e.rollAttackV2 hook, same as
 * activationScript) or per-target saving throws → ONE damage roll →
 * dnd5e's own actor.applyDamage per target (resistances/immunities/
 * vulnerabilities and temp-HP-first live in dnd5e, never here). Damage
 * descriptions come from dnd5e.dice.aggregateDamageRolls — the exact shape
 * dnd5e's own chat-card apply button uses. `applied` is the true HP+temp
 * delta (snapshot before/after), so resistance halving is visible to the
 * caller. Only validated ids are interpolated, via JSON.stringify.
 */
function targetedUseScript(
  itemUuid: string,
  targetTokenUuids: string[],
  slotKey?: string,
  mode?: 'advantage' | 'disadvantage',
): string {
  const usage =
    slotKey !== undefined
      ? `{ subsequentActions: false, consume: { spellSlot: true }, spell: { slot: ${JSON.stringify(slotKey)} }, create: { measuredTemplate: false } }`
      : `{ subsequentActions: false, create: { measuredTemplate: false } }`;
  const attackConfig =
    mode === 'advantage' ? '{ advantage: true }' : mode === 'disadvantage' ? '{ disadvantage: true }' : '{}';
  return [
    `const item = await fromUuid(${JSON.stringify(itemUuid)});`,
    `if (!item) throw new Error('item not found');`,
    `const activities = item.system?.activities;`,
    `const activity = activities?.size > 0 ? [...activities.values()][0] : null;`,
    `if (!activity) throw new Error('item has no activity');`,
    `const kind = activity.type;`,
    `const wanted = ${JSON.stringify(targetTokenUuids)};`,
    `const targets = [];`,
    `for (const uuid of wanted) {`,
    `  const tok = await fromUuid(uuid);`,
    `  targets.push({ uuid, doc: tok?.actor ? tok : null });`,
    `}`,
    `try { game.user.updateTokenTargets(targets.filter((t) => t.doc).map((t) => t.doc.id)); } catch (e) {}`,
    `let attackRoll = null;`,
    `const hookId = Hooks.once('dnd5e.rollAttackV2', (rolls) => { if (rolls?.length) attackRoll = rolls[0]; });`,
    `try {`,
    `  const useResult = await activity.use(${usage}, { configure: false }, {});`,
    `  if (!useResult) throw new Error('use could not be performed');`,
    `  if (kind === 'attack') await activity.rollAttack(${attackConfig}, { configure: false }, {});`,
    `} finally { Hooks.off('dnd5e.rollAttackV2', hookId); }`,
    `const attack = attackRoll ? { total: attackRoll.total, formula: attackRoll.formula, isCritical: attackRoll.isCritical ?? false, isFumble: attackRoll.isFumble ?? false } : null;`,
    `const isCrit = attack?.isCritical === true;`,
    `for (const t of targets) {`,
    `  if (!t.doc) continue;`,
    `  if (kind === 'attack') {`,
    `    const ac = Number(t.doc.actor.system?.attributes?.ac?.value ?? 10);`,
    `    t.hit = isCrit || (attack !== null && attack.isFumble !== true && attack.total >= ac);`,
    `  }`,
    `}`,
    `const saveCfg = kind === 'save' ? activity.save : null;`,
    `const dc = Number(saveCfg?.dc?.value ?? 0);`,
    `const ability = saveCfg ? (saveCfg.ability?.first?.() ?? [...(saveCfg.ability ?? [])][0] ?? 'dex') : null;`,
    `const onSave = String(activity.damage?.onSave ?? 'half');`,
    `if (kind === 'save') {`,
    `  for (const t of targets) {`,
    `    if (!t.doc) continue;`,
    `    try {`,
    `      const rolls = await t.doc.actor.rollSavingThrow({ ability, target: dc }, { configure: false }, {});`,
    `      const total = rolls?.[0]?.total;`,
    `      t.saveTotal = typeof total === 'number' ? total : null;`,
    `      t.passed = t.saveTotal !== null && t.saveTotal >= dc;`,
    `    } catch (e) { t.saveTotal = null; t.passed = false; }`,
    `  }`,
    `}`,
    `const needsDamage = (kind === 'attack' && targets.some((t) => t.hit)) || kind === 'save' || kind === 'heal';`,
    `let damages = [];`,
    `let rolledParts = [];`,
    `if (needsDamage && typeof activity.rollDamage === 'function') {`,
    `  let dmgRolls = null;`,
    `  const dmgHook = Hooks.once('dnd5e.rollDamageV2', (rolls) => { dmgRolls = rolls; });`,
    `  try {`,
    `    const returned = await activity.rollDamage({ isCritical: isCrit }, { configure: false }, {});`,
    `    if (Array.isArray(returned) && returned.length) dmgRolls = returned;`,
    `  } finally { Hooks.off('dnd5e.rollDamageV2', dmgHook); }`,
    `  if (Array.isArray(dmgRolls) && dmgRolls.length) {`,
    // dnd5e 5.3.x exposes no dnd5e.dice.aggregateDamageRolls (live-verified
    // 2026-07-22: dnd5e.dice is empty on 5.3.3) — each rollDamage() Roll is
    // already one damage part carrying its type/properties on roll.options,
    // and actor.applyDamage accepts that array of parts directly (resistances/
    // immunities/vulnerabilities still resolved inside dnd5e). Map the rolls
    // straight to parts; no aggregation helper needed.
    `    damages = dmgRolls.map((r) => ({ value: r.total, type: r.options?.type, properties: new Set(r.options?.properties ?? []) }));`,
    `    rolledParts = damages.map((d) => ({ type: String(d.type ?? ''), value: d.value }));`,
    `  }`,
    `}`,
    `const results = [];`,
    `for (const t of targets) {`,
    `  if (!t.doc) { results.push({ tokenUuid: t.uuid, name: '', outcome: 'gone' }); continue; }`,
    `  const name = t.doc.name ?? t.doc.actor.name;`,
    `  let outcome = 'applied';`,
    `  let multiplier = 1;`,
    `  if (kind === 'attack') { outcome = t.hit ? 'hit' : 'miss'; if (!t.hit) multiplier = 0; }`,
    `  else if (kind === 'save') {`,
    `    outcome = t.passed ? 'save-passed' : 'save-failed';`,
    `    if (t.passed) multiplier = onSave === 'none' ? 0 : onSave === 'half' ? 0.5 : 1;`,
    `  }`,
    `  const entry = { tokenUuid: t.uuid, name, outcome };`,
    `  if (t.saveTotal !== undefined && t.saveTotal !== null) entry.save = { total: t.saveTotal, dc };`,
    `  if (damages.length && multiplier > 0) {`,
    `    const hp = t.doc.actor.system?.attributes?.hp ?? {};`,
    `    const before = (hp.value ?? 0) + (hp.temp ?? 0);`,
    `    await t.doc.actor.applyDamage(damages, { multiplier });`,
    `    const hpAfter = t.doc.actor.system?.attributes?.hp ?? {};`,
    `    const after = (hpAfter.value ?? 0) + (hpAfter.temp ?? 0);`,
    `    entry.damage = { rolled: rolledParts, applied: Math.abs(before - after) };`,
    `  } else if (damages.length) {`,
    `    entry.damage = { rolled: rolledParts, applied: 0 };`,
    `  }`,
    `  results.push(entry);`,
    `}`,
    `try { game.user.updateTokenTargets([]); } catch (e) {}`,
    `return { attack, targets: results };`,
  ].join('\n');
}

export class FoundryRelayClient {
  constructor(private readonly cfg: RelayConfig) {}

  private apiKeyValue(): string {
    const k = this.cfg.apiKey;
    return typeof k === 'function' ? k() : k;
  }

  private clientIdValue(): string {
    const c = this.cfg.clientId;
    return typeof c === 'function' ? c() : c;
  }

  private url(path: string, params: Record<string, string | number | boolean | undefined> = {}): string {
    const u = new URL(path, this.cfg.baseUrl);
    u.searchParams.set('clientId', this.clientIdValue());
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'x-api-key': this.apiKeyValue(), ...extra };
  }

  private async request<T>(method: string, path: string, params: Record<string, string | number | boolean | undefined> = {}, body?: unknown): Promise<T> {
    const endpoint = this.url(path, params);
    let res: Response;
    try {
      const init: RequestInit = {
        method,
        headers: this.headers(body !== undefined ? { 'content-type': 'application/json' } : {}),
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      res = await fetch(endpoint, init);
    } catch (err) {
      throw new RelayError(`relay unreachable: ${(err as Error).message}`, undefined, path);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new RelayError(`relay ${path} -> ${res.status}: ${text.slice(0, 300)}`, res.status, path);
    }
    return (await res.json()) as T;
  }

  /**
   * GET /rolls — recent rolls across the whole world (M9, needs roll:read).
   * Newest first. Shape (M9-verified): {data:[{id, speaker:{actor,alias},
   * flavor, rollTotal, formula, isCritical, isFumble, timestamp, user}]}.
   */
  async getRolls(limit = 50): Promise<RawRoll[]> {
    const body = await this.request<{ data?: RawRoll[] }>('GET', '/rolls', { limit });
    return Array.isArray(body.data) ? body.data : [];
  }

  /**
   * GET /rolls/subscribe (SSE) — live world rolls (M9). Emits `event: roll`
   * frames whose `data.data` is a RawRoll. Calls onRoll per roll until the
   * signal aborts or the stream closes; caller owns reconnection.
   */
  async subscribeRolls(onRoll: (roll: RawRoll) => void, signal: AbortSignal): Promise<void> {
    await this.readSse('/rolls/subscribe', {}, signal, (ev) => {
      if (ev.event !== 'roll') return;
      const payload = ev.data;
      const inner = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).data : undefined;
      if (inner && typeof inner === 'object') onRoll(inner as RawRoll);
    });
  }

  /** GET /clients — worlds currently connected to the relay. */
  async listClients(): Promise<RelayClientInfo[]> {
    // /clients is relay-global; clientId param is harmlessly ignored.
    const body = await this.request<{ total: number; clients: RelayClientInfo[] }>('GET', '/clients');
    return body.clients ?? [];
  }

  /**
   * GET /get?uuid=Actor.xyz — full serialized entity document.
   * Returns null when the entity does not exist.
   *
   * Defense-in-depth (M22 cache-swap bug, live-verified against
   * threehats/foundryvtt-rest-api-relay 3.4.1): under CONCURRENT GET /get
   * calls, the relay was observed returning a 200 whose envelope `uuid` AND
   * whose `data._id` both belong to a DIFFERENT, concurrently-requested
   * uuid — i.e. it delivers the wrong client's response (a request/response
   * correlation bug upstream, not a transient field glitch). 25 rounds of 2
   * truly-concurrent GET /get against the live dev relay produced 14/50
   * cross-wired responses. Since the caller cannot fix the relay, every
   * response is checked for identity here: if the envelope uuid or the
   * document's own _id don't match what was requested, the fetch is treated
   * as failed (null) rather than trusted — callers already have a degrade
   * path for a failed/timed-out fetch (EncounterManager, admin console,
   * /api/actors all treat null as "not yet resolved").
   */
  async getEntity(uuid: string): Promise<Record<string, unknown> | null> {
    try {
      const body = await this.request<Record<string, unknown>>('GET', '/get', { uuid });
      const doc = unwrapEntity(body);
      if (doc === null) return null;
      const expectedId = uuid.split('.').pop();
      const envelopeUuid = typeof body.uuid === 'string' ? body.uuid : undefined;
      const docId = typeof doc._id === 'string' ? doc._id : undefined;
      const envelopeMismatch = envelopeUuid !== undefined && envelopeUuid !== uuid;
      const docMismatch = docId !== undefined && expectedId !== undefined && expectedId !== '' && docId !== expectedId;
      if (envelopeMismatch || docMismatch) {
        this.cfg.log?.warn(
          { requestedUuid: uuid, envelopeUuid, docId },
          'relay GET /get returned a mismatched entity (cross-wired response) — treating as a failed fetch',
        );
        return null;
      }
      return doc;
    } catch (err) {
      if (err instanceof RelayError && err.status === 404) return null;
      throw err;
    }
  }

  /** GET /search — find entities. */
  async search(opts: SearchOptions): Promise<SearchResultEntry[]> {
    const body = await this.request<Record<string, unknown>>('GET', '/search', {
      query: opts.query ?? '',
      filter: opts.filter,
      limit: opts.limit,
      minified: opts.minified,
    });
    const results = (body.results ?? body.entities ?? body) as unknown;
    return Array.isArray(results) ? (results as SearchResultEntry[]) : [];
  }

  /**
   * GET /<systemPath>/get-actor-details — system-specific derived data the
   * plain /get does not serialize (e.g. dnd5e `details=["spells"]` returns
   * real spell-slot maxima). Returns the endpoint's `data` payload.
   */
  async getSystemDetails(systemPath: string, actorUuid: string, details: string[]): Promise<unknown> {
    const body = await this.request<Record<string, unknown>>('GET', `/${systemPath}/get-actor-details`, {
      actorUuid,
      details: JSON.stringify(details),
    });
    return body.data ?? body;
  }

  /** GET /encounters — active/all combats (requires encounter:read scope). */
  async getEncounters(): Promise<RelayEncounter[]> {
    const body = await this.request<{ encounters?: RelayEncounter[] }>('GET', '/encounters', {});
    return Array.isArray(body.encounters) ? body.encounters : [];
  }

  /** GET /scene — the currently ACTIVE scene, or null when there is none.
   *  Requires the relay API key scope `scene:read` (live-verified: 403
   *  without it). The relay reports "no active scene" as an error-in-200;
   *  that maps to null (callers treat it as "movement unavailable", not a
   *  failure). The response's embedded `tokens` array (see RelayScene) is
   *  the ONLY way to read placeable tokens — no separate canvas route
   *  exists on the relay. */
  async getScene(): Promise<RelayScene | null> {
    const body = await this.request<{ data?: RelayScene | null; error?: string }>('GET', '/scene', { active: true });
    if (typeof body.error === 'string' && body.error !== '') return null;
    return body.data ?? null;
  }

  /** POST /move-token — reposition a token (canvas px, top-left), always
   *  animated. Requires the relay API key scope `canvas:write` (live-
   *  verified: 403 without it). tokenUuid form: `Scene.<sceneId>.Token.<tokenId>`. */
  async moveToken(tokenUuid: string, x: number, y: number): Promise<void> {
    const body = await this.request<{ data?: unknown; error?: string }>(
      'POST', '/move-token', {}, { uuid: tokenUuid, x, y, animate: true },
    );
    if (typeof body.error === 'string' && body.error !== '') {
      throw new RelayError(`relay /move-token: ${body.error}`, 200, '/move-token');
    }
  }

  /**
   * POST /roll — roll a formula in Foundry and post the chat card speaking
   * as the given actor (M6-verified). Requires the roll:execute scope.
   */
  async rollFormula(actorUuid: string, formula: string, flavor: string): Promise<RollResult> {
    const body = await this.request<{ data?: { roll?: RollResult } }>('POST', '/roll', {}, {
      formula,
      flavor,
      speaker: actorUuid,
      createChatMessage: true,
    });
    return body.data?.roll ?? { formula, total: Number.NaN };
  }

  /**
   * POST /dnd5e/use-item|use-spell|use-feature — run the system's real usage
   * workflow for an embedded item (chat card, slot/uses consumption).
   * Addressed by item uuid (`Actor.<id>.Item.<id>`).
   */
  async useAbility(
    endpoint: 'use-item' | 'use-spell' | 'use-feature',
    actorUuid: string,
    itemUuid: string,
    opts: { slotLevel?: number } = {},
  ): Promise<Record<string, unknown>> {
    // The module's upcast parameter is `level` (M6-live-verified: `slotLevel`
    // and other names are not recognised and make the cast fail outright).
    const body = await this.request<{ data?: Record<string, unknown>; error?: string }>('POST', `/dnd5e/${endpoint}`, {}, {
      actorUuid,
      abilityUuid: itemUuid,
      ...(opts.slotLevel !== undefined ? { level: opts.slotLevel } : {}),
    });
    if (typeof body.error === 'string' && body.error !== '') {
      throw new RelayError(`relay /dnd5e/${endpoint}: ${body.error}`, 200, `/dnd5e/${endpoint}`);
    }
    return body.data ?? {};
  }

  /**
   * POST /execute-js — cast a spell consuming a SPECIFIC slot (upcast).
   * The relay module's use-spell cannot pass a slot to dnd5e (M6/2026-07-19
   * finding), so this runs a CONSTANT script template through execute-js:
   * dnd5e's own activity.use({ spell: { slot } }) — right slot consumed,
   * card labeled with the cast level, concentration applied. Attack-type
   * activities also capture the to-hit roll (same dnd5e.rollAttackV2 hook
   * the module's use-spell uses) and return it as { roll } so the gateway's
   * extractRoll keeps working. Requires the relay API key scope
   * `execute-js` AND the module setting "Allow Execute JS".
   * Only validated ids/slot keys are interpolated, via JSON.stringify —
   * callers can never inject script text.
   * `actorUuid` is validated for defense-in-depth/API symmetry with the
   * other methods but is never interpolated into the script — the item
   * uuid alone resolves the actor via `fromUuid`.
   * Template placement is suppressed (create.measuredTemplate false — dnd5e would otherwise block awaiting a canvas click that never comes headless; the chat card's own button still lets the GM place it).
   */
  async castAtSlot(actorUuid: string, itemUuid: string, slotKey: string): Promise<Record<string, unknown>> {
    if (!/^Actor\.[A-Za-z0-9]{1,32}$/.test(actorUuid)) throw new Error(`castAtSlot: invalid actorUuid "${actorUuid}"`);
    if (!/^Actor\.[A-Za-z0-9]{1,32}\.Item\.[A-Za-z0-9]{1,32}$/.test(itemUuid)) {
      throw new Error(`castAtSlot: invalid itemUuid "${itemUuid}"`);
    }
    if (!/^spell[2-9]$/.test(slotKey)) throw new Error(`castAtSlot: invalid slotKey "${slotKey}"`);
    return this.executeActivation(activationScript(itemUuid, slotKey));
  }

  /**
   * POST /execute-js — run an item's usage workflow with dnd5e's DEFAULT
   * consumption (base slot for leveled spells, pact slots for pact spells,
   * item uses for free-use grants, nothing for cantrips — identical to the
   * relay module's own use-* flow) but with headless-blocking template
   * placement suppressed. Used for template-bearing items, whose module
   * use-* activation blocks 5-8s on the canvas prompt and 408s
   * (M-daylight finding, live-verified 2026-07-20: 267ms vs 5-8s).
   * Same scope/setting requirements and injection rules as castAtSlot.
   */
  async useWithoutTemplate(actorUuid: string, itemUuid: string): Promise<Record<string, unknown>> {
    if (!/^Actor\.[A-Za-z0-9]{1,32}$/.test(actorUuid)) {
      throw new Error(`useWithoutTemplate: invalid actorUuid "${actorUuid}"`);
    }
    if (!/^Actor\.[A-Za-z0-9]{1,32}\.Item\.[A-Za-z0-9]{1,32}$/.test(itemUuid)) {
      throw new Error(`useWithoutTemplate: invalid itemUuid "${itemUuid}"`);
    }
    return this.executeActivation(activationScript(itemUuid));
  }

  /**
   * POST /execute-js — targeted use (2026-07-22 combat-targeting): the
   * orchestration in targetedUseScript. SIDE-EFFECTING (damage applied in
   * Foundry) — callers must never auto-retry; a relay 408 means "check the
   * Foundry chat". Same scope/setting requirements as castAtSlot.
   */
  async useAbilityOnTargets(
    actorUuid: string,
    itemUuid: string,
    opts: TargetedUseOptions,
  ): Promise<TargetedUseResult> {
    if (!/^Actor\.[A-Za-z0-9]{1,32}$/.test(actorUuid)) {
      throw new Error(`useAbilityOnTargets: invalid actorUuid "${actorUuid}"`);
    }
    if (!/^Actor\.[A-Za-z0-9]{1,32}\.Item\.[A-Za-z0-9]{1,32}$/.test(itemUuid)) {
      throw new Error(`useAbilityOnTargets: invalid itemUuid "${itemUuid}"`);
    }
    const targets = opts.targetTokenUuids;
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > 12) {
      throw new Error('useAbilityOnTargets: 1-12 targets required');
    }
    for (const t of targets) {
      if (!/^Scene\.[A-Za-z0-9]{1,32}\.Token\.[A-Za-z0-9]{1,32}$/.test(t)) {
        throw new Error(`useAbilityOnTargets: invalid target "${t}"`);
      }
    }
    if (opts.slotKey !== undefined && !/^spell[2-9]$/.test(opts.slotKey)) {
      throw new Error(`useAbilityOnTargets: invalid slotKey "${opts.slotKey}"`);
    }
    if (opts.mode !== undefined && opts.mode !== 'advantage' && opts.mode !== 'disadvantage') {
      throw new Error(`useAbilityOnTargets: invalid mode "${String(opts.mode)}"`);
    }
    const body = await this.executeActivation(targetedUseScript(itemUuid, targets, opts.slotKey, opts.mode));
    const rawAttack = (body as { attack?: unknown }).attack;
    const attack =
      rawAttack !== null && typeof rawAttack === 'object' &&
      typeof (rawAttack as { total?: unknown }).total === 'number'
        ? (rawAttack as TargetedUseResult['attack'])
        : null;
    const rawTargets = (body as { targets?: unknown }).targets;
    return { attack, targets: Array.isArray(rawTargets) ? (rawTargets as TargetedUseTargetResult[]) : [] };
  }

  /** Shared POST + error-normalization for the execute-js activations. */
  private async executeActivation(script: string): Promise<Record<string, unknown>> {
    const body = await this.request<{ result?: unknown; error?: string; success?: boolean }>('POST', '/execute-js', {}, { script });
    if (typeof body.error === 'string' && body.error !== '') {
      throw new RelayError(`relay /execute-js: ${body.error}`, 200, '/execute-js');
    }
    if (body.success === false) {
      throw new RelayError('relay /execute-js: reported failure with no error text', 200, '/execute-js');
    }
    const result = body.result;
    return result !== null && typeof result === 'object' ? (result as Record<string, unknown>) : (body as Record<string, unknown>);
  }

  /** POST /execute-js — advance the combat turn IF the expected combatant is
   *  still acting (race-guard: a stale End-turn can never skip someone else).
   *  Requires execute-js scope + module setting, like castAtSlot. */
  async endCombatTurn(
    expectedCombatantId: string,
  ): Promise<{ advanced: boolean; reason?: string; round?: number; turn?: number }> {
    if (!/^[A-Za-z0-9]{1,32}$/.test(expectedCombatantId)) {
      throw new Error(`endCombatTurn: invalid combatantId "${expectedCombatantId}"`);
    }
    const script = [
      `const combat = game.combat;`,
      `if (!combat || !(combat.round >= 1)) return { advanced: false, reason: 'no-combat' };`,
      `const current = combat.combatant;`,
      `if (!current || current.id !== ${JSON.stringify(expectedCombatantId)}) return { advanced: false, reason: 'not-your-turn' };`,
      `await combat.nextTurn();`,
      `return { advanced: true, round: combat.round, turn: combat.turn };`,
    ].join('\n');
    const body = await this.executeActivation(script);
    const advanced = (body as { advanced?: unknown }).advanced === true;
    const reason = typeof (body as { reason?: unknown }).reason === 'string' ? String((body as { reason?: unknown }).reason) : undefined;
    const round = typeof (body as { round?: unknown }).round === 'number' ? (body as { round: number }).round : undefined;
    const turn = typeof (body as { turn?: unknown }).turn === 'number' ? (body as { turn: number }).turn : undefined;
    return { advanced, ...(reason !== undefined ? { reason } : {}), ...(round !== undefined ? { round } : {}), ...(turn !== undefined ? { turn } : {}) };
  }

  /** POST /execute-js — a plain chat note speaking as the actor (Dash etc.).
   *  Text is sanitized (no angle brackets, ≤100 chars) and JSON.stringified. */
  async postChatNote(actorUuid: string, text: string): Promise<void> {
    if (!/^Actor\.[A-Za-z0-9]{1,32}$/.test(actorUuid)) {
      throw new Error(`postChatNote: invalid actorUuid "${actorUuid}"`);
    }
    const safe = text.replace(/[<>]/g, '').slice(0, 100);
    const script = [
      `const actor = await fromUuid(${JSON.stringify(actorUuid)});`,
      `await ChatMessage.create({ content: ${JSON.stringify(safe)}, speaker: actor ? ChatMessage.getSpeaker({ actor }) : undefined });`,
      `return { ok: true };`,
    ].join('\n');
    await this.executeActivation(script);
  }

  /** POST /execute-js — the PREPARED actor's derived AC. The relay's
   *  get-actor-details stats.ac does not recompute ac.calc overrides (Mage
   *  Armor, 2026-07-22 root-cause), so this reads the live prepared document.
   *  Returns null on ANY failure — callers treat it like a timed-out fetch. */
  async getDerivedAc(actorUuid: string): Promise<number | null> {
    if (!/^Actor\.[A-Za-z0-9]{1,32}$/.test(actorUuid)) return null;
    try {
      const script = [
        `const actor = await fromUuid(${JSON.stringify(actorUuid)});`,
        `const v = actor?.system?.attributes?.ac?.value;`,
        `return { ac: (typeof v === 'number' && Number.isFinite(v)) ? v : null };`,
      ].join('\n');
      const body = await this.executeActivation(script);
      const ac = (body as { ac?: unknown }).ac;
      return typeof ac === 'number' && Number.isFinite(ac) ? ac : null;
    } catch {
      return null;
    }
  }

  /** POST /dnd5e/equip-item — toggle an embedded item's equipped state. */
  async equipItem(actorUuid: string, itemUuid: string, equipped: boolean): Promise<void> {
    await this.request('POST', '/dnd5e/equip-item', {}, { actorUuid, itemUuid, equipped });
  }

  /**
   * POST /dnd5e/attune-item — set an embedded item's attuned state
   * (M12-live-verified). Errors arrive as HTTP 200 bodies with an `error`
   * field, so status alone cannot signal failure.
   */
  async attuneItem(actorUuid: string, itemUuid: string, attuned: boolean): Promise<void> {
    const body = await this.request<{ error?: string }>('POST', '/dnd5e/attune-item', {}, { actorUuid, itemUuid, attuned });
    if (typeof body.error === 'string' && body.error !== '') {
      throw new RelayError(`relay /dnd5e/attune-item: ${body.error}`, 200, '/dnd5e/attune-item');
    }
  }

  /**
   * POST /dnd5e/{short-rest|long-rest|death-save|break-concentration} — an
   * actor-scoped command (no item). M8-verified: `actorUuid` goes in the
   * query, no body needed; Foundry applies the result and posts any card.
   * death-save returns a roll under `data`; the others return a result
   * summary we ignore (the caller re-fetches the sheet).
   */
  async actorCommand(
    endpoint: 'short-rest' | 'long-rest' | 'death-save' | 'break-concentration',
    actorUuid: string,
  ): Promise<Record<string, unknown>> {
    const body = await this.request<{ data?: Record<string, unknown>; error?: string }>(
      'POST',
      `/dnd5e/${endpoint}`,
      { actorUuid },
      {},
    );
    if (typeof body.error === 'string' && body.error !== '') {
      throw new RelayError(`relay /dnd5e/${endpoint}: ${body.error}`, 200, `/dnd5e/${endpoint}`);
    }
    return body.data ?? {};
  }

  /**
   * POST /create — create a WORLD-level entity (not embedded on any actor).
   * Used only as the first leg of the custom-item chain (M23 Task 0
   * findings §Headline plan amendments 5: no embedded-create endpoint
   * exists, so a custom weapon/gear item is created as a scratch world item,
   * then `give`n onto the actor, then `delete`d). Returns the created uuid
   * (`body.uuid`, falling back to `'Item.' + body.entity._id` — both shapes
   * observed live), or null on any failure (never throws — the gateway
   * route treats null exactly like a bounded-timeout miss).
   */
  async createWorldItem(data: Record<string, unknown>): Promise<string | null> {
    try {
      const body = await this.request<{ uuid?: string; entity?: { _id?: string } }>(
        'POST',
        '/create',
        {},
        { entityType: 'Item', data },
      );
      if (typeof body.uuid === 'string' && body.uuid !== '') return body.uuid;
      const id = body.entity?._id;
      return typeof id === 'string' && id !== '' ? `Item.${id}` : null;
    } catch (err) {
      this.cfg.log?.warn({ err }, 'relay POST /create failed; treating as a failed fetch');
      return null;
    }
  }

  /**
   * POST /give — copy an item onto a target actor. `itemUuid` may be ANY
   * uuid Foundry's fromUuid resolves, including compendium uuids
   * (`Compendium.<pack>.Item.<id>`) — that is how "learn spell" works, and
   * (M23) a freshly `create`d world item, for the custom-item chain. Live-
   * verified response shape (M23 Task 0 findings): `{success:true}` on
   * success. Returns a boolean rather than throwing so every caller (the
   * M13 library "add" route and the M23 custom-item chain) can treat a
   * failure uniformly without a try/catch of its own.
   */
  async giveItem(toUuid: string, itemUuid: string): Promise<boolean> {
    try {
      const body = await this.request<{ success?: boolean; error?: string }>('POST', '/give', {}, { toUuid, itemUuid });
      if (body.success === true) return true;
      this.cfg.log?.warn({ toUuid, itemUuid, body }, 'relay POST /give did not report success');
      return false;
    } catch (err) {
      this.cfg.log?.warn({ err, toUuid, itemUuid }, 'relay POST /give failed');
      return false;
    }
  }

  /**
   * DELETE /delete — delete an entity by uuid; embedded item uuids
   * (`Actor.<id>.Item.<id>`) resolve via fromUuid, so this deletes a single
   * item off an actor; a bare `Item.<id>` uuid deletes a world item (M23:
   * the custom-item chain's cleanup step). Returns a boolean rather than
   * throwing — true on success, false on HTTP failure or an applicative
   * `{error}` body (a warning is logged either way) — so every caller can
   * treat a failure uniformly without a try/catch of its own. Some callers
   * (the M23 custom-item chain's cleanup leg) treat this as best-effort and
   * ignore the result; others (the M13 library "remove" route) must surface
   * a `false` as a failed request.
   */
  async deleteEntity(uuid: string): Promise<boolean> {
    try {
      const body = await this.request<{ error?: string }>('DELETE', '/delete', { uuid });
      if (typeof body.error === 'string' && body.error !== '') {
        this.cfg.log?.warn({ uuid, error: body.error }, 'relay DELETE /delete reported an error');
        return false;
      }
      return true;
    } catch (err) {
      this.cfg.log?.warn({ err, uuid }, 'relay DELETE /delete failed');
      return false;
    }
  }

  /**
   * PUT /update — apply a dot-notation update to an entity. The payload is
   * passed straight to Foundry's Document.update(), e.g.
   * `{ "system.attributes.hp.value": 25 }`.
   */
  async updateEntity(uuid: string, data: Record<string, number | string | boolean>): Promise<void> {
    await this.request('PUT', '/update', { uuid }, { data });
  }

  /**
   * PUT /update — create/replace an Active Effect on an actor via the relay's
   * embedded-doc upsert (the effect is upserted by its `_id`). Used to apply
   * buff-spell effects the headless use-flow never applies (2026-07-19; see
   * docs/M-buff-effects-findings.md). Needs only `entity:write` — no
   * execute-js. `effect` is a full AE document (the caller supplies `_id`
   * and flags).
   */
  async applyEffect(actorUuid: string, effect: Record<string, unknown>): Promise<void> {
    await this.request('PUT', '/update', { uuid: actorUuid }, { data: { effects: [effect] } });
  }

  /**
   * GET /hooks/subscribe?hooks=updateActor,… — SSE push of Foundry hook
   * events. This is the live feed that works (M0-verified); a single
   * subscription covers all actors — filter by the document `_id` in
   * `data.args[0]`. Calls `onEvent` for every named event until `signal`
   * aborts or the stream ends. Resolves when the stream closes; the caller
   * owns reconnection.
   */
  async subscribeHooks(hooks: string[], onEvent: (ev: HookEvent) => void, signal: AbortSignal): Promise<void> {
    await this.readSse('/hooks/subscribe', { hooks: hooks.join(',') }, signal, onEvent);
  }

  /**
   * GET /actor/subscribe?actorUuid=… — per-actor SSE subscription.
   * M0 finding: connects but delivers no update events in relay/module
   * 3.4.1 — kept only for re-testing on upgrades. Prefer subscribeHooks.
   */
  async subscribeActor(actorUuid: string, onEvent: (ev: ActorEvent) => void, signal: AbortSignal): Promise<void> {
    await this.readSse('/actor/subscribe', { actorUuid }, signal, (ev) => onEvent({ actorUuid, data: ev.data }));
  }

  private async readSse(
    path: string,
    params: Record<string, string>,
    signal: AbortSignal,
    onEvent: (ev: HookEvent) => void,
  ): Promise<void> {
    const endpoint = this.url(path, params);
    const res = await fetch(endpoint, {
      headers: this.headers({ accept: 'text/event-stream' }),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new RelayError(`relay ${path} -> ${res.status}`, res.status, path);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line
      for (;;) {
        const sep = buffer.indexOf('\n\n');
        if (sep === -1) break;
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = 'message';
        const dataLines: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;
        const raw = dataLines.join('\n');
        let data: unknown = raw;
        try {
          data = JSON.parse(raw);
        } catch {
          /* keep raw string */
        }
        onEvent({ event, data });
      }
    }
  }
}

/**
 * The /get envelope, M0-verified (relay 3.4.1):
 * `{"type":"entity-result","requestId":"…","uuid":"Actor.x","data":{<doc>}}`.
 * The envelope itself carries a top-level `uuid`, so `data` must be checked
 * FIRST — a bare-document fallback is kept for older relays.
 */
export function unwrapEntity(body: Record<string, unknown>): Record<string, unknown> | null {
  if (body === null || typeof body !== 'object') return null;
  for (const key of ['data', 'entity', 'result']) {
    const inner = body[key];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner as Record<string, unknown>;
  }
  if (typeof body._id === 'string') return body;
  return null;
}
