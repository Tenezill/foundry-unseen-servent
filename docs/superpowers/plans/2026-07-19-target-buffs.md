# Target Buffs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a player cast a creature-targeting buff (Bless, Aid, Mage Armor, Shield of Faith) on a chosen target — a combatant in an active encounter, or a party member out of combat — with "Yourself" always one tap away.

**Architecture:** The adapter flags creature-targetable buff casts (`targetable`); the cast intent and `cast-and-apply-effect` relay action carry an optional `targetActorId`; the gateway applies the copied effect to that actor (validated against the current combatants ∪ the party roster) instead of the caster. A new `GET /api/party` feeds the out-of-combat picker; the PWA opens a target-picker sheet before casting.

**Tech Stack:** pnpm workspace, TypeScript strict, vitest, Nuxt 4 / Vue 3 PWA, Fastify gateway, foundryvtt-rest-api module+relay 3.4.1 (pinned), dnd5e 5.3.3 / Foundry v14.

**Spec:** `docs/superpowers/specs/2026-07-19-target-buffs-design.md`
**Builds on:** the shipped self-buff feature (`cast-and-apply-effect`, `applyEffect`, `selfBuffEffect`, flagged removable badges).

## Global Constraints

- Versions pinned (dnd5e 5.3.3, module/relay 3.4.1, Foundry v14) — no bumps.
- No rules engine: targetability is data-shape only; the applied effect is still copied verbatim from the spell item's own effect (self-buff feature). Only the apply *target* is new.
- Buff-apply uses `relay.applyEffect` (PUT /update, `entity:write`) — never execute-js.
- Cross-actor apply is allowed ONLY for a `targetActorId` in the allowed set = current encounter combatants' actorIds ∪ party-roster actorIds (union of all invites). Anything else → `403 FORBIDDEN_RESOURCE`. Absent `targetActorId` = the caster (today's path).
- Self-only buffs (activity `target.affects.type === 'self'`, e.g. Shield) are NOT targetable — they auto-apply to the caster with no picker (unchanged).
- `targetActorId` id format: `^[A-Za-z0-9]{1,32}$`.
- Tests: vitest per package (`pnpm --filter <pkg> exec vitest run` / `... exec tsc --noEmit`). Skip `@companion/bootstrap` typecheck (pre-existing unrelated failure).
- Commit per task, `feat(scope): …`/`test(scope): …`, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`, multi-line via `git commit -F <tempfile>` (Windows). Commit on main; do NOT push (Task 8 live-verify gates the push).

---

### Task 1: SDK types

**Files:**
- Modify: `packages/adapter-sdk/src/index.ts` (ActionDescriptor; ActionIntent cast; RelayAction cast-and-apply-effect)
- Test: none (typecheck gate: `pnpm --filter @companion/adapter-sdk exec tsc --noEmit`)

**Interfaces:**
- Produces: `ActionDescriptor.targetable?: boolean`; ActionIntent cast variant gains `targetActorId?: string`; RelayAction `cast-and-apply-effect` variant gains `targetActorId?: string`.

- [ ] **Step 1: ActionDescriptor.targetable** — add to the interface (near `slotLevels`/`level`):

```ts
  /** cast only: this buff can target another creature — the PWA opens a
   *  target picker before casting (2026-07-19 target buffs). Absent =
   *  self-only or non-buff, cast applies to the caster. */
  targetable?: boolean;
```

- [ ] **Step 2: ActionIntent cast** — the cast variant is currently `{ kind: 'cast'; actionId: string; slotLevel?: number }`. Add `targetActorId`:

```ts
  | { kind: 'cast'; actionId: string; slotLevel?: number; targetActorId?: string }
```

- [ ] **Step 3: RelayAction cast-and-apply-effect** — the variant is currently `{ endpoint: 'cast-and-apply-effect'; use: 'use-spell' | 'cast-at-slot'; itemId: string; slotKey?: string; effect: EffectPayload }`. Add `targetActorId`:

```ts
  | { endpoint: 'cast-and-apply-effect'; use: 'use-spell' | 'cast-at-slot'; itemId: string; slotKey?: string; effect: EffectPayload; targetActorId?: string }
