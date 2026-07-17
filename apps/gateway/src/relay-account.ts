/**
 * Whitelist reader for the bootstrap sidecar's relay-account.json (shared
 * volume). The relay account email + password are the credentials an operator
 * needs to APPROVE a pairing request on the self-hosted relay; they are served
 * ONLY behind the admin credential (GET /api/admin/relay), never on any
 * unauthenticated surface. Only the two known string fields pass through, so
 * nothing else written to the shared volume can leak into the response.
 * Absent/malformed file -> null (the caller reports "not available yet").
 */
import { readFileSync } from 'node:fs';

export interface RelayAccountView {
  email: string;
  password: string;
}

export function readRelayAccount(filePath: string): RelayAccountView | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const rec = doc as Record<string, unknown>;
  if (typeof rec.email !== 'string' || rec.email === '') return null;
  if (typeof rec.password !== 'string' || rec.password === '') return null;
  return { email: rec.email, password: rec.password };
}
