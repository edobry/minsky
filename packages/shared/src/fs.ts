/**
 * File system utility helpers.
 * Thin wrappers around Node's fs APIs that always return string
 * (avoiding the `string | Buffer` union that appears when no encoding
 * is passed to readFile / readFileSync).
 */

import { readFileSync as _readFileSync } from "fs";
import { readFile as _readFile } from "fs/promises";

/**
 * Read a text file synchronously, always returning a string.
 */
export function readTextFileSync(path: string): string {
  return _readFileSync(path, "utf-8") as string;
}

/**
 * Read a text file asynchronously, always returning a string.
 */
export async function readTextFile(path: string): Promise<string> {
  return _readFile(path, "utf-8") as Promise<string>;
}
