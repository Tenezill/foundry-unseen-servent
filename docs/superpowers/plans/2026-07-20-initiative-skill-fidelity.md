# Initiative & Skill Total Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the companion show/roll the same initiative and skill totals Foundry derives, so feat/active-effect bonuses (e.g. Temporal Awareness "add INT to initiative") are reflected instead of a recompute from a single ability.

**Architecture:** Adapter-only change. The relay's `get-actor-details` already returns derived data keyed off the requested `details` array (`stats.initBonus`, `skills.<id>.{total,mod,passive}`, `abilities.<id>.{mod,save}`). `enrich` already requests `["stats"]`/`["spells","stats"]` and folds AC + encumbrance from `stats`. We expand the request to also ask for `"skills"` and `"abilities"`, and fold their derived values into `system`. `initiative()`, `skillInfo()`, `abilityMod()`, and `saveBonus()` already *prefer* those derived fields, so they light up with no change to their own bodies. All existing DEX/recompute fallbacks stay for when the relay is unavailable.

**Tech Stack:** TypeScript, Vitest. Package: `packages/adapter-dnd5e`.

## Global Constraints

- Foundry 13 / dnd5e 5.3.3 (system-of-record). The relay serializes SOURCE data, not derived totals — the adapter's fallbacks must stay intact.
- `enrich` failure MUST return the actor unchanged (existing contract; test at `m12.test.ts:367`).
- Derived data is folded only when it is a finite number; junk/absent values are ignored (existing pattern for AC at `index.ts:2421`).
- No new relay scope, no execute-JS. Adapter-only.
- Commit message trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- Modify: `packages/adapter-dnd5e/src/index.ts` — `enrich` (lines 2382–2447): expand the `getSystemDetails` request; add three fold blocks (init, skills, abilities) before the final return.
- Modify: `packages/adapter-dnd5e/test/m12.test.ts` — update the three `calls` assertions (lines 318, 332, 346) for the new request keys.
- Create: `packages/adapter-dnd5e/test/derived-fidelity.test.ts` — unit tests for the three new folds + integration checks via `initiative`/`skillInfo`/`saveBonus` (exercised through the public view model / resources).

---

### Task 1: Expand the details request + fold derived initiative

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts:2388-2389` (request), and add a fold block before `return` at `:2446`.
- Modify: `packages/adapter-dnd5e/test/m12.test.ts:318,332,346` (request-key assertions).
- Test: `packages/adapter-dnd5e/test/derived-fidelity.test.ts` (new).

**Interfaces:**
- Consumes: `enrich(actor, { getSystemDetails })` — `AdapterIO.getSystemDetails(details: string[]) => Promise<unknown>` (already defined).
- Produces: enriched `actor.system.attributes.init.total` (number) when the IO response carries `stats.initBonus`. Request key order becomes: casters `['spells','stats','skills','abilities']`, non-casters `['stats','skills','abilities']`.

- [ ] **Step 1: Write the failing test**

Create `packages/adapter-dnd5e/test/derived-fidelity.test.ts`:

```ts
/**
 * Feature 3 — initiative & skill/ability total fidelity. enrich folds the
 * relay's derived totals (which the plain /get omits) so feats/active effects
 * (e.g. Temporal Awareness adding INT to initiative) are reflected.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dnd5eAdapter } from '../src/index.js';
import type { FoundryActorDoc } from '@foundry-companion/adapter-sdk';

function fixture(name: string): FoundryActorDoc {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as FoundryActorDoc;
}
const martialCaptured = fixture('martial-captured.json');

async function enrichWith(actor: FoundryActorDoc, response: unknown, calls?: string[][]) {
  if (!dnd5eAdapter.enrich) throw new Error('adapter must expose enrich()');
  return dnd5eAdapter.enrich(actor, {
    getSystemDetails: async (details) => {
      calls?.push(details);
      return response;
    },
  });
}

/** Read a stat's `value` from the built sheet by section + stat id. */
function statValue(actor: FoundryActorDoc, sectionId: string, statId: string): string | number | undefined {
  const sheet = dnd5eAdapter.toViewModel(actor) as { sections: Array<Record<string, unknown>> };
  for (const section of sheet.sections) {
    if (section.id !== sectionId) continue;
    const stats = (section.stats as Array<{ id: string; value: string | number }>) ?? [];
    return stats.find((s) => s.id === statId)?.value;
  }
  return undefined;
}

