# D&D Beyond Parity Roadmap — gap analysis + implementation plan

Date: 2026-07-08
Source of truth for the gap analysis: D&D Beyond character 168078224
(Dwarf Wizard 3, Chronurgy Magic, Volstrucker Agent background), read via
`character-service.dndbeyond.com/character/v5/character/168078224`, compared
against the app as of commit `52dde79` (post inventory/actions split,
spellbook management, item-hook live sync).

**Charter guard (PLAN.md §1):** *Companion, not builder.* The app renders
what Foundry computed and triggers Foundry's own workflows. Features that
would need a rules engine or character-builder logic are explicitly out of
scope (see Non-goals). Everything below is either rendering existing actor
data or delegating a write to Foundry.

## Gap analysis

| D&D Beyond feature | App today | dnd5e 5.3.3 data source | Verdict |
|---|---|---|---|
| Abilities + checks/saves | ✅ gems + tap-to-roll | — | done |
| Skills + tap-to-roll | ✅ | — | done |
| Skill proficiency/expertise markers | ❌ not shown | `skills.<id>.value` (0 / 0.5 / 1 / 2) | **M14** |
| Passive Perception/Investigation/Insight | ❌ | derived `skills.<id>.passive`; fallback `10 + total` | **M10** |
| Initiative value | ✅ headline | — | done |
| Initiative ROLL | ❌ no action | formula `1d20 + init total` via `/roll` | **M10** |
| Inspiration | ❌ | `attributes.inspiration` (boolean) | **M10** |
| Exhaustion | ❌ | `attributes.exhaustion` (0–6) | **M10** |
| XP | ❌ | `details.xp.value` | **M10** |
| Senses (darkvision…) | ❌ | `attributes.senses.ranges` | **M10** |
| HP / temp HP / death saves / hit dice | ✅ | — | done |
| AC / speed / prof | ✅ headline | — | done |
| Conditions | ✅ badges | — | done |
| Rests / concentration | ✅ | — | done |
| Attacks / cast / feature use / item use | ✅ Actions tab | — | done |
| Spell prepare/learn/forget | ✅ (this session) | — | done |
| Language/armor/weapon/tool proficiencies | ❌ | `traits.languages/armorProf/weaponProf/toolProf` (+ label vocab) | **M11** |
| Resistances/immunities/vulnerabilities | ❌ | `traits.dr/di/dv/ci` | **M11** |
| Biography / appearance / personality | ❌ | `details.biography.value` (HTML), `details.trait/ideal/bond/flaw`, `details.appearance` | **M11** |
| Attunement (attune toggle + x/3 counter) | ❌ | item `system.attuned`, `system.attunement`, `attributes.attunement.max`; module has an `attune-item` action (source-verified) | **M12** |
| Container hierarchy (backpack…) | ❌ flat list | item `system.container` = container item id | **M12** |
| Item weight / encumbrance | ❌ | item `system.weight.value`; encumbrance totals are DERIVED (not in plain `/get` — enrich or sum client-side) | **M12** |
| Currency | ✅ wallet | — | done |
| Feat management (add/remove) | ❌ display+use only | same relay give/delete as spells; filter `subType:feat` | **M13** |
| Add items from compendium | ❌ | same pattern, physical item types | **M13** |
| Level-up / ability editing / homebrew builder | — | — | non-goal |
| Personality/notes EDITING | — | — | non-goal (render-only in M11) |

## Non-goals (charter)

- Character creation, leveling, ability-score or proficiency editing —
  builder features; Foundry (with the GM) owns them.
- Homebrew authoring, custom items/spells — same.
- Free-text editing of biography/notes from the phone — deferred until a
  real need; M11 renders them read-only (sanitized, like item details).

## Delivery approach

Each milestone below gets its own brainstorm-spec + TDD implementation plan
when picked up (repo workflow). Ordering is by player value per effort;
milestones are independent except M13, which builds on the spellbook
plumbing generalization.

---

## M10 — Sheet completeness (small data, high visibility)

Everything here is adapter + PWA only; no new gateway surface.

1. **Passive senses**: new stats row in the skills/overview section —
   Passive Perception / Investigation / Insight. Derived `skills.<id>.passive`
   when present, else `10 + skill total`. Read-only stats.
2. **Inspiration**: writable resource `inspiration` (0/1, step 1) rendered as
   a glowing toggle chip in Vitals; `buildUpdate` → `system.attributes.inspiration`
   (boolean write — extend `FoundryUpdate.data` handling, it already accepts
   booleans).
3. **Exhaustion**: writable resource 0–6 in Vitals (stepper), path
   `system.attributes.exhaustion`.
4. **XP**: read-only stat in the hero/overview (`details.xp.value`); GM owns
   grants.
5. **Senses**: headline or overview stats for non-null `senses.ranges`
   entries ("Darkvision 60 ft").
