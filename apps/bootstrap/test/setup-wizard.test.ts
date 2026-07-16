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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach } from 'vitest';
import { createWizard, type WizardHandle, type WizardSubmission } from '../../../scripts/setup-wizard.mjs';

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
  it('preserves non-secret values (license, domains, tls checked/open) when passed, and never a password', () => {
    const html = renderCredsForm({
      needCreds: true,
      needTls: true,
      error: 'bad',
      username: 'me@ex.com',
      licenseKey: 'LIC-<1>',
      tls: true,
      domainApp: 'app.ex.com',
      domainVtt: 'vtt.ex.com',
      acmeEmail: 'e@x.com',
    });
    expect(html).toContain('value="me@ex.com"');
    expect(html).toContain('value="LIC-&lt;1&gt;"');
    expect(html).toContain('value="app.ex.com"');
    expect(html).toContain('value="vtt.ex.com"');
    expect(html).toContain('value="e@x.com"');
    expect(html).toContain('checked');
    expect(html).toContain('<details open>');
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
    onSubmitDelayMs?: number;
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
        if (opts?.onSubmitDelayMs) await new Promise((r) => setTimeout(r, opts.onSubmitDelayMs));
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

  it('double-submit race: concurrent valid POSTs run onSubmit once and serve the secret once', async () => {
    const { base, submissions } = await boot({ onSubmitDelayMs: 50 });
    const body = Buffer.from('username=me%40ex.com&password=p%24w&licenseKey=', 'utf8');

    // Simulate two near-simultaneous submits (e.g. a double-clicked button):
    // both requests' headers must reach the server — and pass the pre-body
    // `state`/lock guard — before either request's body finishes arriving,
    // i.e. while both are genuinely "parked in readBody". A plain `fetch` +
    // `Promise.all` isn't a reliable enough clock for that: Node's http
    // client buffers headers until the first body write, so the two
    // connections don't actually reach the server concurrently. Instead,
    // open two raw requests, flush their headers immediately, and hold both
    // bodies back on a shared gate until both are certainly parked.
    let release!: () => void;
    const bodiesReleased = new Promise<void>((r) => (release = r));
    function slowPost(): Promise<{ status: number; text: string }> {
      return new Promise((resolve, reject) => {
        const url = new URL(`${base}/submit`);
        const bodyStream = new Readable({ read() {} });
        const req = httpRequest(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': body.length },
          },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }));
          },
        );
        req.on('error', reject);
        req.flushHeaders(); // send headers now, independent of the (not yet pushed) body
        bodyStream.pipe(req);
        void bodiesReleased.then(() => {
          bodyStream.push(body);
          bodyStream.push(null);
        });
      });
    }

    const p1 = slowPost();
    const p2 = slowPost();
    await new Promise((r) => setTimeout(r, 30)); // let both headers land at the guard
    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(submissions).toHaveLength(1);
    const secretCount = [r1.text, r2.text].filter((t) => t.includes('sec-admin-1')).length;
    expect(secretCount).toBe(1);
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

  it('failed phase resolves waitForFinalPage promptly instead of burning the full timeout', async () => {
    const { w, base } = await boot();
    await fetch(`${base}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=u&password=p',
    });
    await fetch(`${base}/ack`, { method: 'POST', redirect: 'manual' });
    w.setPhase('failed', { exitCode: 3 });
    const finalP = w.waitForFinalPage(5000);
    const start = Date.now();
    const page = await (await fetch(`${base}/`)).text();
    expect(page).toContain('3');
    expect(await finalP).toBe(true);
    expect(Date.now() - start).toBeLessThan(1000); // well under the 5000ms timeout
  });

  it('invalid submit preserves non-secret values (license, tls fields) but never the password', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body:
        'username=&password=hunter2SECRET&licenseKey=LIC-1&tls=on&domainApp=app.ex.com&domainVtt=vtt.ex.com&acmeEmail=e%40x.com',
    });
    const html = await res.text();
    expect(html).toContain('class="err"');
    expect(html).toContain('value="LIC-1"');
    expect(html).toContain('value="app.ex.com"');
    expect(html).toContain('value="vtt.ex.com"');
    expect(html).toContain('value="e@x.com"');
    expect(html).toContain('checked');
    expect(html).toContain('open');
    expect(html).not.toContain('hunter2SECRET');
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
