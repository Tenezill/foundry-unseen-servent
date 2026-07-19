# Save Advantage Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show D&D-Beyond-style situational saving-throw advantage/disadvantage reminders (e.g. "You have advantage on Intelligence, Wisdom, and Charisma saving throws against spells" — Gnomish Magic Resistance) directly under the Saving Throws section.

**Architecture:** Live-data investigation (2026-07-19, all 9 party PCs) proved these reminders exist ONLY as prose inside item `system.description.value` HTML — ddb-importer writes no structured advantage data (no active-effect changes, `save.roll.mode` all 0, no flags). So the dnd5e adapter extracts qualifying sentences from the actor's own item descriptions and emits them as a `kind: 'stats'` section (id `savenotes`) right after `saves`; the PWA renders it with the existing prose-`rows` variant (used by traits today). This is presentation of the user's own world content, same as item detail views — the repo ships no game text.

**Tech Stack:** TypeScript (adapter + Vitest), Vue/Nuxt PWA, Node mock server.

## Global Constraints

- Extraction rules validated against live party data (see plan intro); they must all be implemented:
  1. Scan `feat`, `race`, `background`, `equipment`, `weapon` items' `system.description.value`.
  2. Strip HTML tags, decode `&amp;`→`&` and `&nbsp;`→space, collapse whitespace; replace enricher tokens `@Word[...]{Label}` and `&Reference[...]{Label}` with their `Label`.
  3. A qualifying sentence matches `/[^.!?]*\b(?:dis)?advantage\b[^.!?]*\bsaving throws?\b[^.!?]*[.!?]/gi` AND (after preamble-trimming, rule 4) says the PLAYER gets it: `/\byou(?:\s+\w+)?\s+(?:have|gain|get|make)s?\s+(?:dis)?advantage\b/i`. A bare "you appears somewhere earlier" test is NOT enough — "When you do so, undead have disadvantage on their saving throws…" (Holy Symbol of Ravenkind) must be dropped, while "…of you have advantage…" (Countercharm) and "You have advantage…" (Danger Sense, Rage after trimming) must pass.
  4. If the sentence contains a colon before the (dis)advantage keyword, keep only the text after the LAST such colon (fixes Rage/War Caster list preambles).
  5. Trim; cap at 200 chars with a trailing `…` when cut.
  6. Dedupe case-insensitively on the processed sentence text (race items repeat their trait feats verbatim — Mountain Dwarf vs Dwarven Resilience).
- Section shape: `{ kind: 'stats', id: 'savenotes', label: 'Saving Throw Notes', stats }`, inserted DIRECTLY after the `saves` section; omitted entirely when no notes. Stat shape: `{ id: 'savenote.<n>', label: '<source item name>', value: '<sentence>' }` (no actionId — read-only).
- Web: `savenotes` must render with the `rows` variant (prose), and route to the Overview tab (its id must keep matching neither the spell nor gear tab regexes in `[id].vue`).
- Test command: `pnpm --filter @companion/adapter-dnd5e test`; typecheck `pnpm typecheck` or per-package.
- Commits: conventional style with the Co-Authored-By Claude trailer (see repo log).

---

### Task 1: Adapter — extract save notes and emit the `savenotes` section

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts` (add `saveNoteStats` near `saveStats` ~line 883; insert section in `toViewModel`'s sections array right after `saves` ~line 2145)
- Test: `packages/adapter-dnd5e/test/adapter.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `Stat`, `FoundryActorDoc`, `getPath`/`strAt` helpers, `ABILITIES` NOT needed.
- Produces: `saveNoteStats(actor: FoundryActorDoc): Stat[]` and the `savenotes` section consumed by Task 2's web/mock work.

- [ ] **Step 1: Write the failing tests**

Append to `packages/adapter-dnd5e/test/adapter.test.ts`:

