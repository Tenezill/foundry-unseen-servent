#!/usr/bin/env node
/**
 * Generate a player invite token + the players.yaml entry for it.
 *
 *   node scripts/make-invite.mjs <playerName> <actorId> [moreActorIds…]
 *
 * Prints the token ONCE (hand it to the player as a join link) and the YAML
 * block to append to the gateway's players.yaml. Only the sha256 hash is
 * stored server-side.
 */
import { createHash, randomBytes } from 'node:crypto';

const [name, ...actorIds] = process.argv.slice(2);
if (!name || actorIds.length === 0) {
  console.error('usage: node scripts/make-invite.mjs <playerName> <actorId> [moreActorIds…]');
  process.exit(1);
}

const token = randomBytes(24).toString('base64url');
const tokenHash = createHash('sha256').update(token).digest('hex');

console.log(`# Invite token for ${name} — share ONCE, do not store:`);
console.log(`#   https://<your-app-host>/join#${token}`);
console.log('');
console.log('# Append to players.yaml:');
console.log(`  - name: ${name}`);
console.log(`    tokenHash: "${tokenHash}"`);
console.log(`    actorIds: [${actorIds.map((a) => `"${a}"`).join(', ')}]`);
