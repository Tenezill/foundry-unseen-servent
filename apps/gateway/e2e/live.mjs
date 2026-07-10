#!/usr/bin/env node
/**
 * Live end-to-end test (PLAN.md "M4 accept" / §8 "e2e via stack").
 *
 * Unlike the Vitest suites — which drive `buildApp` against fakes — this boots
 * the REAL gateway (real `FoundryRelayClient`) over a real HTTP socket and
 * exercises the whole player journey against the running dev stack:
 *
 *     PWA-shaped HTTP  ->  gateway  ->  relay  ->  Foundry v13 + dnd5e
 *
 * It proves the acceptance criteria the fakes cannot: a resource write made
 * through the API actually lands in Foundry (read straight back off the relay),
 * and a GM/world change is pushed live to an SSE subscriber.
 *
 * Prereq: the dev stack is up (`stack/docker-compose.dev.yml`) AND a GM browser
 * tab holds the world online (M0-findings §2). Config comes from
 * `apps/gateway/.env`; actor scoping is derived from `apps/gateway/players.yaml`.
 * Every value this test changes is restored before it exits (even on failure).
 *
 *     pnpm --filter @companion/gateway test:e2e
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { sha256Hex, loadPlayers } from '../src/players.js';
import { createDefaultRegistry } from '../src/registry.js';
import { FoundryRelayClient } from '@companion/foundry-client';

// --- tiny assertion harness -------------------------------------------------

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
function skip(name, why) {
  console.log(`  \x1b[33m∅ ${name}\x1b[0m (skipped: ${why})`);
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// --- env / config -----------------------------------------------------------

/** Parse a KEY=VALUE .env file (comments and blank lines ignored). */
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

const envPath = new URL('../.env', import.meta.url);
const playersPath = new URL('../players.yaml', import.meta.url);
const env = { ...parseDotenv(envPath), ...process.env };

let cfg;
try {
  cfg = loadConfig(env);
} catch (err) {
  console.error(`\x1b[31mConfig error:\x1b[0m ${err.message}`);
  console.error('Fill apps/gateway/.env (see .env.example) before running the e2e test.');
  process.exit(1);
}

// --- helpers ----------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findResource(sheet, id) {
  return sheet.resources.find((r) => r.id === id);
}

/** Read an actor's raw HP straight off the relay — proof a write hit Foundry. */
async function relayHp(relay, actorId) {
  const doc = await relay.getEntity(`Actor.${actorId}`);
  const hp = doc?.system?.attributes?.hp?.value;
  return typeof hp === 'number' ? hp : null;
}

/**
 * Read one 'sheet' SSE frame from the gateway whose parsed payload satisfies
 * `match(sheet)`, or reject on timeout. Returns the matching sheet.
 */
