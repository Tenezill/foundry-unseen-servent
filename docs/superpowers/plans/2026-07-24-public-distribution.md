# Public Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the three first-party images to GHCR on version tags and sync a self-contained public quickstart repo, so anyone can install the stack without access to the private source repo.

**Architecture:** A GitHub Actions workflow in the private repo (`Tenezill/foundry-unseen-servent`) builds/pushes multi-arch images on `v*` tags, then runs a tested transform script that assembles the public repo tree (quickstart compose with `build:` → pinned `image:`, wizard/updater scripts, docs, licenses) and force-syncs it to `Tenezill/unseen-servant`. The private repo keeps `build:` blocks so existing private-clone deployments and `make update` are untouched.

**Tech Stack:** Node 22 (plain `.mjs`, no shebangs — see memory note below), vitest (tests live in `apps/bootstrap/test/`), GitHub Actions, docker buildx/QEMU, GHCR.

**Spec:** `docs/superpowers/specs/2026-07-23-public-distribution-design.md`

## Global Constraints

- Image names (exact, lowercase): `ghcr.io/tenezill/unseen-servant-gateway`, `ghcr.io/tenezill/unseen-servant-web`, `ghcr.io/tenezill/unseen-servant-bootstrap`.
- Image tags per release: the exact git tag (e.g. `v0.1.0`) **and** `latest`. Platforms: `linux/amd64,linux/arm64`.
- Public repo: `Tenezill/unseen-servant` (MIT). Private repo stays source of truth; public tree is generated.
- The private repo's `stack/quickstart/docker-compose.yml` KEEPS its `build:` blocks — existing deployments and `make update` must behave exactly as today.
- `.mjs` files must NOT have a `#!` shebang (breaks vitest import — see `docs/` memory; `update-stack.mjs:14` documents this).
- Script unit tests go in `apps/bootstrap/test/*.test.ts` (existing convention: they import `../../../scripts/*.mjs`). Run with `pnpm -C apps/bootstrap test`.
- Version strings passed to the transform must match `/^v\d+\.\d+\.\d+$/`.
- Work on feature branch `feat/public-distribution` in the main checkout (no worktree — the live stack and node_modules live here).

---

### Task 1: EULA, THIRD-PARTY-LICENSES generator, embed in images

**Files:**
- Create: `licence/EULA.md`
- Create: `scripts/generate-third-party-licenses.mjs`
- Create: `licence/THIRD-PARTY-LICENSES.md` (generated, committed)
- Modify: `Makefile` (add `licenses` target)
- Modify: `apps/gateway/Dockerfile`, `apps/web/Dockerfile`, `apps/bootstrap/Dockerfile` (COPY the two licence files)
- Test: `apps/bootstrap/test/third-party-licenses.test.ts`

**Interfaces:**
- Produces: `formatThirdPartyLicenses(byLicense: Record<string, {name, versions?, homepage?}[]>): string` exported from `scripts/generate-third-party-licenses.mjs`; committed file `licence/THIRD-PARTY-LICENSES.md`; `make licenses` regenerates it.
- Consumed by: Task 5's release checklist and all three Dockerfiles (`COPY licence/EULA.md licence/THIRD-PARTY-LICENSES.md /licence/`).

- [ ] **Step 1: Write the failing test**

Create `apps/bootstrap/test/third-party-licenses.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { formatThirdPartyLicenses } from '../../../scripts/generate-third-party-licenses.mjs';

describe('formatThirdPartyLicenses', () => {
  const fixture = {
    MIT: [
      { name: 'zod', versions: ['3.24.1'], homepage: 'https://zod.dev' },
      { name: 'h3', versions: ['1.13.0'] },
    ],
    'Apache-2.0': [{ name: 'fuse.js', versions: ['7.0.0'] }],
  };

  it('renders one section per license with each package listed', () => {
    const md = formatThirdPartyLicenses(fixture);
    expect(md).toContain('# Third-party licenses');
    expect(md).toContain('## MIT');
    expect(md).toContain('## Apache-2.0');
    expect(md).toContain('- zod (3.24.1) — https://zod.dev');
    expect(md).toContain('- h3 (1.13.0)');
    expect(md).toContain('- fuse.js (7.0.0)');
  });

  it('sorts license sections alphabetically (stable output = clean git diffs)', () => {
    const md = formatThirdPartyLicenses(fixture);
    expect(md.indexOf('## Apache-2.0')).toBeLessThan(md.indexOf('## MIT'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C apps/bootstrap test third-party-licenses`
