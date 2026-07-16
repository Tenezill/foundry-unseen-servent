# Setup Wizard (Turnkey Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `make setup` becomes near-zero-touch: it starts an ephemeral LAN web wizard (port 8322) where the operator enters foundry.com credentials, reads the generated secrets once, watches `compose up` run, and lands on the Phase 1 status page — with today's terminal prompts surviving as a raced fallback.

**Architecture:** The wizard is a temporary `node:http` server hosted *inside* the setup CLI process (spec Approach A) — it dies with `make setup`, so one-time-token + auto-disable are structural. All secret generation/writing and compose handling stay in `scripts/setup-quickstart.mjs`, refactored behind a collection seam shared by both the browser and terminal paths.

**Tech Stack:** Node 22 ESM (`node:http`, `node:crypto`, zero runtime deps, zero client JS — meta-refresh polling), Vitest (tests live in `apps/bootstrap/test/`, the established home for `.mjs` CLI tests), PowerShell System.Drawing for the one-time asset compression.

**Spec:** `docs/superpowers/specs/2026-07-16-setup-wizard-design.md`

## Global Constraints

- **No shebang on any `.mjs` that a vitest test imports.** A `#!` line breaks vitest's esbuild transform with a misleading `SyntaxError` at the importer (found the hard way on `setup-quickstart.mjs`, commit `5d8d184`). `scripts/setup-wizard.mjs` starts with a comment, never `#!`.
- **Zero runtime dependencies, zero client-side JavaScript.** `node:http`/`node:crypto`/`node:fs` only; progress polling via `<meta http-equiv="refresh">` (the Phase 1 status-page idiom, `apps/bootstrap/src/status-page.ts`).
- **Wizard port is 8322** (8321 belongs to the sidecar status page, alive during the final redirect). Bind `0.0.0.0`; LAN/SSH-tunnel threat model per spec.
- **Token gate on every path** including `bg.jpg`: URL shape `/s/<token>/…`, constant-time compare, wrong/missing token → plain 404 with no hint.
- **Secrets discipline:** request bodies never logged; no response after the once-only secrets page contains a secret; ALL rendered dynamic text goes through `escapeHtml`.
- **Secret files keep today's ownership/modes:** written host-side via the existing `writeSecretIfAbsent` (0600, chmod guarded for the Windows dev box).
- **Back-compat:** `--no-wizard` gives exactly today's terminal flow; existing `--reset` / `--no-up` behavior unchanged; the podman-override block is untouched.
- **File-mode tests** are wrapped in `it.skipIf(process.platform === 'win32')` (established pattern).
- Strict TS in test files; ESM `.js`/`.mjs` import suffixes; `pnpm -r test && pnpm typecheck` green is a hard gate at the end of every code task.
- Branch: `feat/setup-wizard` (already exists, based on the shebang fix). Commit per task, trailer:

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

## File Structure

**Create**

| path | responsibility |
|---|---|
| `scripts/assets/unseen-servant.jpg` | compressed background artwork (~2000px wide, ≤400 KB), committed once |
| `scripts/setup-wizard.mjs` | wizard module: pure helpers (`tokenMatches`, `parseFormBody`, `escapeHtml`), page renderers, `createWizard` server/state machine |
| `apps/bootstrap/test/setup-wizard.test.ts` | pure-function tests + real-server tests (ephemeral port, global fetch) |

**Modify**

| path | change |
|---|---|
| `scripts/setup-quickstart.mjs` | extract `writeSecretsBundle` / `writeEnvFiles` / `printGeneratedSecrets` seam; rewrite `main()` collection block: wizard race, async compose on wizard path, `--no-wizard`, port-conflict fallback |
| `apps/bootstrap/test/setup-cli.test.ts` | tests for the new exported seam functions |
| `apps/bootstrap/test/mjs.d.ts` | typed declarations: new `*setup-wizard.mjs` module + new `*setup-quickstart.mjs` exports |
| `docs/HOSTING.md` | Part C: wizard flow, port 8322, VPS `ssh -L` guidance |
| `Makefile` | comment describing the new `make setup` behavior (no new targets) |

**Source asset (dev box only, not committed):** `C:\Users\ramsauer\Downloads\unseenservatn.png` — 2752×1536 PNG, ~9.8 MB. The filename typo is real; do not "fix" it when reading.

---

### Task 1: Compressed background asset

**Files:**
- Create: `scripts/assets/unseen-servant.jpg`

**Interfaces:**
- Produces: the committed artwork file. Task 2's `renderShell` references it as relative URL `bg.jpg`; Task 4 passes its absolute path as `bgPath`.

- [ ] **Step 1: Compress the source PNG to a repo-sized JPEG** (PowerShell, System.Drawing — no ffmpeg/magick on this box):

```powershell
New-Item -ItemType Directory -Force F:\private\foundry-comanion\scripts\assets | Out-Null
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('C:\Users\ramsauer\Downloads\unseenservatn.png')
$w = 2000; $h = [int]($src.Height * $w / $src.Width)
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($src, 0, 0, $w, $h)
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg'
$p = New-Object System.Drawing.Imaging.EncoderParameters(1)
$p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 72L)
$bmp.Save('F:\private\foundry-comanion\scripts\assets\unseen-servant.jpg', $enc, $p)
$g.Dispose(); $bmp.Dispose(); $src.Dispose()
(Get-Item F:\private\foundry-comanion\scripts\assets\unseen-servant.jpg).Length
```

