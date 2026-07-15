/**
 * Read-only first-run status page (spec Phase 1): one LAN-bound HTML page
 * that answers "where is my stack" — relay up -> key minted -> module placed
 * -> waiting for world -> gm login failed -> pair once (fallback) -> online.
 * Read-only by design: no secret entry (that is the out-of-scope Phase 2),
 * and stored secrets are NEVER rendered (status.json carries none by
 * contract, and everything is HTML-escaped anyway).
 */
import { createServer, type Server } from 'node:http';
import type { BootstrapPhase, BootstrapStatus } from './status.js';

const GUIDANCE: Record<BootstrapPhase, string> = {
  starting: 'Sidecar starting…',
  'waiting-relay': 'Waiting for the relay to come up. This resolves by itself.',
  'provisioning-account': 'Registering the relay account…',
  'minting-key': 'Minting the gateway API key…',
  'key-ready': 'Relay credentials ready.',
  'placing-module': 'Installing the REST API module into Foundry…',
  'waiting-world':
    'Open Foundry (port 30000), then: create your world, set the Gamemaster password to the one `make setup` printed, enable the "Foundry REST API" module in that world, set its WebSocket Relay URL as printed by setup, and launch the world.',
  'starting-session': 'Bringing the world online…',
  'gm-login-failed':
    'The headless GM login was rejected. In the world, make sure the Gamemaster password matches FOUNDRY_GM_PASSWORD in stack/quickstart/secrets/bootstrap.env.',
  'needs-pairing':
    'One-time pairing needed: open the world as GM, open the REST API Connection dialog, click Pair, then open http://<this-host>:3010/pair/<CODE> and approve with the relay account from the setup output.',
  online: 'World online. Invite players from the admin console.',
  error: 'The sidecar hit an error and will retry automatically. See detail below.',
};

export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function renderStatusHtml(s: BootstrapStatus): string {
  const err =
    s.error === null
      ? ''
      : `<p class="err"><strong>${escapeHtml(s.error.class)}</strong>: ${escapeHtml(s.error.message)}</p>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5">
<title>Foundry's Unseen Servant — setup status</title>
<style>body{font-family:system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem}
.phase{font-size:1.4rem;font-weight:700}.err{color:#a00}</style></head>
<body>
<h1>Setup status</h1>
<p class="phase">${escapeHtml(s.phase)}</p>
<p>${escapeHtml(GUIDANCE[s.phase])}</p>
<p><em>${escapeHtml(s.detail)}</em></p>
${err}
<p><small>updated ${escapeHtml(s.updatedAt)} — this page refreshes itself</small></p>
</body></html>`;
}

export function startStatusPage(port: number, current: () => BootstrapStatus): Server {
  const server = createServer((req, res) => {
    const s = current();
    if (req.url === '/status.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(s));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderStatusHtml(s));
  });
  server.listen(port, '0.0.0.0');
  return server;
}
