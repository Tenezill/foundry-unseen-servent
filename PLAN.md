# Foundry Companion PWA — Execution Plan (v2)

**Audience:** Claude Code (Opus) executing this plan milestone by milestone.
**Owner:** Sebastian. **Status:** Planning complete, ready for M0.
**Supersedes:** the June 2026 `vtt-companion/PLAN.md` (v1). Core decisions carried over are marked ⏩; changes are marked 🔄.

---

## 1. What we are building

A mobile-friendly PWA that lets players of Sebastian's gaming group view and manage their **D&D 5e** characters from a phone while the game runs in Foundry VTT. Foundry is the single source of truth; the app is an alternative player-facing client.

**v1 player capabilities (exhaustive):**
- Log in with a personal invite token and see *only their own* character(s)
- Read the full sheet: abilities, skills, AC, HP, speeds, spell slots, inventory, features, spell list (whatever the 5e system already computed)
- **Edit resources:** current HP (damage/heal), temp HP, hit dice, spell slots, item quantities/charges (ammo), death saves, currency
- See those values update **live** when the GM or Foundry changes them

**Explicitly OUT of v1** (do not build, do not scaffold "for later"):
- Dice rolling into Foundry (v2 — this was deliberately cut; it is the riskiest bridge feature)
- Character creation, leveling, or any rules validation (⏩ "companion, not builder")
- Any system other than dnd5e (but the adapter contract stays multi-system, see §6)
- Offline-first sync / conflict resolution (⏩ live passthrough only; service worker gives app-shell + read-only last-known-state fallback)
- Public multi-tenant hosting (single group, single world; open-sourcing is a later phase)

---

## 2. Settled decisions

1. ⏩ **Companion, not builder.** The app renders what Foundry computed. No rules engine.
2. 🔄 **Auth: invite tokens, not Foundry logins.** v1 replaces the old "authenticate through Foundry's login" decision. The gateway holds a static config mapping `player token → allowed Foundry actor IDs`. No user database, no OIDC (OIDC is an open-source-phase item). Rationale: the maintained bridge exposes the world through a single API key, so per-player scoping must live in our gateway anyway; for a ~5-person group, signed tokens in config are the simplest correct thing.
3. 🔄 **Bridge: upstream ThreeHats module + relay, vanilla, plus our own thin gateway.** See §3 for the comparison and rationale. We do **not** fork the relay in v1.
4. ⏩ **Always-online, live passthrough.** PWA → gateway → relay → Foundry.
5. 🔄 **Single Docker stack, greenfield.** Foundry is not deployed yet, so v1 ships one compose stack: Foundry + relay + gateway + PWA behind one reverse proxy (Caddy) with Let's Encrypt on a VPS. LAN/home-server deployment is not a target.
6. **Foundry v13 (latest stable).** Pin the Foundry image, the dnd5e system version, and the ThreeHats module version in config; record all three in `VERSIONS.md`. Note: Foundry v14 API docs already exist upstream — do not chase v14.
7. ⏩ **Adapter contract survives.** Even with 5e-only v1, all system-specific knowledge lives behind `packages/adapter-sdk`. Mörk Borg is the v2 proof that the contract holds.
8. ⏩ **No game-rules content in the repo.** No stat blocks, spell text, or compendium data. The app renders only what the user's world legally contains.

---

## 3. Bridge comparison (decision record)

The question: how does the PWA reach a Foundry world, given Foundry has no native external API?

### Option A — ThreeHats `foundryvtt-rest-api` (module) + `foundryvtt-rest-api-relay` (server), self-hosted
- **How it works:** the module runs inside the Foundry world and connects *outbound* via WebSocket to the relay; the relay exposes REST endpoints (search, read, modify entities) authenticated by an API key, with a documented Docker Compose self-host path and version-pinned images.
- **Pros:** actively maintained; listed on the official Foundry package registry; the *Foundry-version-churn-exposed part* (the module) is maintained by upstream, not us; outbound connection means Foundry needs no inbound ports; self-hosting removes rate limits.
- **Cons / gaps:** (1) single API key = whole-world access, no per-player permission mapping; (2) client-facing surface is REST — real-time push of world changes to *our* clients is unverified and may require polling; (3) whether the module needs a logged-in GM client in the world for write operations is unverified.

### Option B — `cclloyd/planeshift`
- **How it works:** a standalone REST layer that logs into a running Foundry instance as a dedicated player account (`APIUser`); ships Discord/OIDC auth and a docker-compose file; runs cleanly behind a proxy under `/api`.
- **Pros:** auth story is further along than A; extensible `evaluate` endpoint.
- **Cons:** connects via Foundry's client protocol as a headless user — that handshake is the most version-churn-sensitive layer, maintained by one person; the API user occupies a player session (documented conflict: you and the API can't share an account concurrently); still one Foundry identity for all app users, so per-player scoping again falls to us. Also: name collision with an unrelated "PlaneShift" ArUco-marker module on the Foundry registry — never confuse the two when researching.

