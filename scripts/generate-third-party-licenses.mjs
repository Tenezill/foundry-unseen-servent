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
