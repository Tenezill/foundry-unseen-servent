# Pinned versions

Single source of truth for every upstream moving part. Upgrades are deliberate:
change a pin here, test, then commit. Never let `latest` drift in production.

| Component | Version | Where it is pinned |
|---|---|---|
| Foundry VTT | _pending M0_ (v13 latest stable build) | `stack/docker-compose.*.yml` (`felddy/foundryvtt` image tag) |
| dnd5e system | _pending M0_ | installed into `stack/foundry-data/Data/systems`, recorded here |
| foundryvtt-rest-api module | _pending M0_ | installed into `stack/foundry-data/Data/modules`, recorded here |
| foundryvtt-rest-api-relay | _pending M0_ | `stack/docker-compose.*.yml` image tag |
| Node | 22.x | `package.json` engines |
| pnpm | 11.10.0 | `package.json` packageManager |
