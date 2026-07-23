# Targeted Cast Out-of-Uses Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Casting/using a limited-use ability (e.g. a free-use spell that's out of uses) *at a target* must return a friendly "no uses remaining" (422) instead of the raw 502 "upstream error", and the Actions-tab row must show the uses counter so the player sees it's spent.

**Root cause (diagnosed live 2026-07-23):** The adapter's `use-on-targets` branches (`case 'cast'` and `case 'use'`) return before any uses check, so an exhausted ability reaches Foundry; `activity.use(..., {configure:false})` returns falsy; `targetedUseScript` throws `'use could not be performed'` → relay 400 → gateway 502. The non-targeted paths already guard with `assertUsesRemaining` (`packages/adapter-dnd5e/src/index.ts:2048`); the targeted paths skip it. Separately, the Actions-tab cast descriptor carries no uses info (only the Spells-tab list row shows it via a resource), so the player can't see 0/1 before tapping.

**Tech Stack:** TypeScript pnpm workspace, Vitest, Fastify (gateway), Nuxt/Vue 3 (web).

## Global Constraints

- `assertUsesRemaining(item)` is a no-op when the item has no limited uses (`usesInfo` undefined) — safe to call unconditionally where an item is in scope.
- Friendly rejection uses the existing envelope: adapter throws `IntentError(..., 'INVALID')`; the gateway maps INVALID → HTTP **422 / `INVALID_INTENT`** (codebase convention — NOT 400).
- Do not change the non-targeted paths (they already guard). Do not weaken the 408-timeout tolerance.
- Test/typecheck: `pnpm --filter @companion/adapter-dnd5e test`, `pnpm --filter @companion/gateway test`, `pnpm --filter @companion/web typecheck`; typecheck `@companion/adapter-sdk` too.
- Every commit ends with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Branch: `fix/targeted-cast-out-of-uses` (already created off main@4e4e884).

---

### Task 1: Core — friendly 422 instead of 502 on an exhausted targeted cast/use

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts` (`buildAction`: the `use-on-targets` returns in `case 'cast'` and `case 'use'`)
- Modify: `apps/gateway/src/app.ts` (`use-on-targets` catch backstop + a small `isUsePerformFailure` helper near `isRelayTimeout:501`)
- Modify: `apps/gateway/test/fakes.ts` (a flag to make `FakeRelay.useAbilityOnTargets` throw the perform-failure RelayError)
- Test: `packages/adapter-dnd5e/test/actions.test.ts`, `apps/gateway/test/app.test.ts`

**Interfaces:**
- Consumes: `assertUsesRemaining(item)` (`index.ts:2048`), `usesInfo`, `IntentError`, `isRelayTimeout` (`app.ts:501`), `sendError`.
- Produces: `isUsePerformFailure(err): boolean` in `app.ts`.

- [ ] **Step 1: Adapter failing test.** Add to `packages/adapter-dnd5e/test/actions.test.ts` a block that mutates a spell into a free-use, exhausted, heal spell and casts it at a target:

```ts
describe('targeted cast — out of uses', () => {
  function exhaustedFreeUseHealActor(): FoundryActorDoc {
    const a = structuredClone(caster);
    const spell = (a.items ?? []).find((i) => i.type === 'spell');
    if (!spell) throw new Error('fixture has no spell');
    (spell.system as Record<string, unknown>).method = 'atwill';
    (spell.system as Record<string, unknown>).uses = { max: 1, spent: 1 };
    (spell.system as Record<string, unknown>).activities = {
      a0: { _id: 'a0', type: 'heal', healing: { number: 1, denomination: 4, bonus: '@mod', types: ['healing'] } },
    };
    return { actor: a, id: spell._id };
  }

  it('rejects a targeted cast of an exhausted free-use spell with INVALID', () => {
    const { actor, id } = exhaustedFreeUseHealActor() as unknown as { actor: FoundryActorDoc; id: string };
    let code: string | undefined;
    try {
      build(actor, { kind: 'cast', actionId: `spell.${id}.cast`, targetTokenUuids: ['Scene.s.Token.t'] });
    } catch (e) {
      code = (e as InstanceType<typeof IntentError>).code;
    }
    expect(code).toBe('INVALID');
  });
});
```

Note: adjust the helper's return-shape access to match the file's style (the block above returns `{actor,id}`; simplify to two locals if cleaner). If `caster`'s first spell has no id or can't be cast-targeted, pick a known spell id from the fixture instead.

- [ ] **Step 2: Run it — expect FAIL** (currently returns a `use-on-targets` RelayAction, no throw).
Run: `pnpm --filter @companion/adapter-dnd5e exec vitest run test/actions.test.ts -t "targeted cast — out of uses"`

- [ ] **Step 3: Guard the adapter targeted branches.** In `buildAction`:
  - `case 'cast'` targeted branch (the `if (targeted !== undefined) { return { endpoint: 'use-on-targets', ... } }`): add `if (item) assertUsesRemaining(item);` as the first line inside the `if`.
  - `case 'use'` item branch targeted return and the feature branch targeted return (`if (targeted !== undefined) return { endpoint: 'use-on-targets', ... }`): add `if (item) assertUsesRemaining(item);` immediately before each.

Locate them by the `endpoint: 'use-on-targets'` returns (there are three in `buildAction`). Do NOT add it to the `attack` targeted branch's weapon path — weapons have no limited uses in scope here and it would be a no-op anyway; leaving it out keeps the diff minimal (add only to the cast + use returns).

- [ ] **Step 4: Run adapter test — expect PASS**, then the full adapter suite (no regressions):
Run: `pnpm --filter @companion/adapter-dnd5e test`

- [ ] **Step 5: Gateway backstop — failing test.** In `apps/gateway/test/fakes.ts`, add a flag to `FakeRelay` (near `useOnTargetsTimeout`): `useOnTargetsPerformFail = false;` and in `useAbilityOnTargets`, after the timeout branch, add:

```ts
    if (this.useOnTargetsPerformFail) {
      const err = new Error('relay /execute-js -> 400: {"success":false,"error":"Error executing script: use could not be performed"}') as Error & { status: number };
      err.name = 'RelayError';
      err.status = 400;
      throw err;
    }
