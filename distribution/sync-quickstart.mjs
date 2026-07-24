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
  // Normalize line endings to LF for consistent processing
  let out = text.replace(/\r\n/g, '\n');
  out = stripPrivateOnly(out);
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
