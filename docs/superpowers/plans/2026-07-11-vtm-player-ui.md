# VtM Player UI (M23) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vampire: the Masquerade (wod5e system, id `vtm5e`) players get a full interactive phone sheet — dot-rated attributes/skills, tri-state health/willpower box tracks, hunger/humanity, disciplines — with dice-pool rolls, rouse checks, track edits, and mechanically functional custom items, on a second dedicated stack.

**Architecture:** New `packages/adapter-wod5e` implements the existing `SystemAdapter` contract; the `adapter-sdk` gains four additive optional primitives (adapter-declared tabs, box tracks, dot stats, pool actions) plus a custom-item hook. The gateway registers the adapter (one line) and adds one adapter-gated create-item route. The web shell renders tabs from the view model (regex fallback for dnd5e), adds `TrackBoxes` + dot rendering + a pool-roll bottom sheet + a custom item form, and a `vtm5e` theme token set. Everything system-specific lives in the adapter.

**Tech Stack:** Existing stack (pnpm monorepo, TS strict/ESM, Fastify gateway, Nuxt 4 web, vitest). No new deps. Second docker compose deployment via the M21 files.

**Spec:** `docs/superpowers/specs/2026-07-11-vtm-player-ui-design.md`
**Task 0 findings (produced by Task 0; READ before Tasks 2–7):** `docs/superpowers/specs/2026-07-11-vtm-player-ui-task0-findings.md`

## Global Constraints

- **Fixture is truth.** Every wod5e data path in this plan is *provisional* (marked ⚠). Task 0 captures a real actor to `packages/adapter-wod5e/test/fixtures/vampire-captured.json`; where plan and fixture disagree, the fixture wins — the implementer updates constants/tests, never invents paths. The coordinator amends this plan's shapes from the findings doc before dispatching Tasks 2+.
- **SDK changes are additive and optional.** dnd5e adapter source is untouched; the full existing suite (445 tests: 293 adapter + 140 gateway + 12 client) plus `pnpm -r typecheck` stays green after every task.
- **Track invariant:** per box track, `superficial + aggravated ≤ max`; writes clamp within the descriptor bounds the adapter computes per current state (dnd5e hp-clamp precedent).
- **Roll strategy default = Strategy 2** (generic `/roll`, d10 success-counting formula, hunger dice as a separate term). If Task 0 proves a system-native path, the coordinator amends Task 4 before dispatch; nothing else changes.
- Every relay await is bounded (M18 `adminNameTimeoutMs` pattern). Never print relay keys or account credentials.
- Custom item payloads: the adapter whitelists writable fields; the gateway never forwards raw client JSON to the relay.
- Strict TS both packages, ESM `.js` import suffixes, typecheck is a hard gate. Commit per task with trailer:

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

### Task 0: VtM stack, wod5e install, fixture capture, relay vetting (coordinator-led, live)

No product code. Deliverables: a running second stack, the captured fixture, and the findings doc answering spec §"Feasibility gate" 1–5.

