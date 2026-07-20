# Foundry Enricher Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Foundry text-enricher tokens (`&Reference[inv]{Investigation}`, `@UUID[..]{Label}`, inline rolls `[[..]]`) from leaking raw into feat/spell/item/biography descriptions; render their human label instead.

**Architecture:** Deviation from the spec (approved): the spec proposed a **web** util, but `apps/web` has no unit-test harness, and the `detail`/description HTML is produced entirely by the **adapter** (`itemDetail`, the `*Preview` functions, `biographyItems`) then rendered via `sanitizeHtml`. So the resolver lives in the adapter — fully unit-testable (vitest + fixtures), covers both `DetailDialog` and `LibrarySearch` previews, and needs zero web changes. Identical UX. A labeled-enricher regex already exists in the save-note path (`index.ts:1030`), proving the pattern.

**Tech Stack:** TypeScript, Vitest. Package: `packages/adapter-dnd5e`.

## Global Constraints

- Conservative transform: rewrite only recognized token shapes; unknown tokens (e.g. labelless `@Check[ability=dex;dc=15]`) pass through untouched — no mangling.
- Operates on HTML with tags preserved (callers render via `v-html` after `sanitizeHtml`); do NOT strip tags.
- Do not touch the save-note path (`saveNoteStats`, `index.ts:1010-1060`) — it is separately tested and strips tags for sentence extraction; leaving it avoids destabilizing it (minor one-line duplication of the labeled regex is acceptable).
- SDK import in tests is `@companion/adapter-sdk`. Strict `noUncheckedIndexedAccess` is on.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File Structure

- Modify: `packages/adapter-dnd5e/src/index.ts` — add exported `resolveEnrichers` + `descriptionHtml` helpers; route `itemDetail` (1164), `spellPreview` (1361), `featPreview` (1382), `gearPreview` (1400), and `biographyItems` (933) through them.
- Create: `packages/adapter-dnd5e/test/enrichers.test.ts` — unit tests for `resolveEnrichers` + one integration test through `toViewModel`.

---

### Task 1: resolveEnrichers + apply to all detail emitters

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts`
- Test: `packages/adapter-dnd5e/test/enrichers.test.ts` (new)

**Interfaces:**
- Produces: `export function resolveEnrichers(text: string): string`; internal `descriptionHtml(system: unknown): string | undefined`.

- [ ] **Step 1: Write the failing test**

Create `packages/adapter-dnd5e/test/enrichers.test.ts`:

```ts
/**
 * Foundry text-enricher resolution: descriptions must render human labels, not
 * raw tokens like "&Reference[inv]{Investigation}" (seen on "Warder's
 * Intuition"). Conservative — only recognized shapes are rewritten.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dnd5eAdapter, resolveEnrichers } from '../src/index.js';
import type { FoundryActorDoc } from '@companion/adapter-sdk';

describe('resolveEnrichers', () => {
  it('resolves a labeled &Reference to its label (the Warder\'s Intuition bug)', () => {
    expect(resolveEnrichers('Make an Intelligence (&Reference[inv]{Investigation}) check.')).toBe(
      'Make an Intelligence (Investigation) check.',
    );
  });

  it('resolves labeled @UUID / @Check to their labels', () => {
    expect(resolveEnrichers('Cast @UUID[Compendium.dnd5e.spells.abc]{Fireball} now')).toBe('Cast Fireball now');
    expect(resolveEnrichers('Roll @Check[ability=dex;dc=15]{a DC 15 Dexterity check}')).toBe(
      'Roll a DC 15 Dexterity check',
    );
  });

  it('resolves inline rolls: labeled to label, bare to formula', () => {
    expect(resolveEnrichers('Heal [[/r 2d4 + 2]]{2d4 + 2} HP')).toBe('Heal 2d4 + 2 HP');
    expect(resolveEnrichers('Deal [[/r 1d6]] damage')).toBe('Deal 1d6 damage');
  });

  it('preserves surrounding HTML tags', () => {
    expect(resolveEnrichers('<p>A (&Reference[inv]{Investigation}) check.</p>')).toBe(
      '<p>A (Investigation) check.</p>',
    );
  });

  it('leaves unknown/labelless tokens untouched (no mangling)', () => {
    expect(resolveEnrichers('@Check[ability=dex;dc=15] and plain text')).toBe('@Check[ability=dex;dc=15] and plain text');
    expect(resolveEnrichers('no tokens here')).toBe('no tokens here');
  });
});

describe('enricher resolution through the view model', () => {
  it('a feat description renders the enricher label in its detail', () => {
    const fixturePath = fileURLToPath(new URL('./fixtures/martial-captured.json', import.meta.url));
    const base = JSON.parse(readFileSync(fixturePath, 'utf8')) as FoundryActorDoc;
    const actor: FoundryActorDoc = {
      ...base,
      items: [
        {
          _id: 'featWI',
          type: 'feat',
          name: "Warder's Intuition",
          system: {
            description: { value: '<p>When you make an Intelligence (&Reference[inv]{Investigation}) check…</p>' },
          },
        } as unknown as FoundryActorDoc['items'] extends (infer T)[] ? T : never,
      ],
    };
    const sheet = dnd5eAdapter.toViewModel(actor) as {
      sections: Array<{ id: string; items?: Array<{ id: string; detail?: string }> }>;
    };
    const features = sheet.sections.find((s) => s.id === 'features');
    const detail = features?.items?.find((i) => i.id === 'featWI')?.detail ?? '';
    expect(detail).toContain('(Investigation)');
    expect(detail).not.toContain('&Reference');
  });
});
```

> If the `as unknown as …` item cast is awkward under strict TS, cast the single item via `as unknown as (typeof base.items)[number]` instead — the goal is one feat item with a `description.value`. Verify the features section id is `features` (it is — `index.ts:2322`) and feature ListItems carry `id`/`detail` (via `featureListItem` → `itemDetail`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/adapter-dnd5e/test/enrichers.test.ts`
Expected: FAIL — `resolveEnrichers` is not exported/defined; import error or assertions fail.

- [ ] **Step 3: Add `resolveEnrichers` and `descriptionHtml`**

In `packages/adapter-dnd5e/src/index.ts`, add near the other description/HTML helpers (immediately before `itemDetail`, around line 1159):

```ts
/**
 * Resolve Foundry text-enricher tokens to readable text so descriptions don't
 * leak raw source like "&Reference[inv]{Investigation}". HTML tags are
 * preserved (callers sanitize + render via v-html). Conservative: only
 * recognized shapes are rewritten; unknown/labelless tokens pass through.
 */
