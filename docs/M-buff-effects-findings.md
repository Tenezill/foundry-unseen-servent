# Buff-spell active effects over the bridge — findings (2026-07-19)

Live-verified against the running stack (Foundry v14.364, dnd5e 5.3.3,
module/relay 3.4.1, world Vareon), actor Morgrim Ashmantle
(`Actor.FMuwT5NOXsNQF0gq`) via read-only + self-reverting `execute-js` probes.
World left exactly as found.

## Symptom
Casting **Shield** from the app does not raise AC by +5; casting **Mage
Armor** has no visible effect and offers no self/target choice. User report
2026-07-19.

## Root cause — CONFIRMED
The relay's `use-spell` runs dnd5e's `activity.use({}, {configure:false}, {})`.
Headless (no token selected/targeted, no chat-card "Apply Effect" click),
this **posts the chat card but never applies the item's Active Effect to the
actor.** Evidence:

- Shield's item effect is exactly what we'd want:
  `changes: [{ key: "system.attributes.ac.bonus", mode: 2 (ADD), value: "+5" }]`,
  `transfer: false`, `duration: { value: 6s, expiry: "turnStart" }`.
- Before cast: `ac.value 11`, `ac.bonus 0`, no Shield effect on the actor.
- After `activity.use()` (no error): `ac.value 11`, `ac.bonus 0`,
  `activeEffectsOnActor: []` — **nothing applied, nothing to revert.**

So it is NOT a duration/encounter issue (the effect never lands at all) and
NOT an app-refresh issue (the gateway already re-fetches + enrich merges
`stats.ac` after every action — it faithfully shows an AC that never changed).
The app's AC path is correct; the effect application upstream is the gap.

## Design direction (user-approved intent: "make it work like a condition")
The app already surfaces `actor.effects` as condition badges + concentration
(`parseEffects`) and shows derived AC (`enrich` → `stats.ac`). If a buff's
Active Effect were actually ON the actor, both would "just work" — Shield
would show as a badge AND AC would read 16. So the fix is: **after casting a
buff spell that carries a self-applicable Active Effect, explicitly apply that
effect to the caster** (Foundry won't, headless).

### Mechanism options (decision needed before building)
1. **Relay `create` an embedded ActiveEffect on the actor** (mirrors the
   existing hand-add-item chain create→give). Copy the item effect's
   name/changes/duration/img, set `origin` to the spell item, flag it
   `flags.unseen-servent.appliedBy` so we can find/remove it. No execute-js
   dependency; pure entity write (needs `entity:write`, already granted).
   Cleanest + charter-aligned.
2. **execute-js** apply (now that it's enabled): a script that applies the
   activity's effects to the actor. Couples buff-application to the execute-js
   setting (same gate as upcasting) — avoid unless option 1 can't carry the
   effect faithfully.

Recommendation: **option 1.** Self-targeted-only to start (Shield, Mage Armor
on self); a self/other target picker is a later increment. Manual "tap AC, add
a modifier" stays a fallback only if AE-create proves unreliable.

### Open sub-questions for the build
- **Which spells qualify?** A spell whose item (or activity) carries an AE
  with `transfer:false` and at least one change, cast at self. Need to detect
  this in the adapter without a rules engine (data-shape only).
- **Duration:** Shield's `expiry:"turnStart"` is combat-shaped; outside combat
  it simply persists (worldTime doesn't advance per turn). Acceptable — the
  player (or GM) drops it; we already have an effect-removal path idea.
- **Removal:** surface a way to end an app-applied buff (like End
  Concentration) — delete the flagged effect.
- **Mage Armor vs Shield:** Mage Armor is `system.attributes.ac.calc:"mage"`
  or a flat bonus depending on import; verify its effect shape before assuming
  it matches Shield's `ac.bonus +5`.

## Charter note
This is the first place the app would CREATE game state Foundry didn't derive
on its own. Justified: Foundry genuinely cannot apply the effect headless, and
we copy the world's own effect verbatim (no invented rules content). Same
philosophy as the existing hand-add-item chain.
