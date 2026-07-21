/**
 * Live movement check (token movement v1, plan Task 6).
 *
 * Boots the REAL gateway (real FoundryRelayClient) in-process against the
 * running dev stack and exercises GET/POST /api/actors/:id/movement end to
 * end: view shape, ownership 404, out-of-range 422, occupied 409 (when a
 * neighbor exists), and a real move — one square and back, animated in
 * Foundry. The token is restored to its original cell even on failure.
 *
 * Prereq: dev stack up (stack/docker-compose.dev.yml), GM browser tab holds
 * the world online, and at least one configured actor has a token on the
 * ACTIVE square-grid scene. Config from apps/gateway/.env; actor scope from
 * apps/gateway/players.yaml. The relay API key must carry the `scene:read`
 * and `canvas:write` scopes (GET /scene and POST /move-token 403 without
 * them — see apps/bootstrap/src/scopes.ts).
 *
 *     pnpm --filter @companion/gateway exec node e2e/live-movement.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { sha256Hex, loadPlayers } from '../src/players.js';
import { createDefaultRegistry } from '../src/registry.js';
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
function skip(name, why) {
  console.log(`  \x1b[33m∅ ${name}\x1b[0m (skipped: ${why})`);
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

// --- run ----------------------------------------------------------------------

// RELAY_CLIENT_ID=auto -> cfg.relayClientId is undefined; resolve it the way
// ClientIdResolver does: relay-global GET /clients, pick the online world.
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

const E2E_TOKEN = `e2e-${randomBytes(12).toString('hex')}`;
const NOBODY_TOKEN = `nobody-${randomBytes(12).toString('hex')}`;

let app = null;
/** Set once the outbound move succeeds; cleared after a confirmed restore. */
let restoreMove = null; // { actorId, cell: {cx, cy} }

