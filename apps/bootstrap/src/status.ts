/**
 * status.json on the shared volume: the sidecar's state machine surface,
 * merged into the gateway's /healthz and rendered by the status page. By
 * CONTRACT it carries no secret — phase/detail/error text only, never keys,
 * passwords, or the clientId (the gateway additionally whitelists on read).
 * 0644 (not secret); atomic same-dir tmp + rename; a failed write must never
 * kill the converge loop (status is best-effort).
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type BootstrapPhase =
  | 'starting'
  | 'waiting-relay'
  | 'provisioning-account'
  | 'minting-key'
  | 'key-ready'
  | 'placing-module'
  | 'waiting-world'
  | 'starting-session'
  | 'gm-login-failed'
  | 'needs-pairing'
  | 'online'
  | 'error';

export interface BootstrapStatus {
  phase: BootstrapPhase;
  detail: string;
  error: { class: string; message: string } | null;
  updatedAt: string;
}

export class StatusWriter {
  private state: BootstrapStatus = {
    phase: 'starting',
    detail: 'sidecar starting',
    error: null,
    updatedAt: new Date().toISOString(),
  };

  constructor(private readonly filePath: string) {}

  current(): BootstrapStatus {
    return this.state;
  }

  set(phase: BootstrapPhase, detail: string, error: { class: string; message: string } | null = null): void {
    this.state = { phase, detail, error, updatedAt: new Date().toISOString() };
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = join(dirname(this.filePath), `.${basename(this.filePath)}.tmp`);
      writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', { encoding: 'utf8', mode: 0o644 });
      renameSync(tmp, this.filePath);
    } catch {
      // best-effort: never let a status write kill the converge loop
    }
  }
}
