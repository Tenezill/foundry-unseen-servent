/**
 * Minimal ambient declarations for the Node built-ins this package uses.
 * The workspace intentionally has no @types/node installed; these cover only
 * the exact surface we touch. Delete this file if @types/node is ever added.
 */

declare module 'node:crypto' {
  export interface Hash {
    update(data: string, inputEncoding?: string): Hash;
    digest(): Uint8Array;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: string): Hash;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare const Buffer: {
  from(data: string, encoding: 'hex' | 'utf8'): Uint8Array;
};

declare const process: {
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
};