```ts
describe('Saving Throw Notes section (2026-07-19)', () => {
  /** An actor whose items carry the live-verified description shapes. */
  function actorWithFeats(feats: Array<{ name: string; type?: string; desc: string }>): FoundryActorDoc {
    return {
      ...martial,
      items: feats.map((f, i) => ({
        _id: `note-feat-${i}`.padEnd(16, '0'),
        name: f.name,
        type: f.type ?? 'feat',
        system: { description: { value: f.desc } },
      })),
    };
  }

  it('extracts "you have advantage" save sentences, attributed to the item', () => {
    const actor = actorWithFeats([
      {
        name: 'Gnomish Magic Resistance',
        desc: '<p>You have advantage on Intelligence, Wisdom, and Charisma saving throws against spells.</p>',
      },
    ]);
    const section = dnd5eAdapter.toViewModel(actor).sections.find((s) => s.id === 'savenotes');
    if (section?.kind !== 'stats') throw new Error('savenotes must be a stats section');
    expect(section.label).toBe('Saving Throw Notes');
    expect(section.stats).toEqual([
      {
        id: 'savenote.0',
        label: 'Gnomish Magic Resistance',
        value: 'You have advantage on Intelligence, Wisdom, and Charisma saving throws against spells.',
      },
    ]);
  });

  it('sits directly after the saves section', () => {
    const actor = actorWithFeats([
      { name: 'Danger Sense', desc: '<p>You have advantage on Dexterity saving throws against effects that you can see.</p>' },
    ]);
    const ids = dnd5eAdapter.toViewModel(actor).sections.map((s) => s.id);
    expect(ids.indexOf('savenotes')).toBe(ids.indexOf('saves') + 1);
  });

  it('is omitted when no item text qualifies', () => {
    const ids = dnd5eAdapter.toViewModel(martial).sections.map((s) => s.id);
    expect(ids).not.toContain('savenotes');
  });

  it('drops sentences about other creatures (no "you" before the keyword)', () => {
    const actor = actorWithFeats([
      { name: 'Holy Symbol of Ravenkind', type: 'equipment', desc: '<p>When you do so, undead have disadvantage on their saving throws against the effect.</p>' },
    ]);
    const ids = dnd5eAdapter.toViewModel(actor).sections.map((s) => s.id);
    expect(ids).not.toContain('savenotes');
  });

  it('trims list preambles at the last colon (Rage/War Caster shape)', () => {
    const actor = actorWithFeats([
      {
        name: 'Rage',
        desc: '<p>While raging, you gain the following benefits if you aren’t wearing heavy armor: You have advantage on Strength checks and Strength saving throws.</p>',
      },
    ]);
    const section = dnd5eAdapter.toViewModel(actor).sections.find((s) => s.id === 'savenotes');
    if (section?.kind !== 'stats') throw new Error('savenotes must be a stats section');
    expect(section.stats[0]?.value).toBe('You have advantage on Strength checks and Strength saving throws.');
  });

  it('dedupes identical sentences from race + trait feat, keeping the first source', () => {
    const actor = actorWithFeats([
      { name: 'Mountain Dwarf', type: 'race', desc: '<p>Dwarven Resilience: You have advantage on saving throws against poison.</p>' },
      { name: 'Dwarven Resilience', desc: '<p>You have advantage on saving throws against poison.</p>' },
    ]);
    const section = dnd5eAdapter.toViewModel(actor).sections.find((s) => s.id === 'savenotes');
    if (section?.kind !== 'stats') throw new Error('savenotes must be a stats section');
    expect(section.stats).toHaveLength(1);
  });

  it('resolves enricher tokens and caps runaway sentences at 200 chars', () => {
    const longTail = 'that you can see, such as traps and spells, and also '.repeat(6);
    const actor = actorWithFeats([
      { name: 'Fey Ancestry', desc: '<p>You have advantage on saving throws against being &Reference[charmed]{Charmed}.</p>' },
      { name: 'Windbag', desc: `<p>You have advantage on Dexterity saving throws against effects ${longTail}elsewhere.</p>` },
    ]);
    const section = dnd5eAdapter.toViewModel(actor).sections.find((s) => s.id === 'savenotes');
    if (section?.kind !== 'stats') throw new Error('savenotes must be a stats section');
    expect(section.stats[0]?.value).toBe('You have advantage on saving throws against being Charmed.');
    const long = String(section.stats[1]?.value);
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith('…')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @companion/adapter-dnd5e test`
Expected: the new describe block FAILS (no `savenotes` section); all pre-existing tests pass. Note the fixture items in `actorWithFeats` replace the whole `items` array — the martial fixture's own items must NOT leak into assertions.

- [ ] **Step 3: Implement**

In `packages/adapter-dnd5e/src/index.ts`, below `saveStats`:

```ts
/** Item types whose descriptions may carry save-advantage prose (live-verified
 * 2026-07-19: racial traits duplicate into race items, War Caster is a feat,
 * Holy Symbol of Ravenkind is equipment). */
const SAVE_NOTE_ITEM_TYPES = new Set(['feat', 'race', 'background', 'equipment', 'weapon']);

/** One qualifying sentence: mentions (dis)advantage AND saving throw(s). */
const SAVE_NOTE_SENTENCE = /[^.!?]*\b(?:dis)?advantage\b[^.!?]*\bsaving throws?\b[^.!?]*[.!?]/gi;

/**
 * D&D-Beyond-style situational save reminders (2026-07-19). The structured
 * data does NOT exist in dnd5e/ddb-importer documents — the only source is
 * the items' own description prose, so this extracts sentences that say the
 * PLAYER has (dis)advantage on saving throws. Presentation of the user's own
 * world content, exactly like item detail views.
 */
function saveNoteStats(actor: FoundryActorDoc): Stat[] {
  const out: Stat[] = [];
  const seen = new Set<string>();
  for (const item of actor.items ?? []) {
    if (!SAVE_NOTE_ITEM_TYPES.has(item.type)) continue;
    const html = strAt(item.system, 'description.value') ?? '';
    if (html === '') continue;
    const text = html
      // Enricher tokens keep their human label: @UUID[...]{Poisoned}, &Reference[...]{Charmed}.
      .replace(/[@&][A-Za-z]+\[[^\]]*\]\{([^}]*)\}/g, '$1')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ');
    for (const match of text.matchAll(SAVE_NOTE_SENTENCE)) {
      let sentence = match[0];
      const advIndex = sentence.search(/\b(?:dis)?advantage\b/i);
      // List preambles ("…the following benefits: You have advantage…") end
      // at a colon — keep only the clause that carries the advantage.
      const colon = sentence.lastIndexOf(':', advIndex);
      if (colon !== -1) sentence = sentence.slice(colon + 1);
      sentence = sentence.trim();
      // Only the player's own saves: the (dis)advantage must be granted to
      // "you" as its subject ("you have advantage", "…of you have advantage",
      // "you also gain advantage"). A looser earlier-"you" test wrongly keeps
      // "When you do so, undead have disadvantage…" (Holy Symbol of Ravenkind).
      if (!/\byou(?:\s+\w+)?\s+(?:have|gain|get|make)s?\s+(?:dis)?advantage\b/i.test(sentence)) continue;
      if (sentence.length > 200) sentence = `${sentence.slice(0, 199).trimEnd()}…`;
      const key = sentence.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: `savenote.${out.length}`, label: item.name, value: sentence });
    }
  }
  return out;
}
```