Expected: prints a byte count ≤ 400000. If it is larger, re-run with `Quality, 62L` (and if still larger, `55L`) — the busy illustration compresses well; 72 should land ~250–350 KB.

- [ ] **Step 2: Verify the JPEG decodes and has the right dimensions**

```powershell
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile('F:\private\foundry-comanion\scripts\assets\unseen-servant.jpg')
"$($img.Width)x$($img.Height)"; $img.Dispose()
```

Expected: `2000x1116` (1536 × 2000 / 2752 = 1116).

- [ ] **Step 3: Commit**

```bash
git add scripts/assets/unseen-servant.jpg
git commit -m "feat(setup): unseen-servant wizard background artwork (compressed)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Wizard pure helpers + page renderers

**Files:**
- Create: `scripts/setup-wizard.mjs` (helpers + renderers half; Task 3 appends the server)
- Modify: `apps/bootstrap/test/mjs.d.ts` (new declare-module block)
- Test: `apps/bootstrap/test/setup-wizard.test.ts` (pure-function half)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (Task 3's server and its tests consume — exact signatures):
  - `escapeHtml(s: string): string`
  - `tokenMatches(expected: string, presented: string): boolean` — constant-time
  - `parseFormBody(body: string): Record<string, string>` — urlencoded, first value wins
  - `renderShell(i: { title: string; body: string }): string` — full HTML doc, Gilded Tome card over `bg.jpg`
  - `renderCredsForm(i: { needCreds: boolean; needTls: boolean; error?: string | null; username?: string }): string`
  - `renderSecretsPage(secrets: Array<[string, string]>): string` — includes the ack form (`POST ack`)
  - `renderProgressPage(): string` — meta-refresh 3, no secrets ever
  - `renderDonePage(statusUrl: string): string` — meta-refresh `3;url=<statusUrl>`
  - `renderFailedPage(exitCode: number): string`
  - `renderAlreadyShownPage(): string`
  - `renderGonePage(): string` — terminal took over

- [ ] **Step 1: Write the failing tests** — create `apps/bootstrap/test/setup-wizard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  parseFormBody,
  renderAlreadyShownPage,
  renderCredsForm,
  renderDonePage,
  renderFailedPage,
  renderGonePage,
  renderProgressPage,
  renderSecretsPage,
  renderShell,
  tokenMatches,
} from '../../../scripts/setup-wizard.mjs';

describe('tokenMatches', () => {
  it('accepts only the exact token, regardless of length', () => {
    expect(tokenMatches('abc123', 'abc123')).toBe(true);
    expect(tokenMatches('abc123', 'abc124')).toBe(false);
    expect(tokenMatches('abc123', 'abc12')).toBe(false);
    expect(tokenMatches('abc123', '')).toBe(false);
  });
});

describe('parseFormBody', () => {
  it('parses urlencoded pairs, first value wins, decodes symbols', () => {
    expect(parseFormBody('username=a%40b.c&password=p%24w&password=second')).toEqual({
      username: 'a@b.c',
      password: 'p$w',
    });
    expect(parseFormBody('')).toEqual({});
  });
});

describe('renderShell', () => {
  it('is a full document referencing the token-relative background and the tome palette', () => {
    const html = renderShell({ title: 'T', body: '<p>B</p>' });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('bg.jpg'); // relative — resolves under /s/<token>/
    expect(html).toContain('#1d1922'); // Midnight Tome panel
    expect(html).toContain('#d9a441'); // gold accent
    expect(html).toContain('<p>B</p>');
  });
});

describe('renderCredsForm', () => {
  it('renders creds fields with type=password and the TLS section when both are needed', () => {
    const html = renderCredsForm({ needCreds: true, needTls: true });
    expect(html).toContain('name="username"');
    expect(html).toContain('type="password"');
    expect(html).toContain('name="domainApp"');
    expect(html).toContain('method="post"');
  });
  it('omits the creds section when only TLS is needed, and vice versa', () => {
    const tlsOnly = renderCredsForm({ needCreds: false, needTls: true });
    expect(tlsOnly).not.toContain('name="username"');
    expect(tlsOnly).toContain('name="domainApp"');
    const credsOnly = renderCredsForm({ needCreds: true, needTls: false });
    expect(credsOnly).toContain('name="username"');
    expect(credsOnly).not.toContain('name="domainApp"');
  });
  it('escapes the error and preserves the username, never a password', () => {
    const html = renderCredsForm({ needCreds: true, needTls: false, error: '<b>x</b>', username: 'me@ex.com' });
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('value="me@ex.com"');
    expect(html).not.toContain('name="password" value');
  });
});

describe('renderSecretsPage', () => {
  it('renders every secret with its label plus the ack form, escaped', () => {
    const html = renderSecretsPage([
      ['Admin key', 'k<script>'],
      ['GM password', 'gm-pass-1'],
    ]);
    expect(html).toContain('Admin key');
    expect(html).toContain('k&lt;script&gt;');
    expect(html).toContain('gm-pass-1');
    expect(html).toContain('action="ack"');
  });
});