### Option C — Our own Foundry module + our own relay
- **Pros:** full control; module can use Foundry hooks (`updateActor` etc.) for perfect push semantics; Sebastian already has module-dev experience from the ActorSheetV2 detour.
- **Cons:** we own 100% of the Foundry version churn, forever — the exact failure mode decision 3 of the old plan existed to avoid. For a v1 whose writes are a handful of scoped field updates, this is over-engineering.

### ✅ Recommendation: **A + thin gateway (BFF)**
Run the ThreeHats module and relay **unmodified**, pinned to specific versions. Build a small **gateway service** (`apps/gateway`, Node/TypeScript, ~500 lines) that is the only thing the PWA talks to. The gateway:
1. **Authenticates** players (invite tokens) and **scopes** every request to that player's actor IDs — the relay API key never leaves the server side.
2. **Narrows the write surface** to an allow-list of resource paths (HP, slots, quantities…). The PWA physically cannot ask for arbitrary writes.
3. **Provides live updates** to the PWA over its own WebSocket/SSE channel — fed by relay push if M0 finds it exists, otherwise by short-interval polling with diffing (acceptable at group scale: 1 world, ≤6 actors).
4. **Translates** raw Foundry documents → the adapter-shaped view model, so the PWA never sees raw relay responses.

This keeps upstream churn upstream, keeps our code small and product-shaped, and gives us a clean seam: if the relay ever dies, only `packages/foundry-client` and the gateway's relay adapter change. **Fallback:** if the M0 spike finds a hard blocker in the relay (no workable write path, no headless operation), fall back to Option C with the smallest possible custom module — the gateway and everything above it survives unchanged.

---

## 4. Architecture

```
[ PWA (Nuxt) ] ──HTTPS/WSS──▶ [ Gateway (BFF) ] ──REST/WS──▶ [ Relay (ThreeHats) ]
                                                                    ▲ outbound WS
                                                             [ Foundry v13 + module ]
        all four containers on one Docker network, Caddy in front
```

- **`apps/web`** — Nuxt 3/4 PWA. Renders the adapter view model. Talks only to the gateway. Service worker: app-shell precache + last-known sheet snapshot (read-only) when offline.
- **`apps/gateway`** — Node/TS (Fastify or Nitro). Token auth, actor scoping, write allow-list, live-update fan-out, view-model assembly via adapters.
- **`packages/adapter-sdk`** — the system-adapter contract (§6).
- **`packages/adapter-dnd5e`** — the only adapter shipped in v1.
- **`packages/foundry-client`** — typed wrapper over the relay's REST/WS. The *only* package that knows relay URLs, API keys, and endpoint shapes.
- **Bridge & Foundry** — upstream Docker images, config only, no code of ours. Relay is **not** exposed publicly; only Caddy → PWA and Caddy → gateway (and Caddy → Foundry itself for normal play) are public.

The existing `vtt-companion` monorepo scaffold (pnpm workspace) is reused; add `apps/gateway`, drop `packages/adapter-morkborg` from the v1 build (keep the folder as a placeholder with a README).

---

## 5. Auth & permission model (v1)

- Gateway config (`players.yaml`, mounted secret): `{ playerName, tokenHash, actorIds: [] }` per player.
- Player opens invite link `https://app.example.com/join#<token>` once; token goes into PWA local storage; every gateway request carries it as a Bearer header.
- Gateway enforces: reads → only listed actorIds; writes → only listed actorIds AND only allow-listed resource paths (see §7).
- Relay API key + Foundry admin credentials live only in gateway/stack env, never in the client bundle.
- Rate-limit writes per token (sanity guard, e.g. 30/min).
- Threat model honesty: this protects against curious players and drive-by internet noise, not a determined attacker with server access. Fine for v1's audience; OIDC + per-user Foundry identity mapping is the open-source-phase upgrade.

---

## 6. The adapter contract (unchanged crux)

All system knowledge lives in an adapter implementing (sketch — M2 finalizes):

```ts
interface SystemAdapter {
  systemId: string; // "dnd5e"
  /** Raw Foundry actor document -> normalized view model */
  toViewModel(actor: FoundryActorDoc): SheetViewModel;
  /** The writable resources this system exposes, with bounds */
  resources(actor: FoundryActorDoc): ResourceDescriptor[];
  /** App-level intent -> concrete Foundry update payload (dotted paths) */
  buildUpdate(actor: FoundryActorDoc, intent: ResourceIntent): FoundryUpdate;
}

interface ResourceDescriptor {
  id: string;               // "hp", "slots.3", "item.<id>.qty", "hitdice.d8"
  label: string;
  value: number; max?: number; min?: number;
  step?: number;
  writable: boolean;
}

type ResourceIntent =
  | { kind: "set";   resourceId: string; value: number }
  | { kind: "delta"; resourceId: string; amount: number }; // damage/heal, spend/regain
```