```

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm --filter @companion/adapter-sdk exec tsc --noEmit` → clean.
Commit: `feat(adapter-sdk): types for targeting a buff at another actor`

---

### Task 2: Adapter — targetable flag + threading targetActorId

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts` (`isSelfTargeted` generalization or a new `buffTargetIsSelf`; `buildActions` cast descriptor; `buildAction` cast)
- Test: `packages/adapter-dnd5e/test/actions.test.ts`

**Interfaces:**
- Consumes: Task 1 types; existing `selfBuffEffect`, `firstActivity`/`allActivities`, `getPath`, the cast descriptor push, the `cast-and-apply-effect` return.
- Produces: cast descriptors carry `targetable: true` for creature-targetable buffs; `buildAction` cast threads `intent.targetActorId` into `cast-and-apply-effect`.

- [ ] **Step 1: Failing tests** — append to `actions.test.ts`. Reuse the Task-2 `withShield()` helper pattern from the self-buff tests (a synthetic spell on a `structuredClone(casterCaptured)`); add a targetable variant (a buff whose activity target is NOT self):

```ts
describe('target buffs — targetable flag + targetActorId', () => {
  // Bless-shaped: utility activity, effect applied on use (transfer:false),
  // NO target.affects.type:'self' → creature-targetable.
  function withBless(base = casterCaptured): FoundryActorDoc {
    const actor = structuredClone(base);
    (actor.items as FoundryItemDoc[]).push({
      _id: 'spellBless000001', name: 'Bless', type: 'spell',
      system: {
        level: 1, school: 'enc', prepared: 1, method: 'spell',
        activities: { a1: { type: 'utility', target: { affects: {} } } },
      },
      effects: [{ _id: 'aeBless000000001', name: 'Bless', transfer: false, disabled: false,
        changes: [{ key: 'system.bonuses.abilities.save', mode: 2, value: '+1d4' }] }],
    } as unknown as FoundryItemDoc);
    return actor;
  }
  // Shield-shaped: activity target.affects.type:'self' → self-only, NOT targetable.
  function withShieldSelf(base = casterCaptured): FoundryActorDoc {
    const actor = structuredClone(base);
    (actor.items as FoundryItemDoc[]).push({
      _id: 'spellShieldS0001', name: 'Shield', type: 'spell',
      system: {
        level: 1, school: 'abj', prepared: 1, method: 'spell',
        activities: { a1: { type: 'utility', target: { affects: { type: 'self' } } } },
      },
      effects: [{ _id: 'aeShieldS0000001', name: 'Shield', transfer: false, disabled: false,
        changes: [{ key: 'system.attributes.ac.bonus', mode: 2, value: '+5' }] }],
    } as unknown as FoundryItemDoc);
    return actor;
  }

  it('a creature-targetable buff cast descriptor is flagged targetable', () => {
    expect(action(withBless(), 'spell.spellBless000001.cast').targetable).toBe(true);
  });

  it('a self-only buff (Shield) is NOT targetable', () => {
    expect(action(withShieldSelf(), 'spell.spellShieldS0001.cast').targetable).toBeUndefined();
  });

  it('a non-buff spell is NOT targetable (Guiding Bolt)', () => {
    expect(action(casterCaptured, 'spell.pZMrJb3AXiRYO5E8.cast').targetable).toBeUndefined();
  });

  it('cast with targetActorId threads it into cast-and-apply-effect', () => {
    expect(build(withBless(), { kind: 'cast', actionId: 'spell.spellBless000001.cast', slotLevel: 1, targetActorId: 'TARGETACTOR00001' })).toEqual({
      endpoint: 'cast-and-apply-effect',
      use: 'use-spell',
      itemId: 'spellBless000001',
      effect: {
        name: 'Bless',
        changes: [{ key: 'system.bonuses.abilities.save', mode: 2, value: '+1d4' }],
        origin: 'Actor.pTvtx5dm2AuYqeX2.Item.spellBless000001',
      },
      targetActorId: 'TARGETACTOR00001',
    });
  });

  it('cast without targetActorId omits it (self-apply, unchanged)', () => {
    const a = build(withBless(), { kind: 'cast', actionId: 'spell.spellBless000001.cast', slotLevel: 1 });
    if (a.endpoint !== 'cast-and-apply-effect') throw new Error('expected cast-and-apply-effect');
    expect(a.targetActorId).toBeUndefined();
  });
});
```

(Confirm `casterCaptured._id` is `pTvtx5dm2AuYqeX2` — established in the self-buff feature — and that Bless's effect payload has no `img`/`duration` so the `toEqual` matches; adjust if the fixture differs.)

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @companion/adapter-dnd5e exec vitest run actions.test.ts -t "target buffs"` → FAIL.

