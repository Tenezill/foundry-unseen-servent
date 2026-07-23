# Public Distribution of Unseen Servant

**Date:** 2026-07-23
**Status:** Approved

## Goal

Make the app installable by anyone via prebuilt Docker images, while the source
repo stays private and the code stays closed-source. The app is fully free;
monetization comes later via Patreon-exclusive cosmetic themes, which this
design enables but does not implement.

## Decisions

- **Audience:** anyone may install (public images), source stays private.
- **Monetization model:** free full-featured app; paid themes ship later as
  separate files that are simply not in the public images (no DRM, no license
  server, no Patreon API integration).
- **Release flow:** GitHub Actions on version tags — not manual pushes.
- **Public artifact home:** a small public quickstart repo.

Accepted trade-off: Docker images are extractable — users can pull built,
minified JS out of them. That is the normal exposure level for closed-source
shipped software; readable TypeScript source, git history, and docs remain
private.

## 1. Image publishing (private repo, GitHub Actions)

A workflow in the private repo (`Tenezill/foundry-unseen-servent`) triggers on
tags matching `v*`. It builds the three first-party images with buildx and
pushes them to GHCR as **public** packages:

| Image | Dockerfile |
|---|---|
| `ghcr.io/tenezill/unseen-servant-gateway` | `apps/gateway/Dockerfile` |
| `ghcr.io/tenezill/unseen-servant-web` | `apps/web/Dockerfile` |
| `ghcr.io/tenezill/unseen-servant-bootstrap` | `apps/bootstrap/Dockerfile` |

- Tags per release: exact version (e.g. `v0.1.0`) and `latest`.
- Platforms: `linux/amd64` + `linux/arm64` (QEMU/buildx).
- GHCR package visibility is public even though the repo is private (GHCR
  supports this independently).
- Foundry (`felddy/foundryvtt`) and the relay
  (`threehats/foundryvtt-rest-api-relay`) are already public third-party
  images and are unchanged.

## 2. Public quickstart repo (`Tenezill/unseen-servant`)

Contains only orchestration glue, no app source:

- `docker-compose.yml` — the current `stack/quickstart/docker-compose.yml`
  with the three `build:` blocks replaced by pinned `image:` refs.
- Caddyfile templates (`Caddyfile`, `Caddyfile.tls.example`).
- The setup wizard (`scripts/setup-quickstart.mjs`) and a `Makefile` with
  `setup` / `setup-reset` targets.
- `README.md` with install docs; issues enabled — this repo is the public
  face of the project.

User install flow: `git clone` → `make setup` → `docker compose up -d`.
Host requirements: Docker (or rootless Podman) + Node for the wizard — same
as today.

## 3. Source of truth stays private

Quickstart files continue to live in the private repo. The release workflow
syncs them to the public repo on each tag, rewriting the pinned image versions
as it goes. The public repo is a generated artifact; direct hotfixes there are
possible but the private repo wins on the next release.

## 4. Licensing

- **App images:** short proprietary EULA — free to use, no redistribution or
  resale, no warranty. Lives in the currently-empty `licence/` dir and is
  copied into the images.
- **Quickstart repo:** MIT (glue only; permissive licensing avoids friction
  for users cloning it).
- **Patreon themes (later):** personal use, patrons only.

## 5. Out of scope

- Runtime theme loading (the Patreon perk mechanism) — later feature; themes
  will be files under `gateway-data/themes/` or an admin-panel upload.
- Auto-updates — users run `docker compose pull`.
- Landing page / website.

## Error handling & testing

- The workflow must fail the release if any image build or push fails; no
  partial releases (sync to the public repo runs only after all pushes
  succeed).
- Verify a release by running the public quickstart end-to-end on a clean
  machine/VM: clone → setup → up → pair → open the web app.
- The setup wizard must not assume the private repo layout (it currently runs
  from repo root); the quickstart repo copy must be self-contained.
