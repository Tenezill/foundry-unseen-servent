/**
 * Whitelist reader for the bootstrap sidecar's status.json (shared volume).
 * /healthz is unauthenticated, so ONLY known fields pass through — nothing
 * written to the shared volume (by the sidecar or anyone with volume access)
 * can inject arbitrary content, keys, or a clientId into the health surface.
 * Absent/malformed file -> null (the caller omits the field).
 */
import { readFileSync } from 'node:fs';

export interface BootstrapStatusView {
  phase: string;
  detail?: string;
  error?: { class: string; message: string } | null;
  updatedAt?: string;
}

export function readBootstrapStatus(filePath: string): BootstrapStatusView | null {
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
  if (typeof rec.phase !== 'string' || rec.phase === '') return null;
  const out: BootstrapStatusView = { phase: rec.phase };
  if (typeof rec.detail === 'string') out.detail = rec.detail;
  if (typeof rec.updatedAt === 'string') out.updatedAt = rec.updatedAt;
  if (rec.error === null) {
    out.error = null;
  } else if (rec.error !== undefined && typeof rec.error === 'object' && !Array.isArray(rec.error)) {
    const e = rec.error as Record<string, unknown>;
    if (typeof e.class === 'string' && typeof e.message === 'string') {
      out.error = { class: e.class, message: e.message };
    }
  }
  return out;
}
