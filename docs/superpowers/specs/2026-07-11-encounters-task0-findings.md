# M22 Task 0 — Encounters feasibility spike: live findings

Live-verified against: Foundry VTT 13.351, dnd5e 5.3.3, relay `threehats/foundryvtt-rest-api-relay:3.4.1`, world `companion-test`. Relay reached at `http://localhost:3010`, clientId `fvtt_779f197009ce8c97`, API key = `<KEY>` (the key currently in `apps/gateway/.env` as `RELAY_API_KEY`).

## 1. Verdict per endpoint

| Surface | Verdict | Detail |
|---|---|---|
| `GET /encounters` (read combats) | **QUIRK — scope-blocked, not dead** | `403 {"error":"API key lacks required scope: encounter:read"}`. The route exists and is wired to real Foundry Combat data (confirmed by source read, §2) — our current key just isn't provisioned for it. |
| `POST /start-encounter` | **QUIRK — scope-blocked** | `403 {"error":"API key lacks required scope: encounter:manage"}`. Source shows a real handler (`Combat.create` + `startCombat`), gated by a single write scope that almost certainly also covers `end-encounter`/`next-turn`/`next-round`/`last-turn`/`last-round`/`add-to-encounter`/`remove-from-encounter` (all registered on the same `encounterRouter`; not each individually re-tested since the error text and router grouping make it near-certain). |
| `GET /hooks/subscribe?hooks=updateCombat,createCombatant,deleteCombatant,deleteCombat` | **WORKS** | Already covered by the `events:subscribe` scope our key has. Live-verified: delivered a real `updateCombat` SSE frame within ~2s of `game.combat.nextTurn()`. This is the practical live-push path today, independent of the `encounter:*` scopes. |
| `GET /get?uuid=Actor.<id>` (any actor, including NPC) | **WORKS** | `entity:read` scope already granted. Full serialized actor document returned, matches the M0-documented envelope (`{type:"entity-result", requestId, uuid, data:{...doc}}`). |
| `PUT /update?uuid=Actor.<id>` | **WORKS** | `entity:write` scope already granted. Verified against a real NPC's `system.attributes.hp.max`/`.value`. |

**Root cause / actionable finding:** the relay enforces per-scope API keys, and the key documented in `packages/foundry-client/src/index.ts` (`entity:read, entity:write, search, events:subscribe, clients:read`) is exactly what's provisioned — it was never granted `encounter:read` or `encounter:manage`. There's a relay admin panel at `http://localhost:3010/admin` (separate short-lived JWT-cookie login, 15 min idle timeout) that almost certainly can mint/edit scoped keys, but it requires admin email/password credentials this spike does not have and was not authorized to create — out of scope for a research spike. **Before gateway work depends on the REST encounters endpoints, someone with relay admin access needs to issue a key with `encounter:read` + `encounter:manage`.**

## 2. Verbatim JSON shapes (source-read, module.js `foundry-rest-api` 3.x)

### 2a. Read shape — `encounters` actionType handler (drives `GET /encounters`)

Per-combat object (from `game.combats.contents.map(...)`):

```js
{
  id: <combat._id>,
  name: <combat.name>,
  round: <combat.round>,
  turn: <combat.turn>,
  current: <boolean, true iff this combat === game.combat>,
  combatants: [
    {
      id: <combatant._id>,
      name: <combatant.name>,
      tokenUuid: <combatant.token?.uuid ?? undefined>,
      actorUuid: <combatant.actor?.uuid ?? undefined>,
      img: <combatant.img>,
      initiative: <combatant.initiative>,
      hidden: <combatant.hidden>,
      defeated: <combatant.isDefeated>
    },
    ...
  ]
}
```

Envelope: `{type:"encounters-result", requestId, encounters:[<above>, ...]}`.

Non-GM callers get combatant-list filtered: hidden combatants are dropped unless the requesting user has `testUserPermission(user, 3)` (OWNER) on the linked actor.

### 2b. Live-verified — `updateCombat` hook-event via `/hooks/subscribe`

Actual SSE frame captured while advancing a turn (`game.combat.nextTurn()`), through the granted `events:subscribe` scope, no encounter scope needed:

