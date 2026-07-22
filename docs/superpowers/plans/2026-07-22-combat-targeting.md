# Combat Targeting, Turn Flow & Movement Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In combat, players pick target(s) on the phone and execute an attack/spell/item; Foundry resolves hit-vs-AC / saves-vs-DC and applies damage/healing through its own pipeline (resistances honored); players see a per-target outcome card. Plus: an End-turn button (own turn only), a per-turn movement budget with Dash, the dice FAB sliding above the initiative carousel, and correct displayed AC under active effects (Mage Armor).

**Architecture:** One `/execute-js` orchestration script in `foundry-client` (`useAbilityOnTargets`) does target→use→attack/save→damage→apply atomically inside Foundry and returns a structured result. Three small execute-js helpers (`endCombatTurn`, `postChatNote`, `getDerivedAc`) cover turn advance, dash chat notes, and derived AC. The gateway adds a `use-on-targets` case to the actions route (target allow-list = visible encounter roster), a turn-end route, and an in-memory per-turn movement budget keyed `combatId:round:combatantId` (lazy reset). The PWA adds a multi-select combat target sheet, an outcome sheet, an End-turn button, budget UI on the Move sheet, and a raised dice FAB.

**Tech Stack:** TypeScript, Fastify 5 (gateway), vitest (foundry-client + gateway + adapter), Nuxt 4 / Vue 3.5 (web — typecheck + mock server only, no web unit tests), ThreeHats foundry-rest-api relay 3.4.1, dnd5e 5.3.x.

**Spec:** `docs/superpowers/specs/2026-07-22-combat-targeting-design.md`. Deliberate deviations: (1) the spec says "extend `TargetPickerSheet` with a combat mode" — the combat picker returns `tokenUuid[]` (multi-select) while the buff picker returns a single `actorId`; overloading one component with two emit contracts is messier than a sibling, so we create **`CombatTargetSheet.vue`** and leave `TargetPickerSheet.vue` untouched. (2) The spec's budget fields ride flat on the movement view (`inCombat`, `yourTurn`, `remainingFt`, `dashed`), exactly as written.

## Global Constraints

- Branch: `feat/combat-targeting` in the main checkout (live stack — no worktree). Already exists; the spec is committed on it.
- TDD every task: failing test → run → implement → run → commit. Conventional commits ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **`useAbilityOnTargets` is side-effecting → NEVER auto-retried.** A relay 408 (`isRelayTimeout`, `app.ts:414`) maps to 502 UPSTREAM with the exact message `Timed out — check the Foundry chat before retrying.`
- Only validated ids are interpolated into execute-js scripts, **via `JSON.stringify` only** (the `activationScript` rule, `foundry-client/src/index.ts:170`). Regexes: actor `^Actor\.[A-Za-z0-9]{1,32}$`, item `^Actor\.[A-Za-z0-9]{1,32}\.Item\.[A-Za-z0-9]{1,32}$`, token `^Scene\.[A-Za-z0-9]{1,32}\.Token\.[A-Za-z0-9]{1,32}$`, slotKey `^spell[2-9]$`.
- Targets: 1–12 per call, deduped; **only tokenUuids present in the encounter view's visible roster** may be targeted (hidden combatants never leave the gateway, so they are untargetable by construction).
- Exact NPC HP never serialized (M22 rule). The outcome's `applied` damage number is allowed; remaining HP is not.
- Ownership on every actor route: 404, never 403 (do not leak actor existence). Error bodies `{ error: { code, message } }` via `sendError`; codes from the existing `ErrorCode` union only.
- Every relay await in routes is bounded (M18 pattern) EXCEPT the `use-on-targets` execute-js call, which relies on the relay's own 408 and the timeout-tolerance mapping above (mirrors `cast-at-slot`).
- All rules resolution (hit, saves, resistances, temp-HP order) happens inside Foundry — no dnd5e damage math in gateway/adapters/web.
- Run tests per package: `pnpm --filter @companion/foundry-client test`, `pnpm --filter gateway test`, `pnpm --filter @companion/adapter-dnd5e test`; typecheck: `pnpm -r typecheck`.

## File Structure

| File | Responsibility |
|---|---|
| `packages/foundry-client/src/index.ts` (modify) | `useAbilityOnTargets` orchestration + `endCombatTurn`, `postChatNote`, `getDerivedAc` + result types |
| `packages/foundry-client/test/client.test.ts` (modify) | script-generation/injection/validation tests (mocked fetch) |
| `apps/gateway/src/encounters.ts` (modify) | `tokenUuid` plumbing, `current()`, `combatantByActorId()` |
| `apps/gateway/test/encounters.test.ts` (modify) | plumbing tests |
| `packages/adapter-sdk/src/index.ts` (modify) | intent `targetTokenUuids`, `targeting` metadata, `use-on-targets` RelayAction, `AdapterIO.getDerivedAc` |
| `packages/adapter-dnd5e/src/index.ts` (modify) | `targetingOf()`, buildActions metadata, buildAction targeted paths, enrich AC override |
| `packages/adapter-dnd5e/test/actions.test.ts` (modify) | fixture tests |
| `apps/gateway/src/movement-budget.ts` (create) | pure per-turn budget tracker |
| `apps/gateway/test/movement-budget.test.ts` (create) | pure-module tests |
| `apps/gateway/src/app.ts` (modify) | RelayPort additions, `use-on-targets` case, turn-end route, budget wiring, dash route, AC io wiring |
| `apps/gateway/test/app.test.ts` (modify) | route tests |
| `apps/gateway/test/fakes.ts` (modify) | FakeRelay additions |
| `docs/API.md` (modify) | new/changed endpoints |
| `apps/web/app/types/api.ts` (modify) | outcome/targeting/budget wire types |
| `apps/web/app/components/CombatTargetSheet.vue` (create) | multi-select combat target picker |
| `apps/web/app/components/ActionOutcomeSheet.vue` (create) | per-target outcome card |
| `apps/web/app/components/InitiativeCarousel.vue` (modify) | End-turn button |
| `apps/web/app/components/DiceTray.vue` (modify) | raised position during combat |
| `apps/web/app/components/MoveSheet.vue` (modify) | budget chip, Dash, off-turn state |
| `apps/web/app/pages/actor/[id].vue` (modify) | wiring for all of the above |
| `apps/web/mock/server.mjs` (modify) | outcome + budget + targeting fixtures |
| `e2e/combat-targeting-live-check.md` (create) | live verification script/checklist |

---

### Task 1: foundry-client — `useAbilityOnTargets` orchestration

**Files:**
- Modify: `packages/foundry-client/src/index.ts`
- Test: `packages/foundry-client/test/client.test.ts`

**Interfaces:**
- Consumes: existing `private executeActivation(script)` (`index.ts:454`), the `activationScript` conventions (`index.ts:170`).
- Produces (used by Tasks 4–5, 9):

```ts
export interface TargetedUseOptions {
  targetTokenUuids: string[];
  slotKey?: string;
  mode?: 'advantage' | 'disadvantage';
}
export interface TargetedDamagePart { type: string; value: number }
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
```
- `useAbilityOnTargets(actorUuid: string, itemUuid: string, opts: TargetedUseOptions): Promise<TargetedUseResult>`

- [ ] **Step 1: Write the failing tests**

Append to `packages/foundry-client/test/client.test.ts` (reuse the existing `mockFetch` setup used by the castAtSlot tests):

```ts
describe('FoundryRelayClient.useAbilityOnTargets', () => {
  let client: FoundryRelayClient;
  beforeEach(() => {
    vi.clearAllMocks();
    client = new FoundryRelayClient({ baseUrl: 'http://relay:3010', apiKey: 'k', clientId: 'fvtt_x' });
  });

  function okExec(result: unknown) {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200, text: vi.fn(),
      json: vi.fn().mockResolvedValueOnce({ success: true, result }),
    });
  }

  const RESULT = { attack: { total: 19, formula: '1d20+7', isCritical: false, isFumble: false },
    targets: [{ tokenUuid: 'Scene.s1.Token.t1', name: 'Skeleton', outcome: 'hit',
      damage: { rolled: [{ type: 'slashing', value: 12 }], applied: 6 } }] };

  it('POSTs /execute-js with a script interpolating only JSON.stringified ids', async () => {
    okExec(RESULT);
    const res = await client.useAbilityOnTargets('Actor.a1', 'Actor.a1.Item.i1',
      { targetTokenUuids: ['Scene.s1.Token.t1'] });
    const [url, init] = mockFetch.mock.calls[0] as [string, { body: string; method: string }];
    expect(url).toContain('/execute-js');
    expect(init.method).toBe('POST');
    const script = (JSON.parse(init.body) as { script: string }).script;
    expect(script).toContain('"Actor.a1.Item.i1"');
    expect(script).toContain('["Scene.s1.Token.t1"]');
    expect(script).toContain('applyDamage');
    expect(script).toContain('measuredTemplate: false');
    expect(res.targets[0]?.outcome).toBe('hit');
    expect(res.attack?.total).toBe(19);
  });

  it('threads slotKey and advantage mode into the script', async () => {
    okExec({ attack: null, targets: [] });
    await client.useAbilityOnTargets('Actor.a1', 'Actor.a1.Item.i1',
      { targetTokenUuids: ['Scene.s1.Token.t1'], slotKey: 'spell3', mode: 'advantage' });
    const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
    const script = (JSON.parse(init.body) as { script: string }).script;
    expect(script).toContain('"spell3"');
    expect(script).toContain('advantage: true');
  });

  it('rejects bad target uuids, bad slot keys, and >12 targets without any fetch', async () => {
    await expect(client.useAbilityOnTargets('Actor.a1', 'Actor.a1.Item.i1',
      { targetTokenUuids: ['Token.t1'] })).rejects.toThrow(/invalid target/);
    await expect(client.useAbilityOnTargets('Actor.a1', 'Actor.a1.Item.i1',
      { targetTokenUuids: ['Scene.s1.Token.t1'], slotKey: 'spell1' })).rejects.toThrow(/slotKey/);
    await expect(client.useAbilityOnTargets('Actor.a1', 'Actor.a1.Item.i1',
      { targetTokenUuids: Array.from({ length: 13 }, (_, i) => `Scene.s1.Token.t${i}`) }))
      .rejects.toThrow(/1-12/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('script injection is impossible via a crafted-looking (but invalid) uuid', async () => {
    await expect(client.useAbilityOnTargets('Actor.a1', 'Actor.a1.Item.i1',
      { targetTokenUuids: ['Scene.s1.Token.t1"); game.deleteAll(); ("'] })).rejects.toThrow(/invalid target/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('normalizes a missing/garbled result to an empty target list', async () => {
    okExec({ nonsense: true });
    const res = await client.useAbilityOnTargets('Actor.a1', 'Actor.a1.Item.i1',
      { targetTokenUuids: ['Scene.s1.Token.t1'] });
    expect(res.attack).toBeNull();
    expect(res.targets).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @companion/foundry-client test`
