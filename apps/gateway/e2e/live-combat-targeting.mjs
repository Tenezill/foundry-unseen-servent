/**
 * Live combat-targeting check (2026-07-22 spec, plan Task 11).
 *
 * Boots the REAL gateway (buildApp + EncounterManager over FoundryRelayClient)
 * in-process against the running dev stack and exercises the whole targeted-
 * action surface end to end: tokenUuid format, targeted attacks (hit with
 * resistance halving, miss, crit), multi-target save spells (friendly fire
 * included), targeted heals, upcast slot consumption, versatile-weapon grip
 * (recorded), end-turn (success + stale race), and the per-turn movement
 * budget (move / dash / new-round refill).
 *
 * Determinism: rolls are forced through a temporary CONFIG.Dice.randomUniform
 * patch (executed in the GM client via relay execute-js) — ceil(v * faces)
 * per die. ALWAYS restored in the finally block, even on crash.
 *
 * The world fixture (Morthos + "E2E Skeleton" with slashing/piercing
 * resistance + Akra as ally, tokens on the active scene, a running combat) is
 * created on demand and the combat is deleted afterwards; actors/tokens/items
 * are left as a standing fixture. PC HP/slots are restored on exit.
 *
 * Prereq: dev stack up, world online (GM browser tab or headless session),
 * relay key with entity:*, encounter:read, scene:read, canvas:write,
 * execute-js scopes + module setting "Allow Execute JS".
 *
 *     pnpm --filter @companion/gateway exec tsx e2e/live-combat-targeting.mjs
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { sha256Hex } from '../src/players.js';
import { createDefaultRegistry } from '../src/registry.js';
import { EncounterManager } from '../src/encounters.js';
import { FoundryRelayClient } from '@companion/foundry-client';

// --- tiny assertion harness (same shape as live.mjs) -------------------------

let passed = 0;
const failures = [];
let section = '';

function group(name) {
  section = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}
function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`[${section}] ${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` — ${detail}` : ''}`);
  }
}
function note(name, value) {
  console.log(`  \x1b[36m•\x1b[0m ${name}: ${value}`);
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// --- env / config -------------------------------------------------------------

function parseDotenv(path) {
  const out = {};
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const env = { ...parseDotenv(new URL('../.env', import.meta.url)), ...process.env };
let cfg;
try {
  cfg = loadConfig(env);
} catch (err) {
  console.error(`\x1b[31mConfig error:\x1b[0m ${err.message}`);
  process.exit(1);
}

// --- fixture constants (Companion Test world) ---------------------------------

const MORTHOS = 'uZIJkwOnvnd5FEn6'; // Morthos (Tiefling Sorcerer) — the invite actor
const AKRA = 'pTvtx5dm2AuYqeX2'; // Akra (Dragonborn Cleric) — the ally
const SPELLS = {
  fireball: 'VFSAS8Sod9dLHLhB', // level 3, save (dex), half on save
  acidSplash: 'EAtsNAOhXCGdpQfA', // cantrip, save (dex), none on save
  mageArmor: 'EwmAxxPTF9adUsMp', // level 1, self-buff via ac.calc effect
};

// --- run ----------------------------------------------------------------------

async function resolveClientId() {
  if (cfg.relayClientId && cfg.relayClientId !== 'auto') return cfg.relayClientId;
  const res = await fetch(`${cfg.relayUrl}/clients`, { headers: { 'x-api-key': cfg.relayApiKey } });
  if (!res.ok) throw new Error(`relay /clients -> ${res.status}`);
  const body = await res.json();
  const online = (body.clients ?? []).filter((c) => c.isOnline === true);
  const pick = online[0] ?? (body.clients ?? [])[0];
  if (!pick) throw new Error('no worlds connected to the relay');
  return pick.clientId;
}

const resolvedClientId = await resolveClientId();
const relay = new FoundryRelayClient({
  baseUrl: cfg.relayUrl,
  apiKey: cfg.relayApiKey,
  clientId: resolvedClientId,
});

/** Raw execute-js (bounded). The GM client executes the script; anything set
 *  on globals there persists for the tab session (the dice patch relies on it). */