```
event: updateCombat
data: {"data":{"args":[
  {
    "_id":"dUUDhttMX884hSeE",
    "_stats":{"compendiumSource":null,"coreVersion":"13.351","createdTime":1783766351781,
      "duplicateSource":null,"exportSource":null,"lastModifiedBy":"lRmI4nnUdvBdatol",
      "modifiedTime":1783766377515,"systemId":"dnd5e","systemVersion":"5.3.3"},
    "active":false,
    "combatants":[
      {"_id":"gVBG8XpD2AcMrIpF","_stats":{...},"actorId":"zteTG9PZZ6XQpQtK","defeated":false,
       "flags":{},"group":null,"hidden":false,"img":null,"initiative":6,"sceneId":null,
       "system":{},"tokenId":null,"type":"base"},
      {"_id":"0F9pOLR0yBqA7iCT","_stats":{...},"actorId":"pTvtx5dm2AuYqeX2","defeated":false,
       "flags":{},"group":null,"hidden":false,"img":null,"initiative":10,"sceneId":null,
       "system":{},"tokenId":null,"type":"base"}
    ],
    "flags":{},"groups":[],"round":2,"scene":null,"sort":0,"system":{},"turn":0,"type":"base"
  },
  { "_id":"dUUDhttMX884hSeE", "_stats":{"modifiedTime":1783766377515}, "round":2, "turn":0 },
  { "action":"update","diff":true,"direction":1,"modifiedTime":1783766377515,"parent":null,
    "recursive":true,"render":true,"worldTime":{"delta":6} },
  "lRmI4nnUdvBdatol"
],"hook":"updateCombat"},"type":"hook-event"}
```

This matches the `HookEvent`/`data.args` contract already documented in `packages/foundry-client/src/index.ts`: `args[0]` = full updated Combat document, `args[1]` = diff (only changed fields), `args[2]` = update options, `args[3]` = triggering userId. **The full combatant list (with `actorId`, `initiative`, `defeated`, `tokenId`) rides along on every `updateCombat` frame** — a poller/subscriber does not need a separate read call to get current combatant state after each push.

### 2c. Live-verified — `GET /get?uuid=Actor.<npcId>` (bare NPC)

Envelope unchanged from the M0-documented shape (`{type:"entity-result", requestId, uuid, data:{...}}`). Relevant slice of a freshly-created bare NPC (before any edits):

