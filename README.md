# Foundry's Unseen Servant

A mobile-first PWA that lets players of a D&D 5e group view and manage their
characters from a phone while the game runs in Foundry VTT. Foundry stays the
single source of truth; this app is an alternative player-facing client.
See `PLAN.md` for scope and decisions, `VERSIONS.md` for the pinned upstreams.

```
[ PWA (Nuxt) ] ──HTTPS/WSS──▶ [ Gateway (BFF) ] ──REST/SSE──▶ [ Relay (ThreeHats) ]
                                                                    ▲ outbound WS
                                                             [ Foundry v13 + module ]
```

| path | what |
|---|---|
| `apps/web` | Nuxt PWA (join link → actor picker → live sheet) |
| `apps/gateway` | BFF: invite-token auth, actor scoping, write allow-list, SSE fan-out (`docs/API.md`) |
| `packages/adapter-sdk` | the system-adapter contract |
| `packages/adapter-dnd5e` | the v1 adapter (paths pinned to dnd5e 5.3.3) |
| `packages/adapter-wod5e` | second supported system, Vampire: the Masquerade 5e (M23; paths pinned to wod5e 5.3.15 on Foundry v13) |
| `packages/foundry-client` | typed wrapper over the relay REST/SSE |
| `stack/` | Docker: Foundry + relay (+ Caddy/gateway/PWA in prod) |
| `docs/` | `API.md`, `M0-findings.md`, `OPERATIONS.md`, captured fixtures |

## Dev quickstart

```powershell
pnpm install
# stack (fill stack/.env first — see stack/.env.example):
cd stack; docker compose -f docker-compose.dev.yml up -d
# gateway (needs apps/gateway/.env with RELAY_API_KEY/RELAY_CLIENT_ID):
pnpm dev:gateway
# PWA against the gateway (or `pnpm --filter @companion/web dev:mock` standalone):
pnpm dev:web
```

Player invites: `node scripts/make-invite.mjs <player> <actorId…>` →
append the printed YAML to `apps/gateway/players.yaml`, share the link once.

Quality gates: `pnpm typecheck && pnpm test` (adapter fixture tests pin the
dnd5e document shapes; see `docs/OPERATIONS.md` before upgrading anything).

Live end-to-end test (needs the dev stack up **and** a GM tab holding the
world online): `pnpm test:e2e`. It boots the real gateway over HTTP against the
running relay/Foundry and verifies the whole player journey — auth, scoping,
sheet reads, an HP write that round-trips into Foundry, a spell-slot spend, the
write allow-list, and a world change pushed live over SSE — restoring every
value it touches. Config is read from `apps/gateway/.env`; actor scope from
`apps/gateway/players.yaml`.