Expected: FAIL — `useAbilityOnTargets is not a function`.

- [ ] **Step 3: Implement**

Add to `packages/foundry-client/src/index.ts` — the interfaces above (near `RollResult`), the script builder (below `activationScript`), and the method (below `useWithoutTemplate`).

```ts
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
    `    const agg = dnd5e.dice.aggregateDamageRolls(dmgRolls, { respectProperties: true });`,
    `    damages = agg.map((r) => ({ value: r.total, type: r.options.type, properties: new Set(r.options.properties ?? []) }));`,
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
```

Method (validation mirrors `castAtSlot`):

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @companion/foundry-client test`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add packages/foundry-client/src/index.ts packages/foundry-client/test/client.test.ts
git commit -m "feat(foundry-client): useAbilityOnTargets execute-js orchestration"
```

---

### Task 2: foundry-client — `endCombatTurn`, `postChatNote`, `getDerivedAc`

**Files:**
- Modify: `packages/foundry-client/src/index.ts`
- Test: `packages/foundry-client/test/client.test.ts`

**Interfaces:**
- Produces (used by Tasks 6–8):
  - `endCombatTurn(expectedCombatantId: string): Promise<{ advanced: boolean; reason?: string; round?: number; turn?: number }>`
  - `postChatNote(actorUuid: string, text: string): Promise<void>` — best-effort chat message speaking as the actor; text ≤ 100 chars, `<`/`>` stripped.
  - `getDerivedAc(actorUuid: string): Promise<number | null>` — the PREPARED actor's `system.attributes.ac.value` (null on any failure; never throws).

- [ ] **Step 1: Write the failing tests**

```ts
describe('FoundryRelayClient combat/turn helpers', () => {
  let client: FoundryRelayClient;
  beforeEach(() => {
    vi.clearAllMocks();
    client = new FoundryRelayClient({ baseUrl: 'http://relay:3010', apiKey: 'k', clientId: 'fvtt_x' });
  });
  function okExec(result: unknown) {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200, text: vi.fn(),
      json: vi.fn().mockResolvedValueOnce({ success: true, result }),
    });
  }

  it('endCombatTurn guards on the expected combatant inside the script', async () => {
    okExec({ advanced: true, round: 2, turn: 1 });
    const res = await client.endCombatTurn('comb1');
    const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
    const script = (JSON.parse(init.body) as { script: string }).script;
    expect(script).toContain('"comb1"');
    expect(script).toContain('nextTurn');
    expect(res.advanced).toBe(true);
  });

  it('endCombatTurn rejects a bad combatant id without fetching', async () => {
    await expect(client.endCombatTurn('bad id!')).rejects.toThrow(/invalid combatantId/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('postChatNote strips angle brackets and truncates to 100 chars', async () => {
    okExec({ ok: true });
    await client.postChatNote('Actor.a1', `<b>Dash!</b>${'x'.repeat(200)}`);
    const [, init] = mockFetch.mock.calls[0] as [string, { body: string }];
    const script = (JSON.parse(init.body) as { script: string }).script;
    expect(script).not.toContain('<b>');
    expect(script).toContain('ChatMessage.create');
  });

  it('getDerivedAc returns the number and null on failure', async () => {
    okExec({ ac: 14 });
    expect(await client.getDerivedAc('Actor.a1')).toBe(14);
    mockFetch.mockRejectedValueOnce(new Error('boom'));
    expect(await client.getDerivedAc('Actor.a1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @companion/foundry-client test` → FAIL (methods missing).

- [ ] **Step 3: Implement**