- [ ] **Step 3: Generalize self-target detection** — `isSelfTargeted` currently reads `healActivity(item)`. Add a buff-target helper that reads the SAME activity `selfBuffEffect` uses (the first non-transfer effect's owning activity is not tracked; simplest correct read: the item's first activity, since these buffs have one activity). Add near `selfBuffEffect`:

```ts
/** True when a self-buff spell targets only the caster (activity target
 *  `affects.type === 'self'`, e.g. Shield). Such buffs auto-apply to the
 *  caster and are NOT offered a target picker. Buffs that can affect a
 *  chosen creature (Bless, Aid, Mage Armor) return false. */
function buffTargetIsSelf(item: FoundryItemDoc): boolean {
  return getPath(firstActivity(item), 'target.affects.type') === 'self';
}
```

- [ ] **Step 4: buildActions targetable flag** — in the cast descriptor push (the `out.push({ id: `spell.${item._id}.cast`, ... })` block), add after `effectType`:

```ts
          ...(selfBuffEffect(actor, item) !== undefined && !buffTargetIsSelf(item) ? { targetable: true } : {}),
```

- [ ] **Step 5: buildAction cast threading** — in the `cast-and-apply-effect` return inside `buildAction`'s cast case, add the passthrough:

```ts
      if (buff) {
        return {
          endpoint: 'cast-and-apply-effect',
          use: upcast ? 'cast-at-slot' : 'use-spell',
          itemId,
          ...(upcast ? { slotKey: `spell${chosen}` } : {}),
          effect: buff,
          ...(intent.targetActorId !== undefined ? { targetActorId: intent.targetActorId } : {}),
        };
      }
```

- [ ] **Step 6: Run + commit** — full `pnpm --filter @companion/adapter-dnd5e exec vitest run` + `tsc --noEmit` clean. Commit: `feat(adapter-dnd5e): flag creature-targetable buffs and thread targetActorId`

---

### Task 3: Gateway — GET /api/party

**Files:**
- Modify: `apps/gateway/src/app.ts` (new route)
- Modify: `apps/gateway/test/fakes.ts` (ensure FakeRelay.getEntity returns named actors for the test)
- Test: `apps/gateway/test/app.test.ts`

**Interfaces:**
- Consumes: `players` (PlayersPort.list), `relay.getEntity`, existing `adminNameTimeoutMs`-style bounded lookup pattern (see `/api/admin/players`).
- Produces: `GET /api/party` (player auth) → `{ actors: Array<{ id: string; name?: string; img?: string }> }` — the deduped union of all players' actorIds, name/img resolved best-effort (bounded), bare id on miss.

- [ ] **Step 1: Failing test** — in `app.test.ts` (a `party` describe):

```ts
describe('GET /api/party', () => {
  it('returns the deduped union of all players actorIds with resolved names', async () => {
    const { app, relay } = setup(); // setup wires players with actorIds incl. a1 (Anna) and b1 (Bob)
    relay.entities.set('Actor.a1', { name: 'Sariel', img: 'a.png' } as Record<string, unknown>);
    relay.entities.set('Actor.b1', { name: 'Brakk' } as Record<string, unknown>);
    const res = await app.inject({ method: 'GET', url: '/api/party', headers: asAnna });
    expect(res.statusCode).toBe(200);
    const actors = res.json().actors as Array<{ id: string; name?: string; img?: string }>;
    // union of both players, deduped; ids present; names resolved where available
    expect(actors.map((a) => a.id).sort()).toEqual(['a1', 'b1']);
    expect(actors.find((a) => a.id === 'a1')).toMatchObject({ name: 'Sariel', img: 'a.png' });
    expect(actors.find((a) => a.id === 'b1')).toMatchObject({ name: 'Brakk' });
  });

  it('401 without a token', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/api/party' });
    expect(res.statusCode).toBe(401);
  });
});
```