async function main() {
  group('Preflight: relay + world online');
  const clients = await relay.listClients();
  const world = clients.find((c) => c.clientId === resolvedClientId);
  check('relay reachable, configured world present', !!world, `clientId not among ${clients.length} clients`);
  if (!world) throw new Error('configured world not connected to relay');
  check(`world "${world.worldTitle}" is online`, world.isOnline === true, 'open a GM browser tab');
  if (!world.isOnline) throw new Error('world offline');

  const realPlayers = loadPlayers(fileURLToPath(new URL('../players.yaml', import.meta.url)));
  const actorIds = [...new Set(realPlayers.flatMap((p) => p.actorIds))];
  check('players.yaml yields actor ids', actorIds.length > 0, 'none configured');

  const players = [
    { name: 'e2e', tokenHash: sha256Hex(E2E_TOKEN), actorIds: [...actorIds] },
    { name: 'nobody', tokenHash: sha256Hex(NOBODY_TOKEN), actorIds: [] },
  ];

  app = buildApp({
    relay,
    players: { list: () => players },
    registry: createDefaultRegistry(),
    defaultSystemId: cfg.defaultSystemId,
    livePollMs: 60_000,
    pingMs: 60_000,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const api = async (path, { method = 'GET', token, body } = {}) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${path}`, {
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
  };

  // -- find an on-scene actor --------------------------------------------------
  group('GET /api/actors/:id/movement — view');
  let actorId = null;
  let view = null;
  for (const id of actorIds) {
    const r = await api(`/api/actors/${id}/movement`, { token: E2E_TOKEN });
    if (r.status === 200 && r.json?.movement?.onScene) {
      actorId = id;
      view = r.json.movement;
      break;
    }
  }
  check('an actor has a token on the active scene', actorId !== null,
    'place a configured actor token on the ACTIVE square-grid scene');
  if (!actorId) throw new Error('no on-scene actor — nothing to verify');

  console.log(`    actor ${actorId} @ (${view.token.cx},${view.token.cy}) — ${view.speedFt} ${view.gridUnits}, grid ${view.gridDistance} ${view.gridUnits}/cell, others: ${view.others.length}`);
  check('gridDistance > 0', typeof view.gridDistance === 'number' && view.gridDistance > 0, String(view.gridDistance));
  check('speedFt > 0', typeof view.speedFt === 'number' && view.speedFt > 0, String(view.speedFt));
  check('token cell has integer coords', Number.isInteger(view.token?.cx) && Number.isInteger(view.token?.cy));
  check('others is an array', Array.isArray(view.others));
  check('sceneId present', typeof view.sceneId === 'string' && view.sceneId.length > 0);

  const radius = Math.floor(view.speedFt / view.gridDistance);
  const occupied = new Set(view.others.map((o) => `${o.cx},${o.cy}`));

  // -- ownership ---------------------------------------------------------------
  group('Ownership & validation');
  {
    const r = await api(`/api/actors/${actorId}/movement`, { token: NOBODY_TOKEN });
    eq('foreign actor GET -> 404 (never 403)', r.status, 404);

    const far = await api(`/api/actors/${actorId}/movement`, {
      method: 'POST', token: E2E_TOKEN,
      body: { cx: view.token.cx + radius + 1, cy: view.token.cy },
    });
    eq('out-of-range POST -> 422', far.status, 422);
    eq('  code INVALID_INTENT', far.json?.error?.code, 'INVALID_INTENT');

    const malformed = await api(`/api/actors/${actorId}/movement`, {
      method: 'POST', token: E2E_TOKEN, body: { cx: 1.5, cy: 0 },
    });
    eq('non-integer POST -> 422', malformed.status, 422);

    const inRangeOccupied = view.others.find(
      (o) => Math.max(Math.abs(o.cx - view.token.cx), Math.abs(o.cy - view.token.cy)) <= radius,
    );
    if (inRangeOccupied) {
      const r409 = await api(`/api/actors/${actorId}/movement`, {
        method: 'POST', token: E2E_TOKEN, body: { cx: inRangeOccupied.cx, cy: inRangeOccupied.cy },
      });
      eq('occupied cell POST -> 409', r409.status, 409);
      eq('  code CONFLICT', r409.json?.error?.code, 'CONFLICT');
    } else {
      skip('occupied cell POST -> 409', 'no visible token within range');
    }
  }

  // -- the real move: one square and back --------------------------------------
  group('Move one square and back (watch Foundry!)');
  {
    // First free in-range neighbor (prefer east, then the other 7 directions).
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
    const target = dirs
      .map(([dx, dy]) => ({ cx: view.token.cx + dx, cy: view.token.cy + dy }))
      .find((c) => !occupied.has(`${c.cx},${c.cy}`));
    check('a free neighboring cell exists', !!target);
    if (!target) throw new Error('token is fully boxed in — cannot test a move');

    const origin = { cx: view.token.cx, cy: view.token.cy };
    const out = await api(`/api/actors/${actorId}/movement`, {
      method: 'POST', token: E2E_TOKEN, body: target,
    });
    eq('move POST -> 200', out.status, 200);
    if (out.status === 200) restoreMove = { actorId, cell: origin };
    eq('response token at target cx', out.json?.movement?.token?.cx, target.cx);
    eq('response token at target cy', out.json?.movement?.token?.cy, target.cy);

    // Fresh GET must agree with the POST echo (proves the write hit Foundry).
    const confirm = await api(`/api/actors/${actorId}/movement`, { token: E2E_TOKEN });
    eq('fresh GET sees the token at the target cell', `${confirm.json?.movement?.token?.cx},${confirm.json?.movement?.token?.cy}`, `${target.cx},${target.cy}`);

    // Move back (this is also the restore).
    const back = await api(`/api/actors/${actorId}/movement`, {
      method: 'POST', token: E2E_TOKEN, body: origin,
    });
    eq('move back POST -> 200', back.status, 200);
    if (back.status === 200) restoreMove = null;
    const confirm2 = await api(`/api/actors/${actorId}/movement`, { token: E2E_TOKEN });
    eq('token restored to origin', `${confirm2.json?.movement?.token?.cx},${confirm2.json?.movement?.token?.cy}`, `${origin.cx},${origin.cy}`);
  }
}

try {
  await main();
} catch (err) {
  failures.push(`[fatal] ${err.message}`);
  console.error(`\n\x1b[31mFatal:\x1b[0m ${err.message}`);
} finally {
  // Best-effort restore if the outbound move landed but the return didn't.
  if (restoreMove && app) {
    try {
      const addr = app.server.address();
      await fetch(`http://127.0.0.1:${addr.port}/api/actors/${restoreMove.actorId}/movement`, {
        method: 'POST',
        headers: { authorization: `Bearer ${E2E_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(restoreMove.cell),
      });
      console.log('  (token position restored)');
    } catch {
      console.error('  RESTORE FAILED — move the token back by hand.');
    }
  }
  if (app) await app.close();
  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
  process.exit(failures.length === 0 ? 0 : 1);
}