```

Add to `apps/gateway/test/app.test.ts` (reuse the encounter harness that drives `use-on-targets`, e.g. `setupWithEncounter`): set `relay.useOnTargetsPerformFail = true`, POST a targeted cast/attack action, and assert the response is **422 / `INVALID_INTENT`**, not 502.

- [ ] **Step 6: Run it — expect FAIL** (currently the perform-failure rethrows → 502).
Run: `pnpm --filter @companion/gateway test`

- [ ] **Step 7: Implement the gateway backstop.** Add near `isRelayTimeout` (`app.ts:501`):

```ts
/** A relay 400 from targetedUseScript's own `activity.use()` guard: the ability
 *  could not be used (out of uses, no spell slot, etc.). User-actionable, not an
 *  upstream outage — surface as INVALID, never 502. */
function isUsePerformFailure(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === 'RelayError' &&
    (err as { status?: unknown }).status === 400 &&
    /use could not be performed/.test(err.message)
  );
}
```

In the `use-on-targets` catch (currently: timeout → 502, else `throw err`), insert before the `throw err`:

```ts
            if (isUsePerformFailure(err)) {
              return sendError(reply, 422, 'INVALID_INTENT', "That couldn't be used right now — out of uses or no spell slot.");
            }
```

- [ ] **Step 8: Run gateway test — PASS**, then the full gateway suite. Typecheck both:
Run: `pnpm --filter @companion/gateway test && pnpm --filter @companion/adapter-dnd5e typecheck && pnpm --filter @companion/gateway typecheck`

- [ ] **Step 9: Commit.**
```bash
git add packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/actions.test.ts apps/gateway/src/app.ts apps/gateway/test/fakes.ts apps/gateway/test/app.test.ts
git commit -m "fix: friendly 422 (not 502) when a targeted cast/use is out of uses"
```

---

### Task 2: Surface the uses counter on the Actions-tab cast row

**Files:**
- Modify: `packages/adapter-sdk/src/index.ts` (`ActionDescriptor`)
- Modify: `packages/adapter-dnd5e/src/index.ts` (`buildActions` spell cast descriptor)
- Modify: `apps/web/app/components/SectionActions.vue` (render `action.uses`)
- Test: `packages/adapter-dnd5e/test/actions.test.ts`

**Interfaces:**
- Consumes: `usesInfo(item)` (`index.ts:322`).
- Produces: `ActionDescriptor.uses?: { value: number; max: number }`.

- [ ] **Step 1: SDK field.** In `packages/adapter-sdk/src/index.ts` `ActionDescriptor`, add after `sub?`:
```ts
  /** cast/use only: remaining vs max limited uses, for a counter on the Actions
   *  row (free-use / limited-use abilities). Absent = unlimited / slot-based. */
  uses?: { value: number; max: number };
