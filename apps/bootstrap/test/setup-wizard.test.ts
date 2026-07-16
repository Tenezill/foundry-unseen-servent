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
