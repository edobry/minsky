/**
 * Type declarations for Node.js modules used in the project
 * This helps TypeScript recognize built-in Node.js modules without requiring @types/node
 */

// Declare Node.js path module
declare module "path" {
  export function join(...paths: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string): string;
  export function resolve(...paths: string[]): string;
  export function parse(path: string): {
    root: string;
    dir: string;
    base: string;
    ext: string;
    name: string;
  };
}

// Declare Node.js fs module
declare module "fs" {
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, _options?: any): void;
  export function readFileSync(path: string, _options?: any): string | Buffer;
  export function writeFileSync(path: string, data: any, _options?: any): void;
  export type PathLike = string | Buffer;
  export type WriteFileOptions = object;
  export type MakeDirectoryOptions = object;
  export type ObjectEncodingOptions = object;
}

// Declare Node.js fs/promises module
declare module "fs/promises" {
  export function readFile(path: string, _options?: any): Promise<string | Buffer>;
  export function writeFile(path: string, data: any, _options?: any): Promise<void>;
  export function mkdir(path: string, _options?: any): Promise<void>;
  export function access(path: string, mode?: number): Promise<void>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
}

// Declare Node.js child_process module
declare module "child_process" {
  export function execSync(_command: string, _options?: any): Buffer;
}

// Declare Node.js process global
declare const process: {
  cwd(): string;
  env: Record<string, string | undefined>;
  stdout: {
    isTTY?: boolean;
  };
};

// Declare Buffer global
declare const Buffer: {
  from(_data: string | any[], encoding?: string): any;
};

// Declare additional Bun test matchers
declare namespace jest {
  interface Matchers<R> {
    not: Matchers<R>;
    toHaveBeenCalled(): R;
    toHaveBeenCalledWith(..._args: unknown[]): R;
  }
}
