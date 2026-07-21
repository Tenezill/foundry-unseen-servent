/**
 * THE canonical scope set for the gateway's relay API key — single-sourced
 * here. CORRECTED per Task 0 findings §6 finding 1
 * (docs/superpowers/specs/2026-07-15-turnkey-stack-task0-findings.md): the
 * plan/brief's list omits `session:manage`, which is verified LIVE-required
 * by `session-handshake` (`403 API key lacks required scope: session:manage`)
 * — the headless session keeper (Task 7) cannot self-pair without it. Also
 * includes BOTH system scopes, `dnd5e` AND `wod5e`, because the turnkey stack
 * is system-agnostic (bring-your-own-world): the minted key must cover
 * whichever system the operator's world actually uses, not just the default.
 *
 * `execute-js` powers dnd5e spell upcasting (the gateway's `cast-at-slot`
 * calls the relay's POST /execute-js with a fixed script template — see
 * foundry-client castAtSlot). Minting it here means fresh installs upcast out
 * of the box; the operator's only manual step is enabling the module setting
 * "Allow Execute JavaScript" in Foundry (that world setting can't be flipped
 * from the bootstrap — arbitrary-JS execution is a deliberate in-Foundry
 * opt-in). EXISTING installs keep their already-minted key (provision only
 * mints on a fresh/invalid key), so their key needs `execute-js` added once
 * by hand — see docs/HOSTING.md "Upcasting".
 *
 * Fallback (documented only, NOT implemented unless a test demands it): if a
 * relay build rejects an unknown system scope at mint time, mint without the
 * system scopes — read paths worked without a matching system scope in live
 * testing (Task 0 findings §6). The same per-scope drop-and-retry in
 * relay-auth.mintKey covers `execute-js` on any relay build too old to know
 * it, so minting never fails outright over an unknown scope.
 *
 * `scene:read` and `canvas:write` power token movement (Task 6 live
 * verification against relay 3.4.1: `GET /scene` 403s without `scene:read`;
 * `POST /move-token` 403s without `canvas:write`).
 */
export const GATEWAY_KEY_SCOPES = [
  'entity:read',
  'entity:write',
  'search',
  'events:subscribe',
  'clients:read',
  'roll:execute',
  'roll:read',
  'chat:read',
  'encounter:read',
  'session:manage',
  'execute-js',
  'scene:read',
  'canvas:write',
  'dnd5e',
  'wod5e',
] as const satisfies readonly string[];
