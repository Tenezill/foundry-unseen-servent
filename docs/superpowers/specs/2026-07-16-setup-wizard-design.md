# Setup Wizard (Turnkey Phase 2) — Design

**Status:** approved in brainstorming, 2026-07-16.
**Owner:** Sebastian.
**Predecessor:** `2026-07-15-turnkey-stack-design.md` (Phase 0/1, shipped), which
deferred this as "Phase 2 = a LAN-bound web credential wizard — out of scope,
separate spec." This is that spec.

## What we are building

A browser-based first-run wizard that makes `make setup` near-zero-touch: the
operator runs one command, then finishes everything in a browser on their LAN —
enter foundry.com credentials (and optional TLS domains), read the generated
secrets once, watch the stack come up, and land on the Phase 1 status page
(`:8321`), which already owns the world-creation walkthrough.

The wizard replaces the *interactive terminal prompts* of
`scripts/setup-quickstart.mjs`; everything downstream (secret generation,
file writing, compose up, Podman override) is shared code and unchanged.

## Settled decisions

1. **Scope: full first-run wizard.** Not just the credential prompts — the
   browser flow covers creds → generated-secrets display → compose progress →
   handoff to the status page. Post-setup config management and secret
   rotation stay out of scope (unchanged from the v1 spec).
2. **Architecture: CLI-hosted, ephemeral (Approach A).** The wizard is a
   temporary `node:http` server started *inside* `make setup` on the host. It
   dies when setup completes. Rejected: sidecar-hosted wizard (Approach B — an
   always-on container with a flag-guarded secrets-writing endpoint is a
   permanent attack surface, fights the rootless-Podman ownership model, and
   forces Foundry to crash-loop on missing creds) and a staged-compose wizard
   container (Approach C — strictly more machinery than A for the same UX).
