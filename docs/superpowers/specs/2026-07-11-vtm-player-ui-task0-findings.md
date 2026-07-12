# M23 VtM player UI — Task 0 findings (live spike, 2026-07-12)

**Environment:** dev stack (user-approved world switch), Foundry 13.351,
**wod5e 5.3.15** (last Foundry-v13-compatible release — 5.3.16+ requires v14;
the system is PINNED at 5.3.15 until Foundry upgrades). Spike world
`vtm-spike`, test actor **Marius** `Actor.SGeXzzb4NApPhTJf` (kept, world kept
inactive), relay client `fvtt_a42b3a5322a6031e` (paired to the relay account
from `stack/.env`, which CAN mint its own scoped keys — see Operational).
The dev world `companion-test` was restored and relay-verified afterwards.

## Headline plan amendments

1. **System id is `wod5e`, NOT `vtm5e`.** `adapterFor` resolution, theme
   stamping (`[data-system='wod5e']`), and all spec/plan references change.
2. **Relay `/get` returns SOURCE data, not prepared data.** Consequences:
   - `system.health.value` / `system.willpower.value` are stale/derived —
     NEVER read or write them; compute display from
     `{max, superficial, aggravated}` (Foundry derives value = max − agg −
     sup/2; the PWA needs boxes, not the number).
   - `system.disciplines.<key>.powers` is `[]` in source — the powers
     aggregation is prepared data. The adapter groups **embedded items of
     `type:'power'` by `system.discipline`** itself.
3. **Weapon damage field is `system.weaponvalue`** (with `system.weaponType:
   'melee'|'ranged'`), not `system.damage`.
4. **Roll strategy: Strategy 2 (user decision, security-motivated).** The
   system exposes `WOD5E.api.Roll({basicDice, advancedDice, actor, title,
   quickRoll, willpowerDamage, increaseHunger, difficulty, ...})` — a true
   native path — but the relay reaches it only via `execute-js`, which
   requires the `allowExecuteJs` world setting (arbitrary-JS surface for any
   API-key holder). User chose formula rolls. Bonus: the relay's roll
   response includes **per-die results** (`data.roll.dice[].results[]`), so
   the gateway/PWA can derive successes, 10-pair criticals, messy crits and
   bestial failures. Ignore the response's `isCritical`/`isFumble` flags —
   they are dnd5e-shaped (a 10 anywhere / a 1 anywhere) and meaningless here.
5. **Custom item creation is a 3-call chain** (no embedded-create endpoint):
   `POST /create {entityType:'Item', data:{name,type,system}}` (world item)
   → `POST /give {toUuid, itemUuid}` (copies onto actor, system data intact)
   → `DELETE /delete?uuid=<world item>`. Verified live: Stake weapon with
   `weaponvalue:2` landed on Marius, world item removed. The gateway must
   best-effort the trailing delete (a failed cleanup leaves a harmless world
   item; log it).

## Canonical path table (fixture-verified)

| Concept | Path | Notes |
|---|---|---|
| actor type | `type: 'vampire'` | `system.gamesystem: 'vampire'` flags the ruleset flavor; mortal/ghoul share the schema (untested — v1 targets vampires; others render best-effort) |
| attributes (9) | `system.attributes.<key>.value` | keys: strength dexterity stamina charisma manipulation composure intelligence wits resolve; **default/min 1**; each node carries `label`/`displayName`/`type` (physical/social/mental) |
| skills (27) | `system.skills.<key>.value` | 0–5, default 0; `hasSpecialties`/`specialtiesList` exist (ignore v1). **Source data persists only touched skills** (fixture has 6 keys) — prepared data carries all 27. Canonical keys (captured live from the prepared actor): academics animalken athletics awareness brawl craft drive etiquette finance firearms insight intimidation investigation larceny leadership medicine melee occult performance persuasion politics science stealth streetwise subterfuge survival technology. Adapters must render from this vocabulary with source values merged over it (same caveat applies to the 9 attributes: default 1, may be absent from source). |
| health | `system.health.{max, superficial, aggravated}` | **max is manual** (not derived from stamina — GM sets it; Marius 6) |
| willpower | `system.willpower.{max, superficial, aggravated}` | max manual (Marius 4) |
| hunger | `system.hunger.value` | 0–5, `max: 5` present |
| humanity | `system.humanity.{value, stains}` | value 0–10 (default 7), stains 0–10 |
| blood | `system.blood.{potency, generation}` | potency number, generation string |
| disciplines | `system.disciplines.<key>.{value, visible}` | 14 keys incl. `sorcery` (Blood Sorcery), `alchemy`; dot rating on the actor; power items reference these keys |
| power items | items `type:'power'`, `system.{discipline, level, cost, description}` | discipline = key above |
| weapons | items `type:'weapon'`, `system.{weaponvalue, weaponType, quantity, uses, dicepool}` | dicepool empty by default |
| gear | items `type:'gear'`, `system.{description, quantity, uses}` | plan said `equipment` — the wod5e type id is **`gear`** |