```json
"attributes": {
  "hp": {"max":0,"temp":0,"tempmax":0,"value":0,"formula":""},
  "ac": {"calc":"default","flat":null}
}
```
(client-side derived `ac.value` was `10`, `ac.armor` `10` — dnd5e's default flat AC — but `hp.max`/`hp.value` are genuinely `0` with no CR-based default; a gateway-created NPC needs its HP set explicitly or it will show 0/0.)

### 2d. Live-verified — `PUT /update` response envelope (undocumented in foundry-client comments)

```json
{"type":"update-result","requestId":"update_...","uuid":"Actor.6mvUNlbIji0NJddx","entity":[{...full actor doc...}]}
```

**Quirk to flag:** `entity` is an **array** containing the single updated document, not a bare object. `unwrapEntity()` in `packages/foundry-client/src/index.ts` explicitly rejects arrays (`&& !Array.isArray(inner)`) when picking `data`/`entity`/`result` — today that's harmless because `updateEntity()` doesn't call `unwrapEntity`, but anyone tempted to reuse `unwrapEntity` for update responses will get `null` back. Worth a one-line comment in the client if update-response parsing is ever added.

## 3. Live-push verdict + evidence

**Verdict: WORKS today, without any new scope.** `GET /hooks/subscribe?hooks=updateCombat,createCombatant,deleteCombatant,deleteCombat` (or a superset including `createCombat`) delivers combat state changes over SSE using only the already-granted `events:subscribe` scope — see §2b for a captured frame within ~2 seconds of a real `nextTurn()` call.

Source (`module.js`) shows a **second, richer channel** the module can also push through: an `enableEventChannel("combat-events")` path that normalizes events to `{type:"combat-event", data:{eventType:"start"|"turn"|"end"|"combatant-add"|"combatant-remove", encounterId, round, turn, started, combatants:[{id,name,initiative,defeated,uuid}]}}` on hooks `combatStart`/`updateCombat` (turn/round changes only, not arbitrary field edits)/`createCombatant`/`deleteCombatant`/`deleteCombat`. This channel is switched on by the relay sending the Foundry module an internal `event-subscription-update` websocket message (`{channel, count}`) — i.e. it's activated when some REST client subscribes to a relay-side SSE route for it. **We could not identify or successfully hit that route from outside** (unlike `/rolls/subscribe`, `/hooks/subscribe`, `/actor/subscribe`, which are all documented in `foundry-client`, no `/combat/subscribe` or `/encounters/subscribe` route is referenced anywhere in this repo, and guessing paths blind against a relay with 15s timeouts wasn't a good use of the spike's remaining time). **Recommendation: don't chase this — `/hooks/subscribe` with `updateCombat` already gives everything `combat-events` would (round, turn, full combatant array with initiative/defeated), just less pre-filtered.**

## 4. NPC read/write verdict

**Verdict: WORKS**, no blockers, no new scope needed (`entity:read`/`entity:write`, already granted).

- World had **zero NPC actors** before this spike (only the two PC characters, Randal `zteTG9PZZ6XQpQtK` and Akra `pTvtx5dm2AuYqeX2`) — confirms the M22 design must plan for gateway-created NPCs, not assume any exist.
- Created `Spike Goblin` (`Actor.6mvUNlbIji0NJddx`) via `Actor.create({name:'Spike Goblin', type:'npc'})` in the GM tab — bare dnd5e NPCs get **`hp.value = hp.max = 0`** and **`ac.value = 10`** (flat default) with no CR-driven defaults. Any gateway "add NPC to encounter" flow must explicitly push HP/AC or the combatant will show dead-on-arrival (0 HP).
- `GET /get?uuid=Actor.6mvUNlbIji0NJddx` via relay returned the full doc immediately (no delay, no propagation lag).
- `PUT /update?uuid=Actor.6mvUNlbIji0NJddx` with `{"data":{"system.attributes.hp.max":15,"system.attributes.hp.value":15}}` applied correctly and echoed back in the response (see §2d for envelope shape).

## 5. Unlinked-token combatants (source-only, not live-created per task scope)

From the same combatant-mapping code (§2a): `tokenUuid: l.token?.uuid` and `actorUuid: l.actor?.uuid` are read independently.

- **Tokenless combatants** (what we actually created/tested): `tokenUuid` is `undefined`/absent, `actorUuid` is always present (`Actor.<id>`). Live-verified: our two tokenless combatants both returned `tokenUuid:null` (via direct Foundry API) and a normal `actorUuid`.
- **Unlinked-token combatants** (source read only — Foundry semantics, not relay-specific): Foundry's `Combatant#actor` getter resolves to the token's *synthetic* actor even for unlinked tokens, so `actorUuid` should still be populated for an unlinked-token combatant — but it will be a synthetic/delta actor, not necessarily identical to the prototype actor's stat block if the token has actor-data overrides. `actorUuid` is genuinely `null`/absent only when a combatant has **no** actor at all (e.g., a manually-added combatant with a deleted actor). `tokenUuid` will be present (non-null) for both linked and unlinked token combatants alike, since it just reads `combatant.token?.uuid`. **Net: the read endpoint alone can't tell you "linked vs. unlinked" — you'd need to separately resolve the token document and check `token.actorLink`.** Not live-verified this session; flag for a follow-up spike if the gateway design needs to distinguish token-override stats.

## 6. Recommendations for the gateway design

1. **Build the read/poll path on `/hooks/subscribe?hooks=updateCombat,createCombatant,updateCombatant,deleteCombatant,createCombat,deleteCombat`.** It's live, scope-compatible with today's key, and every `updateCombat` frame already carries the full combatant array (id/actorId/initiative/defeated/tokenId) plus round/turn — no extra `GET /encounters` round-trip needed after each push, once encounter scope issues are sorted (or even before, as a stopgap: see point 2).
2. **Escalate getting an `encounter:read` + `encounter:manage` scoped key before committing to REST-driven combat setup.** Until then, the only way to *create/end* a combat programmatically is the Foundry-side path this spike used as a fallback (`Combat.create` + `createEmbeddedDocuments('Combatant', ...)` + `startCombat()` via a script/macro execution channel, e.g. relay's `execute-js` actionType — worth a quick follow-up check of whether `execute-js` is scope-gated separately, since if it's covered by an existing scope it could be the pragmatic workaround for encounter creation without new scopes).
3. **Always set HP (and ideally AC) explicitly when the gateway creates NPC combatants.** Bare `Actor.create({type:'npc'})` gives 0/0 HP; don't let a freshly spawned monster show as already-dead.
4. **Treat "linked vs. unlinked token" as an open question**, not a blocker — the read payload doesn't disambiguate it. If the M22 design needs token-accurate stats (as opposed to base-actor stats), plan a follow-up spike creating an actual scene + unlinked token combatant before committing to a data model that assumes `actorUuid` is always the authoritative stat source.
5. **Don't build against the `combat-events` normalized channel** — its REST subscribe route couldn't be found/confirmed live in the time available, and `/hooks/subscribe` + `updateCombat` already provides equivalent data.
6. Note for the gateway HTTP client layer: an update response's `entity` field is an **array**, not an object — don't reuse `unwrapEntity()` as-is for `/update` responses (see §2d).

## 7. Cleanup confirmation

Live-verified via GM tab after test:
```json
{"combatActive": false, "combatsCount": 0, "actors": [
  {"id":"pTvtx5dm2AuYqeX2","name":"Akra (Dragonborn Cleric)","type":"character"},
  {"id":"zteTG9PZZ6XQpQtK","name":"Randal (Human Fighter)","type":"character"}
]}
```
Test combat (`dUUDhttMX884hSeE`) deleted, `Spike Goblin` NPC actor (`Actor.6mvUNlbIji0NJddx`, along with its manual HP edit) deleted. World is back to its two-PC baseline. No stack restarts were performed.