```

- [ ] **Step 2: Adapter failing test.** Add to `actions.test.ts` (reuse the exhausted-free-use actor helper from Task 1, or a value>0 variant):
```ts
it('a free-use spell cast row carries its uses counter', () => {
  const a = structuredClone(caster);
  const spell = (a.items ?? []).find((i) => i.type === 'spell')!;
  (spell.system as Record<string, unknown>).method = 'atwill';
  (spell.system as Record<string, unknown>).uses = { max: 1, spent: 0 };
  const cast = actions(a).find((x) => x.id === `spell.${spell._id}.cast`);
  expect(cast?.uses).toEqual({ value: 1, max: 1 });
});
```

- [ ] **Step 3: Run — expect FAIL.**
Run: `pnpm --filter @companion/adapter-dnd5e exec vitest run test/actions.test.ts -t "free-use spell cast row carries"`

- [ ] **Step 4: Set `uses` on the cast descriptor.** In `buildActions`, the spell cast `out.push({ id: `spell.${item._id}.cast`, ... })` object: add
```ts
          ...(usesInfo(item) !== undefined
            ? { uses: { value: Math.max(0, usesInfo(item)!.max - usesInfo(item)!.spent), max: usesInfo(item)!.max } }
            : {}),
```
(Compute `usesInfo(item)` once into a local above the push if the reviewer prefers; either is fine.)

- [ ] **Step 5: Run adapter test — PASS**, full suite, typecheck.
Run: `pnpm --filter @companion/adapter-dnd5e test && pnpm --filter @companion/adapter-sdk typecheck && pnpm --filter @companion/adapter-dnd5e typecheck`

- [ ] **Step 6: Render it in the Actions tab.** In `apps/web/app/components/SectionActions.vue`, in `.row-main` (near the existing `row-sub` / `action.sub` spans), add a uses counter for rows that carry it:
```vue
          <span v-if="action.uses" class="row-uses">{{ action.uses.value }}/{{ action.uses.max }}</span>
```
Add a minimal style near the other row styles (mirror `.row-sub`'s muted look), e.g.:
```css
.row-uses { font-size: 0.78rem; opacity: 0.7; margin-left: 0.4rem; }
```
Place the span so it reads as part of the row label/sub area, consistent with how `.row-sub` sits. Web has no unit tests — verify with `pnpm --filter @companion/web typecheck`.

- [ ] **Step 7: Typecheck web.**
Run: `pnpm --filter @companion/web typecheck`

- [ ] **Step 8: Commit.**
```bash
git add packages/adapter-sdk/src/index.ts packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/actions.test.ts apps/web/app/components/SectionActions.vue
git commit -m "feat(web): show uses counter on free-use spell cast rows"
```

---

## Self-Review

- **Coverage:** reported bug (exhausted free-use heal cast at a target → 502) → Task 1 adapter guard (primary) + gateway backstop (defense-in-depth for slot exhaustion / any benign use() refusal). "We don't see the uses on the Actions tab" → Task 2. ✓
- **No placeholders:** real code in every step; one flagged fixture-shape adjustment (Step 1) with a concrete fallback. ✓
- **Consistency:** `IntentError('INVALID')` → 422 `INVALID_INTENT` matches the codebase convention verified during the versatile-grip work. `assertUsesRemaining` reused, not reimplemented. `ActionDescriptor.uses` name identical across SDK + adapter + web.
