# Pinned versions

Single source of truth for every upstream moving part. Upgrades are deliberate:
change a pin here, test against `docs/M0-findings.md` expectations
(fixture tests + one live read/write/SSE round-trip), then commit.
Never let `latest` drift in production.

| Component | Version | Where it is pinned |
|---|---|---|
| Foundry VTT | **13.351** | `stack/docker-compose.*.yml` → `felddy/foundryvtt:13.351.0` + `stack/quickstart/docker-compose.yml` (same tag) |
| dnd5e system | **5.3.3** | `stack/foundry-data/Data/systems/dnd5e` (zip: `github.com/foundryvtt/dnd5e/releases/download/release-5.3.3/dnd5e-release-5.3.3.zip`) |
| foundry-rest-api module | **3.4.1** | `stack/foundry-data/Data/modules/foundry-rest-api` (zip: `github.com/ThreeHats/foundryvtt-rest-api/releases/download/3.4.1/module.zip`) + `apps/bootstrap/Dockerfile` (same zip, baked into the bootstrap image at build time so the quickstart sidecar can pre-place the module without network access at runtime) |
| foundryvtt-rest-api-relay | **3.4.1** | `stack/docker-compose.*.yml` → `threehats/foundryvtt-rest-api-relay:3.4.1` + `stack/quickstart/docker-compose.yml` (same tag) |
| Node | 22.x | `package.json` engines |
| pnpm | 11.10.0 | `package.json` packageManager |

Adapter data paths (`packages/adapter-dnd5e`) are pinned to **dnd5e 5.3.3**;
its fixture tests fail loudly if a system update changes document shapes.
Module and relay versions track each other — upgrade them together. The
quickstart stack (`stack/quickstart/`) pins the same three image/module
versions independently of `stack/docker-compose.*.yml` — when bumping a pin,
update both compose files (and `apps/bootstrap/Dockerfile`'s baked module zip)
together, never `:latest` in any of them.