In `toViewModel`, insert after the `saves` section (the sections array from the previous feature):

```ts
  const sections: SheetSection[] = [
    { kind: 'stats', id: 'abilities', label: 'Abilities', stats: abilityStats(actor) },
    { kind: 'stats', id: 'saves', label: 'Saving Throws', stats: saveStats(actor) },
    { kind: 'stats', id: 'skills', label: 'Skills', stats: skillStats(actor) },
    { kind: 'stats', id: 'passives', label: 'Passive Senses', stats: passiveStats(actor) },
  ];
  const saveNotes = saveNoteStats(actor);
  if (saveNotes.length > 0) {
    sections.splice(2, 0, { kind: 'stats', id: 'savenotes', label: 'Saving Throw Notes', stats: saveNotes });
  }
```

(`splice(2, 0, …)` = directly after `saves` at index 1. Keep the empty-section omission — a section with zero stats must not render an empty card.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @companion/adapter-dnd5e test`
Expected: ALL tests pass, including the Task-1 saves-section ordering test from the previous plan (`saves` still directly after `abilities`; `savenotes` insertion must not break it).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter @companion/adapter-dnd5e typecheck`

```bash
git add packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/adapter.test.ts
git commit -m "feat(adapter-dnd5e): Saving Throw Notes from item description prose

DDB-style situational save advantages have no structured source in
dnd5e/ddb-importer data (live-verified across 9 PCs) — extract the
player-scoped '(dis)advantage on … saving throw' sentences from the
actor's own item descriptions, dedupe race/feat duplicates, and emit
them as a savenotes rows section under Saving Throws.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Web rows variant + mock parity for `savenotes`

**Files:**
- Modify: `apps/web/app/pages/actor/[id].vue` (variant ternary, ~line 152)
- Modify: `apps/web/mock/server.mjs` (add save notes to the wizard actor so the section is mock-visible)

**Interfaces:**
- Consumes: the `savenotes` section shape from Task 1 (`{ kind: 'stats', id: 'savenotes', label: 'Saving Throw Notes', stats: [{ id, label: '<item>', value: '<sentence>' }] }`).
- Produces: nothing new — presentation only.

- [ ] **Step 1: Render `savenotes` with the prose rows variant**

In `apps/web/app/pages/actor/[id].vue` (~line 152) extend the variant ternary:

```html
:variant="section.id === 'abilities' ? 'gems' : section.id === 'traits' || section.id === 'savenotes' ? 'rows' : 'cards'"
```

- [ ] **Step 2: Mock parity**

In `apps/web/mock/server.mjs`, add to the wizard's `staticSections` (next to `saves`):

```js
    savenotes: [
      { id: 'savenote.0', label: 'Gnomish Magic Resistance', value: 'You have advantage on Intelligence, Wisdom, and Charisma saving throws against spells.' },
      { id: 'savenote.1', label: 'War Caster', value: 'You have advantage on Constitution saving throws that you make to maintain your concentration on a spell when you take damage.' },
    ],
```

And in `buildSheet`, after the `saves` section push:

```js
  if (s.savenotes) {
    sections.push({ kind: 'stats', id: 'savenotes', label: 'Saving Throw Notes', stats: s.savenotes })
  }
```

(The fighter actor has no `savenotes` key — verifies the omission path renders nothing.)

- [ ] **Step 3: Verify visually (mock + chrome-devtools)**

Start `pnpm --filter @companion/web dev:mock` and `pnpm --filter @companion/web dev` (background). With chrome-devtools MCP at 390×844, open the wizard actor's Overview tab.
Expected: "Saving Throw Notes" prose rows (feature name over sentence) directly under the Saving Throws card grid; the fighter shows no such section. Kill the servers after.

- [ ] **Step 4: Typecheck and commit**

Run: `pnpm --filter @companion/web typecheck`

```bash
git add apps/web/app/pages/actor/[id].vue apps/web/mock/server.mjs
git commit -m "feat(web): render Saving Throw Notes as prose rows + mock parity

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
