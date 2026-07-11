# Encounters (M22) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Foundry encounter runs, every player's PWA shows a live initiative carousel + a COMBAT tab with the combatant list, and players apply damage/healing to any combatant themselves (temp-HP rules included); NPCs show health states, never numbers.

**Architecture:** A gateway `EncounterManager` subscribes to the relay's combat hooks over SSE (live-verified in Task 0: `updateCombat` frames carry the full combatant array), seeds initial state via the scope-gated `GET /encounters` (new relay key with `encounter:read`), caches combatant actor docs (bounded fetches) to derive server-side health states, and fans out to players via a new `/api/encounter/events` SSE route. HP writes go through the existing dnd5e adapter `buildUpdate` (M20 temp-HP absorption for free) with encounter-scoped authorization. The web app adds an `InitiativeCarousel` above the tab bar and a transient COMBAT tab.

**Tech Stack:** Existing stack (Fastify gateway, foundry-client SSE reader, Nuxt web). No new deps.

**Spec:** `docs/superpowers/specs/2026-07-11-encounters-design.md`
**Task 0 findings (READ FIRST — shapes and verdicts):** `docs/superpowers/specs/2026-07-11-encounters-task0-findings.md`

## Global Constraints

- **Exact NPC HP must never reach player clients in any payload** — health-state derivation is server-side; tests assert the serialized JSON contains no `hp` key for non-`character` combatants. PC combatants (`actor.type === 'character'`) carry exact `hp {value,max}`.
- Health states: `down` (value ≤ 0), `bloodied` (< 50% of max), `wounded` (< 100%), `healthy` (= max). `max ≤ 0` ⇒ `down` (bare NPCs are 0/0 per Task 0).
- Hidden combatants (`hidden: true`) are dropped from player payloads — but the current-turn mapping is computed BEFORE the filter, so the turn pointer stays correct when the acting combatant is hidden (then points at a combatant the player can't see: serialize `turn: { combatantId: null }` in that case).
- Encounter is "active" iff a combat doc is present AND `round >= 1` (Task 0: the doc's `active` flag is false even mid-combat for tokenless combats — do not key on it).
- Every relay await in the encounter path is bounded (M18 pattern) — a stalled relay call degrades, never hangs a route or the manager.
- HP write authorization: valid player token AND active encounter AND `:id` is a combatant in it. Combatant without `actorId` → 422. Writes reuse `adapter.buildUpdate` with a `{kind:'delta', resourceId:'hp', amount}` intent → `relay.updateEntity` — never hand-roll HP math (M20 owns temp-HP semantics). Writes count against the existing `limiter` keyed by `player.tokenHash`.
- Hook subscription for combat: `['updateCombat','createCombat','deleteCombat','createCombatant','updateCombatant','deleteCombatant','updateActor']` (own stream, own backoff — LiveManager's stream stays untouched).
- Strict TS both packages, ESM `.js` suffixes, gateway typecheck is a hard gate. Test commands as in prior milestones; current baseline 408 tests green (293 adapter + 112 gateway + 3 client).
- Commit per task, trailer:

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

### Task 1: Mint an `encounter:read` relay key (operational, live)

No code. The relay enforces per-key scopes; the current key lacks `encounter:read` (Task 0 §1).

- [ ] 1. Read `docs/M10-findings.md` + `docs/LLM-SETUP-RUNBOOK.md` Phase 4 for the key-minting flow. Credentials: `RELAY_ACCOUNT_EMAIL`/`RELAY_ACCOUNT_PASSWORD` in `stack/.env`. Relay web UI at `http://localhost:3010` (admin panel `/admin`, 15-min idle JWT). Mind the auth throttle (~20 req/15 min per IP; on 429 restart the relay container and retry within ~15 s).
- [ ] 2. Mint a NEW key with exactly the existing scopes + `encounter:read`: `entity:read, entity:write, search, events:subscribe, clients:read, encounter:read`. Do NOT add `encounter:manage` (v1 non-goal: the GM drives combat in Foundry).
- [ ] 3. Update `RELAY_API_KEY` in `apps/gateway/.env` AND `stack/.env.gateway` (never print the key). Restart the host gateway.
- [ ] 4. Verify live: `GET http://localhost:3010/encounters?clientId=<id>` with the new key → 200 (empty list is fine); `GET /get?uuid=Actor.zteTG9PZZ6XQpQtK` still 200 (old scopes intact); gateway `/healthz` relay:connected.
- [ ] 5. Record the scope list + verification output in the ledger. Nothing to commit (env files are git-ignored).

---

### Task 2: foundry-client `getEncounters()`

**Files:**
- Modify: `packages/foundry-client/src/index.ts`
- Test: `packages/foundry-client/test/client.test.ts` (existing file — follow its idiom)

**Interfaces:**
- Produces (Task 3 consumes):

```ts
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

/** GET /encounters — active/all combats (requires encounter:read scope). */
async getEncounters(): Promise<RelayEncounter[]>
```

- [ ] **Step 1: Failing test** — mirror the existing tests' fetch-mock idiom; response envelope per Task 0 §2a: `{type:'encounters-result', requestId, encounters:[...]}`; assert URL path `/encounters`, clientId param, api-key header, and that the method returns the `encounters` array (empty array when the field is missing/null).
- [ ] **Step 2: RED**, **Step 3: implement** (`this.url('/encounters', {})`, GET with `this.headers()`, parse envelope, `return Array.isArray(body.encounters) ? body.encounters : []`), **Step 4: GREEN** (`pnpm --filter @companion/foundry-client test`), full client typecheck if script exists.
- [ ] **Step 5: Commit** `feat(client): getEncounters — relay combat read (encounter:read scope)`

---

### Task 3: Gateway — EncounterManager + routes

**Files:**
- Create: `apps/gateway/src/encounters.ts`
- Modify: `apps/gateway/src/app.ts` (RelayPort + deps + 3 routes), `apps/gateway/src/server.ts` (wire manager lifecycle)
- Modify: `apps/gateway/test/fakes.ts` (FakeRelay: `getEncounters`, `emitUpdateCombat`, `emitDeleteCombat`)
- Test: `apps/gateway/test/encounters.test.ts` (new)

**Interfaces:**
- Consumes: `RelayEncounter`/`RelayCombatant` (Task 2); `adapter.buildUpdate` + `IntentError` (existing); hook-frame shape (Task 0 §2b: `data.data.args[0]` = full Combat doc with `combatants[]` carrying `_id, actorId, initiative, defeated, hidden, img, tokenId`).
- Produces (Task 4 consumes):
  - `GET /api/encounter` (bearer player token) → `EncounterView`:

```ts
interface EncounterCombatantView {
  id: string;
  actorId?: string;
  name: string;
  img?: string;
  initiative: number | null;
  isPC: boolean;
  defeated: boolean;
  health?: 'healthy' | 'wounded' | 'bloodied' | 'down'; // NPCs only
  hp?: { value: number; max: number };                   // PCs only
}
interface EncounterView {
  active: boolean;
  round?: number;
  turn?: { combatantId: string | null };
  combatants?: EncounterCombatantView[]; // initiative desc, hidden dropped
}
```

  - `GET /api/encounter/events?token=` — SSE, `event: encounter` frames of `EncounterView` (initial + on every change), `ping` keep-alives (reuse the actor-events route pattern verbatim: hijack, headers, sseCleanups, close/error cleanup, destroyed-race guard — `app.ts:1001-1059` is the template).
  - `POST /api/encounter/combatants/:id/hp` body `{ kind: 'delta', amount: number }` → 200 `{ encounter: EncounterView }`; 409 `CONFLICT` no active encounter; 404 unknown combatant; 422 `INVALID_INTENT` malformed body or combatant without actorId; 429 via existing limiter.

**EncounterManager design (implement in `encounters.ts`):**

```ts
export interface EncounterDeps {
  relay: {
    getEncounters(): Promise<RelayEncounter[]>;
    getEntity(uuid: string): Promise<Record<string, unknown> | null>;
    subscribeHooks(hooks: string[], onEvent: (ev: { event: string; data: unknown }) => void, signal: AbortSignal): Promise<void>;
  };
  /** Bound every relay await (M18 pattern). Default 3000. */
  fetchTimeoutMs?: number;
  reconnectMinMs?: number; // default 1000
  reconnectMaxMs?: number; // default 30000
  log?: { warn(obj: object, msg: string): void };
}
```

- `start()`: seed state via bounded `getEncounters()` (pick the entry with `current === true`, else the single entry with `round >= 1`, else none) then run a subscribe loop on `COMBAT_HOOKS` (list in Global Constraints) with exponential backoff (copy LiveManager's loop shape — its stream is private, and coupling the two managers isn't worth the surgery; note the deliberate duplication in a comment).
- Hook handling: `updateCombat`/`createCombat` → replace cached combat doc from `args[0]` (normalize hook combatants `{_id, actorId, ...}` and REST combatants `{id, actorUuid, ...}` into ONE internal shape; actorId from REST = `actorUuid.split('.').pop()` when it starts with `Actor.`); `deleteCombat` → clear when `args[0]._id` matches; `createCombatant`/`updateCombatant`/`deleteCombatant` → re-seed via bounded `getEncounters()` (frames carry the combatant, not the whole combat — a full re-read is simpler and rare); `updateActor` → if `args[0]._id` is a cached combatant actor, update the actor cache from the frame (it carries the full doc — no extra fetch) and re-emit.
- Actor cache: `Map<actorId, {type: string, hp: {value: number, max: number}}>` built with bounded `getEntity('Actor.'+actorId)` for combatants not yet cached; a timed-out/failed fetch stores `undefined` → combatant serialized with `isPC: false, health: 'healthy'` and a warn log (degrade, never block).
- `view(): EncounterView` — serialization per Global Constraints: sort initiative desc (nulls last, stable), compute turn pointer from the doc's `turn` index against the sorted-unfiltered list, then drop hidden, then per-combatant: `isPC = cached.type === 'character'`; PCs get `hp`, non-PCs get `health` — never both, never `hp` on a non-PC.
- `attach(send: (view: EncounterView) => void): () => void` — LiveManager.attach idiom; every state change emits to all attached.
- `stop()` aborts the loop.

**Routes (app.ts):** GET snapshot; SSE per the template; the hp POST:

```ts
// authorization: any valid player token + active encounter + combatant in it
if (!limiter.allow(player.tokenHash)) return sendError(reply, 429, 'RATE_LIMITED', 'too many write intents');
const target = encounters.combatant(req.params.id);       // manager lookup
if (!encounters.isActive()) return sendError(reply, 409, 'CONFLICT', 'no active encounter');
if (!target) return sendError(reply, 404, 'NOT_FOUND', 'not found');
if (!target.actorId) return sendError(reply, 422, 'INVALID_INTENT', 'combatant has no linked actor');
// body: kind must be 'delta', amount finite non-zero number → else 422
const actor = await fetchActorByUuid(`Actor.${target.actorId}`);   // bounded; reuse fetchActor if id-based works
// adapter via adapterFor(actor); buildUpdate({kind:'delta', resourceId:'hp', amount}) with the existing IntentError catch → updateEntity → manager.refreshActor(target.actorId) → 200 {encounter: manager.view()}
```

`GatewayDeps` gains `encounters?: EncounterManagerPort` (interface with `isActive/combatant/view/attach/refreshActor`) — tests inject a real manager over FakeRelay; when absent the routes 404 (feature requires wiring). `server.ts` constructs it with the real relay, `start()` after listen, `stop()` in close.

**FakeRelay additions (fakes.ts):** `encounters: RelayEncounter[] = []` + `async getEncounters()` returning a structuredClone; `emitUpdateCombat(combatDoc: Record<string, unknown>)` and `emitDeleteCombat(id: string)` pushing `{event: 'updateCombat'|'deleteCombat', data: {data: {args: [combatDoc, {}, {}, 'gm']}}}` to `hookSubscribers` (mirror `emitUpdateActor`).

- [ ] **Step 1: failing tests** (`encounters.test.ts`) — build the app with a manager over FakeRelay; drive state via `emitUpdateCombat` with a doc shaped exactly like Task 0 §2b (two PC combatants + add an NPC actor `n1` to `relay.entities` with hp 8/30 → expect `health: 'bloodied'`). Cover, at minimum:
  - inactive: GET → `{active:false}`; POST → 409.
  - active: PC combatants carry exact `hp`; the NPC carries `health` and the raw response body string contains no `"hp"` within the NPC combatant (assert via parsed object: `expect(npc.hp).toBeUndefined()` AND `expect(npc.health).toBe('bloodied')`; plus a JSON.stringify scan that `"value":30`-style NPC numbers are absent).
  - state thresholds incl. 0/0 → `down`; hidden combatant dropped; hidden acting combatant → `turn.combatantId === null`; initiative-desc ordering; turn pointer correct.
  - hp write: −5 on a temp-carrying PC hits `relay.updates` with temp-first paths (M20); unknown combatant 404; no-actor combatant 422; malformed body 422; limiter 429 (rateLimitMax override, like existing tests).
  - SSE: inject, read initial `encounter` frame; `emitUpdateCombat` → second frame (follow the existing events-route test idiom in app.test.ts if one exists; otherwise test manager.attach directly + route smoke via inject with `payloadAsStream`).
  - never-settling `getEntity` for one actor: view still renders (bounded), combatant degrades.
- [ ] **Step 2 RED → Step 3 implement → Step 4 GREEN** — full gateway suite + typecheck.
- [ ] **Step 5: Commit** `feat(gateway): encounter mirror + combatant hp writes`

---

### Task 4: Web — carousel, COMBAT tab, damage sheet

**Files:**
- Create: `apps/web/app/components/InitiativeCarousel.vue`, `apps/web/app/components/CombatantList.vue`
- Modify: `apps/web/app/pages/actor/[id].vue`, `apps/web/app/types/api.ts`

**Contracts (adapt visuals to the Gilded Tome conventions; these behaviors are binding):**
- `types/api.ts`: mirror `EncounterView`/`EncounterCombatantView` from Task 3.
- Second EventSource `${base}/api/encounter/events?token=…` managed exactly like the sheet stream (`[id].vue:931-984` is the template): connect on mount when online, exponential backoff, close on unmount; frames update `encounter = ref<EncounterView>`. An `active:false` frame (or stream loss) hides all combat UI.
- **InitiativeCarousel** renders above the tab bar whenever `encounter.active`: current combatant + next 4 (wrap around the initiative-desc list, skip nothing else), as `ActorAvatar` medallions with name + initiative badge; ring highlight on the current turn; the viewing player's own combatant (`combatant.actorId === actorId` route param) subtly marked; NPC medallions tinted by `health` (reuse the theme's garnet/gold ramp), PCs show a small `hp.value/hp.max` caption; round number chip.
- **COMBAT tab**: transient `TabId 'combat'` appended to the tabs computed only while active (the existing `tabs.some` fallback in `[id].vue` already handles it vanishing mid-view). Tab content = `CombatantList`: initiative-ordered rows (icon, name, initiative, health state or exact HP, `defeated` strikethrough). Tapping a row (unless offline) opens the damage/heal sheet: reuse the `HpNumpad` component pattern (Damage/Heal modes) targeting the combatant; submit → `POST /api/encounter/combatants/:id/hp` `{kind:'delta', amount: <signed>}` → update `encounter` from the response, toast `"7 dmg → Goblin 2"` / `"5 heal → Akra"`; error → standard toast, sheet stays.
- Offline: carousel hidden; COMBAT tab shows last state read-only (no tap targets), standard offline treatment.
- Gates: `pnpm --filter @companion/web typecheck`; visual smoke against the dev stack with a synthetic combat (see Task 5 setup — the implementer may create/delete one via the GM tab console, restoring baseline after).

- [ ] Implement per contracts; commit `feat(web): initiative carousel + combat tab with player-applied damage`

---

### Task 5: Live verification + docs (coordinator-led)

- [ ] 1. Docs: API.md gains the three encounter endpoints (shapes from Task 3) + the NPC-health-privacy contract. Commit `docs: encounter API (M22)`.
- [ ] 2. Live setup via the GM tab console: create 2 NPC actors with real HP (`await Actor.create({name:'Goblin 1', type:'npc', system:{attributes:{hp:{value:12, max:12}}}})`, `Goblin 2` likewise), then `const c = await Combat.create({}); await c.createEmbeddedDocuments('Combatant', [{actorId:'<randal>'},{actorId:'<akra>'},{actorId:'<goblin1>'},{actorId:'<goblin2>'}]); await c.rollAll(); await c.startCombat();`
- [ ] 3. Checklist: carousel + COMBAT tab appear on the player PWA within ~2 s; order matches Foundry's tracker; `nextTurn()` in the GM tab advances the carousel live; damage Goblin 1 to < 50% from the PWA → state flips to bloodied for the player AND exact HP visible nowhere in any /api/encounter payload (curl the endpoint and grep); heal Akra (exact HP updates; temp-HP rule on damage against Randal's +2 temp); defeat a goblin (0 HP → down + Foundry marks); `deleteCombat` → UI vanishes; offline behavior.
- [ ] 4. Cleanup: delete the combat + both goblins; verify two-PC baseline; record everything in the ledger.

---

## Self-Review (done at plan-writing time)

- **Spec coverage:** carousel + transient tab → Task 4; player-applied damage to any combatant w/ temp-HP → Task 3 (adapter reuse) + Task 4; NPC health states server-side, exact HP never serialized → Task 3 manager + tests + Task 5 curl check; live updates → hooks SSE (Task 0-verified) + `/api/encounter/events`; feasibility gate → Task 0 done (findings committed), scope escalation → Task 1 (`encounter:read` only, `manage` deliberately excluded); error handling (409/404/422, bounded relay awaits, degrade-not-block) → Task 3; offline → Task 4; unlinked tokens → v1 writes target `Actor.<actorId>`, combatants without actorId 422 (findings §5 say the payload can't distinguish linked/unlinked — recorded limitation, follow-up spike if token-override stats ever matter).
- **Placeholder scan:** clean — operational Task 1 and coordinator Task 5 are step-scripted; code tasks carry contracts + exact shapes, with the two deliberate adapt-to-conventions latitudes (Task 4 visuals, Task 3 SSE test idiom) named explicitly.
- **Type consistency:** `EncounterView`/`EncounterCombatantView` identical in Task 3 (gateway), Task 4 (web types); `RelayEncounter`/`RelayCombatant` from Task 2 consumed by Task 3's deps; hook-frame path `data.data.args[0]` consistent with fakes' `emitUpdateActor` nesting and Task 0's capture.
