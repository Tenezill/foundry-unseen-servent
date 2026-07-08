# M10 findings — live verification (2026-07-08)

Verified against the running dev stack (Foundry 13.351, dnd5e 5.3.3,
relay+module 3.4.1, world `companion-test`), test actors Akra
(`Actor.pTvtx5dm2AuYqeX2`) and Randal (`Actor.zteTG9PZZ6XQpQtK`). All writes
were reverted; world left as found.

## give / delete (learn + forget spells) — VERIFIED ✅

- `GET /search?query=…&filter=documentType:Item,subType:spell` — filter string
  accepted verbatim; returns compendium hits.
- `POST /give` body `{toUuid, itemUuid, quantity}` with a COMPENDIUM item uuid
  works exactly as `foundry-client` sends it. Bonus: the response carries
  `newItemId` (the embedded `_id`) — no follow-up actor fetch needed to learn it.
- `DELETE /delete?uuid=Actor.<id>.Item.<id>` — uuid as query param, no body.
- Full round-trip confirmed: spell appears on the actor, delete removes it.

## prepared toggle — VERIFIED ✅

- `PUT /update?uuid=Actor.<id>.Item.<spellId>` body
  `{"data":{"system.prepared":1}}` round-trips: 0 → 1 → 0 confirmed via GET.
  This is the schema-correct route the adapter uses.
- Surprise: the module's `POST /dnd5e/prepare-spell` is NOT dead after all —
  it writes the legacy `system.preparation.prepared` path, but dnd5e 5.x's
  `migrateData` shim converts that to the numeric `system.prepared`. Quirks:
  it requires `actorUuid` (not `uuid`) and matches the spell by
  case-insensitive NAME, not id — so we stay on the generic `/update`.
- Over the wire the serialized item has no `system.preparation`; the live
  client exposes a derived legacy getter. Never trust that field from the relay.

## get-actor-details — ENUMERATED ✅

Supported keys (module 3.4.1): `resources, spells, items, features, stats,
abilities, skills, details, conditions`. Unknown keys are silently ignored;
multiple keys merge into one response.

Relevant for the roadmap:
- `stats.encumbrance {value,max}` EXISTS → M12 encumbrance can use enrich
  instead of client-side summing.
- `skills.<id>.passive` and `skills.<id>.total` EXIST → M10 passives could be
  enriched too; the adapter's `10 + total` fallback stays for the plain /get path.
- SENSES are NOT exposed by any detail key — the adapter reads the actor's
  `attributes.senses.ranges` with a race-item fallback (source-serialized
  actors carry race-granted senses on the race item, mirroring the existing
  `speedLine` movement fallback).

## Operational incident (needs GM action)

Mid-verification the Foundry GM browser session backing the relay logged out,
taking the relay client offline (`/clients` → `isOnline:false`, calls fail
with "Invalid client ID"). Re-login alone does NOT restore the link: the
module's connectionToken is per-browser, and re-pairing goes through the
relay's pair flow (`/auth/pair-request` — the pairUrl points at the public
foundryrestapi.com site even for a local relay) which needs a relay web-UI
login. **The world's relay client is still offline** — re-pair from the
Foundry module settings in the GM browser (Pair flow), or restart the
headless GM session. Two pair-request codes were left pending (auto-expire
after 10 min). No settings or world data were changed.