async function execJs(script, timeoutMs = 15_000) {
  const u = new URL('/execute-js', cfg.relayUrl);
  u.searchParams.set('clientId', resolvedClientId);
  const res = await fetch(u, {
    method: 'POST',
    headers: { 'x-api-key': cfg.relayApiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ script }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false || (typeof body.error === 'string' && body.error !== '')) {
    throw new Error(`execute-js ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body.result;
}

// Dice control: ceil(v * faces) per die. Restored in finally (and belt-and-
// braces at the start in case a previous crashed run left a patch behind).
let dicePatched = false;
async function setUniform(v) {
  dicePatched = true;
  await execJs(
    `if (!window.__e2eOrigRU) window.__e2eOrigRU = CONFIG.Dice.randomUniform;` +
      `CONFIG.Dice.randomUniform = () => ${JSON.stringify(v)};` +
      `return { ok: true };`,
  );
}
async function restoreUniform() {
  await execJs(
    `if (window.__e2eOrigRU) { CONFIG.Dice.randomUniform = window.__e2eOrigRU; delete window.__e2eOrigRU; }` +
      `return { ok: true };`,
  );
  dicePatched = false;
}

const E2E_TOKEN = `e2e-${randomBytes(12).toString('hex')}`;

let app = null;
let encounters = null;
let fixture = null; // { sceneId, tokens: {morthos, skeleton, akra}, combatId, combatants, items: {longsword, cureWounds}, orig: {...} }
let combatCreatedByUs = false;

async function api(path, { method = 'GET', token = E2E_TOKEN, body } = {}) {
  const addr = app.server.address();
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll fn() until pred passes or timeout; returns last value. */
async function until(fn, pred, timeoutMs = 8_000, stepMs = 300) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (pred(last)) return last;
    if (Date.now() > deadline) return last;
    await sleep(stepMs);
  }
}

// --- world-side helpers (ground truth via execute-js) --------------------------

const skelHp = async () =>
  execJs(
    `const t = await fromUuid(${JSON.stringify(`Scene.${fixture.sceneId}.Token.${fixture.tokens.skeleton}`)});` +
      `const hp = t.actor.system.attributes.hp; return { value: hp.value, temp: hp.temp ?? 0, max: hp.max };`,
  );
const akraHp = async () =>
  execJs(`const a = game.actors.get(${JSON.stringify(AKRA)}); const hp = a.system.attributes.hp; return { value: hp.value, temp: hp.temp ?? 0, max: hp.max };`);
const morthosSlots = async () =>
  execJs(
    `const s = game.actors.get(${JSON.stringify(MORTHOS)}).system.spells;` +
      `return Object.fromEntries(Object.entries(s).filter(([k,v]) => v && v.max > 0).map(([k,v]) => [k, v.value]));`,
  );
const setSkelHp = async (value, max) =>
  execJs(
    `const t = await fromUuid(${JSON.stringify(`Scene.${fixture.sceneId}.Token.${fixture.tokens.skeleton}`)});` +
      `await t.actor.update({ 'system.attributes.hp.value': ${value}, 'system.attributes.hp.max': ${max ?? value} });` +
      `return { ok: true };`,
  );
const msgCount = async () => execJs(`return { n: game.messages.size };`);
const lastMessages = async (n) =>
  execJs(
    `return { msgs: game.messages.contents.slice(-${n}).map((m) => ({` +
      `flavor: (m.flavor ?? '').slice(0, 120), content: (m.content ?? '').replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 160),` +
      `rolls: m.rolls.map((r) => ({ formula: r.formula, total: r.total })) })) };`,
  );

const rolledSum = (damage) => (damage?.rolled ?? []).reduce((s, p) => s + (p.value ?? 0), 0);
const tokenUuidOf = (tokenId) => `Scene.${fixture.sceneId}.Token.${tokenId}`;

// --- fixture -------------------------------------------------------------------

async function ensureFixture() {
  const result = await execJs(
    `
const out = {};
const morthos = game.actors.get(${JSON.stringify(MORTHOS)});
const akra = game.actors.get(${JSON.stringify(AKRA)});
if (!morthos || !akra) throw new Error('Morthos/Akra missing from world');
// Items: Longsword (versatile d8/d10, slashing) + Cure Wounds (heal spell).
const findIn = async (packId, name) => {
  const pack = game.packs.get(packId);
  if (!pack) return null;
  const idx = await pack.getIndex();
  const e = idx.find((x) => x.name === name);
  return e ? await pack.getDocument(e._id) : null;
};
let ls = morthos.items.find((i) => i.name === 'Longsword');
if (!ls) {
  const src = await findIn('dnd5e.equipment24', 'Longsword');
  if (!src) throw new Error('Longsword not in dnd5e.equipment24');
  const obj = src.toObject();
  obj.system.equipped = true;
  obj.system.proficient = 1;
  [ls] = await morthos.createEmbeddedDocuments('Item', [obj]);
}
let cw = morthos.items.find((i) => i.name === 'Cure Wounds');
if (!cw) {
  const src = await findIn('dnd5e.spells24', 'Cure Wounds');
  if (!src) throw new Error('Cure Wounds not in dnd5e.spells24');
  [cw] = await morthos.createEmbeddedDocuments('Item', [src.toObject()]);
}
// The dnd5e adapter offers a 'cast' action only for prepared spells; the flag
// is the numeric system.prepared (1 = prepared), NOT system.preparation.
const mageArmor = morthos.items.get(${JSON.stringify(SPELLS.mageArmor)});
await cw.update({ 'system.prepared': 1 });
if (mageArmor) await mageArmor.update({ 'system.prepared': 1 });
out.items = { longsword: ls.id, cureWounds: cw.id };
// Skeleton NPC: slashing/piercing-resistant, bludgeoning-vulnerable (2024 rules shape).
let skel = game.actors.find((a) => a.name === 'E2E Skeleton');
if (!skel) {
  skel = await Actor.implementation.create({
    name: 'E2E Skeleton', type: 'npc',
    system: {
      attributes: { ac: { calc: 'flat', flat: 13 }, hp: { value: 200, max: 200 } },
      abilities: { dex: { value: 14 } },
      traits: { dr: { value: ['slashing', 'piercing'] }, dv: { value: ['bludgeoning'] } },
      details: { type: { value: 'undead' } },
    },
  });
}
out.skeletonActorId = skel.id;
// Tokens on the ACTIVE scene.
const scene = game.scenes.active;
out.sceneId = scene.id;
const ensureToken = async (actor, cx, cy) => {
  let tok = scene.tokens.find((t) => t.actorId === actor.id);
  if (!tok) {
    const proto = (await actor.getTokenDocument({ x: cx * scene.grid.size, y: cy * scene.grid.size })).toObject();
    proto.actorLink = actor.type === 'character';
    const [created] = await scene.createEmbeddedDocuments('Token', [proto]);
    tok = created;
  }
  return tok.id;
};
out.tokens = {
  morthos: await ensureToken(morthos, 3, 5),
  skeleton: await ensureToken(skel, 4, 5),
  akra: await ensureToken(akra, 7, 5),
};
// Combat: Morthos first (init 20), skeleton 10, Akra 5.
let combat = game.combat;
out.combatCreated = false;
if (!combat || combat.round < 1) {
  combat = await Combat.implementation.create({ scene: scene.id, active: true });
  await combat.createEmbeddedDocuments('Combatant', [
    { tokenId: out.tokens.morthos, actorId: morthos.id, sceneId: scene.id, initiative: 20 },
    { tokenId: out.tokens.skeleton, actorId: skel.id, sceneId: scene.id, initiative: 10 },
    { tokenId: out.tokens.akra, actorId: akra.id, sceneId: scene.id, initiative: 5 },
  ]);
  await combat.startCombat();
  out.combatCreated = true;
}
out.combatId = combat.id;
out.combatants = Object.fromEntries(combat.combatants.map((c) => [c.name, c.id]));
// Baselines to restore on exit.
out.orig = {
  morthosHp: morthos.system.attributes.hp.value,
  akraHp: akra.system.attributes.hp.value,
  slots: Object.fromEntries(Object.entries(morthos.system.spells).filter(([k, v]) => v && v.max > 0).map(([k, v]) => [k, v.value])),
};
// Deterministic footing for the checks.
await skel.update({ 'system.attributes.hp.value': 200, 'system.attributes.hp.max': 200 });
return out;
`,
    30_000,
  );
  combatCreatedByUs = result.combatCreated;
  return result;
}

async function cleanupWorld() {
  if (!fixture) return;
  try {
    await execJs(
      `
const morthos = game.actors.get(${JSON.stringify(MORTHOS)});
const akra = game.actors.get(${JSON.stringify(AKRA)});
// Remove any app-applied Mage Armor effect left behind.
for (const a of [morthos, akra]) {
  const eff = a.effects.filter((e) => e.flags?.['unseen-servent']?.appliedBy === 'app');
  if (eff.length) await a.deleteEmbeddedDocuments('ActiveEffect', eff.map((e) => e.id));
}
await morthos.update({ 'system.attributes.hp.value': ${JSON.stringify(fixture.orig.morthosHp)} });
await akra.update({ 'system.attributes.hp.value': ${JSON.stringify(fixture.orig.akraHp)} });
const slotUpdate = {};
for (const [k, v] of Object.entries(${JSON.stringify(fixture.orig.slots)})) slotUpdate['system.spells.' + k + '.value'] = v;
await morthos.update(slotUpdate);
const combat = game.combats.get(${JSON.stringify(fixture.combatId)});
if (combat) await combat.delete();
return { ok: true };
`,
      30_000,
    );
    console.log('  (world restored: PC hp/slots, buff effects, combat deleted)');
  } catch (err) {
    console.error(`  \x1b[33mworld cleanup failed:\x1b[0m ${err.message} — restore by hand (combat ${fixture.combatId})`);
  }
}

// --- main ----------------------------------------------------------------------

async function main() {
  group('Preflight: relay + world online');
  const clients = await relay.listClients();
  const world = clients.find((c) => c.clientId === resolvedClientId);
  check('configured world connected', !!world);
  check(`world "${world?.worldTitle}" online`, world?.isOnline === true, 'wake the world first');
  if (!world?.isOnline) throw new Error('world offline');

  // Clear any dice patch left by a crashed previous run.
  await restoreUniform().catch(() => undefined);

  group('Fixture: Morthos + resistant skeleton + ally, combat running');
  fixture = await ensureFixture();
  note('scene', fixture.sceneId);
  note('tokens', JSON.stringify(fixture.tokens));
  note('combat', `${fixture.combatId} (created by us: ${combatCreatedByUs})`);
  check('longsword + cure wounds on Morthos', !!fixture.items.longsword && !!fixture.items.cureWounds);

  const players = [{ name: 'e2e', tokenHash: sha256Hex(E2E_TOKEN), actorIds: [MORTHOS, AKRA] }];
  encounters = new EncounterManager({
    relay,
    log: { warn: (o, m) => console.error(`  [mgr] ${m}`, JSON.stringify(o).slice(0, 200)) },
  });
  app = buildApp({
    relay,
    players: { list: () => players },
    registry: createDefaultRegistry(),
    defaultSystemId: cfg.defaultSystemId,
    encounters,
    livePollMs: 60_000,
    pingMs: 60_000,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  await encounters.start();

  const view = await until(
    async () => (await api('/api/encounter')).json,
    (v) => v?.active === true && (v.combatants ?? []).length >= 3,
  );
  check('encounter mirror active with 3+ combatants', view?.active === true && (view.combatants ?? []).length >= 3, JSON.stringify(view).slice(0, 200));

  const skelUuid = tokenUuidOf(fixture.tokens.skeleton);
  const akraUuid = tokenUuidOf(fixture.tokens.akra);

  // ---- Check 0: tokenUuid format --------------------------------------------
  group('Check 0: combatants[].tokenUuid is a full Scene.*.Token.* uuid');
  {
    const raw = await relay.getEncounters();
    const combat = raw.find((e) => e.id === fixture.combatId);
    const uuidRe = /^Scene\.[A-Za-z0-9]+\.Token\.[A-Za-z0-9]+$/;
    check('relay REST tokenUuid full uuid (all combatants)', (combat?.combatants ?? []).every((c) => uuidRe.test(c.tokenUuid ?? '')), JSON.stringify(combat?.combatants?.map((c) => c.tokenUuid)));
    check('gateway view tokenUuid full uuid (all combatants)', (view.combatants ?? []).every((c) => uuidRe.test(c.tokenUuid ?? '')), JSON.stringify(view.combatants?.map((c) => c.tokenUuid)));
  }

  // ---- Check 1: attack hit + resistance halving ------------------------------
  group('Check 1: targeted slashing attack vs skeleton — hit, applied < rolled');
  {
    const before = await skelHp();
    const m0 = (await msgCount()).n;
    await setUniform(0.325); // face = ceil((1-v)*faces): d20=14 (hit vs AC 13, no crit), d8=6
    const r = await api(`/api/actors/${MORTHOS}/actions`, {
      method: 'POST',
      body: { actionId: `item.${fixture.items.longsword}.attack`, kind: 'attack', targetTokenUuids: [skelUuid] },
    });
    eq('POST attack -> 200', r.status, 200);
    const t = r.json?.outcome?.targets?.[0];
    eq('outcome is hit', t?.outcome, 'hit');
    check('attack roll present with total', typeof r.json?.outcome?.attack?.total === 'number', JSON.stringify(r.json?.outcome?.attack));
    const rolled = rolledSum(t?.damage);
    check('damage rolled > 0', rolled > 0, JSON.stringify(t?.damage));
    check('applied < rolled (slashing resistance halves)', typeof t?.damage?.applied === 'number' && t.damage.applied < rolled, `applied ${t?.damage?.applied} vs rolled ${rolled}`);
    eq('applied == floor(rolled/2)', t?.damage?.applied, Math.floor(rolled / 2));
    const after = await skelHp();
    eq('Foundry HP dropped by applied', before.value - after.value, t?.damage?.applied);
    const m1 = (await msgCount()).n;
    check('chat gained cards (use + attack + damage)', m1 - m0 >= 2, `${m1 - m0} new messages`);
    const msgs = await lastMessages(m1 - m0);
    note('chat', msgs.msgs.map((m) => `${m.flavor || m.content} ${m.rolls.map((x) => `${x.formula}=${x.total}`).join(' ')}`).join(' | '));
  }

  // ---- Check 2: attack miss ---------------------------------------------------
  group('Check 2: attack misses — no damage roll, HP unchanged');
  {
    const before = await skelHp();
    const m0 = (await msgCount()).n;
    await setUniform(0.9); // d20=2 -> miss vs AC 13
    const r = await api(`/api/actors/${MORTHOS}/actions`, {
      method: 'POST',
      body: { actionId: `item.${fixture.items.longsword}.attack`, kind: 'attack', targetTokenUuids: [skelUuid] },
    });
    eq('POST attack -> 200', r.status, 200);
    const t = r.json?.outcome?.targets?.[0];
    eq('outcome is miss', t?.outcome, 'miss');
    check('no damage on the miss entry', t?.damage === undefined, JSON.stringify(t));
    const after = await skelHp();
    eq('HP unchanged', after.value, before.value);
    const m1 = (await msgCount()).n;
    const msgs = await lastMessages(m1 - m0);
    const hasDamageRoll = msgs.msgs.some((m) => /damage/i.test(m.flavor) || m.rolls.some((x) => /d8/.test(x.formula)));
    check('no damage roll in chat', !hasDamageRoll, JSON.stringify(msgs.msgs));
  }

  // ---- Check 3: crit ----------------------------------------------------------
  group('Check 3: nat 20 — isCritical, doubled dice');
  {
    const before = await skelHp();
    await setUniform(0.0001); // d20=20 (crit), d8=8 (max on all dice)
    const r = await api(`/api/actors/${MORTHOS}/actions`, {
      method: 'POST',
      body: { actionId: `item.${fixture.items.longsword}.attack`, kind: 'attack', targetTokenUuids: [skelUuid] },
    });
    eq('POST attack -> 200', r.status, 200);
    eq('attack.isCritical', r.json?.outcome?.attack?.isCritical, true);
    const t = r.json?.outcome?.targets?.[0];
    eq('outcome is hit', t?.outcome, 'hit');
    const rolled = rolledSum(t?.damage);
    const msgs = await lastMessages(2);
    const dmgRoll = msgs.msgs.flatMap((m) => m.rolls).find((x) => /d8/.test(x.formula));
    check('chat damage roll has doubled dice (2d8)', dmgRoll !== undefined && /2d8/.test(dmgRoll.formula), JSON.stringify(dmgRoll));
    check('crit rolled >= 14 (two max d8s minus a possible negative STR mod)', rolled >= 14, `rolled ${rolled}`);
    const after = await skelHp();
    eq('HP dropped by applied (still resisted)', before.value - after.value, t?.damage?.applied);
    eq('applied == floor(rolled/2)', t?.damage?.applied, Math.floor(rolled / 2));
  }

  // ---- Check 4: save spell, multi-target, friendly fire ------------------------
  group('Check 4: Fireball at skeleton + ALLY (save-passed half) and Acid Splash (save-failed full)');
  {
    await setSkelHp(200);
    const slots0 = await morthosSlots();
    const skelBefore = await skelHp();
    const akraBefore = await akraHp();
    await setUniform(0.0001); // saves: d20=20 -> both PASS; damage 8d6 all 6s (fire, unresisted)
    const r = await api(`/api/actors/${MORTHOS}/actions`, {
      method: 'POST',
      body: { actionId: `spell.${SPELLS.fireball}.cast`, kind: 'cast', targetTokenUuids: [skelUuid, akraUuid] },
    });
    eq('POST fireball -> 200', r.status, 200);
    const targets = r.json?.outcome?.targets ?? [];
    eq('two target results', targets.length, 2);
    for (const t of targets) {
      eq(`${t.name}: save-passed`, t.outcome, 'save-passed');
      check(`${t.name}: save total + dc present`, typeof t.save?.total === 'number' && typeof t.save?.dc === 'number', JSON.stringify(t.save));
      check(`${t.name}: pass consistent with total >= dc`, t.save && t.save.total >= t.save.dc);
      const rolled = rolledSum(t.damage);
      eq(`${t.name}: applied == floor(rolled/2) (half on save, fire unresisted)`, t.damage?.applied, Math.floor(rolled / 2));
    }
    const skelMid = await skelHp();
    const akraMid = await akraHp();
    eq('skeleton HP delta matches applied', skelBefore.value - skelMid.value, targets.find((t) => t.tokenUuid === skelUuid)?.damage?.applied);
    eq('ALLY (Akra) HP delta matches applied — friendly fire is real', akraBefore.value + akraBefore.temp - (akraMid.value + akraMid.temp), targets.find((t) => t.tokenUuid === akraUuid)?.damage?.applied);
    const slots1 = await morthosSlots();
    eq('3rd-level slot consumed exactly once', slots1.spell3, slots0.spell3 - 1);

    // save-FAILED leg: Acid Splash (cantrip, none-on-save -> full on fail, no slot).
    await setUniform(0.9); // d20=2 -> both FAIL
    const r2 = await api(`/api/actors/${MORTHOS}/actions`, {
      method: 'POST',
      body: { actionId: `spell.${SPELLS.acidSplash}.cast`, kind: 'cast', targetTokenUuids: [skelUuid, akraUuid] },
    });
    eq('POST acid splash -> 200', r2.status, 200);
    const targets2 = r2.json?.outcome?.targets ?? [];
    for (const t of targets2) {
      eq(`${t.name}: save-failed`, t.outcome, 'save-failed');
      const rolled = rolledSum(t.damage);
      eq(`${t.name}: applied == rolled (full on fail, acid unresisted)`, t.damage?.applied, rolled);
    }
    const slots2 = await morthosSlots();
    eq('cantrip consumed no slot', JSON.stringify(slots2), JSON.stringify(slots1));
    const msgs = await lastMessages(6);
    const saveRolls = msgs.msgs.flatMap((m) => m.rolls).filter((x) => /d20/.test(x.formula));
    check('per-target save rolls visible in chat', saveRolls.length >= 2, JSON.stringify(saveRolls));
  }

  // ---- Check 5: heal -----------------------------------------------------------
  group('Check 5: Cure Wounds on the ally — HP goes UP by applied');
  {
    // Damage the ally first so a heal is observable (well below max, above 0).
    await execJs(`const a = game.actors.get(${JSON.stringify(AKRA)}); await a.update({ 'system.attributes.hp.value': Math.max(1, Math.floor(a.system.attributes.hp.max / 2)) }); return { ok: true };`);
    const before = await akraHp();
    check('ally is damaged (heal will be visible)', before.value < before.max, `hp ${before.value}/${before.max}`);
    const slots0 = await morthosSlots();
    await setUniform(0.325); // d8=6 (+ spell mod)
    const r = await api(`/api/actors/${MORTHOS}/actions`, {
      method: 'POST',
      body: { actionId: `spell.${fixture.items.cureWounds}.cast`, kind: 'cast', targetTokenUuids: [akraUuid] },
    });
    eq('POST cure wounds -> 200', r.status, 200);
    const t = r.json?.outcome?.targets?.[0];
    check('heal applied > 0', typeof t?.damage?.applied === 'number' && t.damage.applied > 0, JSON.stringify(t));
    const after = await akraHp();
    check('HP went UP (not down!)', after.value > before.value, `before ${before.value}, after ${after.value}`);
    eq('HP rose by exactly applied', after.value - before.value, t?.damage?.applied);
    const slots1 = await morthosSlots();
    eq('1st-level slot consumed once', slots1.spell1, slots0.spell1 - 1);
  }

  // ---- Check 6: upcast slot consumption -----------------------------------------
  group('Check 6: upcast Fireball (4th) consumes the CHOSEN slot exactly once');
  {
    await setSkelHp(200);
    const slots0 = await morthosSlots();
    await setUniform(0.9); // saves fail -> full damage; irrelevant to the slot assertion
    const r = await api(`/api/actors/${MORTHOS}/actions`, {
      method: 'POST',
      body: { actionId: `spell.${SPELLS.fireball}.cast`, kind: 'cast', slotLevel: 4, targetTokenUuids: [skelUuid] },
    });
    eq('POST upcast fireball -> 200', r.status, 200);
    const slots1 = await morthosSlots();
    eq('4th-level slot consumed exactly once', slots1.spell4, slots0.spell4 - 1);
    eq('3rd-level slot untouched', slots1.spell3, slots0.spell3);
    const t = r.json?.outcome?.targets?.[0];
    const rolled = rolledSum(t?.damage);
    check('damage was rolled + applied on the upcast', rolled > 0 && typeof t?.damage?.applied === 'number', JSON.stringify(t?.damage));
    // FINDING (record only): at v=0.9 every d6=1, so `rolled` equals the die
    // COUNT. Base Fireball is 8d6; a 4th-level upcast should be 9d6. Whatever
    // count appears here tells us whether the targeted path scales upcast
    // damage — recorded in the findings doc (targetedUseScript.rollDamage is
    // called without a scaling level).
    note('FINDING: upcast damage die-count (rolled at all-1s)', String(rolled));
    note('upcast target result', JSON.stringify(t));
  }

  // ---- Check 7: versatile weapon (RECORD ONLY) -----------------------------------
  group('Check 7: versatile longsword 1H vs 2H (record only — task #9 follow-up)');
  {
    const introspect = await execJs(
      `const item = game.actors.get(${JSON.stringify(MORTHOS)}).items.get(${JSON.stringify(fixture.items.longsword)});` +
        `const act = item.system.activities.contents[0];` +
        `return { properties: [...item.system.properties], damageBase: act.damage?.parts?.[0]?.formula ?? act.damage?.parts?.[0]?.custom?.formula ?? null,` +
        `denom: act.damage?.parts?.[0]?.denomination ?? null, attackModes: (item.system.attackModes ?? act.attackModes ?? []).map((m) => m.value ?? m) };`,
    );
    note('longsword introspection', JSON.stringify(introspect));
    await setSkelHp(200);
    await setUniform(0.325); // hit, no crit
    const r = await api(`/api/actors/${MORTHOS}/actions`, {
      method: 'POST',
      body: { actionId: `item.${fixture.items.longsword}.attack`, kind: 'attack', targetTokenUuids: [skelUuid] },
    });
    eq('POST attack -> 200', r.status, 200);
    const t7 = r.json?.outcome?.targets?.[0];
    note('grip damage rolled parts', JSON.stringify(t7?.damage?.rolled));
    const msgs = await lastMessages(3);
    const dmgRoll = msgs.msgs.flatMap((m) => m.rolls).find((x) => /d(8|10)/.test(x.formula));
    note('auto damage roll formula', JSON.stringify(dmgRoll ?? null));
    // RECORD ONLY (task #9 follow-up) — never fails the run. The finding is
    // which die the auto damage roll used and that no grip toggle exists on
    // the wire today; recorded in docs/combat-targeting-live-findings.md.
    note('FINDING: damage die', dmgRoll ? (/d10/.test(dmgRoll.formula) ? 'd10 (2H)' : 'd8 (1H default)') : 'no die-bearing roll seen in chat');
  }

  // ---- Check 9a: movement budget (move + dash) ------------------------------------
  group('Check 9a: in-combat movement budget — move 20ft of 30, dash to 40');
  {
    const g0 = await api(`/api/actors/${MORTHOS}/movement`);
    eq('GET movement -> 200', g0.status, 200);
    const mv = g0.json?.movement;
    eq('inCombat', mv?.inCombat, true);
    eq('yourTurn (Morthos acting)', mv?.yourTurn, true);
    eq('full budget at turn start', mv?.remainingFt, mv?.speedFt);
    note('speed', `${mv?.speedFt} ft, token at (${mv?.token?.cx},${mv?.token?.cy})`);
    const target = { cx: mv.token.cx, cy: mv.token.cy + 4 }; // 4 cells = 20 ft, straight south (free per fixture layout)
    const r = await api(`/api/actors/${MORTHOS}/movement`, { method: 'POST', body: target });
    eq('move 20ft -> 200', r.status, 200);
    eq('remaining 10 of 30', r.json?.movement?.remainingFt, mv.speedFt - 20);
    eq('dashed false', r.json?.movement?.dashed, false);
    const m0 = (await msgCount()).n;
    const d = await api(`/api/actors/${MORTHOS}/movement/dash`, { method: 'POST' });
    eq('dash -> 200', d.status, 200);
    eq('remaining after dash = 2*speed - moved', d.json?.movement?.remainingFt, mv.speedFt * 2 - 20);
    eq('dashed true', d.json?.movement?.dashed, true);
    const dupe = await api(`/api/actors/${MORTHOS}/movement/dash`, { method: 'POST' });
    eq('second dash -> 409', dupe.status, 409);
    await sleep(500); // chat note is fire-and-forget
    const m1 = (await msgCount()).n;
    const msgs = await lastMessages(Math.max(1, m1 - m0));
    check('dash chat note posted', msgs.msgs.some((m) => /dashes/i.test(m.content) || /dashes/i.test(m.flavor)), JSON.stringify(msgs.msgs));
    // move back to origin (uses dash budget, keeps the board tidy)
    const back = await api(`/api/actors/${MORTHOS}/movement`, { method: 'POST', body: { cx: mv.token.cx, cy: mv.token.cy } });
    eq('move back -> 200', back.status, 200);
  }

  // ---- Check 8: end turn (stale race -> 409, then success) -------------------------
  group('Check 8: end turn — stale press 409s, own-turn press advances');
  {
    // Race: Foundry advances (GM) while the gateway mirror still shows Morthos
    // acting; the immediately-following end-turn must 409, never skip the
    // skeleton's turn.
    await execJs(`await game.combats.get(${JSON.stringify(fixture.combatId)}).nextTurn(); return { ok: true };`);
    const race = await api('/api/encounter/turn/end', { method: 'POST' });
    check('stale end-turn rejected (409 race guard, or 403 once the mirror caught up)', race.status === 409 || race.status === 403, `got ${race.status} ${JSON.stringify(race.json)}`);
    note('stale end-turn status', String(race.status));
    // Cycle to round 2, Morthos acting again (skeleton -> Akra -> round 2 top).
    await execJs(
      `const c = game.combats.get(${JSON.stringify(fixture.combatId)}); await c.nextTurn(); await c.nextTurn(); return { round: c.round, turn: c.turn };`,
    );
    const v = await until(
      async () => (await api('/api/encounter')).json,
      (x) => x?.round === 2 && x?.turn?.combatantId === fixture.combatants['Morthos'],
    );
    eq('mirror shows round 2, Morthos acting', v?.turn?.combatantId, fixture.combatants['Morthos']);

    // ---- Check 9b: budget refilled on the new round -------------------------------
    group('Check 9b: new round — movement budget refilled');
    const g1 = await api(`/api/actors/${MORTHOS}/movement`);
    eq('remaining refilled to full speed', g1.json?.movement?.remainingFt, g1.json?.movement?.speedFt);
    eq('dashed reset', g1.json?.movement?.dashed, false);

    group('Check 8 (cont.): own-turn end turn advances the tracker');
    const ok = await api('/api/encounter/turn/end', { method: 'POST' });
    eq('end turn -> 200', ok.status, 200);
    const v2 = await until(
      async () => (await api('/api/encounter')).json,
      (x) => x?.turn?.combatantId === fixture.combatants['E2E Skeleton'],
    );
    eq('tracker advanced to the skeleton', v2?.turn?.combatantId, fixture.combatants['E2E Skeleton']);
    const foundrySide = await execJs(`const c = game.combats.get(${JSON.stringify(fixture.combatId)}); return { round: c.round, turn: c.turn, name: c.combatant?.name };`);
    eq('Foundry tracker agrees', foundrySide.name, 'E2E Skeleton');
    // Not your turn now -> 403.
    const notYours = await api('/api/encounter/turn/end', { method: 'POST' });
    eq('end turn off-turn -> 403', notYours.status, 403);
  }

  // ---- Check 10: AC staleness fix (ac.calc under a live effect) ---------------------
  // The branch fix (commit bbf22eb) makes the adapter report the LIVE derived
  // AC (getDerivedAc) instead of a source field that ignores ac.calc / bonus
  // effects. Verified here by applying an AC-changing effect and confirming the
  // gateway sheet tracks Foundry's live value across apply + remove. An
  // AC-bonus effect (+4) is used rather than Mage Armor because Morthos's
  // unarmoredBard calc already beats Mage Armor's `mage` calc — see the
  // findings doc's Check-10 note on the separate self-buff-cast issue.
  group('Check 10: sheet AC tracks the live derived value under an active effect');
  {
    const acOf = (sheet) => sheet?.resources?.find((r) => r.id === 'ac')?.value;
    const liveAc = async () => (await execJs(`return { ac: game.actors.get(${JSON.stringify(MORTHOS)}).system.attributes.ac.value };`)).ac;
    // clean any stray app effect first
    await execJs(`const m=game.actors.get(${JSON.stringify(MORTHOS)}); for(const e of m.effects.filter(e=>e.flags?.['unseen-servent']?.appliedBy==='app')) await e.delete(); return {ok:true};`);

    const s0 = await api(`/api/actors/${MORTHOS}/sheet`);
    const acBefore = acOf(s0.json?.sheet);
    eq('baseline: sheet AC == Foundry live derived (no staleness at rest)', acBefore, await liveAc());

    // Apply a +4 AC effect straight through the relay (the proven applyEffect
    // path) — simulates any effect that shifts ac.calc/bonus.
    const effectId = 'e2eAcBuffLiveTst'; // exactly 16 chars — Foundry rejects other lengths
    await relay.applyEffect(`Actor.${MORTHOS}`, {
      _id: effectId,
      name: 'E2E AC Buff',
      changes: [{ key: 'system.attributes.ac.bonus', mode: 2, value: '4' }],
      flags: { 'unseen-servent': { appliedBy: 'app' } },
    });
    const liveAfter = await liveAc();
    const s1 = await api(`/api/actors/${MORTHOS}/sheet`);
    const acAfter = acOf(s1.json?.sheet);
    note('AC', `before ${acBefore} -> after ${acAfter} (Foundry live derived: ${liveAfter})`);
    check('AC actually moved (+4 effect raised the live derived value)', liveAfter === acBefore + 4, `live ${liveAfter}`);
    eq('THE FIX: sheet AC reflects the live effect-driven AC (not stale)', acAfter, liveAfter);

    // Remove the effect and confirm the sheet tracks the restored live value.
    await execJs(`const m=game.actors.get(${JSON.stringify(MORTHOS)}); const e=m.effects.get(${JSON.stringify(effectId)}); if(e) await e.delete(); return {ok:true};`);
    const s2 = await api(`/api/actors/${MORTHOS}/sheet`);
    const acRestored = acOf(s2.json?.sheet);
    eq('sheet AC back to baseline after removal', acRestored, acBefore);
    eq('and still equals Foundry live derived', acRestored, await liveAc());

    // Record-only: the app's own "cast Mage Armor" self-buff path.
    const before = await liveAc();
    const cast = await api(`/api/actors/${MORTHOS}/actions`, { method: 'POST', body: { actionId: `spell.${SPELLS.mageArmor}.cast`, kind: 'cast' } });
    const appEffect = await execJs(`return { has: game.actors.get(${JSON.stringify(MORTHOS)}).effects.some(e=>e.name==='Mage Armor' && e.flags?.['unseen-servent']?.appliedBy==='app') };`);
    note('FINDING: app cast Mage Armor', `status ${cast.status}; effect created in Foundry: ${appEffect.has}; AC ${before}->${await liveAc()} (unarmoredBard already beats mage calc)`);
    await execJs(`const m=game.actors.get(${JSON.stringify(MORTHOS)}); for(const e of m.effects.filter(e=>e.flags?.['unseen-servent']?.appliedBy==='app')) await e.delete(); return {ok:true};`);
  }
}

try {
  await main();
} catch (err) {
  failures.push(`[fatal] ${err.message}`);
  console.error(`\n\x1b[31mFatal:\x1b[0m ${err.stack ?? err.message}`);
} finally {
  try {
    if (dicePatched) await restoreUniform();
    else await restoreUniform().catch(() => undefined); // belt and braces
  } catch (err) {
    console.error(`  \x1b[31mDICE PATCH RESTORE FAILED\x1b[0m — run in Foundry console: CONFIG.Dice.randomUniform = window.__e2eOrigRU (${err.message})`);
  }
  await cleanupWorld();
  encounters?.stop();
  if (app) await app.close().catch(() => undefined);
  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
  process.exit(failures.length === 0 ? 0 : 1);
}
