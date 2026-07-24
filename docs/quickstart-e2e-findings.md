# Quickstart clean-machine E2E findings (2026-07-24/25, v0.1.0)

First real-user test of the public quickstart: fresh Ubuntu 24.04 (WSL2 instance
with its own dockerd — NOT Docker Desktop), run as **root** (the fresh-VPS
persona), `git clone https://github.com/Tenezill/unseen-servant` → `make setup`.

**Result: PASS end-to-end after three manual interventions.** License
auto-fetch (blank key in wizard) worked; world creation, module pre-place,
relay-key mint, pairing against the self-hosted relay, and player connect all
verified working.

## Bugs found (all wizard/quickstart, target v0.1.1)

1. **`foundry_data/` owned by the wizard's invoking user.** felddy v14 runs as
   uid 1000 and aborts: "Volume write test failed … insufficient permissions on
   /data" (their discussion #1197). Windows/Docker Desktop never enforces bind-
   mount ownership, which is why no dev machine ever hit this. Manual fix used:
   `chown -R 1000:1000 foundry_data`. Real fix: wizard must align ownership
   with the container uid (or the compose must start felddy as root so its
   entrypoint can drop privileges itself — check felddy v14 semantics; must
   also stay correct under rootless podman).

2. **`secrets/foundry-config.json` unreadable by the container.** Written
   root-owned mode 0600; container uid 1000 gets `jq: Permission denied` on
   /run/secrets/config.json, so felddy reports "set FOUNDRY_USERNAME and
   FOUNDRY_PASSWORD" even though credentials exist. Same root cause as (1).
   Manual fix used: `chown 1000:1000 secrets/foundry-config.json`.

3. **`RELAY_PUBLIC_URL` written commented-out in `.env`.** With it unset the
   relay keeps its `foundryrestapi.com` default for the module pairing-approval
   URL, so Pair opens the PUBLIC relay where the self-hosted account doesn't
   exist. The dev compose defaults to `http://localhost:3010`; the quickstart
   compose deliberately passes empty. Manual fix used: set
   `RELAY_PUBLIC_URL=http://localhost:3010` + `docker compose up -d relay
   gateway`. Real fix: wizard should derive/ask for it and write it active
   (localhost default for LAN trials, domain when TLS is configured).

## Nice-to-have (not scheduled)

- Copy buttons are dead on plain-http remote origins — `navigator.clipboard`
  requires a secure context (https or localhost). Fallback (`execCommand` or
  show-the-text) would help LAN users; harmless otherwise.

## Environment notes (for reproducing)

- WSL2 distros share one network namespace with Docker Desktop: the dev stack's
  30000/3010 block the quickstart until `docker compose -f
  stack/docker-compose.dev.yml stop`. Don't run both stacks at once (also a
  Foundry license constraint: one active server per license).
- Pairing is browser-scoped (relay KnownClients) — pairing the test world from
  the GM browser used for the dev world would orphan the dev pairing; use a
  separate profile/incognito.
