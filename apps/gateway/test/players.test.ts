import { describe, expect, it } from 'vitest';
import { parsePlayers, sha256Hex, verifyToken } from '../src/players.js';

const YAML = `
players:
  - name: Anna
    tokenHash: "${sha256Hex('token-a')}"
    actorIds: ["a1", "a2"]
  - name: Bob
    tokenHash: "${sha256Hex('token-b')}"
    actorIds: ["b1"]
`;

describe('players.yaml', () => {
  it('parses valid entries', () => {
    const players = parsePlayers(YAML);
    expect(players).toHaveLength(2);
    expect(players[0]).toEqual({ name: 'Anna', tokenHash: sha256Hex('token-a'), actorIds: ['a1', 'a2'] });
  });

  it('rejects malformed files', () => {
    expect(() => parsePlayers('players: nope')).toThrow();
    expect(() => parsePlayers('players:\n  - name: X\n    tokenHash: short\n    actorIds: []')).toThrow();
  });

  it('verifies tokens by sha256 and returns null for unknown tokens', () => {
    const players = parsePlayers(YAML);
    expect(verifyToken(players, 'token-a')?.name).toBe('Anna');
    expect(verifyToken(players, 'token-b')?.name).toBe('Bob');
    expect(verifyToken(players, 'token-c')).toBeNull();
    expect(verifyToken(players, '')).toBeNull();
    expect(verifyToken(players, sha256Hex('token-a'))).toBeNull(); // the hash itself is not the token
  });
});