Expected: FAIL — cannot resolve `../../../scripts/generate-third-party-licenses.mjs`.

- [ ] **Step 3: Write the generator**

Create `scripts/generate-third-party-licenses.mjs` (NO shebang line):

```javascript
/**
 * Generates licence/THIRD-PARTY-LICENSES.md from `pnpm licenses list --prod
 * --json` — the attribution file shipped inside every published image (spec
 * §4). Regenerate with `make licenses` whenever prod dependencies change;
 * the file is committed so Dockerfile COPYs never depend on CI state.
 * (No shebang on purpose — a `#!` line breaks vitest's .mjs import.)
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {Record<string, {name: string, versions?: string[], homepage?: string}[]>} byLicense
 * @returns {string} markdown
 */
export function formatThirdPartyLicenses(byLicense) {
  const lines = [
    '# Third-party licenses',
    '',
    'Unseen Servant bundles the following third-party packages. Each is used',
    'under its own license; the full license text of every package ships in',
    'its directory inside the image (node_modules/<name>/LICENSE*).',
    '',
  ];
  for (const license of Object.keys(byLicense).sort()) {
    lines.push(`## ${license}`, '');
    for (const p of byLicense[license]) {
      const versions = Array.isArray(p.versions) && p.versions.length ? ` (${p.versions.join(', ')})` : '';
      const homepage = p.homepage ? ` — ${p.homepage}` : '';
      lines.push(`- ${p.name}${versions}${homepage}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function main() {
  const r = spawnSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32', // pnpm is pnpm.cmd on Windows
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    console.error(r.stderr || 'pnpm licenses failed');
    process.exit(r.status ?? 1);
  }
  const out = join(REPO_ROOT, 'licence', 'THIRD-PARTY-LICENSES.md');
  writeFileSync(out, formatThirdPartyLicenses(JSON.parse(r.stdout)), 'utf8');
  console.log(`wrote ${out}`);
}

// Run only when invoked directly, never when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C apps/bootstrap test third-party-licenses`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the EULA**

Create `licence/EULA.md`:

```markdown
# Unseen Servant — End User License Agreement

Copyright (c) 2026 Sebastian Ramsauer. All rights reserved.

This software (the app and its published container images) is provided free
of charge.

You MAY:

- run the software for personal or commercial use;
- make copies as needed to operate it (pulling images, backups).

You may NOT:

- redistribute, resell, sublicense, or rehost the software or its images;
- modify, reverse-engineer, or create derivative works of the software,
  except where applicable law expressly permits it;
- remove or alter copyright or license notices.

Third-party components bundled with this software remain under their own
licenses — see THIRD-PARTY-LICENSES.md.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHOR BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OF THE SOFTWARE.
```

- [ ] **Step 6: Add the Makefile target and generate the committed file**

In `Makefile`, change line 1 and append the target:

```makefile
.PHONY: setup setup-reset update licenses
```

```makefile
# Regenerate licence/THIRD-PARTY-LICENSES.md (committed; shipped in images).
# Run whenever production dependencies change, and before tagging a release.
licenses:
	node scripts/generate-third-party-licenses.mjs
```

Run: `make licenses` (or `node scripts/generate-third-party-licenses.mjs`)
Expected: `wrote .../licence/THIRD-PARTY-LICENSES.md`; spot-check the file contains `## MIT` and `- fuse.js`.

- [ ] **Step 7: Embed both files in the three images**

In `apps/gateway/Dockerfile`, after line 27 (`COPY packages ./packages`) add:

```dockerfile
COPY licence/EULA.md licence/THIRD-PARTY-LICENSES.md /licence/
```

In `apps/web/Dockerfile`, after line 21 (`COPY --from=build /repo/apps/web/.output/public /srv/app`) add:

```dockerfile
COPY licence/EULA.md licence/THIRD-PARTY-LICENSES.md /licence/
```

In `apps/bootstrap/Dockerfile`, after line 22 (`COPY apps/bootstrap ./apps/bootstrap`) add:

```dockerfile
COPY licence/EULA.md licence/THIRD-PARTY-LICENSES.md /licence/
```

- [ ] **Step 8: Verify the images still build**

Run (from repo root):

```bash
docker build -f apps/gateway/Dockerfile -t licence-check-gateway . && docker run --rm --entrypoint cat licence-check-gateway /licence/EULA.md | head -3
```

Expected: build succeeds; output shows `# Unseen Servant — End User License Agreement`. (Gateway alone is enough to validate the COPY pattern; web/bootstrap use the identical line and are fully built in Task 6's release.)

- [ ] **Step 9: Commit**

```bash
git add licence/ scripts/generate-third-party-licenses.mjs Makefile apps/gateway/Dockerfile apps/web/Dockerfile apps/bootstrap/Dockerfile apps/bootstrap/test/third-party-licenses.test.ts
git commit -m "feat(licence): EULA + generated third-party attribution, shipped in all images"
```

---

### Task 2: Quickstart-dir resolution (flat public repo layout)

**Files:**
- Modify: `scripts/setup-quickstart.mjs:20-22`
- Modify: `scripts/update-stack.mjs:19-22`
- Test: `apps/bootstrap/test/setup-cli.test.ts` (add cases), `apps/bootstrap/test/update-cli.test.ts` (no change needed — `buildUpdateSteps` already takes `qdir`)

**Interfaces:**
- Produces: `resolveQuickstartDir(repoRoot: string): string` exported from `scripts/setup-quickstart.mjs` — returns `<repoRoot>/stack/quickstart` when `<repoRoot>/stack/quickstart/docker-compose.yml` exists (private repo), else `repoRoot` (public repo, compose at root).
- Consumes: nothing from other tasks. Task 4's public tree places `docker-compose.yml` at the repo root, which is what makes this function return `repoRoot` there.

- [ ] **Step 1: Write the failing tests**

Add to `apps/bootstrap/test/setup-cli.test.ts` (top of file, alongside existing imports — extend the existing import from `../../../scripts/setup-quickstart.mjs` with `resolveQuickstartDir`):

```typescript
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('resolveQuickstartDir', () => {
  it('returns stack/quickstart when its compose file exists (private repo layout)', () => {
    const root = mkdtempSync(join(tmpdir(), 'qdir-'));
    mkdirSync(join(root, 'stack', 'quickstart'), { recursive: true });
    writeFileSync(join(root, 'stack', 'quickstart', 'docker-compose.yml'), 'name: x\n');
    expect(resolveQuickstartDir(root)).toBe(join(root, 'stack', 'quickstart'));
  });

  it('falls back to the repo root (public quickstart repo layout)', () => {
    const root = mkdtempSync(join(tmpdir(), 'qdir-'));
    writeFileSync(join(root, 'docker-compose.yml'), 'name: x\n');
    expect(resolveQuickstartDir(root)).toBe(root);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C apps/bootstrap test setup-cli`
Expected: FAIL — `resolveQuickstartDir` is not exported.

- [ ] **Step 3: Implement the resolver**

In `scripts/setup-quickstart.mjs`, replace lines 20-22:

```javascript
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const QDIR = join(REPO_ROOT, 'stack', 'quickstart');
const SECRETS = join(QDIR, 'secrets');
```

with:

```javascript
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Private repo: quickstart lives at stack/quickstart. Public quickstart repo:
 * the compose file sits at the repo root (scripts/ next to it). Everything
 * downstream (secrets, .env, bind-mount dirs, compose cwd) hangs off this.
 * @param {string} repoRoot
 * @returns {string}
 */
export function resolveQuickstartDir(repoRoot) {
  const nested = join(repoRoot, 'stack', 'quickstart');
  return existsSync(join(nested, 'docker-compose.yml')) ? nested : repoRoot;
}

const QDIR = resolveQuickstartDir(REPO_ROOT);
const SECRETS = join(QDIR, 'secrets');
```

In `scripts/update-stack.mjs`, add `resolveQuickstartDir` to the existing import from `./setup-quickstart.mjs` (line 19) and replace line 22:

```javascript
const QDIR = join(REPO_ROOT, 'stack', 'quickstart');
```

with:

```javascript
const QDIR = resolveQuickstartDir(REPO_ROOT);
```

(`join` stays used by line 21; if the linter flags it as unused, keep it — REPO_ROOT needs it.)

- [ ] **Step 4: Run the full script-test suite to verify it passes**

Run: `pnpm -C apps/bootstrap test`
Expected: PASS, including all pre-existing setup-cli and update-cli tests (the private-repo layout resolves identically to before, so no existing expectations change).

- [ ] **Step 5: Sanity-check setup-wizard.mjs for layout assumptions**

Run: `grep -n "REPO_ROOT\|stack/quickstart\|__dirname" scripts/setup-wizard.mjs`
Expected: no matches (the wizard receives paths as parameters, e.g. `bgPath`). If anything matches, route it through a parameter the same way and re-run Step 4.

- [ ] **Step 6: Commit**

```bash
git add scripts/setup-quickstart.mjs scripts/update-stack.mjs apps/bootstrap/test/setup-cli.test.ts
git commit -m "feat(quickstart): resolve quickstart dir so wizard+updater run from the flat public repo"
```

---

### Task 3: Public repo static files (README, LICENSE, .gitignore, Makefile)

**Files:**
- Create: `distribution/README.md`
- Create: `distribution/LICENSE`
- Create: `distribution/gitignore` (renamed to `.gitignore` on sync)
- Create: `distribution/Makefile` (public variant — no `licenses` target; that script isn't shipped)

**Interfaces:**
- Produces: the four static files Task 4's manifest copies into the public tree (`distribution/README.md → README.md`, `distribution/LICENSE → LICENSE`, `distribution/gitignore → .gitignore`, `distribution/Makefile → Makefile`).
- Consumes: nothing.

- [ ] **Step 1: Write the public README**

Create `distribution/README.md`:

```markdown
# Unseen Servant

A mobile-first companion app for [Foundry VTT](https://foundryvtt.com):
players manage their characters — rolls, spells, inventory, combat — from
their phone while the GM runs the table in Foundry. Currently supports
D&D 5e (best supported), Mörk Borg, and Vampire: the Masquerade 5e.

Free to use. The app itself is closed-source; this repo contains the
installer and deployment files.

## What you get

One `docker compose` stack: Foundry VTT (bring your own license), the
[foundryvtt-rest-api relay](https://github.com/ThreeHats/foundryvtt-rest-api-relay),
the companion gateway + web app, and a bootstrap sidecar that wires
everything together automatically (module install, relay pairing key).

## Requirements

- Docker with Compose v2, or rootless Podman with podman-compose
- Node.js 22+ (runs the setup wizard; not needed after setup)
- A Foundry VTT license (foundryvtt.com account)

## Install

```bash
git clone https://github.com/Tenezill/unseen-servant.git
cd unseen-servant
make setup
```

The wizard asks for your foundryvtt.com credentials (used once by the
Foundry container to fetch its release), generates all other secrets, writes
them to `./secrets/` (mode 0600), and starts the stack.

Afterwards:

- Web app: http://localhost:8080
- Foundry: http://localhost:30000
- Relay: http://localhost:3010

Ports are configurable in the generated `.env`.

## Update

```bash
make update
```

Data-safe by construction: pulls new pinned image versions and recreates only
changed containers. Never touches your world data, players, secrets, or
relay DB (all live in bind-mount folders next to this file).

## TLS / remote access

Re-run `make setup` and answer the TLS prompts, or see the comments in
`Caddyfile.tls.example`. Rootless Podman note: binding ports 80/443 needs
`sysctl net.ipv4.ip_unprivileged_port_start=80`.

## License

The deployment files in this repo are MIT. The app's container images
(`ghcr.io/tenezill/unseen-servant-*`) are free to use under their EULA
(no redistribution/resale; see `/licence/EULA.md` inside each image, along
with third-party attributions). Foundry VTT and the relay are separate
projects under their own terms.

## Issues

Bug reports and feature requests welcome — open an issue here.
```

- [ ] **Step 2: Write the MIT license**

Create `distribution/LICENSE` with the standard MIT text:

```text
MIT License

Copyright (c) 2026 Sebastian Ramsauer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 3: Write the public .gitignore**

Create `distribution/gitignore` (everything the wizard/stack generates at runtime):

```text
.env
secrets/
foundry_data/
relay-data/
gateway-data/
caddy-data/
companion-runtime/
Caddyfile.tls
docker-compose.override.yml
node_modules/
```

- [ ] **Step 4: Write the public Makefile**

Create `distribution/Makefile`:

```makefile
.PHONY: setup setup-reset update

# Interactive first-run setup: starts an ephemeral web wizard on :8322 raced
# against terminal prompts; writes config/secrets and runs compose up.
# Flags: --no-wizard, --no-up, --reset.
setup:
	node scripts/setup-quickstart.mjs

setup-reset:
	node scripts/setup-quickstart.mjs --reset

# Data-safe update: git pull + pull new pinned images + recreate changed
# containers. NEVER removes volumes or bind mounts — your world, players,
# secrets and relay DB are preserved. Flags: --no-pull.
update:
	node scripts/update-stack.mjs
```

- [ ] **Step 5: Commit**

```bash
git add distribution/
git commit -m "feat(distribution): public quickstart repo static files (README, MIT, gitignore, Makefile)"
```

---

### Task 4: Compose transform + public-tree assembly script

**Files:**
- Modify: `stack/quickstart/docker-compose.yml:52-54` (wrap the personal `extra_hosts` block in PRIVATE-ONLY markers)
- Create: `distribution/sync-quickstart.mjs`
- Test: `apps/bootstrap/test/sync-quickstart.test.ts`

**Interfaces:**
- Consumes: Task 3's `distribution/{README.md,LICENSE,gitignore,Makefile}`; the repo's `stack/quickstart/{docker-compose.yml,Caddyfile,Caddyfile.tls.example}` and `scripts/{setup-quickstart.mjs,setup-wizard.mjs,update-stack.mjs,assets/unseen-servant.jpg}`.
- Produces: exports from `distribution/sync-quickstart.mjs` — `stripPrivateOnly(text: string): string`, `rewriteComposeToImages(text: string, version: string): string`, `IMAGE_FOR_DOCKERFILE: Record<string,string>`, `PUBLIC_FILES: [string,string][]`, `assemblePublicRepo({repoRoot, outDir, version}): void` — plus the CLI `node distribution/sync-quickstart.mjs --version vX.Y.Z --out <dir>` used by Task 5's workflow.

- [ ] **Step 1: Mark the personal extra_hosts block as private-only**

In `stack/quickstart/docker-compose.yml`, wrap lines 52-54 (the relay service's `extra_hosts` and its two comment lines) so they read:

```yaml
    # PRIVATE-ONLY-BEGIN
    # Reach the self-hosted relay domain via NPM's LAN IP (not the public IP) so
    # the headless keep-alive connects over wss:// without hairpinning out to WAN.
    extra_hosts:
      - "relay.evilwizard.academy:192.168.50.111"
    # PRIVATE-ONLY-END
```

(This block is Sebastian's personal LAN wiring and must never reach the public repo. The markers are what the transform strips; the private stack is unaffected — comments are inert to compose.)

- [ ] **Step 2: Write the failing tests**

Create `apps/bootstrap/test/sync-quickstart.test.ts`:

```typescript
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  IMAGE_FOR_DOCKERFILE,
  PUBLIC_FILES,
  assemblePublicRepo,
  rewriteComposeToImages,
  stripPrivateOnly,
} from '../../../distribution/sync-quickstart.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const realCompose = () => readFileSync(join(REPO_ROOT, 'stack', 'quickstart', 'docker-compose.yml'), 'utf8');

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
    const outDir = mkdtempSync(join(tmpdir(), 'public-tree-'));
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm -C apps/bootstrap test sync-quickstart`
Expected: FAIL — cannot resolve `../../../distribution/sync-quickstart.mjs`.

- [ ] **Step 4: Write the transform/assembly script**

Create `distribution/sync-quickstart.mjs` (NO shebang):

```javascript
/**
 * Assembles the public quickstart repo tree (spec §2-3): copies the manifest
 * files, rewrites the quickstart compose's build: blocks to pinned ghcr
 * images, and strips PRIVATE-ONLY regions. Run by the release workflow:
 *
 *   node distribution/sync-quickstart.mjs --version v0.1.0 --out /tmp/public
 *
 * Pure transforms are exported for tests. The private repo's compose keeps
 * its build: blocks — only the OUTPUT is image-pinned.
 * (No shebang on purpose — a `#!` line breaks vitest's .mjs import.)
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Which ghcr image replaces each build: block, keyed by its dockerfile line. */
export const IMAGE_FOR_DOCKERFILE = {
  'apps/gateway/Dockerfile': 'ghcr.io/tenezill/unseen-servant-gateway',
  'apps/web/Dockerfile': 'ghcr.io/tenezill/unseen-servant-web',
  'apps/bootstrap/Dockerfile': 'ghcr.io/tenezill/unseen-servant-bootstrap',
};

/** [source path in private repo, destination path in public repo] */
export const PUBLIC_FILES = [
  ['stack/quickstart/Caddyfile', 'Caddyfile'],
  ['stack/quickstart/Caddyfile.tls.example', 'Caddyfile.tls.example'],
  ['scripts/setup-quickstart.mjs', 'scripts/setup-quickstart.mjs'],
  ['scripts/setup-wizard.mjs', 'scripts/setup-wizard.mjs'],
  ['scripts/update-stack.mjs', 'scripts/update-stack.mjs'],
  ['scripts/assets/unseen-servant.jpg', 'scripts/assets/unseen-servant.jpg'],
  ['distribution/Makefile', 'Makefile'],
  ['distribution/README.md', 'README.md'],
  ['distribution/LICENSE', 'LICENSE'],
  ['distribution/gitignore', '.gitignore'],
];

/**
 * Removes regions between `# PRIVATE-ONLY-BEGIN` / `# PRIVATE-ONLY-END`
 * marker lines (markers included). Throws on unbalanced markers so a typo
 * can never leak a private region.
 * @param {string} text
 * @returns {string}
 */
export function stripPrivateOnly(text) {
  const out = [];
  let depth = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '# PRIVATE-ONLY-BEGIN') {
      depth += 1;
      continue;
    }
    if (t === '# PRIVATE-ONLY-END') {
      depth -= 1;
      if (depth < 0) throw new Error('unbalanced PRIVATE-ONLY markers (END without BEGIN)');
      continue;
    }
    if (depth === 0) out.push(line);
  }
  if (depth !== 0) throw new Error('unbalanced PRIVATE-ONLY markers (BEGIN without END)');
  return out.join('\n');
}

/**
 * Rewrites every first-party build: block to a pinned ghcr image and strips
 * private-only regions. Throws if any build: block survives — a new service
 * added to the compose without a mapping here must fail the release, not
 * ship a broken public compose.
 * @param {string} text quickstart docker-compose.yml content
 * @param {string} version release tag, e.g. "v0.1.0"
 * @returns {string}
 */
export function rewriteComposeToImages(text, version) {
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error(`version must look like v1.2.3, got: ${version}`);
  let out = stripPrivateOnly(text);
  for (const [dockerfile, image] of Object.entries(IMAGE_FOR_DOCKERFILE)) {
    const block = `    build:\n      context: ../..\n      dockerfile: ${dockerfile}`;
    while (out.includes(block)) out = out.replace(block, `    image: ${image}:${version}`);
  }
  if (/^\s+build:/m.test(out)) throw new Error('compose still contains a build: block after rewrite — add its mapping to IMAGE_FOR_DOCKERFILE');
  return out;
}

/**
 * Writes the complete public repo tree into outDir.
 * @param {{repoRoot?: string, outDir: string, version: string}} opts
 */
export function assemblePublicRepo({ repoRoot = REPO_ROOT, outDir, version }) {
  mkdirSync(outDir, { recursive: true });
  for (const [src, dest] of PUBLIC_FILES) {
    const to = join(outDir, dest);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(repoRoot, src), to);
  }
  const compose = readFileSync(join(repoRoot, 'stack', 'quickstart', 'docker-compose.yml'), 'utf8');
  writeFileSync(join(outDir, 'docker-compose.yml'), rewriteComposeToImages(compose, version), 'utf8');
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    if (i === -1 || i + 1 >= args.length) throw new Error(`missing ${flag} <value>`);
    return args[i + 1];
  };
  const version = get('--version');
  const outDir = get('--out');
  assemblePublicRepo({ outDir, version });
  console.log(`assembled public quickstart tree for ${version} in ${outDir}`);
}

// Run only when invoked directly, never when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm -C apps/bootstrap test sync-quickstart`
Expected: PASS (all cases, including the real-repo assembly test).

- [ ] **Step 6: Smoke-run the CLI**

Run (Git Bash, from repo root):

```bash
node distribution/sync-quickstart.mjs --version v0.0.0 --out /tmp/public-smoke && grep -c "ghcr.io/tenezill" /tmp/public-smoke/docker-compose.yml
```

Expected: `assembled public quickstart tree for v0.0.0 in /tmp/public-smoke`, then `4` (gateway + bootstrap + web ×2).

- [ ] **Step 7: Run the full suite and commit**

Run: `pnpm -C apps/bootstrap test`
Expected: PASS.

```bash
git add stack/quickstart/docker-compose.yml distribution/sync-quickstart.mjs apps/bootstrap/test/sync-quickstart.test.ts
git commit -m "feat(distribution): compose image-rewrite + public-tree assembly with PRIVATE-ONLY stripping"
```

---

### Task 5: Release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `VERSIONS.md` (document the release pins/flow — one new table row + paragraph)

**Interfaces:**
- Consumes: Task 4's CLI (`node distribution/sync-quickstart.mjs --version <tag> --out <dir>`); Task 1's committed `licence/` files (Dockerfiles COPY them — no CI regeneration needed).
- Produces: on every `v*.*.*` tag push — three public GHCR images tagged `<tag>` + `latest`, and a synced commit + tag on `Tenezill/unseen-servant`. Requires repo secret `QUICKSTART_PUSH_TOKEN` (created in Task 6).

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/release.yml`:

```yaml
name: release

# Tag-driven release (spec §1, §3): build+push the three first-party images
# to GHCR (multi-arch), then sync the generated public quickstart tree to
# Tenezill/unseen-servant. Sync runs ONLY after all image pushes succeed —
# no partial releases.
on:
  push:
    tags: ['v*.*.*']

permissions:
  contents: read
  packages: write

jobs:
  build-push:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: true
      matrix:
        include:
          - image: unseen-servant-gateway
            dockerfile: apps/gateway/Dockerfile
          - image: unseen-servant-web
            dockerfile: apps/web/Dockerfile
          - image: unseen-servant-bootstrap
            dockerfile: apps/bootstrap/Dockerfile
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: ${{ matrix.dockerfile }}
          platforms: linux/amd64,linux/arm64
          push: true
          tags: |
            ghcr.io/tenezill/${{ matrix.image }}:${{ github.ref_name }}
            ghcr.io/tenezill/${{ matrix.image }}:latest

  sync-quickstart:
    needs: build-push
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Assemble public quickstart tree
        run: node distribution/sync-quickstart.mjs --version "${GITHUB_REF_NAME}" --out /tmp/public
      - name: Push to Tenezill/unseen-servant
        env:
          TOKEN: ${{ secrets.QUICKSTART_PUSH_TOKEN }}
        run: |
          git clone "https://x-access-token:${TOKEN}@github.com/Tenezill/unseen-servant.git" /tmp/repo
          cd /tmp/repo
          find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
          cp -a /tmp/public/. .
          git config user.name "unseen-servant-release"
          git config user.email "release@users.noreply.github.com"
          git add -A
          if git diff --cached --quiet; then
            echo "no content changes since last release"
          else
            git commit -m "release ${GITHUB_REF_NAME}"
          fi
          # -f: the public mirror is generated output; a workflow re-run for the same
          # release must be able to overwrite its own tag instead of failing.
          git tag -f "${GITHUB_REF_NAME}"
          git push origin HEAD:main
          git push origin -f "refs/tags/${GITHUB_REF_NAME}"
```

- [ ] **Step 2: Validate the YAML parses**

Run: `pnpm dlx yaml-lint .github/workflows/release.yml`
Expected: yaml-lint reports the file is valid. (Full behavioral verification happens with the real v0.1.0 release in Task 6 — Actions workflows can't run locally.)

- [ ] **Step 3: Document the release flow in VERSIONS.md**

Append to the VERSIONS.md table:

```markdown
| unseen-servant images | git tag (e.g. `v0.1.0`) | `.github/workflows/release.yml` → `ghcr.io/tenezill/unseen-servant-{gateway,web,bootstrap}` + synced `Tenezill/unseen-servant` quickstart repo |
```

And append this paragraph after the table's existing notes:

```markdown
Releasing: run `make licenses` (refresh third-party attribution if deps
changed), commit, then `git tag vX.Y.Z && git push origin vX.Y.Z`. The
release workflow builds/pushes all three images (amd64+arm64) and syncs the
public quickstart repo; it needs the `QUICKSTART_PUSH_TOKEN` secret (fine-
grained PAT, Contents read/write on Tenezill/unseen-servant).
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml VERSIONS.md
git commit -m "feat(release): tag-driven GHCR publish + public quickstart sync workflow"
```

---

### Task 6: One-time setup, first release, verification

Partially operational — some steps need Sebastian's browser (PAT creation, package visibility). Run the automatable steps; pause and hand over where marked **USER ACTION**.

**Files:**
- No repo files. Creates the public GitHub repo, the PAT secret, tag `v0.1.0`, and verifies the published artifacts.

**Interfaces:**
- Consumes: everything from Tasks 1-5, merged to `main`.
- Produces: live `ghcr.io/tenezill/unseen-servant-*:v0.1.0` images and a populated `Tenezill/unseen-servant` repo.

- [ ] **Step 1: Merge the feature branch** (use superpowers:finishing-a-development-branch)

```bash
git checkout main && git merge --no-ff feat/public-distribution && pnpm -C apps/bootstrap test
```

Expected: merge clean, tests PASS.

- [ ] **Step 2: Create the public repo**

```bash
gh repo create Tenezill/unseen-servant --public --description "Mobile companion app for Foundry VTT - installer & deployment files" --clone=false
```

Expected: `https://github.com/Tenezill/unseen-servant` created (empty).

- [ ] **Step 3: USER ACTION — create the sync PAT**

Sebastian: GitHub → Settings → Developer settings → Fine-grained personal access tokens → Generate new token. Repository access: **only `Tenezill/unseen-servant`**. Permissions: **Contents: Read and write**. Expiration: 1 year. Then hand the token value to the session (or run the next step yourself).

- [ ] **Step 4: Store the secret**

```bash
gh secret set QUICKSTART_PUSH_TOKEN --repo Tenezill/foundry-unseen-servent
```

(Paste the PAT when prompted, or pipe it in.)
Expected: `✓ Set Actions secret QUICKSTART_PUSH_TOKEN`.

- [ ] **Step 5: Tag and release**

```bash
git tag v0.1.0 && git push origin main v0.1.0 && gh run watch --repo Tenezill/foundry-unseen-servent
```

Expected: both jobs green. arm64 emulated builds are slow — 20-40 min is normal.

- [ ] **Step 6: USER ACTION — make the GHCR packages public**

First push creates the packages **private**. Sebastian: github.com → profile → Packages → for each of `unseen-servant-gateway`, `unseen-servant-web`, `unseen-servant-bootstrap` → Package settings → Danger Zone → Change visibility → Public. (One-time; later releases stay public.)

- [ ] **Step 7: Verify the public artifacts**

```bash
docker logout ghcr.io
docker pull ghcr.io/tenezill/unseen-servant-gateway:v0.1.0
docker pull ghcr.io/tenezill/unseen-servant-web:v0.1.0
docker pull ghcr.io/tenezill/unseen-servant-bootstrap:v0.1.0
docker run --rm --entrypoint cat ghcr.io/tenezill/unseen-servant-gateway:v0.1.0 /licence/EULA.md | head -3
```

Expected: all pulls succeed unauthenticated; EULA header prints.

```bash
git clone https://github.com/Tenezill/unseen-servant.git "$SCRATCHPAD/unseen-servant-check"
cd "$SCRATCHPAD/unseen-servant-check" && docker compose config --quiet && echo COMPOSE_OK && grep -c "ghcr.io/tenezill" docker-compose.yml
```

Expected: `COMPOSE_OK` and `4`; repo contains README.md, LICENSE, Makefile, scripts/.

- [ ] **Step 8: USER ACTION (optional but recommended) — clean-machine E2E**

On a machine/VM without the private repo: `git clone https://github.com/Tenezill/unseen-servant.git && cd unseen-servant && make setup` with real foundryvtt.com credentials, then walk through docs/HOSTING.md Part C (world creation, pairing, open the web app on a phone). This is the true "a stranger can install it" test — everything before it only proves the artifacts are well-formed.

---

## Self-Review Notes

- Spec coverage: §1 workflow+images → Tasks 5-6; §2 public repo contents (compose, Caddyfiles, wizard, updater, Makefile, README) → Tasks 3-4; §3 source-of-truth/sync → Tasks 4-5; §4 EULA/MIT/attribution → Tasks 1+3; §5 out-of-scope respected (no theme loading, no auto-update); "Existing deployments" → private compose keeps `build:` (Task 4 only adds inert comment markers); wizard self-containment requirement → Task 2.
- The `extra_hosts` personal block (found during planning) is handled via PRIVATE-ONLY markers — spec's "must not assume private layout" extended to "must not leak private config".
- Type consistency: `resolveQuickstartDir` (Tasks 2), `assemblePublicRepo({repoRoot, outDir, version})`, `rewriteComposeToImages(text, version)` (Task 4 defs = Task 5 CLI usage). Image names identical across Tasks 4, 5, 6.
