# Encounters — design

**Date:** 2026-07-11
**Status:** approved (brainstorm with user)
**Milestone:** M22 (working name: "encounter mode")

## Problem

During combat, players and GM negotiate verbally where damage goes ("the
goblin on the left — no, the other one"), and nobody at the table sees the
initiative order without craning at the GM screen. The PWA knows nothing
about encounters today.

## Goal (user's words, distilled)

When a Foundry encounter starts, every player's PWA:
1. shows the **enemy list** so a player can direct their damage at the right
   combatant — and **apply it themselves** (no GM bookkeeping), and
2. shows the **initiative order** as a compact carousel (the next 4–5
   combatants with their icons), visible everywhere on the sheet.
Both appear automatically when combat starts and disappear when it ends.

## Decisions (user)

- **Placement — auto-overlay + tab:** a compact initiative carousel renders
  above the tab bar on the actor page whenever an encounter is active; a
  `COMBAT` tab appears alongside the existing tabs carrying the full
  combatant list. Both vanish when the encounter ends. (The old idea of
  repurposing the hero XP panel is superseded by this.)
- **Players apply damage/healing themselves** — tap a combatant, enter the
  amount, the gateway writes it. The M20 temp-HP rule (damage consumes
  `hp.temp` first) applies to every such write.
- **Targets: any combatant** — enemies, allies, self; damage and healing
  both. Covers AoE, friendly fire, healing a downed friend.
- **Enemy health as states, not numbers:** players see
  healthy / wounded (<100%) / bloodied (<50%) / down (0) on NPC combatants.
  Exact numbers stay GM-only. Player-character combatants show exact HP
  (their sheets are public to the table anyway).

## Non-goals (v1)

- Controlling the encounter from the PWA (start/end, next turn, initiative
  edits) — the GM drives combat in Foundry; the PWA is a live mirror plus a
  damage-application surface.
- Rolling initiative from the PWA (the existing Roll Initiative button
  stays as-is; whether Foundry auto-adds the roll to the tracker is
  Foundry's business).
- Conditions/targeting integration with Foundry's token targeting.
- XP/loot distribution after combat.

## Feasibility gate (Task 0 of the plan — vet before building)

The relay module exposes `encounters`, `start-encounter`, `next-turn`,
`next-round`, `end-encounter`, `add-to-encounter`, `remove-from-encounter`
action types. Only reads are needed for v1 (`encounters` — presumably the
active combat's combatants + initiative + current turn). **Vet live** (the
`prepare-spell` precedent: existing ≠ working):
1. What `GET /encounters`-equivalent returns with an active combat: combatant
   list shape (actorId? tokenId? initiative, img, name, defeated flag?).
2. Whether combat changes surface through the existing hooks SSE
   (`subscribeHooks`) — e.g. `updateCombat`/`combatTurn` events — for live
   turn advancement; if not, the gateway's existing poll fallback cadence
   applies.
3. Whether NPC combatants' actor documents are readable through the current
   API key scopes (needed server-side for HP writes and state derivation).
Findings get recorded in the plan before implementation tasks are drawn.

## Architecture

### Gateway (new encounter surface)

- `GET /api/encounter` (player token): the active encounter or
  `{ active: false }`. Response (shape finalized after Task 0):

```jsonc
{
  "active": true,
  "round": 3,
  "turn": { "combatantId": "…" },
  "combatants": [
    {
      "id": "…",                 // combatant id
      "actorId": "…",            // present for PCs; NPCs may carry it too
      "name": "Goblin 2",
      "img": "…",
      "initiative": 17,
      "isPC": false,
      "health": "bloodied",      // NPCs: healthy|wounded|bloodied|down — derived SERVER-side
      "hp": { "value": 21, "max": 30 },   // ONLY for PCs; never sent for NPCs
      "defeated": false
    }
  ]
}
```

  The health-state derivation must happen in the gateway/adapter — exact NPC
  HP must not reach player clients in any payload (states are not a UI
  affordance, they are an API contract).
- `POST /api/encounter/combatants/:id/hp` body
  `{ kind: 'delta', amount: -7 }` (negative = damage, positive = heal).
  Authorization: valid player token AND an active encounter AND `:id` is a
  combatant in it — this is the **only** path a player may write an actor
  they don't own, and it dies with the encounter. The write reuses the
  adapter's hp `buildUpdate` (temp-HP absorption, clamping, same
  concurrency semantics), targeting the combatant's actor (token-actors:
  Task 0 decides whether unlinked token combatants are addressable; if not,
  v1 documents "linked actors only" and the endpoint 422s for unlinked).
- Live updates: encounter state joins the existing live/SSE channel the
  sheet already uses (combat hooks if Task 0 confirms them; else the
  existing poll fallback). Sheet payloads stay untouched — encounter state
  is its own resource so all players share one gateway-side view.
- Rate limiting: combatant hp writes count against the existing per-token
  write limiter.

### Web

- **`InitiativeCarousel.vue`** — renders above the tab bar on `actor/[id]`
  whenever the encounter is active: the current combatant plus the next 4
  (wrapping), as avatar medallions (reuse `ActorAvatar`) with name,
  initiative badge, a subtle "acting now" ring on the current turn, and the
  player's own combatant highlighted. NPC medallions tint by health state;
  PCs show a small exact-HP caption. Round number in a corner chip.
- **`COMBAT` tab** — appears in the tab bar (before OVERVIEW visually or
  after GEAR — implementer picks what reads best on 5 tabs + one transient)
  only while active: full initiative-ordered combatant list; each row =
  icon, name, initiative, health state (or exact HP for PCs), defeated
  strikethrough. Tapping a row opens a damage/heal sheet: big signed-amount
  numpad (reuse the HpNumpad pattern: Damage / Heal modes), confirm →
  POST → toast ("7 dmg → Goblin 2"), list refreshes live for everyone.
- Appear/disappear: driven by the live encounter state; when a combat ends
  mid-session the tab unmounts (falling back to OVERVIEW if it was active —
  the existing `tabs.some` fallback in `[id].vue` already handles vanished
  tabs) and the carousel slides away.
- Offline: carousel hides; the COMBAT tab shows the cached last state
  read-only with the standard offline treatment; hp writes disabled.

## Error handling

- No active encounter → `GET` returns `{ active: false }`; `POST` → 409.
- Unknown combatant / not in this encounter → 404/422 per the gateway's
  existing envelope conventions.
- Relay stalls: encounter reads are bounded (M18 `adminNameTimeoutMs`
  precedent) and degrade to the last known state with the standard
  reconnect pill; writes surface the standard error toast.

## Testing

- Gateway tests (fake relay): encounter read mapping incl. server-side
  health-state derivation and the NPC-hp-never-serialized invariant
  (assert the JSON body contains no `hp` key for NPCs); hp write
  authorization matrix (no encounter 409, non-combatant 422/404, combatant
  of another player's PC allowed, temp-HP absorption applied); limiter
  applies.
- Adapter: no changes expected beyond reuse (health-state helper lives
  where Task 0 says the data lives; unit-test the thresholds incl. edge
  100%, 50%, 0).
- Web: typecheck + live checklist: start an encounter in Foundry with 2 PCs
  + 3 NPCs → carousel + COMBAT tab appear on both player PWAs; damage an
  NPC to bloodied from the PWA (state flips for everyone, exact HP visible
  nowhere in the payload); heal an ally (exact HP updates); next-turn in
  Foundry advances the carousel live; end combat → UI vanishes; offline
  behavior.