- [ ] 1. **License check (user-blocking if unmet):** a second *concurrently running* Foundry server needs its own license key. Look for a second key in `stack/.env` conventions; if none is available, ask the user for one. Fallback (spike only): create the VtM world on the existing dev stack and defer the second deployment to Task 9 — record which path was taken.
- [ ] 2. **Stand up `stack-vtm/`:** copy the M21 compose project (`stack/` → `stack-vtm/`), new compose project name `foundry-vtm`, non-conflicting host ports (Foundry `30001`, relay `3011`, gateway `8788`, web `3001`, Caddy off for the spike), fresh named volumes, own `.env*` files. `docker compose up -d`; verify Foundry answers on `:30001`.
- [ ] 3. **Install wod5e + world:** via Foundry setup UI install system "World of Darkness 5e" (verify the installed system's `id` — expected `vtm5e` ⚠). Create world `vtm`. Install the ThreeHats relay module (same version as `stack/foundry-data` — copy the module folder into the new foundry-data volume), configure relay URL/key per `docs/LLM-SETUP-RUNBOOK.md`, enable in the world.
- [ ] 4. **Test vampire:** create actor "Marius" (type vampire) with a *populated* sheet: several attributes/skills at 1–5 dots, 2+ disciplines with powers, hunger 2, humanity 7 with 1 stain, health max 7 with 1 superficial + 1 aggravated marked, willpower damage, one weapon, one gear item. Populate via the wod5e sheet UI (GM console `Actor.create` acceptable for scaffolding, but dots/tracks must be set through the sheet so the data is system-canonical).
- [ ] 5. **Mint relay key** (scopes: `entity:read, entity:write, search, events:subscribe, clients:read`) in the new relay's admin UI; store in `stack-vtm/.env.gateway`; never print it.
- [ ] 6. **Capture fixture:** `GET /get?uuid=Actor.<id>` → save verbatim to `packages/adapter-wod5e/test/fixtures/vampire-captured.json`. Verify serialization completeness (spec gate §1): health/willpower superficial+aggravated, hunger, humanity+stains, all attributes/skills, blood potency, powers & items with their system fields. Record every real path in the findings doc as the canonical path table.
- [ ] 7. **Vet writes (gate §2):** relay `update` actionType writing `system.health.superficial: 2` → verify on the Foundry sheet; revert.
- [ ] 8. **Vet rolls (gate §3):** (a) generic `roll` with `3d10cs>=6 + 2d10cs>=6` → chat card appears, successes counted; (b) hunt for a system-native path: does wod5e expose a roll API triggerable via the relay (inspect module.js `roll`/`use-*` handlers against this system; note `execute-js` exists but adopting it is a coordinator decision, not a default). Record verdict: Strategy 1 or 2.
- [ ] 9. **Vet item creation (gate §4):** relay `create` actionType, embedded item on the actor with wod5e weapon fields (⚠ `{name, type:'weapon', system:{damage: 2}}`) → item appears on the sheet and its attack pool works in Foundry. Record the exact request envelope + accepted fields.
- [ ] 10. **Vet hooks SSE (gate §5):** subscribe `updateActor`; mark a health box in Foundry → frame arrives with the full doc. Record frame shape.
- [ ] 11. **Findings doc:** write `docs/superpowers/specs/2026-07-11-vtm-player-ui-task0-findings.md` (M22 findings format): path table, roll verdict, create-item envelope, hook shape, deviations from this plan. Commit findings + fixture: `docs: M23 task0 findings + captured vampire fixture`. **Coordinator then amends Tasks 2–7 shapes before dispatching them.**

---

### Task 1: adapter-sdk extensions (types only)

**Files:**
- Modify: `packages/adapter-sdk/src/index.ts`
- Verify via consumers: `pnpm -r typecheck && pnpm -r test` (types-only package)

**Interfaces (Produces — Tasks 2–7 consume verbatim):**

```ts
/** Adapter-declared tab layout (M23). Absent → the PWA's legacy heuristic. */
export interface SheetTab {
  id: string;
  label: string;
  /** SheetSection ids rendered in this tab, in order. */
  sectionIds: string[];
  /** Exactly one tab may host the actions UI (rolls/attacks). */
  hostsActions?: boolean;
}

/** A box-rendered track (M23): tri-state (empty/superficial/aggravated)
 *  when aggravatedId is set, two-state otherwise (hunger, stains). */
export interface BoxTrackSpec {
  id: string;
  label: string;
  /** total boxes; NOT derived from a resource max (superficial's dynamic
   *  bound is max - aggravated). */
  max: number;
  /** resource counted as superficial ('/') or plain fill. */
  primaryId: string;
  /** resource counted as aggravated ('X'); shares `max` with primary. */
  aggravatedId?: string;
}

// SheetSection 'tracks' variant gains:  boxTracks?: BoxTrackSpec[]
// Stat gains:                           display?: 'dots'; max?: number  (dots: 0..max, max ≤ 10)
// SheetViewModel gains:                 tabs?: SheetTab[]; glyph?: string
// SheetActionKind gains:                'pool' | 'rouse'
// ActionDescriptor gains:               pool?: { attribute?: string; skill?: string }  // default pairing; ids match Stat.id
// ActionIntent gains:
//   | { kind: 'pool'; actionId: string; attribute?: string; skill?: string; modifier?: number }
//   | { kind: 'rouse'; actionId: string }

/** Custom item creation (M23): input the PWA form sends. */
export interface CustomItemInput {
  name: string;
  type: string;              // adapter-declared type id, e.g. 'weapon' | 'gear'
  damage?: number;           // weapons only
  description?: string;
}
// SheetViewModel gains: customItems?: Array<{ type: string; label: string; hasDamage: boolean }>
// SystemAdapter gains:  buildCustomItem?(actor: FoundryActorDoc, input: CustomItemInput): Record<string, unknown>
//   (returns the full embedded-item payload for the relay `create` call; throws IntentError('INVALID') on bad input)
```

- [ ] **Step 1:** Add the types above with JSDoc in the established voice (see existing M-tagged comments). All fields optional/additive; no existing type changes shape.
- [ ] **Step 2:** `pnpm -r typecheck && pnpm -r test` → green (445 tests), proving dnd5e untouched.
- [ ] **Step 3:** Mirror new types in `apps/web/app/types/api.ts` re-exports if that file enumerates them (follow its idiom).
- [ ] **Step 4:** Commit `feat(sdk): tabs, box tracks, dot stats, pool/rouse actions, custom items (M23)`

---

### Task 2: adapter-wod5e — package, toViewModel, resources

**Files:**
- Create: `packages/adapter-wod5e/package.json`, `tsconfig.json` (copy adapter-dnd5e's, rename `@companion/adapter-wod5e`), `src/index.ts`, `test/adapter.test.ts`
- Fixture: `test/fixtures/vampire-captured.json` (from Task 0)

**Interfaces:**
- Consumes: Task 1 types; the fixture.
- Produces: `export const wod5eAdapter: SystemAdapter` with `systemId: 'vtm5e'` ⚠ (Task 0 §3 verifies the id).

**Provisional path table (⚠ every row — replace from findings):**

| Concept | Path |
|---|---|
| attributes (9) | `system.attributes.<strength\|dexterity\|stamina\|charisma\|manipulation\|composure\|intelligence\|wits\|resolve>.value` |
| skills (27) | `system.skills.<key>.value` (keys from fixture) |
| health | `system.health.{max,superficial,aggravated}` |
| willpower | `system.willpower.{max,superficial,aggravated}` |
| hunger | `system.hunger.value` (0–5) |
| humanity | `system.humanity.{value,stains}` |
| blood potency | `system.blood.potency` |
| powers | items `type:'power'`, `system.{discipline,level}` |
| weapons | items `type:'weapon'`, `system.damage` |
| gear | items `type:'equipment'` |

**View model contract:**
- `headline`: clan (⚠ `system.clan` if present), blood potency, generation if present.
- `glyph: '☥'`.
- `tabs`: `overview` (sections `attributes`, `skills`; `hostsActions: false`), `rolls` (`hostsActions: true`), `disciplines` (section `disciplines`), `vitals` (section `tracks`), `gear` (section `gear`).
- Sections: `attributes` + `skills` as `stats` with `display:'dots'`, ids `attr.<key>` / `skill.<key>`, each with `actionId` referencing its pool entry (Task 4); `disciplines` as `list` grouped by discipline (power rows: `sub` = "Level N · <discipline>", `detail` = description HTML, `actionId` = power pool roll); `tracks` as `kind:'tracks'` with `boxTracks`: health (primary `health.superficial`, aggravated `health.aggravated`, max from fixture), willpower (same shape), hunger (primary only, max 5), stains (primary `humanity.stains`, max 10; humanity itself renders as a read-only dots stat in `attributes` — value 0–10); `gear` as `list` (weapons: `sub` = "Damage N", equip toggle if the system has an equipped flag ⚠).
- `resources` (writable ✓): `health.superficial` ✓ (min 0, max = `health.max - aggravated`), `health.aggravated` ✓ (max = `health.max - superficial`), `willpower.*` same, `hunger` ✓ (0–5), `humanity.stains` ✓ (0–10); read-only: `humanity`, `bloodpotency`.
- `customItems`: `[{type:'weapon', label:'Weapon', hasDamage:true}, {type:'equipment', label:'Gear', hasDamage:false}]` ⚠ type ids from findings.

- [ ] **Step 1: failing tests** — fixture → `toViewModel`: tabs shape exact; every attribute/skill renders a dot stat with the fixture's value and `max` (5 default; assert one raised value); disciplines grouped; tracks section carries the box specs with fixture max values; resources list exact ids/bounds incl. the dynamic superficial/aggravated bounds against the fixture's marked damage. Run: `pnpm --filter @companion/adapter-wod5e test` → RED (module missing).
- [ ] **Step 2: implement** `toViewModel` + `resources` reading only the path table. Missing/undefined paths → defensive defaults (0 / empty), never throw on a sparse actor.
- [ ] **Step 3:** GREEN + `pnpm -r typecheck`.
- [ ] **Step 4:** Commit `feat(adapter-wod5e): view model + resources from captured fixture (M23)`

---

### Task 3: adapter-wod5e — buildUpdate

**Files:** Modify `packages/adapter-wod5e/src/index.ts`; Test `test/updates.test.ts` (new)

**Interfaces:** Consumes Task 2 resource ids. Produces `buildUpdate(actor, intent): FoundryUpdate` with dotted paths from the path table.

- [ ] **Step 1: failing tests**, at minimum:
  - `{kind:'delta', resourceId:'health.superficial', amount:+1}` → `{data:{'system.health.superficial': <fixture+1>}}`
  - clamp: superficial delta that would break `superficial + aggravated ≤ max` clamps to `max - aggravated`; same for aggravated; negatives clamp to 0.
  - hunger set 7 → clamps 5; `humanity.stains` set 11 → clamps 10.
  - unknown resource → `IntentError('UNKNOWN_RESOURCE')`; read-only (`humanity`) → `IntentError('READ_ONLY')`; `expected` mismatch semantics identical to dnd5e (copy its optimistic-lock test idiom).
- [ ] **Step 2: RED → implement → GREEN** (use the shared `clamp` from the SDK). Full suite + typecheck.
- [ ] **Step 3:** Commit `feat(adapter-wod5e): track/hunger/humanity writes with invariant clamps (M23)`

---

### Task 4: adapter-wod5e — actions + buildAction (pool math)

**Files:** Modify `packages/adapter-wod5e/src/index.ts`; Test `test/actions.test.ts` (new)

**Interfaces:**
- Produces `actions(actor)`: one `kind:'pool'` descriptor per attribute (`id:'pool.attr.<key>'`, `pool:{attribute:'attr.<key>'}`), per skill (`id:'pool.skill.<key>'`, default pairing `pool:{attribute:<wod5e sheet default ⚠ else 'attr.dexterity'>, skill:'skill.<key>'}`), per power (`id:'pool.power.<itemId>'`, pairing from the power's dicepool fields ⚠); one `kind:'rouse'` (`id:'rouse'`); equip toggles if the system supports them ⚠.
- Produces `buildAction(actor, intent)` (Strategy 2 default):

```ts
// pool: dice = attrValue + skillValue + (modifier ?? 0), floor 1
//       hunger = min(system.hunger.value, dice)   // vampires; 0 for mortals/ghouls
//       normal = dice - hunger
// → { endpoint:'roll',
//     formula: normal > 0 && hunger > 0 ? `${normal}d10cs>=6 + ${hunger}d10cs>=6`
//            : hunger > 0 ? `${hunger}d10cs>=6` : `${normal}d10cs>=6`,
//     flavor: `Strength + Brawl (5 dice, 2 hunger)` }   // labels from the stat vocab
// rouse: { endpoint:'roll', formula:'1d10cs>=6', flavor:'Rouse Check' }
//        (hunger auto-increment per Task 0 findings; default: player adjusts
//         hunger manually via the track — no follow-up write)
```

- [ ] **Step 1: failing tests** — pool math table-driven (attr only; attr+skill; +/− modifier; hunger > pool → all hunger dice; hunger 0 → single term; floor 1); intent overriding the default pairing; unknown attribute/skill ids → `IntentError('INVALID')`; unknown actionId → `IntentError('UNKNOWN_RESOURCE')`; rouse formula/flavor exact; every stat's `actionId` from Task 2 resolves to a descriptor.
- [ ] **Step 2: RED → implement → GREEN**, full suite + typecheck.
- [ ] **Step 3:** Commit `feat(adapter-wod5e): pool/rouse actions with hunger split (M23)`

---

### Task 5: gateway + foundry-client — registration & custom items

**Files:**
- Modify: `apps/gateway/src/registry.ts` (add `wod5eAdapter`), `apps/gateway/package.json` (workspace dep), `apps/gateway/src/app.ts` (one route), `packages/foundry-client/src/index.ts`
- Test: `apps/gateway/test/app.test.ts` (extend), `packages/foundry-client/test/client.test.ts` (extend), `apps/gateway/test/fakes.ts` (FakeRelay `createEmbeddedItem`)

**Interfaces:**
- foundry-client produces: `async createEmbeddedItem(actorUuid: string, item: Record<string, unknown>): Promise<{ id: string } | null>` — relay `create` envelope ⚠ per Task 0 §9 (URL path, param names, response field for the new id).
- Gateway route: `POST /api/actors/:id/items` body `CustomItemInput` → 200 `{ sheet }` (fresh view model); 404 when the actor's adapter lacks `buildCustomItem`; 422 `INVALID_INTENT` on `IntentError('INVALID')`; write counts against the existing `limiter`; relay call bounded.

- [ ] **Step 1: failing tests** — registry resolves a `vtm5e` doc to the wod5e adapter (mirror `registry.test.ts` idiom); route: happy path passes the adapter-built payload (assert FakeRelay received `buildCustomItem`'s output verbatim, NOT the client body); bad type → 422; dnd5e actor (no `buildCustomItem`) → 404; limiter 429; client: envelope + null on failure (fetch-mock idiom).
- [ ] **Step 2: RED → implement → GREEN**, full suite + typecheck.
- [ ] **Step 3:** Commit `feat(gateway): wod5e adapter registration + custom item creation (M23)`

---

### Task 6: web — adapter tabs, dot stats, box tracks, glyph

**Files:**
- Create: `apps/web/app/components/TrackBoxes.vue`
- Modify: `apps/web/app/pages/actor/[id].vue`, `apps/web/app/components/SectionStats.vue`, `apps/web/app/components/SectionTracks.vue`, `apps/web/app/components/SheetHero.vue`, `apps/web/app/types/api.ts`

**Contracts (visuals follow house conventions; behaviors binding):**
- `[id].vue`: when `sheet.tabs` present, the tab bar and section routing come exclusively from it (`hostsActions` tab renders the actions UI; first tab is landing); absent → the existing regex heuristic verbatim (dnd5e pixel-identical). Transient COMBAT tab logic unchanged and appended after adapter tabs.
- `SectionStats.vue`: `display:'dots'` stats render `value` filled dots of `max` (≤10), tabular layout, tappable when `actionId` set (routes to the pool sheet, Task 7 — until Task 7 lands, tap falls through to the existing action dispatch which posts the intent without params; acceptable interim).
- `TrackBoxes.vue` (used by `SectionTracks` when `boxTracks` present): renders `max` boxes; fill order aggravated-first then superficial; tap cycles the *next state* per V5 marking (empty→superficial→aggravated→empty on the tapped box's current state) and emits the corresponding `delta` intents on the two resources (tri-state) or a single `delta` (two-state); optimistic UI + existing 409-refresh; readonly mode inert.
- `SheetHero.vue`: `sheet.glyph` wins when present; existing caster/martial heuristic is the fallback.
- Gate: `pnpm --filter @companion/web typecheck`; visual smoke on BOTH stacks (dnd5e sheet unchanged; vampire sheet renders tabs/dots/boxes live).

- [ ] Implement per contracts; commit `feat(web): adapter-driven tabs, dot stats, tri-state box tracks (M23)`

---

### Task 7: web — pool roll sheet, rouse, custom item form

**Files:**
- Create: `apps/web/app/components/PoolRollSheet.vue`, `apps/web/app/components/CustomItemSheet.vue`
- Modify: `apps/web/app/pages/actor/[id].vue`

**Contracts:**
- `PoolRollSheet` (bottom sheet, HpNumpad presentation idiom): opens from any pool-action tap, pre-filled with the descriptor's default pairing; attribute + skill pickers listing the dot stats from sections `attributes`/`skills` (id ↔ intent param), modifier stepper (−5..+5); live preview line `"<Attr> <n> + <Skill> <m> = <dice> dice, <hunger> hunger"` (hunger = min(hunger resource value, dice), display-only — the adapter recomputes authoritatively); confirm → `POST /api/actors/:id/actions` `{kind:'pool', actionId, attribute, skill, modifier}` → success toast with the flavor; error → standard toast, sheet stays.
- Rouse: a fixed action button on the `rolls` tab (descriptor `kind:'rouse'`) → intent `{kind:'rouse', actionId:'rouse'}` → toast reminds "On failure: +1 Hunger" (manual track adjust per Task 4 default).
- `CustomItemSheet`: opens from an "Add item" button on the `gear` tab shown iff `sheet.customItems?.length`; fields: name (required), type select from `customItems`, damage stepper 0–10 shown iff selected type `hasDamage`, description textarea; submit → `POST /api/actors/:id/items` → refresh sheet, toast; 422 → inline error. Item rows show the existing remove affordance only when the adapter marks them `removable` (it does not in v1 — deleting mis-created items is GM-side; note this in the empty-state copy).
- Gate: `pnpm --filter @companion/web typecheck`; live smoke: roll Strength+Brawl with hunger from the phone → chat card in Foundry; rouse; create a weapon → appears on both PWA and Foundry sheets.

- [ ] Implement per contracts; commit `feat(web): pool roll sheet, rouse check, custom items (M23)`

---

### Task 8: web — VtM theme

**Files:** Modify `apps/web/app/assets/css/main.css`, `apps/web/app/pages/actor/[id].vue` (stamp `data-system`), `apps/web/app/composables/useTheme.ts` (only if the stamp logic naturally lives there)

**Contracts:**
- `[id].vue` stamps `data-system="<sheet.systemId>"` on the page root when a sheet loads.
- `main.css` gains a `[data-system='vtm5e']` token override set for BOTH color schemes, mapped onto the existing `--accent`/`--surface`/`--text` tokens (the Gilded Tome M7 pattern — components untouched): dark = near-black surfaces + oxblood/crimson accent; light = pale marble + dried-blood red. Existing light/dark toggle continues to work; dnd5e sheets are pixel-unchanged (no `:root`-level edits).
- Gate: typecheck + visual smoke both themes × both schemes.

- [ ] Implement; commit `feat(web): vtm5e theme (M23)`

---

### Task 9: live verification + docs (coordinator-led)

- [ ] 1. Docs: `API.md` gains the custom-items route + the tabs/boxTracks/dots/pool view-model additions; `README`/`PLAN.md` systems list mentions wod5e; if Task 0 deferred the second deployment, complete it now (Caddy + real hostnames per M21) and record it in `docs/LLM-SETUP-RUNBOOK.md`. Commit `docs: wod5e support (M23)`.
- [ ] 2. Live table-loop pass on the VtM stack (spec §Testing): join link → vampire sheet renders with VtM theme + tabs; mark 2 superficial health in the PWA → boxes update in Foundry (and reverse, via SSE); set hunger 3; roll Strength+Brawl (pool preview correct, chat card in Foundry with hunger term); rouse check; create custom weapon "Stake" damage 2 → attack pool works in Foundry; dnd5e stack regression: sheet renders identically, 445+ tests green.
- [ ] 3. Record everything in the findings doc addendum; fix-forward any live defects (systematic-debugging, RED test first) before declaring M23 done.