```ts
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
  return { advanced, ...(reason !== undefined ? { reason } : {}) };
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
```

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @companion/foundry-client test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/foundry-client/src/index.ts packages/foundry-client/test/client.test.ts
git commit -m "feat(foundry-client): endCombatTurn, postChatNote, getDerivedAc execute-js helpers"
```

---

### Task 3: gateway EncounterManager — tokenUuid plumbing + turn accessors

**Files:**
- Modify: `apps/gateway/src/encounters.ts`
- Test: `apps/gateway/test/encounters.test.ts`

**Interfaces:**
- `CombatantRecord` and `EncounterCombatantView` gain `tokenUuid?: string`.
- Produces (used by Tasks 5–7):
  - `current(): { combatId: string; round: number; combatantId: string; actorId?: string } | null` — the acting combatant (null when inactive or the acting combatant is hidden — same rule as `view().turn`).
  - `combatantByActorId(actorId: string): CombatantRecord | undefined` — first non-hidden combatant for the actor.

- [ ] **Step 1: Write the failing tests**

Append to `apps/gateway/test/encounters.test.ts` (reuse its existing FakeRelay + manager harness; seed shapes mirror existing tests):

```ts
describe('tokenUuid plumbing + turn accessors', () => {
  it('carries tokenUuid from REST combatants into the view', async () => {
    const relay = new FakeRelay();
    relay.entities.set('Actor.a1', actorDoc('a1', 'Hero', 10, 10));
    relay.encounters = [{
      id: 'c1', round: 1, turn: 0, current: true,
      combatants: [
        { id: 'comb1', name: 'Hero', actorUuid: 'Actor.a1', tokenUuid: 'Scene.s1.Token.t1', initiative: 15 },
        { id: 'comb2', name: 'Skeleton', tokenUuid: 'Scene.s1.Token.t2', initiative: 10 },
      ],
    }];
    const mgr = new EncounterManager({ relay, fetchTimeoutMs: 50 });
    await mgr.start();
    const view = mgr.view();
    expect(view.combatants?.[0]?.tokenUuid).toBe('Scene.s1.Token.t1');
    expect(view.combatants?.[1]?.tokenUuid).toBe('Scene.s1.Token.t2');
    mgr.stop();
  });

  it('drops a tokenUuid that is not a full Scene.*.Token.* uuid', async () => {
    const relay = new FakeRelay();
    relay.encounters = [{
      id: 'c1', round: 1, turn: 0, current: true,
      combatants: [{ id: 'comb1', name: 'X', tokenUuid: 't1-bare-id', initiative: 5 }],
    }];
    const mgr = new EncounterManager({ relay, fetchTimeoutMs: 50 });
    await mgr.start();
    expect(mgr.view().combatants?.[0]?.tokenUuid).toBeUndefined();
    mgr.stop();
  });

  it('builds tokenUuid from hook-frame tokenId + the combat doc scene', async () => {
    const relay = new FakeRelay();
    const mgr = new EncounterManager({ relay, fetchTimeoutMs: 50 });
    await mgr.start();
    relay.emitUpdateCombat({
      _id: 'c1', round: 1, turn: 0, scene: 's1',
      combatants: [{ _id: 'comb1', name: 'Hero', actorId: 'a1', tokenId: 't1', initiative: 12 }],
    });
    expect(mgr.view().combatants?.[0]?.tokenUuid).toBe('Scene.s1.Token.t1');
    mgr.stop();
  });

  it('current() returns the acting combatant; combatantByActorId finds by actor', async () => {
    const relay = new FakeRelay();
    relay.encounters = [{
      id: 'c1', round: 2, turn: 0, current: true,
      combatants: [
        { id: 'comb1', name: 'Hero', actorUuid: 'Actor.a1', initiative: 15 },
        { id: 'comb2', name: 'Skel', initiative: 10 },
      ],
    }];
    const mgr = new EncounterManager({ relay, fetchTimeoutMs: 50 });
    await mgr.start();
    expect(mgr.current()).toEqual({ combatId: 'c1', round: 2, combatantId: 'comb1', actorId: 'a1' });
    expect(mgr.combatantByActorId('a1')?.id).toBe('comb1');
    expect(mgr.combatantByActorId('nope')).toBeUndefined();
    mgr.stop();
  });

  it('current() is null when inactive', () => {
    const mgr = new EncounterManager({ relay: new FakeRelay(), fetchTimeoutMs: 50 });
    expect(mgr.current()).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter gateway test -- encounters` → FAIL.

- [ ] **Step 3: Implement**

In `apps/gateway/src/encounters.ts`:

1. `EncounterCombatantView` (`:24`) and `CombatantRecord` (`:49`): add `tokenUuid?: string;` with the comment `/** Full "Scene.<id>.Token.<id>" uuid — the combat target picker's currency (2026-07-22). Only set when well-formed. */`
2. Add near `actorIdFromUuid`:

```ts
const TOKEN_UUID_RE = /^Scene\.[A-Za-z0-9]{1,32}\.Token\.[A-Za-z0-9]{1,32}$/;

/** REST combatants carry tokenUuid directly; anything not a full
 *  Scene.*.Token.* uuid is dropped rather than guessed. */
function normalizeTokenUuid(raw: unknown): string | undefined {
  return typeof raw === 'string' && TOKEN_UUID_RE.test(raw) ? raw : undefined;
}
```

3. `normalizeRestCombatant` (`:468`): add `const tokenUuid = normalizeTokenUuid(c.tokenUuid);` and spread `...(tokenUuid !== undefined ? { tokenUuid } : {})`.
4. `normalizeHookCombat` (`:481`): read `const sceneId = typeof raw.scene === 'string' && raw.scene !== '' ? raw.scene : undefined;` and pass it into `normalizeHookCombatant(c, sceneId)`.
5. `normalizeHookCombatant` (`:493`): new second param `sceneId?: string`; build `const tokenUuid = sceneId !== undefined && typeof raw.tokenId === 'string' && raw.tokenId !== '' ? normalizeTokenUuid(`Scene.${sceneId}.Token.${raw.tokenId}`) : undefined;` and spread it.
6. `toCombatantView` (`:199`): spread `...(c.tokenUuid !== undefined ? { tokenUuid: c.tokenUuid } : {})`.
7. Add to the class (below `combatant()`):

```ts
/** The acting combatant (2026-07-22 turn flow): null when inactive or when
 *  the acting combatant is hidden — identical visibility rule to view().turn. */
current(): { combatId: string; round: number; combatantId: string; actorId?: string } | null {
  if (!this.isActive()) return null;
  const combat = this.combat as CombatRecord;
  const id = this.view().turn?.combatantId ?? null;
  if (id === null) return null;
  const rec = this.combatant(id);
  if (!rec) return null;
  return {
    combatId: combat.id,
    round: combat.round,
    combatantId: id,
    ...(rec.actorId !== undefined ? { actorId: rec.actorId } : {}),
  };
}

/** First non-hidden combatant linked to this actor (movement budget / End
 *  turn both key on it). */
combatantByActorId(actorId: string): CombatantRecord | undefined {
  return this.combat?.combatants.find((c) => c.actorId === actorId && !c.hidden);
}
```

- [ ] **Step 4: Run to verify pass** — `pnpm --filter gateway test` → PASS (all).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/encounters.ts apps/gateway/test/encounters.test.ts
git commit -m "feat(gateway): tokenUuid plumbing + current()/combatantByActorId on EncounterManager"
```

---

### Task 4: adapter-sdk + adapter-dnd5e — targeted intents & `use-on-targets`

**Files:**
- Modify: `packages/adapter-sdk/src/index.ts`
- Modify: `packages/adapter-dnd5e/src/index.ts`
- Test: `packages/adapter-dnd5e/test/actions.test.ts`

**Interfaces:**
- adapter-sdk `ActionIntent`: `attack`, `use`, and `cast` variants gain `targetTokenUuids?: string[]`.
- adapter-sdk `ActionDescriptor` gains:

```ts
/** In-combat targeting capability (2026-07-22): absent = untargetable (the
 *  action keeps today's untargeted flow). mode 'multiple' only for
 *  save-vs-DC actions (Fireball can hit several combatants, friends
 *  included); attacks and heals are single-target in v1. */
targeting?: { mode: 'single' | 'multiple'; kind: 'attack' | 'save' | 'heal' };
```

- adapter-sdk `RelayAction` gains:

```ts
/** Targeted use (2026-07-22): one execute-js orchestration — target →
 *  activity.use → attack/save resolution → damage roll → dnd5e applyDamage
 *  per target. Foundry owns ALL rules; the gateway validates targets
 *  against the visible encounter roster and never retries (side effects). */
| {
    endpoint: 'use-on-targets';
    itemId: string;
    targetTokenUuids: string[];
    slotKey?: string;
    mode?: 'advantage' | 'disadvantage';
  }
```

- adapter-sdk `AdapterIO` gains `getDerivedAc?(): Promise<number | null>;` (used in Task 8).
- adapter-dnd5e produces `targetingOf(item)` metadata on descriptors and targeted `buildAction` paths.

- [ ] **Step 1: Write the failing tests**

Append to `packages/adapter-dnd5e/test/actions.test.ts` (reuse the captured `martial`/`caster` fixtures used by existing tests; adjust item ids to the fixture's actual ids as the neighboring tests do):

```ts
describe('combat targeting metadata + use-on-targets (2026-07-22)', () => {
  it('equipped weapon attack descriptors carry single/attack targeting', () => {
    const actions = dnd5eAdapter.actions!(martial);
    const attack = actions.find((a) => a.kind === 'attack');
    expect(attack?.targeting).toEqual({ mode: 'single', kind: 'attack' });
  });

  it('attack-roll damage spells target single; save-damage spells target multiple; heals single', () => {
    const actions = dnd5eAdapter.actions!(caster);
    const fireBolt = actions.find((a) => a.kind === 'cast' && a.label.includes('Fire Bolt'));
    expect(fireBolt?.targeting).toEqual({ mode: 'single', kind: 'attack' });
    const sacredFlame = actions.find((a) => a.kind === 'cast' && a.label.includes('Sacred Flame'));
    expect(sacredFlame?.targeting).toEqual({ mode: 'multiple', kind: 'save' });
    const cureWounds = actions.find((a) => a.kind === 'cast' && a.label.includes('Cure Wounds'));
    expect(cureWounds?.targeting).toEqual({ mode: 'single', kind: 'heal' });
  });

  it('attack intent with a target builds use-on-targets (mode passthrough)', () => {
    const actions = dnd5eAdapter.actions!(martial);
    const attack = actions.find((a) => a.kind === 'attack')!;
    const action = dnd5eAdapter.buildAction!(martial, {
      kind: 'attack', actionId: attack.id, mode: 'advantage',
      targetTokenUuids: ['Scene.s1.Token.t1'],
    });
    expect(action).toMatchObject({
      endpoint: 'use-on-targets',
      targetTokenUuids: ['Scene.s1.Token.t1'],
      mode: 'advantage',
    });
  });

  it('single-target actions reject multiple targets', () => {
    const actions = dnd5eAdapter.actions!(martial);
    const attack = actions.find((a) => a.kind === 'attack')!;
    expect(() =>
      dnd5eAdapter.buildAction!(martial, {
        kind: 'attack', actionId: attack.id,
        targetTokenUuids: ['Scene.s1.Token.t1', 'Scene.s1.Token.t2'],
      }),
    ).toThrow(/single target/);
  });

  it('targeted upcast cast threads slotKey into use-on-targets', () => {
    const actions = dnd5eAdapter.actions!(caster);
    const dmgSpell = actions.find(
      (a) => a.kind === 'cast' && a.targeting?.kind === 'save' && (a.slotLevels?.length ?? 0) > 1,
    )!;
    const chosen = dmgSpell.slotLevels![dmgSpell.slotLevels!.length - 1]!;
    const action = dnd5eAdapter.buildAction!(caster, {
      kind: 'cast', actionId: dmgSpell.id, slotLevel: chosen,
      targetTokenUuids: ['Scene.s1.Token.t1', 'Scene.s1.Token.t2'],
    });
    expect(action).toMatchObject({ endpoint: 'use-on-targets', slotKey: `spell${chosen}` });
  });

  it('untargetable actions reject targets', () => {
    expect(() =>
      dnd5eAdapter.buildAction!(martial, {
        kind: 'check', actionId: 'skill.ath',
        // check intents have no targetTokenUuids field — cast an any to prove
        // the runtime guard, not just the compiler, rejects it:
      } as never),
    ).not.toThrow(); // baseline: kind check unaffected
    const actions = dnd5eAdapter.actions!(caster);
    const utility = actions.find((a) => a.kind === 'cast' && a.targeting === undefined);
    if (utility) {
      expect(() =>
        dnd5eAdapter.buildAction!(caster, {
          kind: 'cast', actionId: utility.id, targetTokenUuids: ['Scene.s1.Token.t1'],
        }),
      ).toThrow(/does not support targets/);
    }
  });
});
```

(Adjust spell names to what the caster fixture actually contains — the neighboring effectType tests name the real ones; keep at least one attack-roll cantrip, one save-with-damage spell, one heal.)

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @companion/adapter-dnd5e test` → FAIL.

- [ ] **Step 3: Implement adapter-sdk types**

In `packages/adapter-sdk/src/index.ts`: extend the three `ActionIntent` variants —

```ts
| { kind: 'attack'; actionId: string; mode?: 'advantage' | 'disadvantage'; targetTokenUuids?: string[] }
| { kind: 'use'; actionId: string; targetTokenUuids?: string[] }
| { kind: 'cast'; actionId: string; slotLevel?: number; targetActorId?: string; targetTokenUuids?: string[] }
```

Add the `targeting` field to `ActionDescriptor`, the `use-on-targets` variant to `RelayAction`, and `getDerivedAc?(): Promise<number | null>;` to `AdapterIO` (doc comments as in Interfaces above).

- [ ] **Step 4: Implement adapter-dnd5e**

In `packages/adapter-dnd5e/src/index.ts`:

1. Add below `effectTypeOf` (`:1573`):

```ts
/**
 * In-combat targeting capability (2026-07-22): attack-roll damage → single
 * target; save-vs-DC damage → multiple (Fireball can catch several
 * combatants, friends included); heals → single. Utility-roll damage items
 * (Bead of Force's split activities) stay untargeted in v1 — their damage
 * has no per-target resolution rule to apply.
 */
function targetingOf(item: FoundryItemDoc): { mode: 'single' | 'multiple'; kind: 'attack' | 'save' | 'heal' } | undefined {
  const et = effectTypeOf(item);
  if (et === 'heal') return { mode: 'single', kind: 'heal' };
  if (et !== 'damage') return undefined;
  const acts = allActivities(item);
  if (acts.some((a) => a.type === 'attack')) return { mode: 'single', kind: 'attack' };
  if (acts.some((a) => a.type === 'save')) return { mode: 'multiple', kind: 'save' };
  return undefined;
}
```

2. `buildActions`: attach metadata —
   - weapon attack (`:1946`): `out.push({ id: ..., kind: 'attack', targeting: { mode: 'single', kind: 'attack' } })`
   - item use (`:1954`), spell cast (`:1989`), feature use (`:2031`): spread `...(targetingOf(item) !== undefined ? { targeting: targetingOf(item) } : {})` (compute once into a local).

3. `buildAction`: add a shared validation helper above the switch —

```ts
const targeted = 'targetTokenUuids' in intent && Array.isArray(intent.targetTokenUuids) && intent.targetTokenUuids.length > 0
  ? intent.targetTokenUuids
  : undefined;
if (targeted !== undefined) {
  if (descriptor.targeting === undefined) {
    throw new IntentError(`action "${intent.actionId}" does not support targets`, 'INVALID');
  }
  if (descriptor.targeting.mode === 'single' && targeted.length !== 1) {
    throw new IntentError(`action "${intent.actionId}" takes a single target`, 'INVALID');
  }
}
```

   - `'attack'` case (`:2111`): before the existing mode fork — `if (targeted !== undefined) { const itemId = intent.actionId.slice('item.'.length, -'.attack'.length); return { endpoint: 'use-on-targets', itemId, targetTokenUuids: targeted, ...(mode !== undefined ? { mode } : {}) }; }`
   - `'cast'` case (`:2209`): after `chosen`/`upcast` are resolved (so slot validation still runs) and BEFORE the buff/heal forks — `if (targeted !== undefined) { return { endpoint: 'use-on-targets', itemId, targetTokenUuids: targeted, ...(upcast ? { slotKey: `spell${chosen}` } : {}) }; }`
   - `'use'` case (`:2167`): at the top of both item and feature branches, after the attunement gate — `if (targeted !== undefined) { return { endpoint: 'use-on-targets', itemId, targetTokenUuids: targeted }; }`

- [ ] **Step 5: Run to verify pass** — `pnpm --filter @companion/adapter-dnd5e test && pnpm --filter @companion/adapter-sdk test` (if sdk has tests) → PASS. `pnpm -r typecheck` — expect the gateway/fakes to still compile (new intent fields are optional; new RelayAction endpoint is additive but `app.ts`'s switch on `action.endpoint` must stay exhaustive — if the compiler flags the missing case there, add a temporary `case 'use-on-targets': return sendError(reply, 422, 'INVALID_INTENT', 'not wired yet');` and note Task 5 replaces it).

- [ ] **Step 6: Commit**

```bash
git add packages/adapter-sdk/src/index.ts packages/adapter-dnd5e/src/index.ts packages/adapter-dnd5e/test/actions.test.ts
git commit -m "feat(adapter): targeting metadata + use-on-targets relay action"
```

---

### Task 5: gateway — `use-on-targets` route case + outcome wire shape

**Files:**
- Modify: `apps/gateway/src/app.ts`
- Modify: `apps/gateway/test/fakes.ts`
- Test: `apps/gateway/test/app.test.ts`
- Modify: `docs/API.md`

**Interfaces:**
- Consumes: `relay.useAbilityOnTargets` (Task 1), `encounterManager.view()` roster with `tokenUuid` (Task 3), `use-on-targets` RelayAction (Task 4).
- Produces: `POST /api/actors/:id/actions` response gains `outcome?: TargetedUseResult` (wire shape consumed by Task 9). `RelayPort` gains `useAbilityOnTargets`.

- [ ] **Step 1: Extend FakeRelay + fakeAdapter**

In `apps/gateway/test/fakes.ts`:

```ts
// ---- targeted use (2026-07-22) --------------------------------------------
readonly useOnTargetsCalls: Array<{
  actorUuid: string; itemUuid: string;
  opts: { targetTokenUuids: string[]; slotKey?: string; mode?: 'advantage' | 'disadvantage' };
}> = [];
useOnTargetsResult: {
  attack: { total: number; formula: string; isCritical: boolean; isFumble: boolean } | null;
  targets: Array<Record<string, unknown>>;
} = { attack: null, targets: [] };
/** RelayError-shaped 408, mirrors useAbilityTimeout. */
useOnTargetsTimeout = false;

async useAbilityOnTargets(
  actorUuid: string,
  itemUuid: string,
  opts: { targetTokenUuids: string[]; slotKey?: string; mode?: 'advantage' | 'disadvantage' },
): Promise<typeof this.useOnTargetsResult> {
  this.useOnTargetsCalls.push({ actorUuid, itemUuid, opts: structuredClone(opts) });
  if (this.useOnTargetsTimeout) {
    const err = new Error('relay /execute-js -> 408: request timed out') as Error & { status: number };
    err.name = 'RelayError';
    err.status = 408;
    throw err;
  }
  if (this.actionError) this.throwActionError('execute-js');
  return structuredClone(this.useOnTargetsResult);
}
```

In `fakeAdapter`'s `actionList`, add:

```ts
{ id: 'item.i1.tattack', label: 'Sword', kind: 'attack', targeting: { mode: 'single', kind: 'attack' } },
{ id: 'spell.f1.cast', label: 'Fireball', kind: 'cast', slotLevels: [3, 4], effectType: 'damage',
  targeting: { mode: 'multiple', kind: 'save' } },
```

And in `buildAction`: for `item.i1.tattack` with `intent.targetTokenUuids?.length` return `{ endpoint: 'use-on-targets', itemId: 'i1', targetTokenUuids: intent.targetTokenUuids, ...(intent.mode !== undefined ? { mode: intent.mode } : {}) }`; for `spell.f1.cast` with targets return `{ endpoint: 'use-on-targets', itemId: 'f1', targetTokenUuids: intent.targetTokenUuids, ...(intent.slotLevel === 4 ? { slotKey: 'spell4' } : {}) }` (single-target `item.i1.tattack` throws `IntentError('takes a single target', 'INVALID')` on length > 1 — mirror the real adapter).

- [ ] **Step 2: Write the failing route tests**

Append to `apps/gateway/test/app.test.ts`. Reuse the harness's `buildApp` injection; where these tests need an encounter, construct an `EncounterManager` over the same FakeRelay (the `encounters.test.ts` pattern) with roster:

```ts
relay.encounters = [{
  id: 'c1', round: 1, turn: 0, current: true,
  combatants: [
    { id: 'comb1', name: 'Hero', actorUuid: 'Actor.a1', tokenUuid: 'Scene.s1.Token.t1', initiative: 15 },
    { id: 'comb2', name: 'Skeleton', tokenUuid: 'Scene.s1.Token.t2', initiative: 10 },
  ],
}];
```

Tests:

```ts
it('POST actions with targets executes use-on-targets and returns the outcome', async () => {
  relay.useOnTargetsResult = {
    attack: { total: 19, formula: '1d20+7', isCritical: false, isFumble: false },
    targets: [{ tokenUuid: 'Scene.s1.Token.t2', name: 'Skeleton', outcome: 'hit',
      damage: { rolled: [{ type: 'slashing', value: 12 }], applied: 6 } }],
  };
  const res = await app.inject({
    method: 'POST', url: '/api/actors/a1/actions', headers: authHeaders,
    payload: { kind: 'attack', actionId: 'item.i1.tattack', targetTokenUuids: ['Scene.s1.Token.t2'] },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { outcome?: { targets: Array<{ outcome: string }> }; result: unknown };
  expect(body.outcome?.targets[0]?.outcome).toBe('hit');
  expect((body.result as { total: number }).total).toBe(19); // attack feeds the roll pill
  expect(relay.useOnTargetsCalls[0]?.opts.targetTokenUuids).toEqual(['Scene.s1.Token.t2']);
});

it('rejects a target not in the visible encounter roster (403)', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/actors/a1/actions', headers: authHeaders,
    payload: { kind: 'attack', actionId: 'item.i1.tattack', targetTokenUuids: ['Scene.s1.Token.tX'] },
  });
  expect(res.statusCode).toBe(403);
  expect(relay.useOnTargetsCalls).toHaveLength(0); // gate BEFORE the relay call
});

it('rejects targeted actions when no encounter is active (409)', async () => {
  // harness without encounters seeded / manager inactive
  const res = await app.inject({
    method: 'POST', url: '/api/actors/a1/actions', headers: authHeaders,
    payload: { kind: 'attack', actionId: 'item.i1.tattack', targetTokenUuids: ['Scene.s1.Token.t2'] },
  });
  expect(res.statusCode).toBe(409);
});

it('maps a relay 408 to 502 with the check-Foundry-chat message and NO retry', async () => {
  relay.useOnTargetsTimeout = true;
  const res = await app.inject({
    method: 'POST', url: '/api/actors/a1/actions', headers: authHeaders,
    payload: { kind: 'attack', actionId: 'item.i1.tattack', targetTokenUuids: ['Scene.s1.Token.t2'] },
  });
  expect(res.statusCode).toBe(502);
  expect((res.json() as { error: { message: string } }).error.message)
    .toBe('Timed out — check the Foundry chat before retrying.');
  expect(relay.useOnTargetsCalls).toHaveLength(1); // exactly one attempt
});

it('parseActionIntent rejects malformed target lists (422)', async () => {
  for (const bad of [['not-a-uuid'], [], ['Scene.s1.Token.t2', 'Scene.s1.Token.t2'],
    Array.from({ length: 13 }, (_, i) => `Scene.s1.Token.t${i}`)]) {
    const res = await app.inject({
      method: 'POST', url: '/api/actors/a1/actions', headers: authHeaders,
      payload: { kind: 'attack', actionId: 'item.i1.tattack', targetTokenUuids: bad },
    });
    expect(res.statusCode).toBe(422);
  }
});
```

- [ ] **Step 3: Run to verify failure** — `pnpm --filter gateway test -- app` → FAIL.

- [ ] **Step 4: Implement**

In `apps/gateway/src/app.ts`:

1. `RelayPort`: add `useAbilityOnTargets(actorUuid: string, itemUuid: string, opts: { targetTokenUuids: string[]; slotKey?: string; mode?: 'advantage' | 'disadvantage' }): Promise<{ attack: { total: number; formula: string; isCritical: boolean; isFumble: boolean } | null; targets: Array<Record<string, unknown>> }>;`
2. Add near `TOKEN`-style helpers (above `parseActionIntent`):

```ts
const TARGET_TOKEN_UUID_RE = /^Scene\.[A-Za-z0-9]{1,32}\.Token\.[A-Za-z0-9]{1,32}$/;

/** undefined = field absent; null = malformed (422). 1-12 unique full uuids. */
function parseTargetTokenUuids(raw: unknown): string[] | null | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 12) return null;
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== 'string' || !TARGET_TOKEN_UUID_RE.test(t) || out.includes(t)) return null;
    out.push(t);
  }
  return out;
}
```

3. `parseActionIntent`: in the `'attack'`, `'use'`, and `'cast'` cases, parse `body.targetTokenUuids` via the helper (`null` → return null; spread when defined). For `'attack'` this means restructuring the early return into an object build like `'cast'`'s.
4. Route switch (`app.ts:1210`): new case —

```ts
case 'use-on-targets': {
  // Targets are only meaningful during a live encounter; the visible roster
  // is the whole legal surface (hidden combatants never reach the view, so
  // they are untargetable by construction — Global Constraints).
  const mgr = deps.encounters;
  if (!mgr || !mgr.isActive()) return sendError(reply, 409, 'CONFLICT', 'no active encounter');
  const roster = new Set(
    (mgr.view().combatants ?? []).map((c) => c.tokenUuid).filter((t): t is string => typeof t === 'string'),
  );
  for (const t of action.targetTokenUuids) {
    if (!roster.has(t)) return sendError(reply, 403, 'FORBIDDEN_RESOURCE', 'target is not in the encounter');
  }
  try {
    const res = await relay.useAbilityOnTargets(`Actor.${id}`, `Actor.${id}.Item.${action.itemId}`, {
      targetTokenUuids: action.targetTokenUuids,
      ...(action.slotKey !== undefined ? { slotKey: action.slotKey } : {}),
      ...(action.mode !== undefined ? { mode: action.mode } : {}),
    });
    outcome = res;
    result = res.attack !== null ? extractRoll(res.attack) : null;
  } catch (err) {
    // SIDE-EFFECTING — never retried. A relay 408 means the orchestration
    // may have already applied damage in Foundry; retrying could double it.
    if (isRelayTimeout(err)) {
      return sendError(reply, 502, 'UPSTREAM', 'Timed out — check the Foundry chat before retrying.');
    }
    throw err;
  }
  break;
}
```

Declare `let outcome: unknown = null;` next to `let result` (`:1209`) and change the final send (`:1371`) to `return reply.code(200).send({ result, ...(outcome !== null ? { outcome } : {}), sheet: buildSheet(freshAdapter, fresh) });`

5. `docs/API.md`: document `targetTokenUuids` on the actions POST + the `outcome` response field + the 409/403/502 semantics.

- [ ] **Step 5: Run to verify pass** — `pnpm --filter gateway test` → PASS (all). `pnpm -r typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/app.ts apps/gateway/test/fakes.ts apps/gateway/test/app.test.ts docs/API.md
git commit -m "feat(gateway): use-on-targets action route with roster allow-list and outcome payload"
```

---

### Task 6: gateway — `POST /api/encounter/turn/end`

**Files:**
- Modify: `apps/gateway/src/app.ts` (inside the `if (encounterManager)` block, after the hp route)
- Modify: `apps/gateway/test/fakes.ts`
- Test: `apps/gateway/test/app.test.ts`
- Modify: `docs/API.md`

**Interfaces:**
- Consumes: `encounterManager.current()` (Task 3), `relay.endCombatTurn` (Task 2).
- Produces: `POST /api/encounter/turn/end` → 200 `{ ok: true }` | 403 (not your turn) | 409 (no encounter / turn already advanced) | 502.

- [ ] **Step 1: FakeRelay additions**

```ts
readonly endTurnCalls: string[] = [];
endTurnResult: { advanced: boolean; reason?: string } = { advanced: true };
hangEndTurn = false;

