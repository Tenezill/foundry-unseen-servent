import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildBootstrapEnv,
  buildDotEnv,
  buildFoundryConfigJson,
  buildGatewayEnv,
  buildPodmanComposeOverride,
  buildTlsCaddyfile,
  detectComposeCommand,
  generateSecret,
  isPodmanRuntime,
  PODMAN_OVERRIDE_MARKER,
  QUICKSTART_BIND_DIRS,
  writeEnvFiles,
  writeSecretIfAbsent,
  writeSecretsBundle,
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

describe('isPodmanRuntime', () => {
  it('is true for podman runtimes, false for docker/null', () => {
    expect(isPodmanRuntime(['docker', 'compose'])).toBe(false);
    expect(isPodmanRuntime(['podman', 'compose'])).toBe(true);
    expect(isPodmanRuntime(['podman-compose'])).toBe(true);
    expect(isPodmanRuntime(null)).toBe(false);
  });
});

describe('buildPodmanComposeOverride', () => {
  it('starts with the marker and applies keep-id to foundry ONLY', () => {
    const out = buildPodmanComposeOverride();
    expect(out.startsWith(PODMAN_OVERRIDE_MARKER)).toBe(true);
    expect(out).toContain('foundry:');
    expect(out).toContain('userns_mode: "keep-id"');
    // never apply keep-id to root-running services
    expect(out).not.toContain('relay:');
    expect(out).not.toContain('gateway:');
    expect(out).not.toContain('web:');
    expect(out).not.toContain('bootstrap:');
  });
});

describe('QUICKSTART_BIND_DIRS', () => {
  it('is the expected set of five data dirs', () => {
    expect([...QUICKSTART_BIND_DIRS].sort()).toEqual([
      'caddy-data',
      'companion-runtime',
      'foundry_data',
      'gateway-data',
      'relay-data',
    ]);
  });

  it('covers every directory bind-mount source in the quickstart compose (drift guard)', () => {
    // rootless Podman (crun) will not auto-create bind-mount source dirs, so the
    // list must stay complete. Extract "- ./<src>:" sources, drop file mounts
    // (Caddyfile*, secrets/*), and assert the remaining dirs match the list.
    const compose = readFileSync(new URL('../../../stack/quickstart/docker-compose.yml', import.meta.url), 'utf8');
    const sources = [...compose.matchAll(/-\s*\.\/([^:\n]+):/g)]
      .map((m) => m[1])
      .filter((s): s is string => s !== undefined);
    const dirTops = new Set(
      sources
        .map((s) => s.split('/')[0] ?? '')
        .filter((s) => s !== '' && s !== 'secrets' && !s.startsWith('Caddyfile')),
    );
    expect([...dirTops].sort()).toEqual([...QUICKSTART_BIND_DIRS].sort());
  });
});

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
    expect(gatewayEnv).toContain(`ADMIN_PASSWORD=${out[3]?.[1]}`);
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