(Check `app.test.ts` for the real player fixtures/headers — `asAnna`, and which actorIds the memoryPlayers set holds — and align the expected ids. The existing `makePlayers()` helper defines them.)

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @companion/gateway exec vitest run app.test.ts -t "party"` → FAIL (404, no route).

- [ ] **Step 3: Implement** — add near `/api/me` (which reads `req.player`). Use the same bounded name-resolution the admin route uses. `players.list()` gives every player:

```ts
  app.get('/api/party', { preHandler: auth(false) }, async (_req, reply) => {
    const ids = [...new Set(deps.players.list().flatMap((p) => p.actorIds))];
    const meta = new Map<string, { name?: string; img?: string }>();
    await Promise.all(
      ids.map(async (id) => {
        try {
          const doc = await Promise.race([
            relay.getEntity(`Actor.${id}`),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), adminNameTimeoutMs)),
          ]);
          if (doc !== null) {
            const entry: { name?: string; img?: string } = {};
            if (typeof doc.name === 'string') entry.name = doc.name;
            if (typeof doc.img === 'string') entry.img = doc.img;
            meta.set(id, entry);
          }
        } catch {
          /* best-effort: unresolved ids render bare */
        }
      }),
    );
    return reply.code(200).send({
      actors: ids.map((id) => ({ id, ...(meta.get(id) ?? {}) })),
    });
  });
```

(If `PlayersPort` exposes `list()` — confirm; the admin route uses `(adminStore as AdminStorePort).list()`. `PlayersPort` at app.ts:43 should have `list()`; if only the admin store does, use `deps.players` if it has list, else reuse the same source the admin route uses. Match whatever the admin route reads.)

- [ ] **Step 4: Run + commit** — `pnpm --filter @companion/gateway exec vitest run` + `tsc --noEmit` clean. Commit: `feat(gateway): GET /api/party roster for the out-of-combat buff target picker`

---

### Task 4: Gateway — apply buff to targetActorId with permission check

**Files:**
- Modify: `apps/gateway/src/app.ts` (`parseActionIntent` cast; `cast-and-apply-effect` execution)
- Modify: `apps/gateway/test/fakes.ts` (fake adapter emits `targetActorId`; encounter combatant helper if needed)
- Test: `apps/gateway/test/app.test.ts`

**Interfaces:**
- Consumes: Task 1 intent/relay-action fields; `encounterManager` (optional), `deps.players`, `relay.applyEffect`.
- Produces: cast intent carries `targetActorId`; `cast-and-apply-effect` applies to `targetActorId ?? casterId`, with a non-self target validated against combatants ∪ party (else 403).

- [ ] **Step 1: Fake adapter + FakeRelay** — in `fakes.ts`, extend the fake adapter's `spell.b1.cast` buildAction to pass through `intent.targetActorId` on its `cast-and-apply-effect` result. Ensure FakeRelay records `applyEffectCalls` with the actorUuid (already added in the buff feature).

- [ ] **Step 2: Failing tests** — in `app.test.ts`:

```ts
  it('cast-and-apply-effect applies to a party targetActorId', async () => {
    const { app, relay } = setup(); // players own a1 (Anna, caster) and b1 (Bob) — both in the party union
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.b1.cast', slotLevel: 1, targetActorId: 'b1' });
    expect(res.statusCode).toBe(200);
    expect(relay.applyEffectCalls.at(-1)!.actorUuid).toBe('Actor.b1');
  });

  it('a targetActorId outside combat + party is refused 403', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.b1.cast', slotLevel: 1, targetActorId: 'STRANGERACTORXX' });
    expect(res.statusCode).toBe(403);
    expect(relay.applyEffectCalls.every((c) => c.actorUuid !== 'Actor.STRANGERACTORXX')).toBe(true);
  });

  it('no targetActorId applies to the caster', async () => {
    const { app, relay } = setup();
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.b1.cast', slotLevel: 1 });
    expect(res.statusCode).toBe(200);
    expect(relay.applyEffectCalls.at(-1)!.actorUuid).toBe('Actor.a1');
  });

  it('rejects a malformed targetActorId (422)', async () => {
    const { app } = setup();
    const res = await post(app, 'a1', { kind: 'cast', actionId: 'spell.b1.cast', slotLevel: 1, targetActorId: 'bad id!' });
    expect(res.statusCode).toBe(422);
  });