async endCombatTurn(expectedCombatantId: string): Promise<{ advanced: boolean; reason?: string }> {
  this.endTurnCalls.push(expectedCombatantId);
  if (this.hangEndTurn) return new Promise(() => undefined);
  return structuredClone(this.endTurnResult);
}
```

- [ ] **Step 2: Write the failing tests** (same encounter-seeded harness as Task 5; `a1` is the acting combatant's actor, owned by the authed player; a second player `other` owns only `a2`):

```ts
it('the acting player ends their turn', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/encounter/turn/end', headers: authHeaders });
  expect(res.statusCode).toBe(200);
  expect(relay.endTurnCalls).toEqual(['comb1']);
});

it('a player who does not own the acting combatant gets 403', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/encounter/turn/end', headers: otherAuthHeaders });
  expect(res.statusCode).toBe(403);
  expect(relay.endTurnCalls).toHaveLength(0);
});

it('no active encounter -> 409', async () => { /* inactive-manager harness */ });

it('turn race (script refuses) -> 409', async () => {
  relay.endTurnResult = { advanced: false, reason: 'not-your-turn' };
  const res = await app.inject({ method: 'POST', url: '/api/encounter/turn/end', headers: authHeaders });
  expect(res.statusCode).toBe(409);
});

it('stalled relay -> 502 (bounded)', async () => {
  relay.hangEndTurn = true;
  const res = await app.inject({ method: 'POST', url: '/api/encounter/turn/end', headers: authHeaders });
  expect(res.statusCode).toBe(502);
});
```

- [ ] **Step 3: Run to verify failure**, then **Step 4: Implement**

```ts
app.post('/api/encounter/turn/end', { preHandler: auth(false) }, async (req, reply) => {
  const player = req.player as Player;
  if (!limiter.allow(player.tokenHash)) return sendError(reply, 429, 'RATE_LIMITED', 'too many write intents');
  const cur = encounterManager.current();
  if (!cur) return sendError(reply, 409, 'CONFLICT', 'no active encounter');
  // Only the acting combatant's owner may advance — GM keeps NPC turns in Foundry.
  if (cur.actorId === undefined || !player.actorIds.includes(cur.actorId)) {
    return sendError(reply, 403, 'FORBIDDEN_RESOURCE', 'not your turn');
  }
  const res = await boundedMs(relay.endCombatTurn(cur.combatantId), encounterFetchTimeoutMs);
  if (res === null) return sendError(reply, 502, 'UPSTREAM', 'upstream error');
  if (!res.advanced) return sendError(reply, 409, 'CONFLICT', 'turn already advanced');
  return reply.code(200).send({ ok: true });
});
```

`RelayPort` gains `endCombatTurn(expectedCombatantId: string): Promise<{ advanced: boolean; reason?: string }>;`. Document in `docs/API.md`.

- [ ] **Step 5: Run to verify pass**, commit:

```bash
git add apps/gateway/src/app.ts apps/gateway/test/fakes.ts apps/gateway/test/app.test.ts docs/API.md
git commit -m "feat(gateway): POST /api/encounter/turn/end (own turn only, race-guarded)"
```

---

### Task 7: gateway — movement budget + dash + in-combat move gating

**Files:**
- Create: `apps/gateway/src/movement-budget.ts`
- Create: `apps/gateway/test/movement-budget.test.ts`
- Modify: `apps/gateway/src/app.ts` (movement GET/POST + new dash route)
- Modify: `apps/gateway/test/fakes.ts` (`postChatNote` fake)
- Test: `apps/gateway/test/app.test.ts`
- Modify: `docs/API.md`

**Interfaces:**
- Consumes: `encounterManager.current()` / `combatantByActorId()` (Task 3), `relay.postChatNote` (Task 2), `chebyshev` (`movement.ts:54`).
- Produces:

```ts
// apps/gateway/src/movement-budget.ts — pure, no I/O
export interface BudgetState { movedFt: number; dashed: boolean }
export class MovementBudgetTracker {
  static key(combatId: string, round: number, combatantId: string): string;
  state(key: string): BudgetState;               // {0,false} default
  addMove(key: string, ft: number): void;
  markDashed(key: string): boolean;              // false when already dashed
  prune(combatId: string, round: number): void;  // drop everything not this combat+round
  clear(): void;
}
```

- Movement view wire fields (flat, per spec): `inCombat?: boolean; yourTurn?: boolean; remainingFt?: number; dashed?: boolean`.
- New route: `POST /api/actors/:id/movement/dash` → 200 with the refreshed movement view | 409 (not in combat / not your turn / already dashed).

- [ ] **Step 1: Write the failing pure-module tests** (`apps/gateway/test/movement-budget.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { MovementBudgetTracker } from '../src/movement-budget.js';

