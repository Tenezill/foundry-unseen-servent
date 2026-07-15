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
}