```

- [ ] **Step 3: parseActionIntent cast** — extend the cast case to accept `targetActorId`:

```ts
    case 'cast': {
      if (body.slotLevel !== undefined && (typeof body.slotLevel !== 'number' || !Number.isInteger(body.slotLevel) || body.slotLevel < 0)) {
        return null;
      }
      if (body.targetActorId !== undefined && (typeof body.targetActorId !== 'string' || !/^[A-Za-z0-9]{1,32}$/.test(body.targetActorId))) {
        return null;
      }
      return {
        kind, actionId,
        ...(body.slotLevel !== undefined ? { slotLevel: body.slotLevel } : {}),
        ...(body.targetActorId !== undefined ? { targetActorId: body.targetActorId } : {}),
      };
    }
```

(Read the CURRENT cast case in `parseActionIntent` first and merge — keep its existing slotLevel handling.)

- [ ] **Step 4: cast-and-apply-effect target + permission** — in the execution switch's `cast-and-apply-effect` case, resolve and validate the target before `applyEffect`. Add a helper near the route:

```ts
/** actor ids a player may drop a buff on: the caster is always allowed;
 *  otherwise the target must be a current combatant or a party member. */
function buffTargetAllowed(targetId: string, casterId: string, deps: GatewayDeps): boolean {
  if (targetId === casterId) return true;
  const party = new Set(deps.players.list().flatMap((p) => p.actorIds));
  if (party.has(targetId)) return true;
  const combatIds = new Set(
    (deps.encounters?.view().combatants ?? [])
      .map((c) => c.actorId)
      .filter((a): a is string => typeof a === 'string'),
  );
  return combatIds.has(targetId);
}
```

Then in the case (after activation, before `applyEffect`):

```ts
          const targetId = action.targetActorId ?? id;
          if (!buffTargetAllowed(targetId, id, deps)) {
            return sendError(reply, 403, 'FORBIDDEN_RESOURCE', 'cannot target that actor');
          }
          await relay.applyEffect(`Actor.${targetId}`, {
            _id: mintEffectId(),
            ...action.effect,
            flags: { 'unseen-servent': { appliedBy: 'app' } },
          });