describe('enrich — derived initiative', () => {
  it('folds stats.initBonus into attributes.init.total and the init card', async () => {
    const enriched = await enrichWith(martialCaptured, { stats: { initBonus: 5 } });
    const sys = enriched.system as { attributes: { init: { total: unknown } } };
    expect(sys.attributes.init.total).toBe(5);
    expect(statValue(enriched, 'core', 'init')).toBe('+5');
  });

  it('requests skills and abilities alongside stats (caster: spells too)', async () => {
    const calls: string[][] = [];
    await enrichWith(martialCaptured, { stats: {} }, calls);
    expect(calls).toEqual([['spells', 'stats', 'skills', 'abilities']]);
  });

  it('ignores non-numeric initBonus (local fallback stands)', async () => {
    for (const initBonus of [null, 'x', Number.NaN]) {
      const enriched = await enrichWith(martialCaptured, { stats: { initBonus } });
      const sys = enriched.system as { attributes: { init: { total?: unknown } } };
      expect(sys.attributes.init.total).toBeUndefined();
    }
  });
});
```

> NOTE: The init stat lives in the section whose id is `core` in the view model. If the section id differs, adjust `statValue(enriched, 'core', 'init')` to the actual section id (grep `id: 'init'` in `index.ts` — it is emitted at `:2231` inside the section built around there). Verify the section id while running Step 2 and fix the literal before implementing.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/adapter-dnd5e/test/derived-fidelity.test.ts`
Expected: FAIL — `attributes.init.total` is `undefined` (martial capture has no derived init), and `calls` is `[['spells','stats']]`.

While it fails, confirm the init section id for the `statValue` call (grep `id: 'init'`).

- [ ] **Step 3: Expand the request in `enrich`**

In `packages/adapter-dnd5e/src/index.ts`, replace the request (currently `:2388-2389`):

```ts
    details = await io.getSystemDetails(hasSpellcasting ? ['spells', 'stats'] : ['stats']);
```

with:

```ts
    details = await io.getSystemDetails(
      hasSpellcasting
        ? ['spells', 'stats', 'skills', 'abilities']
        : ['stats', 'skills', 'abilities'],
    );
```

- [ ] **Step 4: Add the initiative fold**

In `enrich`, immediately before `return merged === undefined ? actor : { ...actor, system: merged };` (`:2446`), add:

```ts
  const initBonus =
    typeof stats.initBonus === 'number' && Number.isFinite(stats.initBonus) ? stats.initBonus : undefined;
  if (initBonus !== undefined) {
    const base = merged ?? { ...system };
    const attributes = rec(base.attributes);
    base.attributes = { ...attributes, init: { ...rec(attributes.init), total: initBonus } };
    merged = base;
  }
```

- [ ] **Step 5: Update the existing request-key assertions in `m12.test.ts`**