describe('state pages', () => {
  it('progress page meta-refreshes and carries no secret-ish content', () => {
    const html = renderProgressPage();
    expect(html).toContain('http-equiv="refresh"');
  });
  it('done page meta-refreshes to the status URL', () => {
    expect(renderDonePage('http://192.168.1.20:8321/')).toContain('url=http://192.168.1.20:8321/');
  });
  it('failed page shows the exit code', () => {
    expect(renderFailedPage(7)).toContain('7');
  });
  it('already-shown and gone pages render', () => {
    expect(renderAlreadyShownPage()).toContain('already');
    expect(renderGonePage()).toContain('terminal');
  });
});
```

  and add to `apps/bootstrap/test/mjs.d.ts` (new block after the existing one; the `WizardHandle` parts are consumed by Task 3 — declare them now so the file is touched once):

```ts
declare module '*setup-wizard.mjs' {
  export function escapeHtml(s: string): string;
  export function tokenMatches(expected: string, presented: string): boolean;
  export function parseFormBody(body: string): Record<string, string>;
  export function renderShell(i: { title: string; body: string; head?: string }): string;
  export function renderCredsForm(i: {
    needCreds: boolean;
    needTls: boolean;
    error?: string | null;
    username?: string;
  }): string;
  export function renderSecretsPage(secrets: Array<[string, string]>): string;
  export function renderProgressPage(): string;
  export function renderDonePage(statusUrl: string): string;
  export function renderFailedPage(exitCode: number): string;
  export function renderAlreadyShownPage(): string;
  export function renderGonePage(): string;

  export interface WizardSubmission {
    creds: { username: string; password: string; licenseKey: string } | null;
    tls: { enabled: boolean; domainApp?: string; domainVtt?: string; acmeEmail?: string };
  }
  export interface WizardHandle {
    token: string;
    server: import('node:http').Server;
    submitted: Promise<'browser'>;
    acked: Promise<void>;
    listen(port: number, host?: string): Promise<number>;
    setPhase(phase: 'done' | 'failed', extra?: { exitCode?: number }): void;
    takeover(): void;
    waitForFinalPage(timeoutMs: number): Promise<boolean>;
    close(): void;
  }
  export function createWizard(opts: {
    token: string;
    needCreds: boolean;
    needTls: boolean;
    bgPath: string;
    statusUrl: string;
    onSubmit: (values: WizardSubmission) => Promise<Array<[string, string]>>;
  }): WizardHandle;
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @companion/bootstrap test -- setup-wizard`
Expected: FAIL — `Cannot find module '../../../scripts/setup-wizard.mjs'`.

- [ ] **Step 3: Implement the helpers + renderers** — create `scripts/setup-wizard.mjs` (NO shebang — see Global Constraints):

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @companion/bootstrap test -- setup-wizard`
Expected: PASS (all pure-function blocks green).

- [ ] **Step 5: Commit**

```bash
git add scripts/setup-wizard.mjs apps/bootstrap/test/setup-wizard.test.ts apps/bootstrap/test/mjs.d.ts
git commit -m "feat(setup): wizard page renderers + token/form helpers (Gilded Tome shell)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Wizard server + state machine (`createWizard`)

**Files:**
- Modify: `scripts/setup-wizard.mjs` (append the server half)
- Test: `apps/bootstrap/test/setup-wizard.test.ts` (append the server suite)

**Interfaces:**
- Consumes: Task 2's helpers/renderers (same file).
- Produces (Task 4's `main()` consumes — exact shape, already declared in `mjs.d.ts` by Task 2):
  - `createWizard({ token, needCreds, needTls, bgPath, statusUrl, onSubmit }) => WizardHandle`
  - `WizardHandle.listen(port, host?) => Promise<number>` — resolves the bound port, rejects on `EADDRINUSE`
  - `WizardHandle.submitted: Promise<'browser'>` — resolves the moment a *valid* form arrives (the CLI race uses this to cancel the terminal listener)
  - `WizardHandle.acked: Promise<void>` — operator confirmed the secrets page (auto-resolved when `onSubmit` returned `[]`)
  - `WizardHandle.setPhase('done' | 'failed', { exitCode? })`, `.takeover()`, `.waitForFinalPage(timeoutMs) => Promise<boolean>`, `.close()`
- State machine: `collecting → submitting → secrets-shown → composing → done | failed`, plus `gone` (terminal takeover). Backward transitions are refused; replays render the current-state page.

- [ ] **Step 1: Write the failing tests** — append to `apps/bootstrap/test/setup-wizard.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { createWizard, type WizardHandle, type WizardSubmission } from '../../../scripts/setup-wizard.mjs';

describe('createWizard (real server)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  interface Booted {
    w: WizardHandle;
    base: string; // http://127.0.0.1:<port>/s/<token>
    submissions: WizardSubmission[];
  }
  async function boot(opts?: {
    needCreds?: boolean;
    needTls?: boolean;
    secrets?: Array<[string, string]>;
  }): Promise<Booted> {
    const dir = mkdtempSync(join(tmpdir(), 'wiz-'));
    const bgPath = join(dir, 'bg.jpg');
    writeFileSync(bgPath, 'fake-jpeg-bytes', 'utf8');
    const submissions: WizardSubmission[] = [];
    const w = createWizard({
      token: 'tok-123',
      needCreds: opts?.needCreds ?? true,
      needTls: opts?.needTls ?? true,
      bgPath,
      statusUrl: 'http://192.168.1.20:8321/',
      onSubmit: async (v) => {
        submissions.push(v);
        return opts?.secrets ?? [['Admin key', 'sec-admin-1']];
      },
    });
    const port = await w.listen(0, '127.0.0.1');
    cleanups.push(() => {
      w.close();
      rmSync(dir, { recursive: true, force: true });
    });
    return { w, base: `http://127.0.0.1:${port}/s/tok-123`, submissions };
  }

