# The relay, explained

What sits between the app and Foundry, where each piece runs, and why it's
flaky. This is the "I don't actually understand the relay" reference — read it
before touching anything relay-shaped. Operational steps live in
`OPERATIONS.md`; endpoint shapes in `packages/foundry-client/src/index.ts`;
version pins in `VERSIONS.md`.

## The one thing to understand first

"The relay" is really **three separate pieces**, and lumping them together is
what makes it confusing:

| # | piece | what it is | where it runs |
|---|---|---|---|
| 1 | **relay server** | a Go process (`threehats/foundryvtt-rest-api-relay`), a message broker with a small SQLite db | `relay` container, port 3010 |
| 2 | **relay module** | a Foundry *module* (`foundry-rest-api`) — client-side JS that touches Foundry through the live `game` API | *inside a browser* with the world loaded — **not** on any server |
| 3 | **headless Chrome** | a browser the relay server drives, logged into the world as a stored user, to keep it "online" without a human | `relay` container (`relay-data/chrome-profile/`) |

The relay server (1) exposes the REST/SSE API the gateway calls. It knows
**nothing** about Foundry internals — it only forwards messages. The module
(2) is the piece that actually reads and writes Foundry documents. The
headless browser (3) exists purely to load the world so the module comes
alive and stays connected.

## Which way the arrows point (the counterintuitive part)

```
  gateway ──HTTP request──▶ relay server (Go, :3010)
                                 │  matches the request to a connected world
                                 │  by clientId (fvtt_…), forwards it DOWN an
                                 │  already-open socket
                                 ▼
    Foundry world ◀──outbound WS── relay module (running in headless Chrome)
    the module runs it via game.*, sends the result back UP the same socket
                                 │
                                 ▼
  relay server returns it to the gateway as the HTTP response
```

**The relay server never connects *into* Foundry.** The *module* dials *out*
to the relay and holds that WebSocket open. An incoming HTTP request is parked
until a matching reply comes back up that socket. `clientId` (`fvtt_3a9f1c2e…`,
from `GET /clients`) is the routing key that picks which connected world gets
the request.

So the relay is not "a backend." It's a **broker plus a robot that pretends to
be a logged-in GM.** Once you picture it as "a headless browser holding the
world open, taking orders over a socket," the failure modes stop being
mysterious.

## Why it's flaky — every wart traces to the picture above

The defensive code in `foundry-client/src/index.ts` exists because of these.
Each is a symptom of the broker/robot design, not a random glitch:

| symptom | cause | mitigation in our code |
|---|---|---|
| **requests stall forever, no timeout** | the module's socket dropped, or the world is mid-reload → the relay holds the HTTP request with nowhere to send it and no path back | bounded best-effort awaits (M18 `adminNameTimeoutMs` pattern); treat a miss as "not yet resolved" |
| **cross-wired responses** (wrong actor's data under concurrency) | the relay correlates async HTTP requests to async socket replies by a requestId table; under real concurrency that correlation is buggy | `getEntity` checks the returned envelope `uuid` **and** the doc's own `_id` against what was requested; mismatch → treat as a failed fetch |
| **errors arrive as HTTP 200** with an `{error}` body | the *transport* (HTTP→WS→HTTP) succeeded; the failure happened *inside Foundry* | every write re-checks the body for `error`, not just the status code |
| **missing / dead endpoints** (no embedded-create; dead `prepare-spell`) | the module only implements what ThreeHats wrote | multi-leg workarounds (custom item = `create` world item → `give` → `delete`) |
| **per-actor SSE delivers nothing** | that subscription path is broken in the module | subscribe to `hooks/subscribe` instead and filter by `_id` client-side |

## "Online" is the whole ballgame

Nothing works unless a browser has the world loaded and the module connected.
Two ways that happens:

- **Prod:** the relay's own headless Chrome. `POST /session-handshake` +
  `POST /start-session` log it into the world (credentials stored encrypted —
  `CREDENTIALS_ENCRYPTION_KEY` in `relay-data/.secrets.env`; lose that key and
  the stored Foundry login must be re-entered). See `OPERATIONS.md` §First
  deploy step 5.
- **Dev:** usually no headless browser — you keep a **real GM browser tab**
  open on the world. That is why `pnpm test:e2e` requires "a GM tab holding
  the world online." Close the tab → every relay call stalls.

First thing to check when players see stale data or the app hangs:
`GET /clients` and confirm `isOnline: true`. A dropped GM/headless session is
the usual cause (`OPERATIONS.md` §Health).

## The seam that keeps this swappable

Everything that knows relay URLs, API keys, and endpoint shapes lives in **one
501-line file**: `packages/foundry-client/src/index.ts`. Nothing else in the
codebase talks to the relay. That is deliberate: if the relay is ever replaced
(a custom Foundry module, a different bridge), only that file changes — the
gateway, adapters, and app don't. There is no urgency to replace it *because*
of this seam; it can be done whenever the relay becomes the limiting factor,
not before.

## Pointers

- endpoint reference & response shapes: `packages/foundry-client/src/index.ts`
  (each method's doc comment records the live-verified shape)
- pinned versions (module and relay track each other, upgrade together):
  `VERSIONS.md`
- first-time bridge setup, pairing, health checks: `OPERATIONS.md`
- original live-verification findings (SSE quirks, envelope shape, pairing
  gotchas): `docs/M0-findings.md`