```

(Replace the existing `applyEffect(`Actor.${id}`, …)` line. `deps` is in scope in `buildApp`; if not directly, capture `players`/`encounterManager` the way the surrounding code already does — match existing access. `EncounterManagerPort.view()` returns the `EncounterView` with `combatants`; confirm the shape exposes `actorId` — `EncounterCombatantView.actorId`.)

- [ ] **Step 5: Run + commit** — `pnpm --filter @companion/gateway exec vitest run` + `tsc --noEmit` clean. Commit: `feat(gateway): apply buffs to a validated target actor (combatants + party)`

---

### Task 5: PWA — target picker sheet + cast flow

**Files:**
- Create: `apps/web/app/components/TargetPickerSheet.vue`
- Modify: `apps/web/app/pages/actor/[id].vue` (open the picker for targetable casts; party fetch; wire submit)
- Modify: `apps/web/app/types/api.ts` (party response type)
- Test: none (typecheck gate + Task 8 live-verify)

**Interfaces:**
- Consumes: Task 1 `ActionDescriptor.targetable`, cast `targetActorId`; `EncounterView`/`EncounterCombatantView` (existing); new `GET /api/party`.
- Produces: a picker that yields `targetActorId | 'self'`; `[id].vue` opens it before casting a targetable spell.

- [ ] **Step 1: Party response type** — in `apps/web/app/types/api.ts`:

```ts
/** GET /api/party — roster for the out-of-combat buff target picker. */
export interface PartyView {
  actors: Array<{ id: string; name?: string; img?: string }>
}
```

- [ ] **Step 2: TargetPickerSheet.vue** (new). Props: the caster's name, an `encounter: EncounterView | null`, and a `party: PartyView | null`. Emits `('pick', targetActorId: string | null)` (null = self) and `('close')`. Renders "Yourself" pinned first, then either encounter combatants (when `encounter?.active`) or party actors. Combatants without `actorId` render disabled.

```vue
<template>
  <div class="scrim" @click.self="emit('close')">
    <div class="modal-sheet" role="dialog" aria-modal="true" aria-label="Choose a target">
      <div class="head"><span class="title">Cast on…</span></div>
      <div class="list card">
        <button class="row self" type="button" @click="emit('pick', null)">
          <span class="row-label">Yourself</span>
        </button>
        <template v-if="encounter?.active">
          <button v-for="c in encounter.combatants ?? []" :key="c.id" class="row" type="button"
                  :disabled="!c.actorId" @click="c.actorId && emit('pick', c.actorId)">
            <ActorAvatar :name="c.name" :img="foundryImgUrl(c.img, foundryBase)" :size="36" />
            <span class="row-label" :class="{ strike: c.defeated }">{{ c.name }}</span>
          </button>
        </template>
        <template v-else>
          <button v-for="a in party?.actors ?? []" :key="a.id" class="row" type="button"
                  @click="emit('pick', a.id)">
            <ActorAvatar :name="a.name ?? a.id" :img="foundryImgUrl(a.img, foundryBase)" :size="36" />
            <span class="row-label">{{ a.name ?? a.id }}</span>
          </button>
          <p v-if="!party" class="empty-hint">Loading party…</p>
        </template>
      </div>
      <button class="cancel" type="button" @click="emit('close')">Cancel</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { EncounterView, PartyView } from '~/types/api'