- `:318` — change `expect(calls).toEqual([['spells', 'stats']]);` to `expect(calls).toEqual([['spells', 'stats', 'skills', 'abilities']]);`
- `:332` — change `expect(calls).toEqual([['stats']]);` to `expect(calls).toEqual([['stats', 'skills', 'abilities']]);`
- `:346` — change `expect(calls).toEqual([['spells', 'stats']]);` to `expect(calls).toEqual([['spells', 'stats', 'skills', 'abilities']]);`

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run packages/adapter-dnd5e/test/derived-fidelity.test.ts packages/adapter-dnd5e/test/m12.test.ts`
Expected: PASS (all).

- [ ] **Step 7: Commit**

```bash
git add packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/derived-fidelity.test.ts packages/adapter-dnd5e/test/m12.test.ts
git commit -m "$(printf 'feat(adapter-dnd5e): fold derived initiative + request skills/abilities\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: Fold derived skill totals

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts` — add a skills fold block in `enrich` after the initiative fold.
- Test: `packages/adapter-dnd5e/test/derived-fidelity.test.ts` (extend).

**Interfaces:**
- Consumes: IO response `{ skills: { <id>: { total?: number; mod?: number; passive?: number } } }`.
- Produces: enriched `actor.system.skills.<id>.{total,mod,passive}`; `skillInfo()` returns the derived `total`.

- [ ] **Step 1: Write the failing test**

Append to `packages/adapter-dnd5e/test/derived-fidelity.test.ts`:

```ts
describe('enrich — derived skill totals', () => {
  it('folds skills.<id>.total so the skill card shows the derived bonus', async () => {
    const enriched = await enrichWith(martialCaptured, {
      stats: {},
      skills: { ath: { total: 7, mod: 7, passive: 17 } },
    });
    const sys = enriched.system as { skills: Record<string, { total?: unknown }> };
    expect(sys.skills.ath.total).toBe(7);
    expect(statValue(enriched, 'skills', 'skill.ath')).toBe('+7');
  });

  it('leaves untouched skills alone and ignores non-numeric totals', async () => {
    const enriched = await enrichWith(martialCaptured, {
      stats: {},
      skills: { acr: { total: 'x' } },
    });
    const sys = enriched.system as { skills: Record<string, { total?: unknown }> };
    expect(sys.skills.acr?.total).not.toBe('x');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/adapter-dnd5e/test/derived-fidelity.test.ts -t "derived skill totals"`
Expected: FAIL — `sys.skills.ath.total` is the capture's source value (not 7).

- [ ] **Step 3: Add the skills fold**

In `enrich`, after the initiative fold and before the `return`, add:

```ts
  const derivedSkills = rec(body.skills);
  const skillKeys = Object.keys(derivedSkills);
  if (skillKeys.length > 0) {
    const base = merged ?? { ...system };
    const skills = { ...rec(base.skills) };
    for (const key of skillKeys) {
      const d = rec(derivedSkills[key]);
      const total = typeof d.total === 'number' && Number.isFinite(d.total) ? d.total : undefined;
      const mod = typeof d.mod === 'number' && Number.isFinite(d.mod) ? d.mod : undefined;
      const passive = typeof d.passive === 'number' && Number.isFinite(d.passive) ? d.passive : undefined;
      if (total === undefined && mod === undefined && passive === undefined) continue;
      skills[key] = {
        ...rec(skills[key]),
        ...(total !== undefined ? { total } : {}),
        ...(mod !== undefined ? { mod } : {}),
        ...(passive !== undefined ? { passive } : {}),
      };
    }
    base.skills = skills;
    merged = base;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/adapter-dnd5e/test/derived-fidelity.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/derived-fidelity.test.ts
git commit -m "$(printf 'feat(adapter-dnd5e): fold derived skill totals in enrich\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: Fold derived ability mods + save values

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts` — add an abilities fold block in `enrich` after the skills fold.
- Test: `packages/adapter-dnd5e/test/derived-fidelity.test.ts` (extend).

**Interfaces:**
- Consumes: IO response `{ abilities: { <id>: { mod?: number; save?: number } } }` (the relay flattens `save` to a number).
- Produces: enriched `actor.system.abilities.<id>.mod` (number) and `actor.system.abilities.<id>.save.value` (number); `abilityMod()` and `saveBonus()` return the derived values.

- [ ] **Step 1: Write the failing test**

Append to `packages/adapter-dnd5e/test/derived-fidelity.test.ts`:

```ts
describe('enrich — derived ability mods + saves', () => {
  it('folds abilities.<id>.mod and .save (flattened number) into source shape', async () => {
    const enriched = await enrichWith(martialCaptured, {
      stats: {},
      abilities: { str: { mod: 3, save: 5 } },
    });
    const sys = enriched.system as {
      abilities: Record<string, { mod?: unknown; save?: { value?: unknown } }>;
    };
    expect(sys.abilities.str.mod).toBe(3);
    expect(sys.abilities.str.save?.value).toBe(5);
    // saveBonus (via the Saving Throws card) reflects the derived save value
    expect(statValue(enriched, 'saves', 'save.str')).toBe('+5');
  });

  it('ignores non-numeric mod/save', async () => {
    const enriched = await enrichWith(martialCaptured, {
      stats: {},
      abilities: { dex: { mod: 'x', save: null } },
    });
    const sys = enriched.system as { abilities: Record<string, { mod?: unknown }> };
    expect(sys.abilities.dex.mod).not.toBe('x');
  });
});
```

> NOTE: Confirm the saves section id and save stat id while running Step 2 (grep `id: 'save.` and the section built by `saveStats` in `index.ts`). Adjust the `statValue(enriched, 'saves', 'save.str')` literals to the real ids before implementing.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/adapter-dnd5e/test/derived-fidelity.test.ts -t "derived ability mods"`
Expected: FAIL — `sys.abilities.str.save.value` is not 5.

- [ ] **Step 3: Add the abilities fold**

In `enrich`, after the skills fold and before the `return`, add:

```ts
  const derivedAbilities = rec(body.abilities);
  const abilityKeys = Object.keys(derivedAbilities);
  if (abilityKeys.length > 0) {
    const base = merged ?? { ...system };
    const abilities = { ...rec(base.abilities) };
    for (const key of abilityKeys) {
      const d = rec(derivedAbilities[key]);
      const mod = typeof d.mod === 'number' && Number.isFinite(d.mod) ? d.mod : undefined;
      const save = typeof d.save === 'number' && Number.isFinite(d.save) ? d.save : undefined;
      if (mod === undefined && save === undefined) continue;
      const prev = rec(abilities[key]);
      abilities[key] = {
        ...prev,
        ...(mod !== undefined ? { mod } : {}),
        ...(save !== undefined ? { save: { ...rec(prev.save), value: save } } : {}),
      };
    }
    base.abilities = abilities;
    merged = base;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/adapter-dnd5e/test/derived-fidelity.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/derived-fidelity.test.ts
git commit -m "$(printf 'feat(adapter-dnd5e): fold derived ability mods + save values in enrich\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full adapter + gateway suites and typecheck**

Run:
```bash
npx vitest run packages/adapter-dnd5e
cd apps/gateway && npx vitest run && npx tsc --noEmit; cd ../..
npx tsc --noEmit -p packages/adapter-dnd5e
```
Expected: all suites PASS; both typechecks exit 0. Existing captured-fixture tests still pass because those fixtures carry no derived totals — the fallbacks remain in force and the enrich request-key change is covered by the updated `m12.test.ts` assertions.

- [ ] **Step 2: (No commit)** — if anything fails, fix under systematic-debugging and re-run before declaring done.

---

## Self-Review

**Spec coverage (Feature 3 section):**
- "Request skills and abilities in addition to current keys" → Task 1 Step 3 (+ Task 2/3 use them).
- "Fold stats.initBonus → attributes.init.total" → Task 1 Step 4.
- "Fold skills.<id>.total (+mod,passive)" → Task 2 Step 3.
- "Fold abilities.<id>.mod / .save.value" → Task 3 Step 3.
- "initiative()/skillInfo() already prefer derived; keep fallbacks" → no change to those bodies; fallback preserved (verified Task 4).
- "enrich failure returns unenriched actor" → unchanged; existing `m12.test.ts:367` still guards it (Task 4).

**Placeholder scan:** two NOTEs ask the implementer to confirm real section/stat ids (`core` for init, `saves`/`save.str` for saves) at Step 2 before implementing — these are verification instructions with a concrete grep, not placeholders in the code. All code blocks are complete.

**Type consistency:** `enrichWith`, `statValue`, `fixture` defined once in Task 1 and reused. Fold blocks all use the existing `rec()` helper and the `merged ?? { ...system }` pattern from the AC/encumbrance folds. Request-key arrays match between `index.ts` and the three updated `m12.test.ts` assertions.
