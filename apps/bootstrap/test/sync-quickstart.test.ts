import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IMAGE_FOR_DOCKERFILE,
  PUBLIC_FILES,
  assemblePublicRepo,
  rewriteComposeToImages,
  stripPrivateOnly,
} from '../../../distribution/sync-quickstart.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const realCompose = () => readFileSync(join(REPO_ROOT, 'stack', 'quickstart', 'docker-compose.yml'), 'utf8');

const dirs: string[] = [];
function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'public-tree-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('stripPrivateOnly', () => {
  it('removes marked regions including the marker lines', () => {
    const text = 'a\n# PRIVATE-ONLY-BEGIN\nsecret\n# PRIVATE-ONLY-END\nb';
    expect(stripPrivateOnly(text)).toBe('a\nb');
  });

  it('throws on unbalanced markers', () => {
    expect(() => stripPrivateOnly('# PRIVATE-ONLY-BEGIN\nx')).toThrow(/unbalanced/);
    expect(() => stripPrivateOnly('x\n# PRIVATE-ONLY-END')).toThrow(/unbalanced/);
  });
});

describe('rewriteComposeToImages (against the real quickstart compose)', () => {
  it('replaces every build: block with a pinned ghcr image', () => {
    const out = rewriteComposeToImages(realCompose(), 'v0.1.0');
    expect(out).not.toMatch(/^\s+build:/m);
    expect(out).toContain('image: ghcr.io/tenezill/unseen-servant-gateway:v0.1.0');
    expect(out).toContain('image: ghcr.io/tenezill/unseen-servant-bootstrap:v0.1.0');
    // web AND web-tls both build the web image → two occurrences
    const webRefs = out.match(/image: ghcr\.io\/tenezill\/unseen-servant-web:v0\.1\.0/g);
    expect(webRefs).toHaveLength(2);
  });

  it('strips private-only regions (no personal LAN wiring in public output)', () => {
    const out = rewriteComposeToImages(realCompose(), 'v0.1.0');
    expect(out).not.toContain('evilwizard');
    expect(out).not.toContain('PRIVATE-ONLY');
  });

  it('keeps third-party images untouched', () => {
    const out = rewriteComposeToImages(realCompose(), 'v0.1.0');
    expect(out).toContain('felddy/foundryvtt:14.364.0');
    expect(out).toContain('threehats/foundryvtt-rest-api-relay:3.4.1');
  });

  it('rejects a malformed version', () => {
    expect(() => rewriteComposeToImages(realCompose(), 'latest')).toThrow(/version/);
    expect(() => rewriteComposeToImages(realCompose(), '0.1.0')).toThrow(/version/);
  });

  it('throws if a build: block survives (unknown context/dockerfile shape)', () => {
    const rogue = 'services:\n  x:\n    build:\n      context: .\n      dockerfile: Dockerfile.other\n';
    expect(() => rewriteComposeToImages(rogue, 'v0.1.0')).toThrow(/build/);
  });
});

describe('assemblePublicRepo (against the real repo)', () => {
  it('produces the complete flat public tree', () => {
    const outDir = makeDir();
    assemblePublicRepo({ repoRoot: REPO_ROOT, outDir, version: 'v0.1.0' });
    for (const f of [
      'docker-compose.yml',
      'Caddyfile',
      'Caddyfile.tls.example',
      'Makefile',
      'README.md',
      'LICENSE',
      '.gitignore',
      'scripts/setup-quickstart.mjs',
      'scripts/setup-wizard.mjs',
      'scripts/update-stack.mjs',
      'scripts/assets/unseen-servant.jpg',
    ]) {
      expect(existsSync(join(outDir, f)), `missing ${f}`).toBe(true);
    }
    const compose = readFileSync(join(outDir, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('image: ghcr.io/tenezill/unseen-servant-gateway:v0.1.0');
    expect(compose).not.toMatch(/^\s+build:/m);
  });

  it('every manifest source file exists in the repo (catches manifest drift)', () => {
    for (const [src] of PUBLIC_FILES) {
      expect(existsSync(join(REPO_ROOT, src)), `manifest source missing: ${src}`).toBe(true);
    }
  });

  it('covers all three first-party images', () => {
    expect(Object.values(IMAGE_FOR_DOCKERFILE).sort()).toEqual([
      'ghcr.io/tenezill/unseen-servant-bootstrap',
      'ghcr.io/tenezill/unseen-servant-gateway',
      'ghcr.io/tenezill/unseen-servant-web',
    ]);
  });
});