defineProps<{ encounter: EncounterView | null; party: PartyView | null }>()
const emit = defineEmits<{ (e: 'pick', targetActorId: string | null): void; (e: 'close'): void }>()
const config = useRuntimeConfig()
const foundryBase = String(config.public.foundryBase || '')
</script>
```

(Reuse the modal/scrim + `.row`/`.card` styling conventions from `CombatantHpSheet.vue`/`ActionSheet.vue`; copy the minimal CSS. `foundryImgUrl` is the existing util.)

- [ ] **Step 3: [id].vue wiring** — state + flow:
  - `const targetPickerFor = ref<string | null>(null)` (holds the cast actionId while picking).
  - `const party = ref<PartyView | null>(null)`; a lazy `loadParty()` that `GET /api/party` once (cache).
  - In `onCombatAction`/`onAction` cast handling: if the descriptor has `targetable`, set `targetPickerFor.value = actionId` (and if no active encounter, call `loadParty()`), instead of casting/opening the slot picker immediately.
  - Render `<TargetPickerSheet v-if="targetPickerFor" :encounter="..." :party="party" @pick="onTargetPick" @close="targetPickerFor = null" />`. Source the encounter from wherever the Encounter tab already holds it (the SSE `/api/encounter/events` state); if the actor page doesn't already hold encounter state, fetch `GET /api/encounter` in `loadParty`'s sibling `loadEncounter()` when opening the picker.
  - `onTargetPick(targetActorId: string | null)`: close the picker; then if the descriptor also has `slotLevels?.length > 1`, open the existing slot picker carrying the chosen target; else `submitAction({ kind: 'cast', actionId, ...(targetActorId ? { targetActorId } : {}) }, label)`. Thread `targetActorId` through the slot-picker path too.
  - Toast on success: include the target name when known.

- [ ] **Step 4: Typecheck + commit** — `pnpm --filter @companion/web exec nuxt typecheck` (or the repo's web typecheck script) → clean. Commit: `feat(web): target picker for creature-targeting buffs`

---

### Task 6: Mock gateway parity

**Files:**
- Modify: `apps/web/mock/server.mjs`

**Interfaces:**
- Produces: a targetable buff on Sariel; `GET /api/party` stub; cast honoring `targetActorId`.

- [ ] **Step 1: Implement** —
  - Add a targetable buff spell to Sariel, e.g. `{ id: 's-bless', label: 'Bless', sub: '1st · V,S,M', level: 1, effectType: 'utility', buff: { name: 'Bless', ac: 0 }, targetable: true }`; in `buildActions` set `targetable: true` on its cast descriptor when the spell def has `targetable`.
  - Add a `GET /api/party` handler returning `{ actors: [{ id: 'a-sariel', name: 'Sariel Dawnwhisper' }, { id: 'a-brakk', name: 'Brakk Ironhide' }] }` (the two mock actors).
  - Cast handler: accept optional `targetActorId`; when it equals the current mock actor (or is omitted → self) push the Bless condition on the sheet as today; when it names the OTHER mock actor, just 200 (the mock only renders one actor's sheet — acknowledge without mutating the other). Keep it simple; the point is the picker + request shape are exercisable offline.

- [ ] **Step 2: Smoke** — `node apps/web/mock/server.mjs`; `curl GET /api/party` → the two actors; `curl POST …/actions {kind:'cast',actionId:'spell.s-bless.cast',slotLevel:1,targetActorId:'a-sariel'}` → 200. Kill the server; paste output in the report.

- [ ] **Step 3: Commit** — `feat(mock): targetable buff + /api/party for offline target-picker dev`

---

### Task 7: Docs

**Files:**
- Modify: `docs/API.md` (document `GET /api/party` + the cast `targetActorId` field), if that file documents the API surface.

- [ ] **Step 1:** Add `GET /api/party` (response shape) and note the cast action's optional `targetActorId` (+ the combatants∪party permission rule) wherever the actions/encounter endpoints are documented. If `docs/API.md` doesn't exist or isn't the right home, add a short note to `docs/HOSTING.md` or the relevant runbook instead. Read the file first to match its style.
- [ ] **Step 2: Commit** — `docs: /api/party + targetActorId on cast`

---

### Task 8: Live verification (before push)

**Files:** none (drive the real stack; screenshots to the session scratchpad, NOT the repo).

- [ ] **Step 1:** Deploy the branch (operator `make update`) and confirm health + world online.
- [ ] **Step 2:** In an active encounter, cast a targetable buff (Bless/Aid) from the PWA on ANOTHER PC → verify the effect lands on that PC's sheet (badge + bonus) and, for a bonus that moves a visible stat, that it changed. Cast on a monster combatant → verify (via a read-only relay probe) the effect is on the monster's actor.
- [ ] **Step 3:** Out of combat, cast a targetable buff → the party roster picker appears; cast on a party member → lands on their sheet.
- [ ] **Step 4:** "Yourself" → applies to the caster. Confirm a `targetActorId` outside the party+combat set is refused (403 → the PWA's "not available" toast).
- [ ] **Step 5:** Report ready-to-push (do NOT push without the user's word).

---

## Self-review notes
- Spec coverage: SDK types (T1), targetable detection + threading (T2), party roster (T3), targeted apply + permission (T4), picker UI + flow (T5), mock (T6), docs (T7), live-verify incl. monster + out-of-combat + 403 (T8). Out-of-scope items (cross-target removal, monster roster out of combat, multi-target) implemented nowhere. ✓
- Type consistency: `targetable` (T1) set in T2, read in T5; cast `targetActorId` (T1) parsed in T4, threaded in T2, sent in T5; `cast-and-apply-effect.targetActorId` (T1) produced in T2, consumed in T4; `PartyView` (T5 types) produced by T3, consumed in T5/T6. ✓
- Anchor by symbol names; verify `deps.players.list()` and `deps.encounters?.view()` shapes against app.ts before T3/T4 (the admin route and encounter routes show the real accessors).
