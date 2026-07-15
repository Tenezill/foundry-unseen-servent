import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildBootstrapEnv,
  buildDotEnv,
  buildFoundryConfigJson,
  buildGatewayEnv,
  buildTlsCaddyfile,
  detectComposeCommand,
  generateSecret,
  writeSecretIfAbsent,
} from '../../../scripts/setup-quickstart.mjs';

const dirs: string[] = [];
function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'setup-cli-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('generateSecret', () => {
  it('is base64url (symbol-safe: no $, no quotes, no spaces) and long enough', () => {
    for (let i = 0; i < 50; i++) {
      const s = generateSecret();
      expect(s).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    }
  });
});

describe('file builders', () => {
  it('buildFoundryConfigJson emits exactly the felddy secret keys', () => {
    const json = JSON.parse(
      buildFoundryConfigJson({ username: 'u@x.y', password: 'p$w', licenseKey: 'L-1', adminKey: 'A-1' }),
    );
    expect(json).toEqual({
      foundry_username: 'u@x.y',
      foundry_password: 'p$w',
      foundry_license_key: 'L-1',
      foundry_admin_key: 'A-1',
    });
  });

  it('buildFoundryConfigJson omits the license key when empty (felddy fetches it from the account)', () => {
    const json = JSON.parse(buildFoundryConfigJson({ username: 'u', password: 'p', licenseKey: '', adminKey: 'a' }));
    expect(json.foundry_license_key).toBeUndefined();
  });

  it('buildBootstrapEnv emits the exact sidecar env contract', () => {
    expect(
      buildBootstrapEnv({ relayEmail: 'b@c.local', relayPassword: 'rp', gmUser: 'Gamemaster', gmPassword: 'gp', adminKey: 'ak' }),
    ).toBe(
      'RELAY_ACCOUNT_EMAIL=b@c.local\nRELAY_ACCOUNT_PASSWORD=rp\nFOUNDRY_GM_USER=Gamemaster\nFOUNDRY_GM_PASSWORD=gp\nFOUNDRY_ADMIN_KEY=ak\n',
    );
  });

  it('buildGatewayEnv emits ADMIN_PASSWORD', () => {
    expect(buildGatewayEnv({ adminPassword: 'ap' })).toBe('ADMIN_PASSWORD=ap\n');
  });

  it('buildDotEnv: HTTP default vs TLS profile', () => {
    expect(buildDotEnv({ tls: false })).toBe(
      'HOST_PORT_WEB=8080\nHOST_PORT_FOUNDRY=30000\nHOST_PORT_RELAY=3010\nHOST_PORT_STATUS=8321\n',
    );
    expect(buildDotEnv({ tls: true })).toBe(
      'HOST_PORT_WEB=8080\nHOST_PORT_FOUNDRY=30000\nHOST_PORT_RELAY=3010\nHOST_PORT_STATUS=8321\nCOMPOSE_PROFILES=tls\nFOUNDRY_PROXY_SSL=true\nFOUNDRY_PROXY_PORT=443\n',
    );
  });

  it('buildTlsCaddyfile replaces all three placeholders', () => {
    const out = buildTlsCaddyfile({ domainApp: 'app.ex.com', domainVtt: 'vtt.ex.com', acmeEmail: 'ops@ex.com' });
    expect(out).toContain('app.ex.com {');
    expect(out).toContain('vtt.ex.com {');
    expect(out).toContain('email ops@ex.com');
    expect(out).not.toContain('{{');
  });
});

describe('detectComposeCommand', () => {
  it('prefers docker compose, falls back to podman compose, then podman-compose, else null', () => {
    const ok = { status: 0 };
    const nope = { status: 1 };
    expect(detectComposeCommand(() => ok)).toEqual(['docker', 'compose']);
    expect(detectComposeCommand((cmd) => (cmd === 'docker' ? nope : ok))).toEqual(['podman', 'compose']);
    expect(detectComposeCommand((cmd) => (cmd === 'podman-compose' ? ok : nope))).toEqual(['podman-compose']);
    expect(detectComposeCommand(() => nope)).toBeNull();
  });
});

describe('writeSecretIfAbsent', () => {
  it.skipIf(process.platform === 'win32')('sets mode 0600 and is idempotent', () => {
    const f = join(makeDir(), 'test-secret.env');
    expect(writeSecretIfAbsent(f, 'SECRET_VALUE=abc123\n')).toBe(true);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(writeSecretIfAbsent(f, 'SHOULD_NOT_OVERWRITE=xyz\n')).toBe(false);
  });
});