export function resolveEnrichers(text: string): string {
  return text
    // Labeled document/reference/check enrichers -> the author's label:
    // @UUID[..]{Label}, &Reference[..]{Label}, @Check[..]{Label}, @Damage[..]{Label}
    .replace(/[@&][A-Za-z]+\[[^\]]*\]\{([^}]*)\}/g, '$1')
    // Labeled inline rolls: [[/r 1d20]]{Label} -> Label
    .replace(/\[\[[^\]]*\]\]\{([^}]*)\}/g, '$1')
    // Bare inline rolls: [[/r 1d20 + 3]] -> "1d20 + 3", [[1d6]] -> "1d6"
    .replace(/\[\[\s*\/?[A-Za-z]*\s*([^\]]*?)\s*\]\]/g, '$1');
}

/** A world item/doc's description HTML with enrichers resolved; undefined when
 *  empty/missing. Single source for detail views + compendium previews. */
function descriptionHtml(system: unknown): string | undefined {
  const v = getPath(system, 'description.value');
  return typeof v === 'string' && v !== '' ? resolveEnrichers(v) : undefined;
}
```

- [ ] **Step 4: Route `itemDetail` through the helper**

Replace `itemDetail` (`index.ts:1164-1167`) body:
```ts
function itemDetail(item: FoundryItemDoc): string | undefined {
  return descriptionHtml(item.system);
}
```

- [ ] **Step 5: Route the three compendium previews through the helper**

In `spellPreview` (`:1361`), `featPreview` (`:1382`), and `gearPreview` (`:1400`), replace the `const detail = getPath(...'description.value')` line with:
- `spellPreview` / `featPreview`: `const detail = descriptionHtml(system);`
- `gearPreview`: `const detail = descriptionHtml(rec(doc.system));`

Then simplify each emit spread (the value is already `string | undefined`):
```ts
    ...(detail !== undefined ? { detail } : {}),
```
(Replace the existing `...(typeof detail === 'string' && detail !== '' ? { detail } : {})` at `:1369`, `:1390`, `:1409`.)

- [ ] **Step 6: Resolve enrichers in the biography detail**

In `biographyItems` (`:933`), change the pushed row's detail:
```ts
    out.push({ id: 'bio', label: 'Biography', sub: 'Tap to read', detail: resolveEnrichers(bio) });
```
(`bio` is already a non-empty string here.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run packages/adapter-dnd5e/test/enrichers.test.ts`
Expected: PASS (all).

- [ ] **Step 8: Full adapter suite + typecheck**

Run: `npx vitest run packages/adapter-dnd5e` (expect PASS — the save-note path is untouched, so its tests are unaffected), then `cd packages/adapter-dnd5e && npx tsc --noEmit; cd ../..` (expect exit 0).

- [ ] **Step 9: Commit**

```bash
git add packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/enrichers.test.ts
git commit -m "$(printf 'feat(adapter-dnd5e): resolve Foundry enricher tokens in descriptions\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: Verification

**Files:** none.

- [ ] **Step 1: Suites + typechecks**

Run:
```bash
npx vitest run packages/adapter-dnd5e
cd apps/gateway && npx vitest run && npx tsc --noEmit; cd ../..
cd packages/adapter-dnd5e && npx tsc --noEmit; cd ../..
```
Expected: adapter + gateway suites PASS; both typechecks exit 0. (No web change in this PR — the web renders the already-resolved `detail` unchanged.)

- [ ] **Step 2:** Fix any failure under systematic-debugging and re-run before declaring done.

---

## Self-Review

**Spec coverage (Feature 4):**
- Resolve `&Reference[..]{..}`, `@UUID/@Check/@Damage[..]{..}`, `[[/r ..]]` → label → `resolveEnrichers` (Task 1 Step 3), tested (Step 1).
- Applied wherever descriptions render (DetailDialog + LibrarySearch preview) → all five adapter emit sites routed through `descriptionHtml`/`resolveEnrichers` (Steps 4-6); web unchanged because it renders adapter-produced `detail`.
- Conservative (unknown tokens untouched) → tested (Step 1 "leaves unknown/labelless untouched").

**Placeholder scan:** none — all code complete; the one NOTE is a typing fallback for the test's item cast.

**Type consistency:** `resolveEnrichers(text: string): string` and `descriptionHtml(system: unknown): string | undefined` used consistently at all call sites; `itemDetail` keeps its `(item): string | undefined` signature. Features section id `features` and ListItem `detail` field confirmed against `index.ts:2322` and `featureListItem`.

**Deviation from spec noted:** resolver lives in the adapter (testable, correct layer), not a web util. UX identical. Documented follow-up (out of scope): labelless `@Check[ability=dex;dc=15]` prose rendering and double-escaped `&amp;Reference` tokens.
