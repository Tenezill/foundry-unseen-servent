/**
 * Ephemeral first-run web wizard (spec Phase 2). Hosted INSIDE `make setup`
 * on the operator's host (spec Approach A): the server dies with the CLI, so
 * "one-time token" and "auto-disable" are structural properties, not flags.
 * Zero runtime deps, zero client JS — progress polling is <meta refresh>,
 * the Phase 1 status-page idiom.
 *
 * Security model (spec): LAN or SSH tunnel only; every path is gated by a
 * per-run token (/s/<token>/…) compared constant-time; wrong token -> bare
 * 404. No cookies. No response after the once-only secrets page contains a
 * secret. All dynamic text is HTML-escaped.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

export function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Constant-time token check; sha256 both sides so lengths always match. */
export function tokenMatches(expected, presented) {
  const a = createHash('sha256').update(String(expected)).digest();
  const b = createHash('sha256').update(String(presented)).digest();
  return timingSafeEqual(a, b);
}

/** application/x-www-form-urlencoded -> plain object; first value wins. */
export function parseFormBody(body) {
  const out = {};
  for (const [k, v] of new URLSearchParams(body)) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Gilded Tome shell — token values copied from apps/web/app/assets/css/main.css
   (Midnight Tome, dark). The wizard cannot import the Nuxt CSS; keep this
   block in sync with that source of truth by hand.
--------------------------------------------------------------------------- */
const STYLE = `
:root{--panel:#1d1922;--panel-2:#262029;--line:#3a3140;--ink:#ece5d8;--ink-dim:#a99f8f;
--gold:#d9a441;--gold-bright:#f0c56a;--garnet:#c94640;--accent-ink:#241a08;--radius:14px;
--serif:'Palatino Linotype','Book Antiqua',Palatino,Georgia,serif}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;color:var(--ink);
font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
background:#131017 url(bg.jpg) center/cover no-repeat fixed}
body::before{content:'';position:fixed;inset:0;pointer-events:none;
background:radial-gradient(ellipse at center,transparent 35%,rgba(0,0,0,.55))}
.wrap{position:relative;width:min(34rem,92vw);margin:36vh auto 4vh}
@media (max-aspect-ratio:1/1){.wrap{margin-top:14vh}}
.card{background:rgba(29,25,34,.95);border:1px solid var(--line);
border-radius:var(--radius);padding:1.6rem;box-shadow:0 10px 40px rgba(0,0,0,.55)}
h1{font-family:var(--serif);color:var(--gold-bright);font-size:1.45rem;margin:0 0 .75rem}
p{line-height:1.5}
label{display:block;margin:.85rem 0 .3rem;color:var(--ink-dim);font-size:.9rem}
input[type=text],input[type=password],input[type=email]{width:100%;padding:.6rem .7rem;
background:var(--panel-2);border:1px solid var(--line);border-radius:10px;
color:var(--ink);font-size:1rem}
input:focus{outline:2px solid var(--gold);outline-offset:1px}
details{margin-top:1rem;border:1px solid var(--line);border-radius:10px;padding:.6rem .8rem}
summary{cursor:pointer;color:var(--gold)}
button{margin-top:1.3rem;width:100%;padding:.85rem;border:0;border-radius:10px;
background:var(--gold);color:var(--accent-ink);font-size:1.05rem;font-weight:700;cursor:pointer}
button:hover{background:var(--gold-bright)}
.err{color:var(--garnet)}
.secret{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--panel-2);
border:1px solid var(--line);border-radius:8px;padding:.5rem .6rem;margin:.15rem 0 .7rem;
user-select:all;overflow-wrap:anywhere}
small{color:var(--ink-dim)}
`;

export function renderShell({ title, body, head = '' }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${head}<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><div class="wrap"><div class="card">${body}</div></div></body></html>`;
}

export function renderCredsForm({ needCreds, needTls, error = null, username = '' }) {
  const err = error === null ? '' : `<p class="err">${escapeHtml(error)}</p>`;
  const creds = !needCreds
    ? ''
    : `<label for="username">foundry.com username or email</label>
<input type="text" id="username" name="username" value="${escapeHtml(username)}" autocomplete="username" required>
<label for="password">foundry.com password</label>
<input type="password" id="password" name="password" autocomplete="current-password" required>
<label for="licenseKey">license key <small>(leave blank to fetch from the account)</small></label>
<input type="text" id="licenseKey" name="licenseKey">`;
  const tls = !needTls
    ? ''
    : `<details><summary>Enable HTTPS on your own domain (optional)</summary>
<label><input type="checkbox" name="tls" value="on"> use HTTPS (Let's Encrypt)</label>
<label for="domainApp">app domain</label>
<input type="text" id="domainApp" name="domainApp" placeholder="app.example.com">
<label for="domainVtt">foundry domain</label>
<input type="text" id="domainVtt" name="domainVtt" placeholder="vtt.example.com">
<label for="acmeEmail">email for Let's Encrypt</label>
<input type="email" id="acmeEmail" name="acmeEmail" placeholder="you@example.com">
</details>`;
  const intro = needCreds
    ? '<p>These credentials let the Foundry container download and license your server. They are written to a <code>0600</code> secret file on this host and never leave it.</p>'
    : '<p>Choose whether to enable HTTPS. Credentials are already configured.</p>';
  return renderShell({
    title: 'Setup — Foundry’s Unseen Servant',
    body: `<h1>Summon your servant</h1>${err}${intro}
<form method="post" action="submit">${creds}${tls}<button type="submit">Begin the ritual</button></form>`,
  });
}

export function renderSecretsPage(secrets) {
  const rows = secrets
    .map(([label, value]) => `<label>${escapeHtml(label)}</label><div class="secret">${escapeHtml(value)}</div>`)
    .join('');
  return renderShell({
    title: 'Your secrets — shown once',
    body: `<h1>Written in invisible ink</h1>
<p><strong>These are shown once.</strong> Copy them somewhere safe now — they are also printed in the terminal that ran <code>make setup</code>.</p>
${rows}
<form method="post" action="ack"><button type="submit">I’ve written these down — start the stack</button></form>`,
  });
}

export function renderProgressPage() {
  return renderShell({
    title: 'Starting your stack…',
    head: '<meta http-equiv="refresh" content="3">\n',
    body: `<h1>The servant is busy…</h1>
<p>Pulling images and starting containers. This page refreshes itself; the terminal shows detailed logs.</p>`,
  });
}

export function renderDonePage(statusUrl) {
  return renderShell({
    title: 'Stack started',
    head: `<meta http-equiv="refresh" content="3;url=${escapeHtml(statusUrl)}">\n`,
    body: `<h1>At your service!</h1>
<p>The stack is up. Continuing to the <a href="${escapeHtml(statusUrl)}">setup status page</a>, which walks you through creating your world…</p>`,
  });
}

export function renderFailedPage(exitCode) {
  return renderShell({
    title: 'Stack failed to start',
    body: `<h1>Mostly clumsy, indeed</h1>
<p class="err">compose exited with code ${escapeHtml(String(exitCode))}.</p>
<p>See the terminal that ran <code>make setup</code> for the full logs, fix the cause, and run <code>make setup</code> again — your secrets are kept.</p>`,
  });
}

export function renderAlreadyShownPage() {
  return renderShell({
    title: 'Secrets already shown',
    body: `<h1>Already revealed</h1>
<p>The generated secrets were already shown once and will not be rendered again. Check your notes — or the terminal that ran <code>make setup</code>, which printed them too.</p>
<form method="post" action="ack"><button type="submit">I have them — start the stack</button></form>`,
  });
}

export function renderGonePage() {
  return renderShell({
    title: 'Continued in the terminal',
    body: `<h1>The ritual moved</h1>
<p>Setup was continued in the terminal, so this page is no longer active. Finish the prompts in the terminal that ran <code>make setup</code>.</p>`,
  });
}

/* ---------------------------------------------------------------------------
   Server + state machine
   collecting -> submitting -> secrets-shown -> composing -> done | failed
   plus `gone` (terminal takeover). Backward transitions are refused; replays
   render the current-state page. `submitted` resolves the moment a VALID form
   arrives so the CLI can cancel its terminal listener; `acked` gates compose
   behind the "I've written these down" click (auto-resolved when there were
   no new secrets to show).
--------------------------------------------------------------------------- */

const MAX_BODY_BYTES = 64 * 1024;

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('body too large'), { code: 'E_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** null when valid, else a user-facing error string. */
function validateForm(form, { needCreds, needTls }) {
  if (needCreds) {
    if ((form.username ?? '').trim() === '') return 'foundry.com username is required.';
    if ((form.password ?? '') === '') return 'foundry.com password is required.';
  }
  if (needTls && form.tls === 'on') {
    for (const f of ['domainApp', 'domainVtt', 'acmeEmail']) {
      if ((form[f] ?? '').trim() === '') return 'HTTPS needs all three fields (both domains and the email).';
    }
  }
  return null;
}

function normalizeForm(form, { needCreds, needTls }) {
  const creds = !needCreds
    ? null
    : {
        username: form.username.trim(),
        password: form.password,
        licenseKey: (form.licenseKey ?? '').trim(),
      };
  const tls =
    needTls && form.tls === 'on'
      ? {
          enabled: true,
          domainApp: form.domainApp.trim(),
          domainVtt: form.domainVtt.trim(),
          acmeEmail: form.acmeEmail.trim(),
        }
      : { enabled: false };
  return { creds, tls };
}

export function createWizard({ token, needCreds, needTls, bgPath, statusUrl, onSubmit }) {
  let state = 'collecting';
  let exitCode = 1;
  let bg = null; // lazily read so construction is side-effect-free
  // Synchronous lock taken BEFORE the first await in the /submit path
  // (readBody), so two near-simultaneous valid POSTs can't both slip past
  // the `state` check while the first is still parked awaiting its body.
  // Released on the validation-error and onSubmit-throw paths so the
  // operator can retry after a rejected form.
  let submitLocked = false;

  let submitResolve;
  const submitted = new Promise((r) => (submitResolve = r));
  let ackResolve;
  const acked = new Promise((r) => (ackResolve = r));
  let finalResolve;
  const finalServed = new Promise((r) => (finalResolve = r));

  function pageForState() {
    switch (state) {
      case 'collecting':
        return renderCredsForm({ needCreds, needTls });
      case 'submitting':
      case 'composing':
        return renderProgressPage();
      case 'secrets-shown':
        return renderAlreadyShownPage();
      case 'done':
        finalResolve(true);
        return renderDonePage(statusUrl);
      case 'failed':
        return renderFailedPage(exitCode);
      default:
        return renderGonePage(); // 'gone'
    }
  }

  function html(res, page, status = 200) {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      // never leak error details to the network
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('error');
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://wizard.invalid');
    const m = /^\/s\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (m === null || !tokenMatches(token, m[1])) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const path = m[2] ?? '/';

    if (req.method === 'GET' && path === '/bg.jpg') {
      if (bg === null) bg = readFileSync(bgPath);
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=3600' });
      res.end(bg);
      return;
    }

    if (req.method === 'POST' && path === '/submit') {
      if (submitLocked || state !== 'collecting') {
        // A submit is already in flight (locked, still 'collecting') or the
        // state has moved on; either way this is a concurrent/replayed
        // request that must never reach onSubmit or render secrets again.
        html(res, state === 'collecting' ? renderProgressPage() : pageForState());
        return;
      }
      // Reject oversized bodies BEFORE reading: once readBody destroys the
      // socket mid-stream, no 413 can be delivered. fetch/browsers always
      // send content-length for form posts; readBody's cap stays as the
      // backstop for chunked/lying clients (those may just see a reset).
      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
        res.writeHead(413, { 'content-type': 'text/plain' });
        res.end('payload too large');
        return;
      }
      // Take the lock synchronously, BEFORE the first await below, so no
      // other request can observe `submitLocked === false` until this one
      // either releases it (error path) or moves `state` past 'collecting'.
      submitLocked = true;
      let body;
      try {
        body = await readBody(req, MAX_BODY_BYTES);
      } catch {
        submitLocked = false;
        return; // backstop path: socket already destroyed
      }
      const form = parseFormBody(body);
      const error = validateForm(form, { needCreds, needTls });
      if (error !== null) {
        submitLocked = false;
        html(res, renderCredsForm({ needCreds, needTls, error, username: form.username ?? '' }));
        return;
      }
      state = 'submitting';
      submitResolve('browser'); // the CLI race cancels its terminal listener now
      let secrets;
      try {
        secrets = await onSubmit(normalizeForm(form, { needCreds, needTls }));
      } catch (err) {
        state = 'collecting';
        submitLocked = false;
        html(res, renderCredsForm({ needCreds, needTls, error: err.message, username: form.username ?? '' }));
        return;
      }
      if (secrets.length === 0) {
        state = 'composing'; // nothing to show once -> no ack gate
        ackResolve();
        html(res, renderProgressPage());
        return;
      }
      state = 'secrets-shown';
      html(res, renderSecretsPage(secrets)); // the once-only response
      return;
    }

    if (req.method === 'POST' && path === '/ack') {
      if (state === 'secrets-shown') {
        state = 'composing';
        ackResolve();
      }
      res.writeHead(303, { location: './' });
      res.end();
      return;
    }

    html(res, pageForState());
  }

  return {
    token,
    server,
    submitted,
    acked,
    listen(port, host = '0.0.0.0') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          // A later runtime 'error' event (e.g. a broken client socket) must
          // not crash the process now that no listener remains for it.
          server.on('error', () => {});
          resolve(server.address().port);
        });
      });
    },
    setPhase(phase, extra = {}) {
      if (phase === 'failed') exitCode = extra.exitCode ?? 1;
      state = phase;
    },
    takeover() {
      state = 'gone';
    },
    waitForFinalPage(timeoutMs) {
      let timer;
      const timeout = new Promise((r) => {
        timer = setTimeout(() => r(false), timeoutMs);
      });
      return Promise.race([finalServed, timeout]).then((v) => {
        clearTimeout(timer);
        return v;
      });
    },
    close() {
      server.close();
      server.closeAllConnections?.();
    },
  };
}