async function nextSheetEvent(base, actorId, token, match, timeoutMs, signal) {
  const res = await fetch(`${base}/api/actors/${actorId}/events?token=${token}`, {
    headers: { accept: 'text/event-stream' },
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`events stream -> ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      if (Date.now() > deadline) throw new Error('timeout waiting for matching sheet event');
      const { done, value } = await reader.read();
      if (done) throw new Error('stream ended before a matching event');
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const sep = buffer.indexOf('\n\n');
        if (sep === -1) break;
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = 'message';
        const data = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        }
        if (event !== 'sheet' || data.length === 0) continue;
        let sheet;
        try {
          sheet = JSON.parse(data.join('\n'));
        } catch {
          continue;
        }
        if (match(sheet)) return sheet;
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

// --- run --------------------------------------------------------------------

const relay = new FoundryRelayClient({
  baseUrl: cfg.relayUrl,
  apiKey: cfg.relayApiKey,
  clientId: cfg.relayClientId,
});

// Restore actions registered as state is mutated; run in finally (even on
// crash) so the world is left exactly as found.
const restores = [];

const E2E_TOKEN = `e2e-${randomBytes(12).toString('hex')}`;
const SOLO_TOKEN = `solo-${randomBytes(12).toString('hex')}`;
const NOBODY_TOKEN = `nobody-${randomBytes(12).toString('hex')}`;

let app = null;
let sseAbort = null;

async function main() {
  group('Preflight: relay + world online');
  const clients = await relay.listClients();
  const world = clients.find((c) => c.clientId === cfg.relayClientId);
  check('relay reachable and returns the configured world', !!world, `clientId ${cfg.relayClientId} not among ${clients.length} clients`);
  if (!world) throw new Error('configured world not connected to relay');
  check(`world "${world.worldTitle}" is online`, world.isOnline === true, 'open a GM browser tab so the module holds the world online');
  console.log(`    ${world.systemId} ${world.systemVersion} on Foundry ${world.foundryVersion}`);
  if (!world.isOnline) throw new Error('world offline: writes/reads require a live GM session');

  // Actor scope from the real players.yaml; e2e player owns all of them.
  const realPlayers = loadPlayers(fileURLToPath(playersPath));
  const actorIds = [...new Set(realPlayers.flatMap((p) => p.actorIds))];
  check('players.yaml yields at least one actor id', actorIds.length > 0, `${actorIds.length} actors`);
  if (actorIds.length === 0) throw new Error('no actor ids configured');

  const players = [
    { name: 'e2e', tokenHash: sha256Hex(E2E_TOKEN), actorIds: [...actorIds] },
    { name: 'solo', tokenHash: sha256Hex(SOLO_TOKEN), actorIds: [actorIds[0]] },
    { name: 'nobody', tokenHash: sha256Hex(NOBODY_TOKEN), actorIds: [] },
  ];

  app = buildApp({
    relay,
    players: { list: () => players },
    registry: createDefaultRegistry(),
    defaultSystemId: cfg.defaultSystemId,
    livePollMs: 60_000, // force the SSE test to exercise real relay push, not polling
    liveReconnectMinMs: 250,
    liveReconnectMaxMs: 2_000,
    pingMs: 60_000,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const base = `http://127.0.0.1:${addr.port}`;

  const api = async (path, { method = 'GET', token, body } = {}) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  };

  // -- health ---------------------------------------------------------------
  group('Health');
  {
    const r = await api('/healthz');
    eq('GET /healthz -> 200', r.status, 200);
    eq('reports relay connected', r.json?.relay, 'connected');
  }

  // -- auth -----------------------------------------------------------------
  group('Auth & identity');
  {
    const noTok = await api('/api/me');
    eq('GET /api/me without token -> 401', noTok.status, 401);
    eq('  error code UNAUTHORIZED', noTok.json?.error?.code, 'UNAUTHORIZED');

    const badTok = await api('/api/me', { token: 'not-a-real-token' });
    eq('GET /api/me with bad token -> 401', badTok.status, 401);

    const me = await api('/api/me', { token: E2E_TOKEN });
    eq('GET /api/me with valid token -> 200', me.status, 200);
    eq('  returns player name', me.json?.player?.name, 'e2e');
    check('  returns the full actor scope', JSON.stringify(me.json?.player?.actorIds) === JSON.stringify(actorIds));
    check('  never leaks the relay api key', !me.text.includes(cfg.relayApiKey));
  }

  // -- actor list + sheets --------------------------------------------------
  group('Actor list & sheets');
  const sheets = new Map();
  {
    const list = await api('/api/actors', { token: E2E_TOKEN });
    eq('GET /api/actors -> 200', list.status, 200);
    const returned = (list.json?.actors ?? []).map((a) => a.id);
    check('lists exactly the scoped actors', JSON.stringify([...returned].sort()) === JSON.stringify([...actorIds].sort()), JSON.stringify(returned));
    check('every listed actor has a name', (list.json?.actors ?? []).every((a) => typeof a.name === 'string' && a.name.length > 0));
    check('list body never leaks the relay api key', !list.text.includes(cfg.relayApiKey));

    for (const id of actorIds) {
      const s = await api(`/api/actors/${id}/sheet`, { token: E2E_TOKEN });
      eq(`GET /api/actors/${id}/sheet -> 200`, s.status, 200);
      const sheet = s.json?.sheet;
      if (!sheet) continue;
      sheets.set(id, sheet);
      eq(`  sheet.actorId matches`, sheet.actorId, id);
      check(`  has an HP resource with bounds`, !!findResource(sheet, 'hp') && typeof findResource(sheet, 'hp').max === 'number');
      check(`  has ability + skill sections`, sheet.sections.some((x) => x.id === 'abilities') && sheet.sections.some((x) => x.id === 'skills'));
    }
  }

  // -- scoping --------------------------------------------------------------
  group('Scoping (a player only sees their own)');
  {
    const nobody = await api(`/api/actors/${actorIds[0]}/sheet`, { token: NOBODY_TOKEN });
    eq('unscoped player -> 404 (existence not leaked)', nobody.status, 404);
    eq('  error code NOT_FOUND', nobody.json?.error?.code, 'NOT_FOUND');

    if (actorIds.length > 1) {
      const cross = await api(`/api/actors/${actorIds[1]}/sheet`, { token: SOLO_TOKEN });
      eq("foreign actor for a scoped player -> 404", cross.status, 404);
      const soloList = await api('/api/actors', { token: SOLO_TOKEN });
      check('scoped list contains only the owned actor', JSON.stringify((soloList.json?.actors ?? []).map((a) => a.id)) === JSON.stringify([actorIds[0]]));
    } else {
      skip('foreign-actor 404', 'only one actor configured');
    }
  }

  // -- HP write round-trip to Foundry (M3 accept) ---------------------------
  group('HP write round-trips to Foundry (M3)');
  {
    const id = actorIds[0];
    const hp0 = findResource(sheets.get(id), 'hp');
    const original = hp0.value;
    const damage = Math.min(3, Math.max(1, original)); // never drive below 0
    const target = original - damage;

    restores.push(async () => {
      await relay.updateEntity(`Actor.${id}`, { 'system.attributes.hp.value': original });
    });

    const dmg = await api(`/api/actors/${id}/intents`, {
      method: 'POST',
      token: E2E_TOKEN,
      body: { kind: 'delta', resourceId: 'hp', amount: -damage, expected: original },
    });
    eq(`POST damage -${damage} -> 200`, dmg.status, 200);
    eq('  returned sheet shows the new HP', findResource(dmg.json?.sheet, 'hp')?.value, target);

    await sleep(150);
    eq('  the change is visible reading Foundry back off the relay', await relayHp(relay, id), target);

    const stale = await api(`/api/actors/${id}/intents`, {
      method: 'POST',
      token: E2E_TOKEN,
      body: { kind: 'delta', resourceId: 'hp', amount: -1, expected: original }, // wrong expected now
    });
    eq('stale optimistic-lock write -> 409 CONFLICT', stale.status, 409);
    eq('  conflict returns the fresh sheet', findResource(stale.json?.sheet, 'hp')?.value, target);

    const heal = await api(`/api/actors/${id}/intents`, {
      method: 'POST',
      token: E2E_TOKEN,
      body: { kind: 'set', resourceId: 'hp', value: original },
    });
    eq('restore to original HP -> 200', heal.status, 200);
    eq('  Foundry back at original HP', await relayHp(relay, id), original);
  }

  // -- spell slot spend (M4 accept: "spend a spell slot") -------------------
  group('Spell slot spend (M4)');
  {
    let casterId = null;
    let slot = null;
    for (const id of actorIds) {
      const s = sheets.get(id);
      const found = s?.resources.find((r) => /^slots\.(\d|pact)$/.test(r.id) && (r.max ?? 0) > 0);
      if (found) {
        casterId = id;
        slot = found;
        break;
      }
    }
    if (!casterId) {
      skip('spell slot round-trip', 'no actor with spell slots in scope');
    } else {
      const original = slot.value;
      restores.push(async () => {
        const path = slot.id === 'slots.pact' ? 'system.spells.pact.value' : `system.spells.spell${slot.id.split('.')[1]}.value`;
        await relay.updateEntity(`Actor.${casterId}`, { [path]: original });
      });

      if (original > 0) {
        const spend = await api(`/api/actors/${casterId}/intents`, {
          method: 'POST',
          token: E2E_TOKEN,
          body: { kind: 'delta', resourceId: slot.id, amount: -1, expected: original },
        });
        eq(`POST spend one ${slot.id} -> 200`, spend.status, 200);
        eq('  slot decremented', findResource(spend.json?.sheet, slot.id)?.value, original - 1);

        const restore = await api(`/api/actors/${casterId}/intents`, {
          method: 'POST',
          token: E2E_TOKEN,
          body: { kind: 'set', resourceId: slot.id, value: original },
        });
        eq('  restore slot -> 200', restore.status, 200);
        eq('  slot back to original', findResource(restore.json?.sheet, slot.id)?.value, original);
      } else {
        // Slot already empty: gain one then spend it back, still a real round-trip.
        const gain = await api(`/api/actors/${casterId}/intents`, {
          method: 'POST',
          token: E2E_TOKEN,
          body: { kind: 'set', resourceId: slot.id, value: 1 },
        });
        eq(`POST set ${slot.id}=1 -> 200`, gain.status, 200);
        eq('  slot shows 1', findResource(gain.json?.sheet, slot.id)?.value, 1);
        const back = await api(`/api/actors/${casterId}/intents`, {
          method: 'POST',
          token: E2E_TOKEN,
          body: { kind: 'set', resourceId: slot.id, value: 0 },
        });
        eq('  restore slot to 0 -> 200', back.status, 200);
      }
    }
  }

  // -- write allow-list enforcement -----------------------------------------
  group('Write allow-list & validation');
  {
    const id = actorIds[0];
    const before = await relayHp(relay, id);

    const readOnly = await api(`/api/actors/${id}/intents`, { method: 'POST', token: E2E_TOKEN, body: { kind: 'set', resourceId: 'ac', value: 30 } });
    eq('write to read-only "ac" -> 403', readOnly.status, 403);
    eq('  code FORBIDDEN_RESOURCE', readOnly.json?.error?.code, 'FORBIDDEN_RESOURCE');

    const unknown = await api(`/api/actors/${id}/intents`, { method: 'POST', token: E2E_TOKEN, body: { kind: 'set', resourceId: 'not.a.resource', value: 1 } });
    eq('write to unknown resource -> 403', unknown.status, 403);

    const bad = await api(`/api/actors/${id}/intents`, { method: 'POST', token: E2E_TOKEN, body: { resourceId: 'hp' } });
    eq('malformed intent -> 422', bad.status, 422);
    eq('  code INVALID_INTENT', bad.json?.error?.code, 'INVALID_INTENT');

    eq('none of the rejected writes touched Foundry', await relayHp(relay, id), before);
  }

  // -- live SSE push (M4 accept: "watch HP change live") --------------------
  group('Live SSE push from a world change (M4)');
  {
    const id = actorIds[0];
    const original = (await relayHp(relay, id)) ?? findResource(sheets.get(id), 'hp').value;
    const bumped = Math.max(0, original - 1);

    // No token on the SSE route -> 401.
    const noAuth = await fetch(`${base}/api/actors/${id}/events`);
    eq('SSE without token -> 401', noAuth.status, 401);
    await noAuth.body?.cancel().catch(() => undefined);

    sseAbort = new AbortController();
    restores.push(async () => {
      await relay.updateEntity(`Actor.${id}`, { 'system.attributes.hp.value': original });
    });

    // Subscribe, wait until the gateway's shared relay hooks stream is live,
    // then make a change directly on the relay (simulating the GM/Foundry) and
    // expect it pushed to our subscriber.
    const waitForPush = nextSheetEvent(
      base,
      id,
      E2E_TOKEN,
      (sheet) => findResource(sheet, 'hp')?.value === bumped,
      10_000,
      sseAbort.signal,
    );
    await sleep(600); // let the initial 'sheet' event flush and the hooks stream attach
    await relay.updateEntity(`Actor.${id}`, { 'system.attributes.hp.value': bumped });

    try {
      const pushed = await waitForPush;
      check('a Foundry-side HP change is pushed live over SSE', findResource(pushed, 'hp')?.value === bumped);
    } catch (err) {
      check('a Foundry-side HP change is pushed live over SSE', false, err.message);
    } finally {
      sseAbort.abort();
      sseAbort = null;
    }
  }
}

// --- entrypoint -------------------------------------------------------------

let exitCode = 0;
try {
  await main();
} catch (err) {
  failures.push(`fatal: ${err?.message ?? err}`);
  console.error(`\n\x1b[31mfatal:\x1b[0m ${err?.stack ?? err}`);
} finally {
  if (sseAbort) sseAbort.abort();
  for (const restore of restores.reverse()) {
    try {
      await restore();
    } catch (err) {
      console.error(`  \x1b[33mrestore failed:\x1b[0m ${err?.message ?? err}`);
    }
  }
  if (app) await app.close().catch(() => undefined);
}

console.log(`\n\x1b[1mSummary:\x1b[0m ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('\x1b[31mFailures:\x1b[0m');
  for (const f of failures) console.log(`  - ${f}`);
  exitCode = 1;
}
process.exit(exitCode);
