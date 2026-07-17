/**
 * Data-safe updater for the turnkey stack (docs/HOSTING.md Part C).
 *
 * Pulls the latest code, refreshes/rebuilds images, and recreates only the
 * containers whose image or config changed. It NEVER touches the host
 * bind-mount state — your world, players.yaml, secrets and the relay DB all
 * live in ./stack/quickstart/{foundry_data,relay-data,gateway-data,...} and are
 * simply reattached. No `down`, no `-v`, no volume/dir removal. Idempotent:
 * re-running with nothing new is a no-op restart.
 *
 *   node scripts/update-stack.mjs            # git pull + compose pull + up -d --build
 *   node scripts/update-stack.mjs --no-pull  # skip git pull (rebuild/restart only)
 *
 * (No shebang on purpose — a `#!` line breaks vitest's .mjs import.)
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectComposeCommand } from './setup-quickstart.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const QDIR = join(REPO_ROOT, 'stack', 'quickstart');

/** Tokens that would destroy state — this updater must NEVER emit them. */
export const DESTRUCTIVE_TOKENS = ['down', '-v', '--volumes', 'rm', 'prune', 'stop'];

/**
 * The ordered, data-safe steps for an update. Pure (no side effects) so the
 * safety guarantee is unit-testable: none of these removes a container,
 * volume, or bind mount.
 * @param {string[]} compose e.g. ['docker','compose']
 * @param {{ pull?: boolean, cwd?: string, qdir?: string }} [opts]
 * @returns {{ label: string, cwd: string, cmd: string[] }[]}
 */
export function buildUpdateSteps(compose, { pull = true, cwd = REPO_ROOT, qdir = QDIR } = {}) {
  const steps = [];
  // Fast-forward only: refuse to silently merge/rebase divergent local commits.
  if (pull) steps.push({ label: 'pull latest code', cwd, cmd: ['git', 'pull', '--ff-only'] });
  // Refresh pinned upstream images (foundry, relay). Build-only services are skipped.
  steps.push({ label: 'pull updated images', cwd: qdir, cmd: [...compose, 'pull'] });
  // Rebuild locally-built images (gateway/web/bootstrap) and recreate ONLY the
  // containers whose image/config changed. Bind mounts are reattached as-is.
  steps.push({ label: 'rebuild & restart', cwd: qdir, cmd: [...compose, 'up', '-d', '--build'] });
  return steps;
}

/** True if any step would destroy state — a defensive backstop. */
export function hasDestructiveStep(steps) {
  return steps.some((s) => s.cmd.some((t) => DESTRUCTIVE_TOKENS.includes(t)));
}

function runSteps(steps) {
  for (const s of steps) {
    console.log(`\n→ ${s.label}: ${s.cmd.join(' ')}${s.cwd ? `  (in ${s.cwd})` : ''}`);
    const r = spawnSync(s.cmd[0], s.cmd.slice(1), { cwd: s.cwd, stdio: 'inherit' });
    if (r.status !== 0) {
      console.error(`\n✗ step failed: ${s.cmd.join(' ')} (exit ${r.status ?? 'signal'})`);
      console.error('  Your data was NOT touched. Fix the cause and re-run `make update`.');
      process.exit(r.status ?? 1);
    }
  }
}

function main() {
  const pull = !process.argv.includes('--no-pull');
  const compose = detectComposeCommand();
  if (compose === null) {
    console.error('no container runtime found — install docker (with compose v2) or podman.');
    process.exit(1);
  }
  const steps = buildUpdateSteps(compose, { pull });
  if (hasDestructiveStep(steps)) {
    // Should be unreachable; guarantees we never nuke state even after edits.
    console.error('refusing to run: update plan contained a destructive step.');
    process.exit(1);
  }
  console.log('Updating the stack — world, players, secrets and data are preserved (host bind mounts untouched).');
  runSteps(steps);
  console.log('\n✓ Update complete. Nothing in your setup was reset.');
}

// Run only when invoked directly, never when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
