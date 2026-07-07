/**
 * players.yaml loading and invite-token verification (PLAN.md §5).
 *
 * Tokens are never stored; players.yaml holds sha256 hex digests. Lookup
 * hashes the presented token and compares against every entry with a
 * timing-safe comparison (no early exit on match).
 */
import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { parse } from 'yaml';

export interface Player {
  name: string;
  /** sha256 hex digest of the invite token. */
  tokenHash: string;
  /** Foundry actor ids this player may read/write. */
  actorIds: string[];
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

export function parsePlayers(yamlText: string): Player[] {
  const doc: unknown = parse(yamlText);
  if (doc === null || typeof doc !== 'object' || !Array.isArray((doc as Record<string, unknown>).players)) {
    throw new Error('players file must contain a top-level "players" list');
  }
  const raw = (doc as { players: unknown[] }).players;
  return raw.map((entry, i) => {
    if (entry === null || typeof entry !== 'object') {
      throw new Error(`players[${i}] must be a mapping`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== 'string' || e.name === '') {
      throw new Error(`players[${i}].name must be a non-empty string`);
    }
    if (typeof e.tokenHash !== 'string' || !HEX64.test(e.tokenHash)) {
      throw new Error(`players[${i}].tokenHash must be a sha256 hex digest`);
    }
    if (!Array.isArray(e.actorIds) || !e.actorIds.every((a) => typeof a === 'string' && a !== '')) {
      throw new Error(`players[${i}].actorIds must be a list of non-empty strings`);
    }
    return { name: e.name, tokenHash: e.tokenHash.toLowerCase(), actorIds: e.actorIds as string[] };
  });
}

export function loadPlayers(filePath: string): Player[] {
  return parsePlayers(readFileSync(filePath, 'utf8'));
}

export function sha256Hex(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Returns the player whose tokenHash matches sha256(token), or null.
 * Compares against ALL entries (timing-safe, no early exit).
 */
export function verifyToken(players: readonly Player[], token: string): Player | null {
  const digest = createHash('sha256').update(token, 'utf8').digest();
  let match: Player | null = null;
  for (const p of players) {
    if (!HEX64.test(p.tokenHash)) continue;
    const hash = Buffer.from(p.tokenHash, 'hex');
    if (hash.length !== digest.length) continue;
    if (timingSafeEqual(digest, hash) && match === null) {
      match = p;
    }
  }
  return match;
}