3. **Exposure: LAN or SSH tunnel only.** Binds `0.0.0.0`; VPS operators are
   documented to use `ssh -L 8322:localhost:8322 <host>`. Never intended to be
   internet-reachable; plain HTTP on the operator's own network is the accepted
   threat model (consistent with the v1 "curious players, not determined
   attackers" posture).
4. **CLI prompts survive as a fallback.** `make setup` launches the wizard by
   default and simultaneously waits on terminal-Enter; whichever side acts
   first wins. `--no-wizard` skips the server entirely. Both paths call the
   same `build*` / `writeSecretIfAbsent` functions.
5. **Port 8322** (8321 belongs to the sidecar status page, which is alive
   during the wizard's final redirect — no collision allowed).
6. **Zero runtime dependencies, zero JavaScript.** `node:http` + `node:crypto`
   only; progress polling via `<meta http-equiv="refresh">` (the Phase 1
   status-page idiom). All HTML escaped via the established `escapeHtml`
   discipline.

## Operator experience

```
$ make setup
Open  http://192.168.1.20:8322/s/<token>/  in a browser on your network
to finish setup — or press Enter to use terminal prompts instead.
```

1. **Credentials form** (one page): foundry.com username + password
   (`type="password"` — an improvement over the terminal's visible input),
   optional license key (blank = fetch from account), and an "Enable HTTPS on
   your own domain" toggle revealing app-domain / vtt-domain / ACME-email
   fields. Validation is non-empty-only: foundry.com credentials cannot be
   verified without calling foundry.com, so wrong creds surface exactly where
   they do today (Foundry container logs + status page).
2. **Secrets page, shown once**: the four generated secrets (Foundry admin
   key, GM password, relay account password, `/admin` console password) with
   an "I've written these down" button. The same secrets are still printed to
   the terminal as backup (today's behavior). After this page is served once,
   no wizard state ever renders them again; a re-GET shows "already shown —
   check your notes or the terminal."
3. **"Starting your stack…"** progress page, meta-refresh polling while the
   CLI runs `compose up` asynchronously.
4. Compose success → redirect to `http://<host>:8321` (sidecar status page,
   which carries the world-creation guidance). The wizard server exits and
   `make setup` returns.

**Skip condition:** if secrets and `.env` already exist there is nothing to
collect — no wizard server is started and `make setup` behaves exactly as
today (prints "secrets already present", manages the Podman override, runs
compose up).

**Mutual exclusion:** browser submission and terminal-Enter race; the first
event wins and the losing path is disabled (server stops accepting POSTs /
terminal prompts are skipped). One shared code path runs from that point on.

## Security model

- **Per-run one-time token in the URL path** (`/s/<token>/…`), minted with the
  existing `generateSecret()` (base64url), compared with
  `crypto.timingSafeEqual`. Wrong or missing token → `404` with no hint that a
  wizard exists. The token is printed only to the operator's terminal.
- **No cookies, no sessions.** Token-in-path is the entire auth story; it also
  neutralizes CSRF (an attacker cannot forge a POST to a path they cannot
  know).
- **Auto-disable is structural, not a flag.** The server is part of the
  `make setup` process and dies with it — there is no persistent endpoint to
  accidentally leave enabled.
- **Secrets discipline:** request bodies are never logged; no response after
  the once-only secrets page contains a secret; everything rendered is
  HTML-escaped. Generated secret files keep today's ownership and `0600`
  modes (host-written, exactly as now).

## Visual design ("Gilded Tome" over the Unseen Servant artwork)

- **Background:** the "Unseen Servant" illustration (wizard's study, broom,
  floating tea tray; carries its own title banner "The Unseen Servant — Always
  busy. Mostly clumsy. At Your Service!"), full-bleed `background-size: cover`
  with a soft dark vignette. The artwork's banner acts as the page heading; on
  wide screens the form card sits in the lower two-thirds so the banner stays
  visible. On portrait phones the artwork crops to center; the card takes
  ~92% width.
- **Asset pipeline:** the source PNG (~9.8 MB, 2752×1536) is compressed once
  at development time to `scripts/assets/unseen-servant.jpg` (~2000 px wide,
  target ≤ 400 KB) and committed. The wizard serves it at
  `/s/<token>/bg.jpg`. (Own generated artwork — the "no game-rules content"
  rule is untouched.)
- **Form card:** Midnight Tome tokens lifted verbatim from
  `apps/web/app/assets/css/main.css` and inlined (the wizard cannot import the
  Nuxt CSS; a comment marks the source of truth): panel `#1d1922` at ~95%
  opacity, border `#3a3140`, radius `14px`, ink `#ece5d8`, gold `#d9a441` for
  headings/buttons/focus rings, Palatino serif headings, system sans inputs.
  **Form legibility beats artwork visibility** — the card never goes
  translucent enough for the busy illustration to bleed through text.
- The secrets and progress pages reuse the same shell so the flow reads as one
  product, continuous with the PWA's look.

## Code structure

**Create**

| path | responsibility |
|---|---|
| `scripts/setup-wizard.mjs` | ephemeral wizard server: pure render functions (`renderCredsPage`, `renderSecretsPage`, `renderProgressPage`), `parseFormBody` (urlencoded), constant-time token check, state machine `collecting → secrets-shown → composing → done \| failed`; `startWizard()` resolves with the submitted values but keeps serving — the CLI drives later phases via `wizard.setPhase(…)` and `wizard.close()` |
| `scripts/assets/unseen-servant.jpg` | compressed background artwork (committed once) |
| `apps/bootstrap/test/setup-wizard.test.ts` | unit + real-server tests (see Testing) |

**Modify**

| path | change |
|---|---|
| `scripts/setup-quickstart.mjs` | extract credential collection behind a seam: `collectViaTerminal()` (today's prompts, verbatim) vs `collectViaWizard()`; wizard path runs `compose up` via async `spawn` (progress page polls); `--no-wizard` flag; everything downstream shared and unchanged |
| `apps/bootstrap/test/mjs.d.ts` | typed declarations for the new wizard exports |
| `docs/HOSTING.md` | Part C: wizard flow, port 8322, VPS `ssh -L` guidance |
| `Makefile` | comment only (`make setup` behavior description), no new targets |

The existing terminal path keeps `spawnSync` for compose; only the wizard path
needs the async variant so the event loop can serve the progress page.

## Error handling

- **Compose failure:** progress page becomes a failure page ("stack failed to
  start — see the terminal for logs") with the exit code; the CLI exits
  non-zero as today. Secrets already written stay written; re-running
  `make setup` skips collection (idempotent, today's semantics).
- **Browser abandoned:** terminal-Enter works at any time before browser
  submission; Ctrl+C tears everything down (server closed in `finally`).
- **Double-submit / back-button:** the state machine refuses backward
  transitions; replays get the current-state page.
- **Malformed POST:** re-render the form with an inline error, non-secret
  values preserved (passwords cleared).
- **Port 8322 occupied:** print a clear error and fall back to terminal
  prompts (never fail setup over the wizard's own port).

## Testing

Same idiom as `apps/bootstrap/test/setup-cli.test.ts` (vitest importing the
`.mjs` — note: **no shebang** on any imported `.mjs`; a shebang breaks
vitest's transform, found the hard way on `setup-quickstart.mjs`):

- **Pure-function tests:** render outputs contain/never-contain the right
  things (secrets page renders values exactly once across the whole state
  machine; progress/failure pages never contain them; form re-render preserves
  username but never the password), token comparison, urlencoded parsing,
  state-machine transition rules.
- **Real-server test:** boot the wizard on an ephemeral port with an injected
  fake compose-runner; drive the full flow with `fetch`: wrong token → 404,
  happy path collecting → secrets → composing → done, backward-transition
  replay, POST after terminal-side win → rejected.
- Gate: `pnpm -r test` and `pnpm typecheck` green.

## Out of scope

- Post-setup config management / secret rotation UI (unchanged from v1 spec).
- Any always-on wizard surface; the sidecar status page stays read-only.
- HTTPS for the wizard itself (LAN/tunnel threat model).
- Validating foundry.com credentials during the wizard.
- Absorbing the Phase 1 status page into the wizard (handoff is a redirect).