6. **Initiative roll**: `ActionDescriptor { id: 'init.roll', kind: 'check' }`
   → `/roll` with `1d20 + initiative(actor)`; the existing headline init stat
   gets `actionId: 'init.roll'` so tapping it rolls.

Tests: fixture-driven adapter tests (resources, stats, action mapping);
gateway needs none beyond existing allow-list coverage. Effort: S.

## M11 — Identity & lore (read-only "Character" tab)

1. **Proficiencies & traits panel**: new list/stats section fed from
   `traits.*`. Requires a small label vocabulary (lgt→Light Armor, sim→Simple
   Weapons, …) — labels only, no rules text (charter-safe, same as
   SPELL_SCHOOLS).
2. **Biography & personality**: render `details.biography.value` (sanitized
   HTML, same pipeline as item details) plus appearance/trait/ideal/bond/flaw
   one-liners when non-empty.
3. **PWA**: new "Character" tab (or fold into Overview below the stats) —
   tab routing already keys off section ids.

Contract: none (existing `stats`/`list` sections + `detail` field suffice).
Tests: adapter section shape from fixtures; sanitization already covered.
Effort: S–M.

## M12 — Inventory depth

1. **Attunement**: "attuned" tag + attune/unattune toggle on rows whose
   `system.attunement` is `"required"`; counter chip "Attuned 1/3" from
   `attributes.attunement.max`. New action kind is NOT needed — model like
   prepare: `attune` rides `update-item` writing `system.attuned`, OR the
   module's dedicated `attune-item` action (source-verified in 3.4.1) —
   live-verify which one dnd5e 5.3.3 honors, prefer the dedicated endpoint if
   it works (it may enforce the max).
2. **Container hierarchy**: group inventory rows under their container
   (`system.container` → container item id); collapsible groups in
   SectionList, loose items first. Contract: `ListItem.children?: ListItem[]`
   or a `containerId` field + PWA grouping — decide in spec.
3. **Weight & encumbrance**: per-row weight in `sub`; total vs capacity bar.
   Encumbrance max is derived — extend `enrich` (relay `get-actor-details`,
   check whether an `encumbrance` detail exists) or compute
   `sum(weight×qty)` + `STR × 15` fallback, labeled approximate.

Effort: M. Live-verify: attune endpoint behavior.

## M13 — Library management (generalize the spellbook)

Generalize `SpellbookSupport` into adapter-declared **collections** so feats
(and optionally gear) get the same search → preview → add / remove flow that
spells have:

```ts
library?: Array<{
  id: string;              // 'spells' | 'feats' | 'gear'
  label: string;           // "Learn spell" / "Add feat" / "Add item"
  searchFilter: string;    // 'documentType:Item,subType:feat' …
  canAdd(doc): boolean;
  canRemove(item): boolean;
  describe(doc): ListItem;
}>
```

- Gateway: `/api/actors/:id/library/:collection/{search,preview,learn}` +
  `DELETE /api/actors/:id/library/:collection/:itemId`; the existing
  spellbook routes become the spells collection (internal API, pre-1.0 —
  migrate, don't alias). `hasSpellbook` → `library: [{id,label}]` hints.
- dnd5e collections: spells (as today), feats (`subType:feat`,
  `canRemove: type === 'feat'`), gear (physical types) — gear behind the
  same trust model (GM sees everything in Foundry).
- PWA: the SpellbookSearch component becomes LibrarySearch (props already
  generic); "Add feat" button on the Overview/Features section, "Add item"
  on Gear.
- Feats display today under Features with use-actions — removal gets the
  same forget flow (detail dialog, confirm).

Effort: M (mostly renaming + one route family). Reuses give/delete
plumbing shipped today.

## M14 — Skills polish

1. **Proficiency markers**: skill stats gain `sub` markers — ◐ half, ●
   proficient, ◆ expertise from `skills.<id>.value`; saves likewise from
   `abilities.<id>.proficient`.
2. **Tool checks**: tools already get item-use actions (M-this-session);
   verify tool check cards roll with the right ability live; if the relay
   workflow is lacking, fall back to `/roll` with the tool's formula.

Effort: S.

---

## Live-verification checklist (accumulate in docs/M10+-findings.md)

- `POST /give` + `DELETE /delete` routes and player-key scopes (carried over
  from the spellbook milestone — still pending).
- `PUT /update` with `system.prepared` flips the dnd5e prepared checkbox.
- `attune-item` module action vs `system.attuned` update (M12).
- Whether `get-actor-details` exposes encumbrance/passive details (M10/M12).

## Suggested order

M10 → M13 → M12 → M11 → M14. M10 is the cheapest visible win; M13 answers
the explicit "manage feats" ask and generalizes plumbing that is fresh now;
M12/M11 deepen inventory and lore; M14 is polish.
