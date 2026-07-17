# Visual walkthrough — Foundry's Unseen Servant

A picture tour of what you get after setup: the turnkey installer, pairing
Foundry to the relay, the admin console, and the mobile player app in action.

All player-app shots below are from a **phone-sized screen** (the app is
mobile-first) using a level-11 D&D 5e Sorcerer — *Morthos* — carrying a full
spellbook, magic items, and weapons so every button is exercised. The theme is
the built-in "Gilded Tome" dark theme (a light parchment theme ships too).

---

## 1. Setup — the turnkey wizard

`make setup` runs a one-time, self-hosted web wizard (it dies with the CLI, so
the token and secrets can't linger). It asks only for your foundryvtt.com
credentials, generates every other secret for you, shows them **once**, then
brings the whole stack up.

| Enter credentials | Save the generated secrets | Stack is up |
|---|---|---|
| <img src="screenshots/25-wizard-creds.png" width="260"> | <img src="screenshots/26-wizard-secrets.png" width="260"> | <img src="screenshots/27-wizard-done.png" width="260"> |

*The wizard writes credentials to a `0600` file on your host — they never leave
it. Secrets shown are placeholders in this doc, not real values.*

---

## 2. Pairing Foundry to the relay

Inside Foundry, the **REST API Connection** module links your world to the
relay with a single **Pair** click. Once paired it stays connected and shows
its live status — this is the bridge the app talks to.

<img src="screenshots/24-foundry-rest-module.png" width="720">

*Status: **Paired** · Relay: `ws://localhost:3010/relay`.*

---

## 3. Admin console — player links & pairing

The self-hosted admin console (password from the gateway's `.env`) is where you
mint one-tap join links per player, scope each to specific characters, revoke
links, and follow the pairing steps.

| Admin login | Player links | Relay & pairing panel |
|---|---|---|
| <img src="screenshots/20-admin-login.png" width="260"> | <img src="screenshots/21-admin-players.png" width="260"> | <img src="screenshots/22-admin-relay-pairing.png" width="260"> |

Each player is bound to one or more Foundry actors; **New link** rotates their
invite, **Revoke** kills it.

---

## 4. The player app

A player taps their invite link once and lands on their character — no Foundry
account, no app install. Everything writes straight back into Foundry, live
(note the **LIVE** badge).

### Choosing a character & the overview

| Character picker | Overview (dark) | Overview (light) |
|---|---|---|
| <img src="screenshots/01-character-picker.png" width="260"> | <img src="screenshots/02-overview-top.png" width="260"> | <img src="screenshots/18-light-theme.png" width="260"> |

The header carries HP with **Damage/Heal**, AC, speed, proficiency, initiative
and XP; below are ability scores, skills, senses, proficiencies and features —
each tappable to roll.

### Actions — attack, cast, use

| Attacks & spell filters | The full spell action list |
|---|---|
| <img src="screenshots/03-actions.png" width="260"> | <img src="screenshots/04-actions-spells.png" width="260"> |

The Actions tab gathers everything you can *do* this turn: weapon **Attack**/​
**Dmg**, spell **Cast**/​**Dmg** (filterable by Attack / Heal / Utility), plus
class features and usable items each with a **Use** button.

### Vitals — HP, resources & rest

| Rest & hit points | Hit dice, exhaustion & spell slots |
|---|---|
| <img src="screenshots/05-vitals.png" width="260"> | <img src="screenshots/06-vitals-conditions.png" width="260"> |

Short/Long rest, HP and temp-HP steppers, hit dice, inspiration, exhaustion and
per-level spell slots — all editable and synced to Foundry.

### Gear — inventory, attunement & containers

| Carried gear | Magic items & attunement |
|---|---|
| <img src="screenshots/07-gear.png" width="260"> | <img src="screenshots/08-gear-weapons.png" width="260"> |

Quantities, weights, **Equipped** and **Attuned** badges (with an attune
toggle), consumables, and containers that roll up their contents' weight.

### Spells — the spellbook

| Cantrips & prepared spells | Leveled spells with concentration |
|---|---|
| <img src="screenshots/09-spells.png" width="260"> | <img src="screenshots/10-spells-leveled.png" width="260"> |

School, level, **Prepared**/​**Concentration**/​**Ritual** tags, a prepare
toggle for swappable spells, and **Cast** buttons that spend the right slot.

### Rolling & details

| Item / spell detail | Dice tray + result | Roll history |
|---|---|---|
| <img src="screenshots/12-item-details-modal.png" width="200"> | <img src="screenshots/15-roll-result.png" width="200"> | <img src="screenshots/16-roll-history.png" width="200"> |

| Advantage / disadvantage prompt | Biography |
|---|---|
| <img src="screenshots/17-skill-roll.png" width="260"> | <img src="screenshots/19-biography.png" width="260"> |

Tap any roll to choose normal / advantage / disadvantage — the roll runs *in
Foundry as your character* and lands in the shared chat log. A built-in dice
tray handles freeform rolls, and roll history keeps the session's results.

---

*Screens captured against Foundry VTT 14.364 + dnd5e 5.3.3 with the ThreeHats
REST relay 3.4.1. See [`HOSTING.md`](HOSTING.md) for the full setup guide and
[`README.md`](../README.md) for the architecture.*
