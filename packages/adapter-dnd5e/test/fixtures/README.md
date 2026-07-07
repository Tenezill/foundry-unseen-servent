# adapter-dnd5e test fixtures

Two fixture families, both matching dnd5e system **5.3.3** on Foundry
**v13** (13.351) document shapes.

## Captured fixtures — GROUND TRUTH

`martial-captured.json` and `caster-captured.json` are the verbatim `.data`
payloads of relay `GET /get` responses (envelope
`{type:'entity-result',uuid,data:{<actor doc>}}`) fetched from the live M0
spike world (`docs/captured/martial-raw.json` / `caster-raw.json`). They pin
the exact serialization the gateway sees. Do not hand-edit them; re-capture
instead.

- `martial-captured.json` — **Randal (Human Fighter)**, Fighter 5,
  `Actor.zteTG9PZZ6XQpQtK`. hp 35/44 with temp 5 (state after M0 test
  writes), gp 10, class item `system.hd = { denomination: "d10", spent: 1 }`.
- `caster-captured.json` — **Akra (Dragonborn Cleric)**, Cleric 5,
  `Actor.pTvtx5dm2AuYqeX2`. hp 38/38 (temp `null`), partly spent slots
  (`spells.spell1.value` 2, `spell2` 2, `spell3` 1 — `override: null`, no
  serialized `max`), class `hd = { denomination: "d8", spent: 0 }`, 18 spell
  items.

Live-verified schema facts these captures established (they DISPROVE earlier
assumptions the synthetic fixtures were built on):

- Class hit dice live in `system.hd.{denomination,spent,additional}` — there
  is **no** `system.hitDice` / `system.hitDiceUsed`. Writes target
  `system.hd.spent`.
- Spell preparation is `system.method` (`"spell"` etc.) plus a **numeric**
  `system.prepared` flag (0 = unprepared, 1 = prepared, 2 = always
  prepared) — there is **no** `system.preparation` object.
- Item uses are `system.uses = { spent, max, recovery }` with `max` a string
  formula (`""` = no uses; e.g. Torch has `max: "1"`).
- The relay serializes SOME derived data (`abilities.*.max`, hp fields) but
  **no** `skills.*.total`, `abilities.*.mod`, `attributes.prof`,
  `attributes.ac.value`, `attributes.init.total`, or slot `max` — the
  adapter's presentation fallbacks must carry those.

## Synthetic fixtures

`martial.json` (Bram Ironfist, Fighter 5) and `caster.json` (Seraphine
Dawnwhisper, Cleric 5) are hand-built, corrected to agree with the captured
schema (`hd`, `method`/`prepared`). They deliberately differ on the
derived-data axis:

- `martial.json` — **source-shaped**, no derived fields; item `uses.max` is a
  formula string. Exercises the adapter's presentation fallbacks (computed
  ability mods, prof from level, flat AC).
- `caster.json` — **derived fields present** (`mod`, `total`, `ac.value`,
  `prof`, slot `max`). Exercises the derived-preferred paths;
  `skills.rel.total` intentionally includes a check bonus so tests can prove
  the derived total wins over the computed fallback.

Names and item names are minimal labels only — no game-rules content
(no descriptions, stat blocks, or compendium text) per PLAN.md decision 8.
(The captured documents contain whatever the live world contains, verbatim.)
