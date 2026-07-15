/**
 * World relaunch after a reboot (spec §Bootstrap sidecar 4): felddy only
 * auto-launches when FOUNDRY_WORLD is preset, which a bring-your-own-world
 * stack cannot do. When Foundry is at the setup screen but exactly one world
 * exists on disk, drive Foundry's own admin surface to launch it.
 *
 * ADMIN_RELAUNCH is the Task 0(b) verdict (findings §2): the admin-API world
 * relaunch recipe was NOT verified in this environment, so it is DEFERRED —
 * relaunchWorldIfIdle returns 'skipped' unconditionally by default. The
 * status page instructs the operator to launch the world manually; docs
 * (Task 10) cover setting `foundry_world` in config.json so felddy
 * auto-launches on subsequent boots. The HTTP recipe below (POST /auth
 * adminAuth -> POST /setup launchWorld, cookie-carried) is the EXPECTED
 * shape only — replace it with the exact captured recipe from findings §2
 * once verified, then flip ADMIN_RELAUNCH to true.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const ADMIN_RELAUNCH = false;

export type RelaunchOutcome = 'launched' | 'already-active' | 'no-world' | 'multiple-worlds' | 'skipped' | 'failed';

export interface RelaunchDeps {
  foundryUrl: string;
  adminKey: string;
  foundryDataDir: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log: { info(msg: string): void; warn(msg: string): void };
}

export async function relaunchWorldIfIdle(deps: RelaunchDeps): Promise<RelaunchOutcome> {
  if (!ADMIN_RELAUNCH) return 'skipped';
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  try {
    const statusRes = await fetchImpl(new URL('/api/status', deps.foundryUrl).toString(), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const status = (await statusRes.json()) as Record<string, unknown>;
    // Findings §2: an idle server reports no active world on /api/status.
    if (status.world !== undefined && status.world !== null && status.active !== false) return 'already-active';
  } catch {
    return 'failed'; // Foundry not up yet — the loop retries later
  }
  const worldsDir = join(deps.foundryDataDir, 'Data', 'worlds');
  if (!existsSync(worldsDir)) return 'no-world';
  const worlds = readdirSync(worldsDir).filter((d) => existsSync(join(worldsDir, d, 'world.json')));
  if (worlds.length === 0) return 'no-world';
  if (worlds.length > 1) return 'multiple-worlds'; // v1: never guess — status page says launch manually
  const worldId = worlds[0] as string;
  try {
    const authRes = await fetchImpl(new URL('/auth', deps.foundryUrl).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'adminAuth', adminPassword: deps.adminKey }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const cookie = authRes.headers.get('set-cookie') ?? '';
    const launchRes = await fetchImpl(new URL('/setup', deps.foundryUrl).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie !== '' ? { cookie } : {}) },
      body: JSON.stringify({ action: 'launchWorld', world: worldId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (launchRes.status >= 200 && launchRes.status < 300) {
      deps.log.info(`relaunched world ${worldId}`);
      return 'launched';
    }
    deps.log.warn(`world relaunch rejected (${launchRes.status})`);
    return 'failed';
  } catch (err) {
    deps.log.warn(`world relaunch failed: ${(err as Error).message}`);
    return 'failed';
  }
}