Item types available: base, feature, customRoll, armor, weapon, gear, trait,
condition, clan, predatorType, resonance, power, boon, creed, drive, perk,
edgepool, tribe, auspice, talisman, gift.

## Feasibility gates

1. **Serialization ✓** — full actor incl. embedded items in `data` envelope
   (`{type:'entity-result'-style, data, requestId, uuid}`), same unwrap path
   foundry-client already handles. Fixture:
   `packages/adapter-wod5e/test/fixtures/vampire-captured.json` (Marius with
   4 items: Knife weapon, Lethal Body power/potence, Lockpicks gear, Stake
   custom weapon).
2. **Writes ✓** — `PUT /update` dotted paths (`system.health.superficial`)
   land live; object-valued fields MERGE (clearing a key needs Foundry's
   `-=key` syntax — irrelevant for our numeric writes).
3. **Rolls ✓** — `POST /roll` with `3d10cs>=6 + 2d10cs>=6` → 200, chat card,
   `total` = success count, per-die results in response. Needs the
   **`roll:execute` scope** (the production key list must include it —
   dnd5e's key evidently has it; the spike key needed a PATCH).
4. **Item creation ✓** — create→give→delete chain above.
5. **Hooks SSE ✓** — `GET /hooks/subscribe?hooks=updateActor,...` delivers
   `updateActor` frames with the full doc in `data.args[0]` (items
   included) — identical shape to dnd5e; LiveManager unchanged.

## Operational notes (for Task 9 / runbook)

- wod5e install: extract release zip to `Data/systems/wod5e` (no UI needed);
  world create/launch scriptable via `POST /auth {action:'adminAuth'}` +
  `POST /setup {action:'createWorld'|'launchWorld'}` with the session cookie;
  world shutdown via `POST /join {action:'shutdown', adminPassword}`.
- Relay pairing is scriptable end-to-end: module dialog "Pair" → code →
  `POST /auth/login {email,password}` → Bearer →
  `POST /auth/pair-request/<code>/approve`. Module needs a page reload after
  pairing to open its WS.
- Scoped keys: users mint their own via `POST /auth/api-keys {name, scopes}`
  (Bearer session) — no admin panel needed (M22's runbook path is the hard
  way). `PATCH /auth/api-keys/<id>` edits scopes;
  `POST .../regenerate` rotates. Spike key id 9 (account from `stack/.env`),
  scopes `entity:read entity:write search events:subscribe clients:read
  roll:execute` — key value held outside the repo; Task 9 mints fresh keys
  for the production stack.
- `/clients` visibility is account-scoped: the gateway's key (other account)
  does not see the vtm client and vice versa. A stale duplicate
  companion-test client entry exists (offline) — harmless.
- The world is relay-online only while a GM session is connected (known);
  the automation browser's GM tab restores this after world switches.

## Open items carried to later tasks

- Rouse checks: Strategy 2 = `1d10cs>=6`, hunger increment stays MANUAL
  (player adjusts the hunger track; the PWA toast reminds). WOD5E.api's
  `increaseHunger` automation is execute-js-only — out with Strategy 2.
- Equip state: wod5e has no `equipped` flag on weapons (no equip toggle in
  v1; the plan's "if the system supports them ⚠" resolves to NO).
- Willpower rerolls, specialties, resonance: out of v1 scope (spec).
