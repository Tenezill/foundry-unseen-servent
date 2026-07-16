/** Typed surface of scripts/setup-quickstart.mjs for the vitest import —
 *  runtime behavior is what the tests exercise; keep in sync with the CLI. */
declare module '*setup-quickstart.mjs' {
  export function generateSecret(bytes?: number): string;
  export function buildFoundryConfigJson(i: {
    username: string;
    password: string;
    licenseKey: string;
    adminKey: string;
  }): string;
  export function buildBootstrapEnv(s: {
    relayEmail: string;
    relayPassword: string;
    gmUser: string;
    gmPassword: string;
    adminKey: string;
  }): string;
  export function buildGatewayEnv(s: { adminPassword: string }): string;
  export function buildDotEnv(k: { tls: boolean }): string;
  export function buildTlsCaddyfile(t: { domainApp: string; domainVtt: string; acmeEmail: string }): string;
  export function detectComposeCommand(
    run?: (cmd: string, args: string[]) => { status: number | null },
  ): string[] | null;
  export function writeSecretIfAbsent(path: string, content: string): boolean;
}

declare module '*setup-wizard.mjs' {
  export function escapeHtml(s: string): string;
  export function tokenMatches(expected: string, presented: string): boolean;
  export function parseFormBody(body: string): Record<string, string>;
  export function renderShell(i: { title: string; body: string; head?: string }): string;
  export function renderCredsForm(i: {
    needCreds: boolean;
    needTls: boolean;
    error?: string | null;
    username?: string;
  }): string;
  export function renderSecretsPage(secrets: Array<[string, string]>): string;
  export function renderProgressPage(): string;
  export function renderDonePage(statusUrl: string): string;
  export function renderFailedPage(exitCode: number): string;
  export function renderAlreadyShownPage(): string;
  export function renderGonePage(): string;

  export interface WizardSubmission {
    creds: { username: string; password: string; licenseKey: string } | null;
    tls: { enabled: boolean; domainApp?: string; domainVtt?: string; acmeEmail?: string };
  }
  export interface WizardHandle {
    token: string;
    server: import('node:http').Server;
    submitted: Promise<'browser'>;
    acked: Promise<void>;
    listen(port: number, host?: string): Promise<number>;
    setPhase(phase: 'done' | 'failed', extra?: { exitCode?: number }): void;
    takeover(): void;
    waitForFinalPage(timeoutMs: number): Promise<boolean>;
    close(): void;
  }
  export function createWizard(opts: {
    token: string;
    needCreds: boolean;
    needTls: boolean;
    bgPath: string;
    statusUrl: string;
    onSubmit: (values: WizardSubmission) => Promise<Array<[string, string]>>;
  }): WizardHandle;
}