describe('MovementBudgetTracker', () => {
  it('accumulates moves per key and defaults to zero', () => {
    const t = new MovementBudgetTracker();
    const k = MovementBudgetTracker.key('c1', 1, 'comb1');
    expect(t.state(k)).toEqual({ movedFt: 0, dashed: false });
    t.addMove(k, 10); t.addMove(k, 5);
    expect(t.state(k).movedFt).toBe(15);
  });

  it('a new round is a new key — lazy reset', () => {
    const t = new MovementBudgetTracker();
    t.addMove(MovementBudgetTracker.key('c1', 1, 'comb1'), 30);
    expect(t.state(MovementBudgetTracker.key('c1', 2, 'comb1')).movedFt).toBe(0);
  });

  it('markDashed arms once per key', () => {
    const t = new MovementBudgetTracker();
    const k = MovementBudgetTracker.key('c1', 1, 'comb1');
    expect(t.markDashed(k)).toBe(true);
    expect(t.markDashed(k)).toBe(false);
    expect(t.state(k).dashed).toBe(true);
  });

  it('prune drops other rounds/combats but keeps the current one', () => {
    const t = new MovementBudgetTracker();
    t.addMove(MovementBudgetTracker.key('c1', 1, 'comb1'), 10);
    t.addMove(MovementBudgetTracker.key('c1', 2, 'comb1'), 5);
    t.addMove(MovementBudgetTracker.key('cOld', 2, 'combX'), 5);
    t.prune('c1', 2);
    expect(t.state(MovementBudgetTracker.key('c1', 2, 'comb1')).movedFt).toBe(5);
    expect(t.state(MovementBudgetTracker.key('c1', 1, 'comb1')).movedFt).toBe(0);
    expect(t.state(MovementBudgetTracker.key('cOld', 2, 'combX')).movedFt).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement `apps/gateway/src/movement-budget.ts`:

```ts
/**
 * Per-turn movement budget (2026-07-22 combat-targeting spec §F4). Pure
 * in-memory state keyed `combatId:round:combatantId` — a new round is a new
 * key, so budgets reset lazily with no reset logic. Deliberately NOT
 * persisted: a gateway restart refills budgets (soft-cap philosophy).
 */
export interface BudgetState { movedFt: number; dashed: boolean }

export class MovementBudgetTracker {
  private readonly entries = new Map<string, BudgetState>();

  static key(combatId: string, round: number, combatantId: string): string {
    return `${combatId}:${round}:${combatantId}`;
  }

  state(key: string): BudgetState {
    return this.entries.get(key) ?? { movedFt: 0, dashed: false };
  }

  addMove(key: string, ft: number): void {
    const cur = this.state(key);
    this.entries.set(key, { ...cur, movedFt: cur.movedFt + ft });
  }

  /** true when dash armed now; false when already dashed this turn. */
  markDashed(key: string): boolean {
    const cur = this.state(key);
    if (cur.dashed) return false;
    this.entries.set(key, { ...cur, dashed: true });
    return true;
  }

  /** Keep only the current combat+round (called lazily on access). */
  prune(combatId: string, round: number): void {
    const prefix = `${combatId}:${round}:`;
    for (const k of this.entries.keys()) if (!k.startsWith(prefix)) this.entries.delete(k);
  }

  clear(): void {
    this.entries.clear();
  }
}
```

Run: `pnpm --filter gateway test -- movement-budget` → PASS. Commit:

```bash
git add apps/gateway/src/movement-budget.ts apps/gateway/test/movement-budget.test.ts
git commit -m "feat(gateway): pure per-turn movement budget tracker"
```

- [ ] **Step 3: Write the failing route tests** (encounter-seeded harness; actor `a1` = acting combatant `comb1`; grid distance 5, speed 30 via `relay.systemDetails = { stats: { speed: 30 } }`):

```ts
it('GET movement reports combat budget fields', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/actors/a1/movement', headers: authHeaders });
  const mv = (res.json() as { movement: Record<string, unknown> }).movement;
  expect(mv.inCombat).toBe(true);
  expect(mv.yourTurn).toBe(true);
  expect(mv.remainingFt).toBe(30);
  expect(mv.dashed).toBe(false);
});

it('moves consume the budget; beyond remaining -> 422', async () => {
  // token at (3,2): move 4 cells (20ft) then attempt 3 more (15ft > 10 remaining)
  await app.inject({ method: 'POST', url: '/api/actors/a1/movement', headers: authHeaders,
    payload: { cx: 7, cy: 2 } });
  const after = await app.inject({ method: 'GET', url: '/api/actors/a1/movement', headers: authHeaders });
  expect((after.json() as { movement: { remainingFt: number } }).movement.remainingFt).toBe(10);
  const tooFar = await app.inject({ method: 'POST', url: '/api/actors/a1/movement', headers: authHeaders,
    payload: { cx: 10, cy: 2 } });
  expect(tooFar.statusCode).toBe(422);
});

it('moving off-turn in combat -> 409', async () => {
  // seed turn: 1 (comb2 acting) — reuse emitUpdateCombat to flip the turn
  relay.emitUpdateCombat({ _id: 'c1', round: 1, turn: 1, scene: 's1', combatants: [/* same two */] });
  const res = await app.inject({ method: 'POST', url: '/api/actors/a1/movement', headers: authHeaders,
    payload: { cx: 4, cy: 2 } });
  expect(res.statusCode).toBe(409);
});

it('dash doubles the budget once and posts a chat note', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/actors/a1/movement/dash', headers: authHeaders });
  expect(res.statusCode).toBe(200);
  expect((res.json() as { movement: { remainingFt: number; dashed: boolean } }).movement)
    .toMatchObject({ remainingFt: 60, dashed: true });
  expect(relay.chatNoteCalls).toHaveLength(1);
  const again = await app.inject({ method: 'POST', url: '/api/actors/a1/movement/dash', headers: authHeaders });
  expect(again.statusCode).toBe(409);
});

it('a new round refills the budget (lazy reset)', async () => {
  await app.inject({ method: 'POST', url: '/api/actors/a1/movement', headers: authHeaders,
    payload: { cx: 7, cy: 2 } });
  relay.emitUpdateCombat({ _id: 'c1', round: 2, turn: 0, scene: 's1', combatants: [/* same two */] });
  const res = await app.inject({ method: 'GET', url: '/api/actors/a1/movement', headers: authHeaders });
  expect((res.json() as { movement: { remainingFt: number } }).movement.remainingFt).toBe(30);
});

it('out of combat the movement view carries no budget fields', async () => { /* inactive harness */ });
```

FakeRelay: add `readonly chatNoteCalls: Array<{ actorUuid: string; text: string }> = []; async postChatNote(actorUuid: string, text: string): Promise<void> { this.chatNoteCalls.push({ actorUuid, text }); }`.

- [ ] **Step 4: Run to verify failure**, then implement in `app.ts`:

1. `RelayPort` gains `postChatNote(actorUuid: string, text: string): Promise<void>;`
2. Instantiate `const movementBudget = new MovementBudgetTracker();` next to the limiter.
3. Composition helper (near `fetchMovementContext`):

```ts
interface CombatMoveContext {
  inCombat: boolean;
  yourTurn: boolean;
  key?: string;
  remainingFt?: number;
  dashed?: boolean;
}

/** Budget context for this actor (2026-07-22 §F4). Not a combatant (or no
 *  live encounter) -> free movement, exactly like out-of-combat today. */
function combatMoveContext(actorId: string, speedFt: number): CombatMoveContext {
  const mgr = deps.encounters;
  if (!mgr || !mgr.isActive()) return { inCombat: false, yourTurn: false };
  const cur = mgr.current();
  const mine = mgr.combatantByActorId(actorId);
  if (!cur || !mine) return { inCombat: false, yourTurn: false };
  movementBudget.prune(cur.combatId, cur.round);
  const key = MovementBudgetTracker.key(cur.combatId, cur.round, mine.id);
  const st = movementBudget.state(key);
  return {
    inCombat: true,
    yourTurn: mine.id === cur.combatantId,
    key,
    remainingFt: Math.max(0, speedFt * (st.dashed ? 2 : 1) - st.movedFt),
    dashed: st.dashed,
  };
}
```

4. GET movement (`app.ts:1002`): after `result.ctx.view` resolves — `const cc = combatMoveContext(id, result.ctx.view.speedFt ?? 0); return reply.code(200).send({ movement: { ...result.ctx.view, ...(cc.inCombat ? { inCombat: true, yourTurn: cc.yourTurn, remainingFt: cc.remainingFt, dashed: cc.dashed } : {}) } });`
5. POST movement (`app.ts:1017`): after the context resolves and before `validateMove` —

```ts
const cc = combatMoveContext(id, ctx.view.speedFt ?? 0);
if (cc.inCombat && !cc.yourTurn) return sendError(reply, 409, 'CONFLICT', 'not your turn');
const effView = cc.inCombat ? { ...ctx.view, speedFt: cc.remainingFt } : ctx.view;
const verdict = validateMove(effView, target, occupied);
```

and after the successful `moveToken`:

```ts
if (cc.inCombat && cc.key !== undefined && ctx.view.token) {
  movementBudget.addMove(cc.key, chebyshev(ctx.view.token, target) * (ctx.view.gridDistance ?? 5));
}
```

Echo the budget fields on the confirmed view (recompute `combatMoveContext` after `addMove`).
6. Dash route:

```ts
app.post<{ Params: { id: string } }>(
  '/api/actors/:id/movement/dash',
  { preHandler: auth(false) },
  async (req, reply) => {
    const player = req.player as Player;
    const { id } = req.params;
    if (!player.actorIds.includes(id)) return sendError(reply, 404, 'NOT_FOUND', 'actor not found');
    if (!limiter.allow(player.tokenHash)) return sendError(reply, 429, 'RATE_LIMITED', 'too many write intents');
    const result = await fetchMovementContext(id);
    if (result === null) return sendError(reply, 502, 'UPSTREAM', 'upstream error');
    if (result.offScene) return sendError(reply, 409, 'CONFLICT', 'no token on the active scene');
    const speedFt = result.ctx.view.speedFt ?? 0;
    const cc = combatMoveContext(id, speedFt);
    if (!cc.inCombat) return sendError(reply, 409, 'CONFLICT', 'not in combat');
    if (!cc.yourTurn) return sendError(reply, 409, 'CONFLICT', 'not your turn');
    if (cc.key === undefined || !movementBudget.markDashed(cc.key)) {
      return sendError(reply, 409, 'CONFLICT', 'already dashed this turn');
    }
    // Best-effort GM visibility — a failed note never fails the dash.
    const name = typeof result.ctx.own?.name === 'string' ? result.ctx.own.name : 'A player';
    void boundedMs(relay.postChatNote(`Actor.${id}`, `${name} dashes!`).then(() => true), movementTimeoutMs);
    const fresh = combatMoveContext(id, speedFt);
    return reply.code(200).send({
      movement: { ...result.ctx.view, inCombat: true, yourTurn: fresh.yourTurn,
        remainingFt: fresh.remainingFt, dashed: fresh.dashed },
    });
  },
);
```

7. `docs/API.md`: budget fields + dash route.

- [ ] **Step 5: Run to verify pass** — `pnpm --filter gateway test` → PASS. Commit:

```bash
git add apps/gateway/src/app.ts apps/gateway/src/movement-budget.ts apps/gateway/test/ docs/API.md
git commit -m "feat(gateway): per-turn movement budget, dash route, own-turn move gating"
```

---

### Task 8: AC display fix — derived AC under active effects

**Files:**
- Modify: `packages/adapter-dnd5e/src/index.ts` (enrich)
- Test: `packages/adapter-dnd5e/test/derived-fidelity.test.ts` (or the test file housing existing enrich tests)
- Modify: `apps/gateway/src/app.ts` (AdapterIO wiring)
- Test: `apps/gateway/test/app.test.ts`

**Interfaces:**
- Consumes: `AdapterIO.getDerivedAc?` (declared Task 4), `relay.getDerivedAc` (Task 2).
- Behavior: when the actor carries an enabled Active Effect whose changes touch `system.attributes.ac*` AND `io.getDerivedAc` is available, `enrich` overrides `system.attributes.ac.value` with the live prepared value. Failure (null) keeps the get-actor-details merge — a sheet with slightly stale AC beats no sheet.

- [ ] **Step 1: Write the failing adapter test**

```ts
describe('enrich AC override under active effects (2026-07-22 Mage Armor)', () => {
  function acEffectActor(): FoundryActorDoc {
    const actor = structuredClone(caster); // any captured fixture
    (actor as Record<string, unknown>).effects = [{
      _id: 'ae1', name: 'Mage Armor', disabled: false,
      changes: [{ key: 'system.attributes.ac.calc', mode: 5, value: 'mage' }],
    }];
    return actor;
  }

  it('prefers io.getDerivedAc when an AC effect is active', async () => {
    const enriched = await dnd5eAdapter.enrich!(acEffectActor(), {
      getSystemDetails: async () => ({ stats: { ac: 11 } }), // relay's stale value
      getDerivedAc: async () => 14,
    });
    expect(numAtPath(enriched.system, 'attributes.ac.value')).toBe(14);
  });

  it('keeps the get-actor-details value when getDerivedAc degrades to null', async () => {
    const enriched = await dnd5eAdapter.enrich!(acEffectActor(), {
      getSystemDetails: async () => ({ stats: { ac: 11 } }),
      getDerivedAc: async () => null,
    });
    expect(numAtPath(enriched.system, 'attributes.ac.value')).toBe(11);
  });

  it('does not call getDerivedAc when no AC effect is active', async () => {
    let called = false;
    await dnd5eAdapter.enrich!(structuredClone(caster), {
      getSystemDetails: async () => ({ stats: { ac: 11 } }),
      getDerivedAc: async () => { called = true; return 99; },
    });
    expect(called).toBe(false);
  });
});
```

(Use the file's existing helper for reading `system` paths, or inline a tiny `numAtPath`.)

- [ ] **Step 2: Run to verify failure**, then implement in adapter-dnd5e:

```ts
/** True when an enabled Active Effect changes any system.attributes.ac*
 *  path (Mage Armor's ac.calc OVERRIDE, Shield's ac.bonus…). Gate for the
 *  extra execute-js AC read — rare enough to keep sheet loads cheap. */
function hasAcEffect(actor: FoundryActorDoc): boolean {
  const effects = Array.isArray(actor.effects) ? actor.effects : [];
  return effects.some((e) => {
    const eff = rec(e);
    if (eff.disabled === true) return false;
    const changes = Array.isArray(eff.changes) ? eff.changes : [];
    return changes.some((c) => {
      const key = rec(c).key;
      return typeof key === 'string' && key.startsWith('system.attributes.ac');
    });
  });
}
```

At the end of `enrich` (before the final return, after the abilities merge):

```ts
// 2026-07-22 Mage Armor: the relay's get-actor-details stats.ac does not
// recompute ac.calc overrides. When an AC-touching effect is active, read
// the live prepared AC (execute-js) and let it win; null degrades to the
// stats.ac merge above.
if (hasAcEffect(actor) && io.getDerivedAc !== undefined) {
  try {
    const liveAc = await io.getDerivedAc();
    if (liveAc !== null) {
      const base = merged ?? { ...system };
      const attributes = rec(base.attributes);
      base.attributes = { ...attributes, ac: { ...rec(attributes.ac), value: liveAc } };
      merged = base;
    }
  } catch {
    /* keep the stats.ac merge */
  }
}
```

- [ ] **Step 3: Gateway wiring** — in `app.ts`, find where the `AdapterIO` object is constructed for `adapter.enrich` (the `getSystemDetails: (details) => relay.getSystemDetails(...)` closure) and add:

```ts
getDerivedAc: () =>
  boundedMs(relay.getDerivedAc(`Actor.${id}`), encounterFetchTimeoutMs).then((v) => v ?? null),
```

`RelayPort` gains `getDerivedAc(actorUuid: string): Promise<number | null>;`; FakeRelay gets `derivedAc: number | null = null; async getDerivedAc(): Promise<number | null> { return this.derivedAc; }`. Add one gateway test: seed an actor doc with an AC effect + `relay.derivedAc = 14`, assert the sheet headline AC stat reads 14 (skip if the fake adapter has no AC headline — then assert at the adapter level only and test the gateway wiring by spying `getDerivedAc` was reachable; keep whichever assertion the harness supports).

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @companion/adapter-dnd5e test && pnpm --filter gateway test && pnpm -r typecheck` → PASS/clean.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-sdk/src/index.ts packages/adapter-dnd5e/ apps/gateway/
git commit -m "fix(adapter-dnd5e): live derived AC under active effects (Mage Armor ac.calc)"
```

---

### Task 9: web — targeting UI (target sheet, outcome sheet, wiring, mock)

**Files:**
- Modify: `apps/web/app/types/api.ts`
- Create: `apps/web/app/components/CombatTargetSheet.vue`
- Create: `apps/web/app/components/ActionOutcomeSheet.vue`
- Modify: `apps/web/app/pages/actor/[id].vue`
- Modify: `apps/web/mock/server.mjs`

**Interfaces:**
- Consumes: `ActionDescriptor.targeting` + combatant `tokenUuid` (wire, Tasks 3–5), actions POST `outcome` field (Task 5).
- Produces (types in `apps/web/app/types/api.ts`):

```ts
export interface ActionOutcomeTarget {
  tokenUuid: string
  name: string
  outcome: 'hit' | 'miss' | 'save-failed' | 'save-passed' | 'applied' | 'gone'
  save?: { total: number; dc: number }
  damage?: { rolled: Array<{ type: string; value: number }>; applied: number }
}
export interface ActionOutcome {
  attack: { total: number; formula: string; isCritical: boolean; isFumble: boolean } | null
  targets: ActionOutcomeTarget[]
}
```

Plus: `tokenUuid?: string` on the encounter combatant type, `targeting?: { mode: 'single' | 'multiple'; kind: 'attack' | 'save' | 'heal' }` on the action descriptor type, `targetTokenUuids?: string[]` on the action-intent type, `outcome?: ActionOutcome` on the actions POST response type.

**Behavior (all in `[id].vue`):**
- When `encounterActive && combatConn === 'live'` and a tapped action has `targeting`, open `CombatTargetSheet` INSTEAD of executing directly (attack buttons, cast buttons, use buttons; the existing buff-cast `targetable` flow keeps priority for buff spells — `targeting` and `targetable` never co-exist on one descriptor because buffs are `effectType: 'utility'`).
- Chain like the existing `pendingTargetActorId`: `pendingTargetTokenUuids` carries the picked tokens across the upcast slot sheet when `slotLevels.length > 1`.
- On action response with `outcome`, open `ActionOutcomeSheet` (replaces the roll pill for targeted actions; untargeted actions keep the pill).
- Out of combat, everything behaves exactly as today.

**`CombatTargetSheet.vue`** (modeled on `TargetPickerSheet.vue`): props `{ encounter: EncounterView | null; mode: 'single' | 'multiple'; title: string }`; emits `pick(tokenUuids: string[])`, `close`. Lists `encounter.combatants` rows (avatar, name, defeated strike-through, health tier dot when present); rows without `tokenUuid` disabled. `single`: tap = immediate pick. `multiple`: tap toggles a checkmark; a sticky gold "Confirm (n)" button emits the selection (disabled at 0).

**`ActionOutcomeSheet.vue`**: props `{ outcome: ActionOutcome; label: string }`; emits `close`. Header: label + attack total when present ("19 to hit — CRIT!" styling for `isCritical`). Per target row: name; outcome badge (Hit / Miss / Save failed / Save passed / Healed / Gone — `applied` maps to "Healed" when the action kind was heal, else "Applied"); damage line `12 slashing → 6 applied` with a subtle "resisted" tag whenever `damage.applied < sum(rolled)` and `applied > 0`, and "immune" when `applied === 0` on a hit/failed-save. Follow the modal-sheet / scrim / gold-accent patterns of `CombatantHpSheet.vue`.

- [ ] **Step 1: Add the types** to `apps/web/app/types/api.ts` (as above).
- [ ] **Step 2: Build `CombatTargetSheet.vue`** (copy `TargetPickerSheet.vue`'s scrim/list/row styling; add the multi-select checkmark + confirm button).
- [ ] **Step 3: Build `ActionOutcomeSheet.vue`**.
- [ ] **Step 4: Wire `[id].vue`:** state refs `combatTargetFor: ref<string | null>`, `pendingTargetTokenUuids: ref<string[] | undefined>`, `actionOutcome: ref<{ outcome: ActionOutcome; label: string } | null>`; intercept in `onAction`/`onCombatAction` where attack/cast/use actions dispatch (`[id].vue:1372-1451`): if in live combat and the descriptor has `targeting`, set `combatTargetFor` and return; `onCombatTargetPick(tokenUuids)` resolves the descriptor and either submits (with `targetTokenUuids`) or stores `pendingTargetTokenUuids` and opens the slot sheet (mirror `onTargetPick`, `[id].vue:652`); `onActionSubmit` consumes `pendingTargetTokenUuids` like it consumes `pendingTargetActorId`; in `submitAction` (`[id].vue:1772`), when the response carries `outcome`, set `actionOutcome` instead of the roll pill. Mount both sheets at page root next to `TargetPickerSheet` (`[id].vue:264`).
- [ ] **Step 5: Mock server parity** (`apps/web/mock/server.mjs`): add `tokenUuid` to mock encounter combatants, `targeting` to a weapon attack + one save spell + one heal action, and make the actions POST return a canned `outcome` when `targetTokenUuids` is present (hit + resisted-damage shape from Task 5's test).
- [ ] **Step 6: Verify** — `pnpm -r typecheck` clean; run the web app against the mock server and click through: pick single target → outcome sheet with resisted damage; pick multi-target save spell → per-target save results.
- [ ] **Step 7: Commit**

```bash
git add apps/web/
git commit -m "feat(web): combat target picker + action outcome sheet"
```

---

### Task 10: web — End-turn button, raised dice FAB, Move-sheet budget UI

**Files:**
- Modify: `apps/web/app/components/InitiativeCarousel.vue`
- Modify: `apps/web/app/components/DiceTray.vue`
- Modify: `apps/web/app/components/MoveSheet.vue`
- Modify: `apps/web/app/pages/actor/[id].vue`
- Modify: `apps/web/app/types/api.ts` (movement fields)
- Modify: `apps/web/mock/server.mjs`

**Interfaces:**
- Consumes: `POST /api/encounter/turn/end` (Task 6), movement budget fields + dash route (Task 7).
- `MovementView` (web type) gains `inCombat?: boolean; yourTurn?: boolean; remainingFt?: number; dashed?: boolean`.

**Behavior:**
- **End turn:** `InitiativeCarousel.vue` gains prop `canEndTurn: boolean` and emit `endTurn`; renders a compact gold "End turn ▸" button at the carousel's right edge when true. `[id].vue`: `canEndTurn = computed(() => { const turnId = encounter.value.turn?.combatantId; if (!turnId) return false; const acting = encounter.value.combatants?.find((c) => c.id === turnId); return acting?.actorId === actorId })`; handler POSTs `/api/encounter/turn/end`; on 409 silently refresh (`connectCombatEvents` self-heals anyway); on 403/error show the standard toast. Single tap, no confirm (spec).
- **Dice FAB:** `DiceTray.vue` gains prop `raised: boolean`; when true the root `.dice-tray` gets a `raised` class: `bottom: calc(160px + env(safe-area-inset-bottom))` (above the `.carousel-dock` at `bottom: 68px` + its height), with `transition: bottom 200ms ease`. The open panel keeps its relative offset. `[id].vue:344` passes `:raised="showCarousel"`.
- **Move sheet:** `MoveSheet.vue` shows, when `movement.inCombat`: a budget chip `“{speedFt - remaining spent} — {remainingFt} ft left”` (render simply as `{{ remainingFt }} / {{ speedFt * (dashed ? 2 : 1) }} ft`), a "Dash" pill button (hidden once `dashed`), and — when `!yourTurn` — a "Not your turn" hint with the grid disabled. The reachable-cell radius the sheet renders already derives from `speedFt`; feed it `remainingFt` instead when in combat (`const rangeFt = movement.inCombat ? movement.remainingFt ?? 0 : movement.speedFt ?? 0`). Dash button emits `dash`; `[id].vue` POSTs `/api/actors/:id/movement/dash` and replaces the `movement` ref with the response.
- **Mock parity:** mock movement GET returns the budget fields; mock dash route flips `dashed` and doubles remaining.

- [ ] **Step 1: Implement the three components + wiring** (as above).
- [ ] **Step 2: Verify** — `pnpm -r typecheck` clean; against the mock server: carousel shows End-turn only on own turn; FAB visibly slides up when combat activates; Move sheet shows budget, Dash extends range once, off-turn blocks.
- [ ] **Step 3: Commit**

```bash
git add apps/web/
git commit -m "feat(web): end-turn button, raised dice FAB in combat, move-sheet budget + dash"
```

---

### Task 11: live E2E verification

**Files:**
- Create: `e2e/combat-targeting-live-check.md` (findings doc; follow the movement live-check format)

Use the headless GM session pattern (memory: session-handshake + start-session) against the dev stack (`stack/docker-compose.dev.yml`: relay :3010, gateway :8090, web :3000) with a combat containing Morthos (invite exists) + at least one **skeleton** (bludgeoning-vulnerable, slashing/piercing-resistant in 2024 rules — if the world's skeleton lacks resistances, add one via its sheet) and one ally.

- [ ] **Check 0 (format probe):** `GET /encounters` — confirm `combatants[].tokenUuid` is a full `Scene.<id>.Token.<id>` uuid. If it is a bare token id, fix `normalizeTokenUuid` (Task 3) to compose it from the encounter's scene and re-run Task 3 tests.
- [ ] **Check 1 (attack, hit + resistance):** targeted slashing attack vs the skeleton → outcome `hit`, `applied < rolled`, Foundry HP dropped by `applied`, chat card shows the attack + target.
- [ ] **Check 2 (attack, miss):** vs a high-AC target → `miss`, no damage roll in chat, HP unchanged.
- [ ] **Check 3 (crit):** force/fish a nat 20 → `isCritical: true`, doubled dice in the chat damage roll.
- [ ] **Check 4 (save spell, multi-target):** Sacred Flame or Fireball at 2 targets (one ally to prove friendly fire) → per-target save rolls in chat, `save-failed` takes full, `save-passed` takes half/none per spell, HP deltas match `applied`.
- [ ] **Check 5 (heal):** Cure Wounds on the ally → HP goes UP by `applied`; **if it goes down, flip the heal path to `applyDamage(damages, { multiplier: -1 })` in `targetedUseScript` and re-verify** (dnd5e healing-type handling is the one API assumption not verifiable offline).
- [ ] **Check 6 (slot consumption):** upcast targeted cast consumes the chosen slot exactly once.
- [ ] **Check 7 (versatile weapon — task #9):** longsword 1H vs 2H: check whether the auto damage roll matches the current grip (`d8` vs `d10`). Record findings; if dnd5e's first activity ignores grip, file the follow-up fix (attack `mode`-style option) in the findings doc.
- [ ] **Check 8 (end turn):** End-turn on own turn advances Foundry's tracker; pressing after the GM already advanced → 409 and the PWA refreshes cleanly.
- [ ] **Check 9 (budget):** move 20ft of 30 → remaining 10 shown; Dash → 40 remaining, chat note posted; end turn + new round → budget refilled.
- [ ] **Check 10 (Mage Armor):** apply Mage Armor via the app → sheet AC shows 14 (was the `ac.calc` staleness); remove → back to 11.
- [ ] **Check 11 (FAB):** with combat live on a phone-sized viewport, the dice FAB sits above the carousel, not on it.
- [ ] **Fix-forward:** any failed check gets a fix commit + re-run before the doc is finalized.
- [ ] **Commit**

```bash
git add e2e/combat-targeting-live-check.md
git commit -m "docs+e2e: combat targeting live verification findings"
```

---

## Plan Self-Review Notes

- **Spec coverage:** F1/F2 → Tasks 1, 3–5, 9; F3 → Tasks 2, 6, 10; F4 → Tasks 2, 7, 10; F5 → Task 10; F6 → Tasks 2, 8; error handling (no-retry, 408 mapping, gone targets, turn race) → Tasks 1, 5, 6; live E2E incl. versatile-weapon follow-up → Task 11.
- **Known API risk, isolated by design:** the exact dnd5e 5.3.x shapes (`rollSavingThrow` config, `rollDamage` crit flag, healing-type `applyDamage`) live ONLY inside `targetedUseScript` and are live-verified in Task 11 with explicit fix-forward instructions; unit tests intentionally assert script *generation*, not Foundry behavior.
- **Type consistency:** `TargetedUseResult`/`TargetedUseOptions` (Task 1) = FakeRelay shapes (Task 5) = web `ActionOutcome` (Task 9). `use-on-targets` fields (Task 4) match the route case (Task 5). Budget wire fields flat on the movement view in Tasks 7 and 10.
