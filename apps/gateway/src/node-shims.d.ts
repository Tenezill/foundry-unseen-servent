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
  export function randomBytes(size: number): { toString(encoding: 'base64url'): string };
}

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export interface FSWatcher {
    close(): void;
  }
  export function watch(
    path: string,
    listener: (event: string, filename: string | null) => void,
  ): FSWatcher;
}

declare module 'node:fs/promises' {
  export function mkdtemp(prefix: string): Promise<string>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function readdir(path: string): Promise<string[]>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
}

declare const Buffer: {
  from(data: string, encoding: 'hex' | 'utf8'): Uint8Array;
};

declare const process: {
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
};