  it('404s on a wrong or missing token, including bg.jpg', async () => {
    const { base } = await boot();
    const root = base.slice(0, base.lastIndexOf('/s/'));
    expect((await fetch(`${root}/`)).status).toBe(404);
    expect((await fetch(`${root}/s/wrong/`)).status).toBe(404);
    expect((await fetch(`${root}/s/wrong/bg.jpg`)).status).toBe(404);
  });

  it('serves the form and the background under the token path', async () => {
    const { base } = await boot();
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('name="username"');
    const bg = await fetch(`${base}/bg.jpg`);
    expect(bg.status).toBe(200);
    expect(bg.headers.get('content-type')).toBe('image/jpeg');
  });

  it('re-renders the form with an error on an invalid submit and stays collecting', async () => {
    const { base, submissions } = await boot();
    const res = await fetch(`${base}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=&password=',
    });
    const html = await res.text();
    expect(html).toContain('class="err"');
    expect(html).toContain('name="username"');
    expect(submissions).toHaveLength(0);
  });

  it('happy path: valid submit -> secrets page once -> ack -> progress -> done page', async () => {
    const { w, base, submissions } = await boot();
    const submit = await fetch(`${base}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=me%40ex.com&password=p%24w&licenseKey=',
    });
    const secretsHtml = await submit.text();
    expect(secretsHtml).toContain('sec-admin-1');
    expect(await w.submitted).toBe('browser');
    expect(submissions).toEqual([
      { creds: { username: 'me@ex.com', password: 'p$w', licenseKey: '' }, tls: { enabled: false } },
    ]);

    // replay after the once-only page: never the secret again
    const replay = await (await fetch(`${base}/`)).text();
    expect(replay).not.toContain('sec-admin-1');
    expect(replay).toContain('already');

    const ack = await fetch(`${base}/ack`, { method: 'POST', redirect: 'manual' });
    expect(ack.status).toBe(303);
    await w.acked;
    expect(await (await fetch(`${base}/`)).text()).toContain('refresh');

    w.setPhase('done');
    const finalP = w.waitForFinalPage(3000);
    const done = await (await fetch(`${base}/`)).text();
    expect(done).toContain('url=http://192.168.1.20:8321/');
    expect(await finalP).toBe(true);
  });

  it('parses the TLS section: checkbox on requires all three fields', async () => {
    const { base, submissions } = await boot();
    const bad = await fetch(`${base}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=u&password=p&tls=on&domainApp=app.ex.com&domainVtt=&acmeEmail=',
    });
    expect(await bad.text()).toContain('class="err"');
    expect(submissions).toHaveLength(0);

    await fetch(`${base}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=u&password=p&tls=on&domainApp=app.ex.com&domainVtt=vtt.ex.com&acmeEmail=e%40x.com',
    });
    expect(submissions).toEqual([
      {
        creds: { username: 'u', password: 'p', licenseKey: '' },
        tls: { enabled: true, domainApp: 'app.ex.com', domainVtt: 'vtt.ex.com', acmeEmail: 'e@x.com' },
      },
    ]);
  });

  it('skips the ack gate when onSubmit returns no secrets (TLS-only run)', async () => {
    const { w, base } = await boot({ needCreds: false, secrets: [] });
    const res = await fetch(`${base}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'tls=on&domainApp=a.ex.com&domainVtt=v.ex.com&acmeEmail=e%40x.com',
    });
    expect(await res.text()).toContain('refresh'); // straight to progress
    await w.acked; // auto-resolved
  });

  it('failed phase renders the exit code', async () => {
    const { w, base } = await boot();
    await fetch(`${base}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=u&password=p',
    });
    await fetch(`${base}/ack`, { method: 'POST', redirect: 'manual' });
    w.setPhase('failed', { exitCode: 7 });
    expect(await (await fetch(`${base}/`)).text()).toContain('7');
  });

  it('takeover(): pages go gone, submits are refused', async () => {
    const { w, base, submissions } = await boot();
    w.takeover();
    expect(await (await fetch(`${base}/`)).text()).toContain('terminal');
    await fetch(`${base}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=u&password=p',
    });
    expect(submissions).toHaveLength(0);
  });

  it('rejects an oversized body with 413', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `username=${'a'.repeat(70_000)}&password=p`,
    });
    expect(res.status).toBe(413);
  });

  it('listen() rejects when the port is taken', async () => {
    const a = await boot();
    const port = Number(new URL(a.base).port);
    const b = createWizard({
      token: 't2',
      needCreds: true,
      needTls: false,
      bgPath: a.base ? join(tmpdir(), 'nonexistent-not-read-until-listen.jpg') : '',
      statusUrl: 'http://x/',
      onSubmit: async () => [],
    });
    await expect(b.listen(port, '127.0.0.1')).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});
```

  Note: the last test's `bgPath` points at a nonexistent file — Step 3 therefore reads the background lazily on first request, not in `createWizard` (also keeps construction side-effect-free).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @companion/bootstrap test -- setup-wizard`
Expected: FAIL — `createWizard` is not exported.

- [ ] **Step 3: Implement `createWizard`** — append to `scripts/setup-wizard.mjs`:

```js
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
      if (state !== 'collecting') {
        html(res, pageForState());
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
      let body;
      try {
        body = await readBody(req, MAX_BODY_BYTES);
      } catch {
        return; // backstop path: socket already destroyed
      }
      const form = parseFormBody(body);
      const error = validateForm(form, { needCreds, needTls });
      if (error !== null) {
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
      return Promise.race([finalServed, new Promise((r) => setTimeout(() => r(false), timeoutMs))]);
    },
    close() {
      server.close();
      server.closeAllConnections?.();
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @companion/bootstrap test -- setup-wizard`
Expected: PASS — all pure-function AND server suites green.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup-wizard.mjs apps/bootstrap/test/setup-wizard.test.ts
git commit -m "feat(setup): wizard server + state machine (token gate, once-only secrets, ack-gated compose)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: CLI integration — collection seam, wizard race, async compose

**Files:**
- Modify: `scripts/setup-quickstart.mjs` (imports; new exported seam functions after `writeSecretIfAbsent`; `main()` collection + compose blocks rewritten)
- Modify: `apps/bootstrap/test/mjs.d.ts` (extend the `*setup-quickstart.mjs` block)
- Test: `apps/bootstrap/test/setup-cli.test.ts` (seam-function tests)

**Interfaces:**
- Consumes: `createWizard` from `./setup-wizard.mjs` (Task 3's exact `WizardHandle` shape).
- Produces (exported for tests; used only inside `main()` at runtime):
  - `writeSecretsBundle(creds: { username; password; licenseKey }, dirs?: { secrets: string }) => Array<[string, string]>` — writes the three secret files, returns the four labeled generated secrets
  - `writeEnvFiles(tls: { enabled: boolean; domainApp?; domainVtt?; acmeEmail? }, dirs?: { qdir: string }) => void`
- Behavior contract (spec): `--no-wizard` → today's flow exactly; wizard listen failure (e.g. `EADDRINUSE`) → warn + terminal fallback, never a failed setup; browser submit and terminal Enter race, first wins; wizard path runs compose via async `spawn` so the progress page can be served; secrets are printed to the terminal on BOTH paths.

- [ ] **Step 1: Write the failing tests** — append to `apps/bootstrap/test/setup-cli.test.ts` (the file already imports `mkdtempSync`, `rmSync`, `statSync`, `tmpdir`, `join`, `afterEach` and manages a `dirs` array with a `makeDir()` helper — reuse them; add `readFileSync`, `existsSync` to the `node:fs` import if absent):

```ts
import { writeSecretsBundle, writeEnvFiles } from '../../../scripts/setup-quickstart.mjs';

describe('writeSecretsBundle', () => {
  it('writes the three secret files and returns the four labeled secrets', () => {
    const dir = makeDir();
    const out = writeSecretsBundle(
      { username: 'me@ex.com', password: 'p$w', licenseKey: '' },
      { secrets: dir },
    );
    expect(out.map(([label]) => label)).toEqual([
      'Foundry admin key (setup screen)',
      'Gamemaster password (set this on the Gamemaster user in YOUR world)',
      'Relay account (bootstrap@companion.local)',
      'App admin console password (/admin)',
    ]);
    const cfg = JSON.parse(readFileSync(join(dir, 'foundry-config.json'), 'utf8'));
    expect(cfg.foundry_username).toBe('me@ex.com');
    expect(cfg.foundry_password).toBe('p$w');
    expect(cfg.foundry_license_key).toBeUndefined(); // blank key omitted
    const bootstrapEnv = readFileSync(join(dir, 'bootstrap.env'), 'utf8');
    expect(bootstrapEnv).toContain(`FOUNDRY_ADMIN_KEY=${cfg.foundry_admin_key}`);
    const gatewayEnv = readFileSync(join(dir, 'gateway.env'), 'utf8');
    expect(gatewayEnv).toContain(`ADMIN_PASSWORD=${out[3][1]}`);
  });

  it.skipIf(process.platform === 'win32')('writes every secret file with mode 0600', () => {
    const dir = makeDir();
    writeSecretsBundle({ username: 'u', password: 'p', licenseKey: 'LK' }, { secrets: dir });
    for (const f of ['foundry-config.json', 'bootstrap.env', 'gateway.env']) {
      expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps existing files (writeSecretIfAbsent semantics)', () => {
    const dir = makeDir();
    const first = writeSecretsBundle({ username: 'u', password: 'p', licenseKey: '' }, { secrets: dir });
    const before = readFileSync(join(dir, 'foundry-config.json'), 'utf8');
    writeSecretsBundle({ username: 'other', password: 'x', licenseKey: '' }, { secrets: dir });
    expect(readFileSync(join(dir, 'foundry-config.json'), 'utf8')).toBe(before);
    expect(first).toHaveLength(4);
  });
});

describe('writeEnvFiles', () => {
  it('writes only .env when TLS is off', () => {
    const dir = makeDir();
    writeEnvFiles({ enabled: false }, { qdir: dir });
    expect(readFileSync(join(dir, '.env'), 'utf8')).toContain('HOST_PORT_WEB=8080');
    expect(existsSync(join(dir, 'Caddyfile.tls'))).toBe(false);
  });

  it('writes .env with the tls profile plus Caddyfile.tls when enabled', () => {
    const dir = makeDir();
    writeEnvFiles(
      { enabled: true, domainApp: 'app.ex.com', domainVtt: 'vtt.ex.com', acmeEmail: 'e@x.com' },
      { qdir: dir },
    );
    expect(readFileSync(join(dir, '.env'), 'utf8')).toContain('COMPOSE_PROFILES=tls');
    const caddy = readFileSync(join(dir, 'Caddyfile.tls'), 'utf8');
    expect(caddy).toContain('app.ex.com');
    expect(caddy).toContain('e@x.com');
  });
});
```

  and extend the `declare module '*setup-quickstart.mjs'` block in `apps/bootstrap/test/mjs.d.ts`:

```ts
  export function writeSecretsBundle(
    creds: { username: string; password: string; licenseKey: string },
    dirs?: { secrets: string },
  ): Array<[string, string]>;
  export function writeEnvFiles(
    tls: { enabled: boolean; domainApp?: string; domainVtt?: string; acmeEmail?: string },
    dirs?: { qdir: string },
  ): void;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @companion/bootstrap test -- setup-cli`
Expected: FAIL — `writeSecretsBundle` / `writeEnvFiles` not exported.

- [ ] **Step 3: Add the seam functions** — in `scripts/setup-quickstart.mjs`, insert after `writeSecretIfAbsent` (line 109):

```js
/** Generate + write the three secret files (0600, keep-if-present) and
 *  return the four operator-facing generated secrets as [label, value]. */
export function writeSecretsBundle(creds, dirs = { secrets: SECRETS }) {
  const adminKey = generateSecret();
  writeSecretIfAbsent(
    join(dirs.secrets, 'foundry-config.json'),
    buildFoundryConfigJson({ username: creds.username, password: creds.password, licenseKey: creds.licenseKey, adminKey }),
  );
  const gmPassword = generateSecret();
  const relayPassword = generateSecret();
  writeSecretIfAbsent(
    join(dirs.secrets, 'bootstrap.env'),
    buildBootstrapEnv({
      relayEmail: 'bootstrap@companion.local',
      relayPassword,
      gmUser: 'Gamemaster',
      gmPassword,
      adminKey,
    }),
  );
  const adminPassword = generateSecret();
  writeSecretIfAbsent(join(dirs.secrets, 'gateway.env'), buildGatewayEnv({ adminPassword }));
  return [
    ['Foundry admin key (setup screen)', adminKey],
    ['Gamemaster password (set this on the Gamemaster user in YOUR world)', gmPassword],
    ['Relay account (bootstrap@companion.local)', relayPassword],
    ['App admin console password (/admin)', adminPassword],
  ];
}

/** Write .env (+ Caddyfile.tls when TLS is enabled). tls: {enabled, domainApp?, domainVtt?, acmeEmail?} */
export function writeEnvFiles(tls, dirs = { qdir: QDIR }) {
  if (tls.enabled) {
    writeFileSync(
      join(dirs.qdir, 'Caddyfile.tls'),
      buildTlsCaddyfile({ domainApp: tls.domainApp, domainVtt: tls.domainVtt, acmeEmail: tls.acmeEmail }),
      'utf8',
    );
  }
  writeFileSync(join(dirs.qdir, '.env'), buildDotEnv({ tls: tls.enabled }), 'utf8');
}

function printGeneratedSecrets(generated) {
  console.log('\n================ GENERATED SECRETS — SHOWN ONCE, WRITE THEM DOWN ================');
  for (const [label, value] of generated) console.log(`  ${label}:\n      ${value}`);
  console.log('==================================================================================\n');
}
```

- [ ] **Step 4: Run the seam tests to verify they pass**

Run: `pnpm --filter @companion/bootstrap test -- setup-cli`
Expected: PASS (new blocks green; existing blocks untouched and green).

- [ ] **Step 5: Rewrite `main()`'s collection and compose sections**

First update the imports at the top of `scripts/setup-quickstart.mjs`:

```js
import { spawn, spawnSync } from 'node:child_process';
import { createWizard } from './setup-wizard.mjs';
```

(`spawn` added; `createWizard` new; all other imports unchanged.)

Then replace everything in `main()` from `const generated = [];` (line 133) through the secrets-banner block ending `console.log('======…\n');` (line 181) with:

```js
    const needCreds = !existsSync(join(SECRETS, 'foundry-config.json'));
    const needTls = !existsSync(join(QDIR, '.env'));
    const ip = lanIp();
    let generated = [];
    let wizard = null;

    if (!needCreds) {
      console.log('secrets already present — keeping them (use `make setup-reset` to regenerate).');
    }

    // Ephemeral web wizard (spec Phase 2, Approach A): hosted in THIS process,
    // so it dies with the CLI — one-time token + auto-disable are structural.
    // Raced against terminal-Enter; --no-wizard or a failed listen (port in
    // use) falls back to the terminal prompts. Never expose it when there is
    // nothing to collect.
    if ((needCreds || needTls) && !args.includes('--no-wizard')) {
      const w = createWizard({
        token: generateSecret(),
        needCreds,
        needTls,
        bgPath: join(REPO_ROOT, 'scripts', 'assets', 'unseen-servant.jpg'),
        statusUrl: `http://${ip}:8321/`,
        onSubmit: async ({ creds, tls }) => {
          if (creds !== null) generated = writeSecretsBundle(creds);
          if (needTls) writeEnvFiles(tls);
          if (generated.length > 0) printGeneratedSecrets(generated); // terminal backup, both paths
          return generated;
        },
      });
      try {
        await w.listen(8322, '0.0.0.0');
        wizard = w;
      } catch (err) {
        console.error(`wizard could not start (${err.code ?? err.message}) — using terminal prompts.`);
      }
    }

    if (wizard !== null) {
      console.log(`\nOpen  http://${ip}:8322/s/${wizard.token}/  in a browser on your network`);
      console.log('to finish setup — or press Enter here to use terminal prompts instead.');
      console.log('(remote server? tunnel first:  ssh -L 8322:localhost:8322 <host>)');
      const ac = new AbortController();
      const enter = rl.question('', { signal: ac.signal }).then(
        () => 'terminal',
        () => 'aborted', // AbortError when the browser wins
      );
      const winner = await Promise.race([wizard.submitted, enter]);
      if (winner === 'terminal') {
        wizard.takeover();
        wizard.close();
        wizard = null;
      } else {
        ac.abort();
      }
    }

    if (wizard === null && (needCreds || needTls)) {
      if (needCreds) {
        console.log('foundryvtt.com credentials (used by the container to download Foundry):');
        const username = (await rl.question('  foundry.com username/email: ')).trim();
        const password = await rl.question('  foundry.com password (input is visible): ');
        const licenseKey = (await rl.question('  license key (Enter = fetch from the account): ')).trim();
        generated = writeSecretsBundle({ username, password, licenseKey });
      }
      if (needTls) {
        const wantTls = (await rl.question('Enable HTTPS on your own domain? [y/N] ')).trim().toLowerCase() === 'y';
        const tls = { enabled: wantTls };
        if (wantTls) {
          tls.domainApp = (await rl.question('  app domain (e.g. app.example.com): ')).trim();
          tls.domainVtt = (await rl.question('  foundry domain (e.g. vtt.example.com): ')).trim();
          tls.acmeEmail = (await rl.question("  email for Let's Encrypt: ")).trim();
        }
        writeEnvFiles(tls);
      }
      if (generated.length > 0) printGeneratedSecrets(generated);
    }
```

(The old `if (!existsSync(join(SECRETS, 'foundry-config.json'))) { … } else { … }` block, the old `.env` block, and the old inline secrets banner are all subsumed — delete them.)

Then replace the compose tail (from `if (args.includes('--no-up')) return;` through `process.exitCode = up.status ?? 1;`, currently lines 206-214) with:

```js
    if (args.includes('--no-up')) {
      wizard?.close();
      return;
    }
    if (compose === null) {
      console.error('no container runtime found — install docker (with compose v2) or podman.');
      process.exitCode = 1;
      wizard?.close();
      return;
    }
    console.log(`\nrunning: ${compose.join(' ')} up -d --build   (in stack/quickstart)`);
    if (wizard !== null) {
      // Browser path: the "I've written these down" click gates compose, and
      // compose runs async so the wizard can keep serving the progress page.
      await wizard.acked;
      const code = await new Promise((resolve) => {
        const child = spawn(compose[0], [...compose.slice(1), 'up', '-d', '--build'], { cwd: QDIR, stdio: 'inherit' });
        child.on('close', (c) => resolve(c ?? 1));
        child.on('error', () => resolve(1));
      });
      wizard.setPhase(code === 0 ? 'done' : 'failed', { exitCode: code });
      process.exitCode = code;
      await wizard.waitForFinalPage(30_000); // bounded — let the browser land on the redirect page
      wizard.close();
      wizard = null;
    } else {
      const up = spawnSync(compose[0], [...compose.slice(1), 'up', '-d', '--build'], { cwd: QDIR, stdio: 'inherit' });
      process.exitCode = up.status ?? 1;
    }
```

Finally, harden the `finally` block (line 215-217) so Ctrl-C/errors always tear the wizard down — `wizard` must be declared where `finally` can see it, so ALSO move its declaration: delete `let wizard = null;` from the collection block above and place it next to `const rl = createInterface(…)` before the `try`:

```js
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let wizard = null;
  try {
```

```js
  } finally {
    rl.close();
    wizard?.close();
  }
```

- [ ] **Step 6: Run the full bootstrap suite + typecheck**

Run: `pnpm --filter @companion/bootstrap test && pnpm typecheck`
Expected: PASS / clean. (The `main()` rewrite has no unit tests by established convention — `main()` is not unit-tested; the seam functions and the wizard server are.)

- [ ] **Step 7: Smoke-test both paths by hand (no containers needed)**

```bash
cd /f/private/foundry-comanion
node scripts/setup-quickstart.mjs --no-up
```

Expected: prints the `Open http://<ip>:8322/s/<token>/` line. Open the URL in a browser — the Gilded Tome form renders over the artwork. Press Ctrl+C (don't submit — this dev box must not get real secrets written… note `--no-up` still writes files on submit, so just LOOK, then abort). Then:

```bash
node scripts/setup-quickstart.mjs --no-up --no-wizard
```

Expected: goes straight to `foundry.com username/email:` prompt; Ctrl+C out.

- [ ] **Step 8: Commit**

```bash
git add scripts/setup-quickstart.mjs apps/bootstrap/test/setup-cli.test.ts apps/bootstrap/test/mjs.d.ts
git commit -m "feat(setup): make setup launches the web wizard, raced with terminal prompts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Docs + full verification

**Files:**
- Modify: `docs/HOSTING.md` (Part C — the `make setup` description)
- Modify: `Makefile` (comment only)

**Interfaces:** none (docs/verification task).

- [ ] **Step 1: Document the wizard in HOSTING.md Part C**

Locate the Part C paragraph that describes what `make setup` prompts for (near the line "(`Makefile` just runs `node scripts/setup-quickstart.mjs`.) It prompts for the …", `docs/HOSTING.md:405`). Insert this subsection immediately after that paragraph:

```markdown
#### The setup wizard (default) vs terminal prompts

`make setup` starts an **ephemeral web wizard** on port **8322** and prints a
one-time URL (`http://<lan-ip>:8322/s/<token>/`). Open it in a browser on your
network: enter the foundry.com credentials (password input is masked, unlike
the terminal), optionally enable HTTPS, write down the generated secrets shown
**once**, and the page follows `compose up` and then forwards to the status
page (`:8321`). The wizard lives only inside the `make setup` process — when
setup ends, the server is gone; there is nothing to disable.

- Prefer the terminal? Press **Enter** at the prompt instead of opening the
  URL, or run `node scripts/setup-quickstart.mjs --no-wizard`.
- **Remote server (VPS)?** Do not open port 8322 to the internet — tunnel it:
  `ssh -L 8322:localhost:8322 <host>`, then open
  `http://localhost:8322/s/<token>/`.
- The generated secrets are also printed to the terminal on both paths.
- If port 8322 is taken, setup falls back to terminal prompts by itself.
```

- [ ] **Step 2: Update the Makefile comment**

Replace the current `Makefile` content's first lines so the file reads:

```makefile
.PHONY: setup setup-reset

# Interactive first-run setup: starts an ephemeral web wizard on :8322 (see
# docs/HOSTING.md Part C) raced against terminal prompts; writes quickstart
# config/secrets and runs compose up. Flags: --no-wizard, --no-up, --reset.
setup:
	node scripts/setup-quickstart.mjs

setup-reset:
	node scripts/setup-quickstart.mjs --reset
```

- [ ] **Step 3: Full-repo verification**

Run: `pnpm -r test && pnpm typecheck`
Expected: every package green, typecheck clean.

- [ ] **Step 4: Grep for leftovers**

Run: `git grep -n "8322" -- docs scripts Makefile` — expect hits in HOSTING.md, setup-quickstart.mjs, Makefile only.
Run: `head -c 3 scripts/setup-wizard.mjs` — expect `/**` (no shebang crept in).

- [ ] **Step 5: Commit**

```bash
git add docs/HOSTING.md Makefile
git commit -m "docs: setup wizard flow (port 8322, VPS tunnel guidance)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Post-implementation

- [ ] Whole-branch review (code-review skill) before push.
- [ ] Push `feat/setup-wizard`; note it is based on `fix/setup-cli-shebang-vitest` (PR #2) — merge PR #2 first, then this (or rebase onto main after #2 lands).
- [ ] Live verification on the Foundry host is optional for this feature (the wizard only changes *collection*; the written files are byte-identical to the terminal path — the seam tests prove it).

## Self-review

- **Spec coverage:** operator flow (Task 3 server + Task 4 race/compose), security model (Task 3 token gate/404/body-cap; structural auto-disable via Task 4 close-paths), visual design + asset pipeline (Tasks 1-2), code structure (matches spec's create/modify table), error handling (compose-fail page Task 3/4, port-conflict fallback Task 4, malformed POST Task 3, abandoned browser via terminal race Task 4), testing (pure + real-server + seam suites), docs (Task 5). Out-of-scope items untouched.
- **Placeholder scan:** none — every step carries exact code/commands.
- **Type consistency:** `WizardHandle`/`WizardSubmission` in `mjs.d.ts` (Task 2) match `createWizard`'s runtime shape (Task 3) and `main()`'s usage (Task 4); `writeSecretsBundle`/`writeEnvFiles` signatures match across Task 4's test, implementation, and d.ts.
- **Known sequencing note:** Task 2 declares the Task-3 types in `mjs.d.ts` so the file is edited once; the Task 2 test file compiles because the type-only imports land in Task 3's test half.