Rules:
- The **gateway** runs adapters (server-side), not the PWA — the client gets view models and sends intents. This keeps the write allow-list and clamping (min/max) server-enforced.
- `SheetViewModel` is system-agnostic in shape (sections of labeled groups/stats/lists) so the PWA renders any system generically; the adapter controls layout hints, not the PWA.
- dnd5e dotted paths (`system.attributes.hp.value`, `system.spells.spell3.value`, item `system.quantity`/`system.uses.value`) are pinned to the **dnd5e system version recorded in `VERSIONS.md`** and covered by fixture tests (M2).

---

## 7. Write allow-list (v1, dnd5e)

HP value + temp; death saves; hit dice remaining; spell slot values (not max); item quantity and item uses/charges; currency. Everything else is read-only. The allow-list is data in `adapter-dnd5e`, enforced in the gateway.

---

## 8. Milestones

Each milestone = one or a few Claude Code sessions, ends with its acceptance criteria demonstrably met and committed. Do not start a milestone before the previous one's criteria pass.

### M0 — Spike: deploy the stack, verify the bridge (≈1 session, throwaway code allowed)
Stand up Foundry v13 + dnd5e + ThreeHats module + self-hosted relay via Docker Compose locally. Create a test world, one GM, two players, two 5e actors with ownership set.
**Answer in writing (`docs/M0-findings.md`):**
1. Exact relay endpoints/payloads to read an actor and to update `system.attributes.hp.value` — verified working.
2. Does anything require a logged-in Foundry client (GM or otherwise) for reads/writes? If yes, what's the smallest reliable headless setup?
3. Does the relay offer any push/subscription of world changes to API consumers? If not, measure a 2–3s polling loop's behavior.
4. Version pins that worked (Foundry build, dnd5e, module, relay image) → `VERSIONS.md`.
**Gate:** if reads or scoped writes are impossible → invoke the Option C fallback (design doc first, then re-plan M1).

### M1 — Gateway skeleton + auth (≈1 session)
Fastify/Nitro service; `players.yaml` token auth; `GET /me`, `GET /actors`, `GET /actors/:id` proxying through `packages/foundry-client` with scoping; structured logging; Vitest for auth/scoping (relay mocked).
**Accept:** wrong token → 401; valid token → only own actors; relay key absent from all client-visible responses.

### M2 — dnd5e adapter + view model (≈1–2 sessions)
Finalize the SDK types; implement `adapter-dnd5e` against **fixture JSON captured from the M0 world** (commit fixtures); `GET /actors/:id/sheet` returns the full view model; resource descriptors with correct bounds.
**Accept:** fixture tests cover a martial and a caster actor; view model contains everything §1 lists as readable.

### M3 — Writes (≈1 session)
`POST /actors/:id/intents` with intent validation, allow-list, clamping, optimistic-lock (send last-seen value; reject on mismatch with fresh state). Round-trip verified against the live M0 stack.
**Accept:** HP delta from the API is visible in the Foundry UI within 3s; non-allow-listed path → 403; over-max clamp works.

### M4 — PWA (≈2–3 sessions)
Nuxt app: join-link flow, actor picker, sheet screens (overview / resources / inventory / spells), resource edit UI (tap ± with confirm for large deltas), live updates via gateway WS/SSE, PWA manifest + service worker (app-shell + last-snapshot read-only offline), mobile-first, dark mode. Use the frontend-design skill; this should feel like a product, not a demo.
**Accept:** on a phone, a player can join via link, watch the GM change their HP live, and spend a spell slot that appears in Foundry.

### M5 — Production deploy + docs (≈1 session)
Single `docker-compose.prod.yml`: Caddy (auto-TLS) + Foundry + relay (internal-only) + gateway + PWA static. Deploy on the VPS, migrate the group's world in, generate real invite tokens. Write `docs/OPERATIONS.md` (backup of Foundry data dir, update procedure honoring `VERSIONS.md`, token rotation).
**Accept:** the group plays one real session using the app.

### v2 backlog (do not build in v1): dice rolling into Foundry chat, Mörk Borg adapter, OIDC, push notifications ("you took damage"), GM dashboard.

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Relay lacks change-push | Polling + diff at gateway (fine at 1 world / ≤6 actors); revisit only if latency hurts |
| Relay/module abandons Foundry v13 or breaks | Everything pinned in `VERSIONS.md`; upgrades are deliberate; blast radius confined to `foundry-client` + gateway relay adapter; Option C fallback documented in §3 |
| dnd5e system update changes data paths | Adapter fixture tests fail loudly; paths pinned to system version |
| Concurrent edits (player + GM) | Optimistic-lock on intents (M3); last-write-wins is acceptable at this scale |
| Relay write surface too permissive if leaked | Relay not publicly exposed; API key server-side only; gateway allow-list |

## 10. Working agreements for Claude Code
- Read this file and `VERSIONS.md` at session start; update `docs/M*-findings.md` as decisions land.
- Never widen the write allow-list or the v1 scope without an explicit instruction from Sebastian.
- Prefer boring code: no speculative abstractions beyond the adapter seam.
- Every milestone ends green: typecheck, tests, and a one-paragraph summary in the PR/commit message.
