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
 * Fallback (documented only, NOT implemented unless a test demands it): if a
 * relay build rejects an unknown system scope at mint time, mint without the
 * system scopes — read paths worked without a matching system scope in live
 * testing (Task 0 findings §6).
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
  'dnd5e',
  'wod5e',
] as const satisfies readonly string[];
