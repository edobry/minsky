/**
 * Runtime Environment Schema Definitions
 * 
 * This module provides Zod schemas for validating runtime environment APIs,
 * replacing unsafe `(Bun as unknown).argv` patterns with proper validation.
 */

import { z } from "zod";

/**
 * Bun runtime environment schema
 */
export const bunRuntimeSchema = z.object({
  argv: z.array(z.string()).describe("Command line arguments"),
  version: z.string().describe("Bun version"),
  revision: z.string().describe("Bun revision"),
  env: z.record(z.string(), z.string().optional()).describe("Environment variables"),
});

/**
 * Process environment schema
 */
export const processSchema = z.object({
  argv: z.array(z.string()).describe("Command line arguments"),
  env: z.record(z.string(), z.string().optional()).describe("Environment variables"),
  cwd: z.function().returns(z.string()).describe("Current working directory function"),
  pid: z.number().describe("Process ID"),
  platform: z.string().describe("Operating system platform"),
  version: z.string().describe("Node.js version"),
  versions: z.record(z.string(), z.string()).describe("Runtime versions"),
});

/**
 * File system stats schema for fs.statSync results
 */
export const fileStatsSchema = z.object({
  isFile: z.function().returns(z.boolean()),
  isDirectory: z.function().returns(z.boolean()),
  isBlockDevice: z.function().returns(z.boolean()),
  isCharacterDevice: z.function().returns(z.boolean()),
  isSymbolicLink: z.function().returns(z.boolean()),
  isFIFO: z.function().returns(z.boolean()),
  isSocket: z.function().returns(z.boolean()),
  dev: z.number(),
  ino: z.number(),
  mode: z.number(),
  nlink: z.number(),
  uid: z.number(),
  gid: z.number(),
  rdev: z.number(),
  size: z.number(),
  blksize: z.number(),
  blocks: z.number(),
  atimeMs: z.number(),
  mtimeMs: z.number(),
  ctimeMs: z.number(),
  birthtimeMs: z.number(),
  atime: z.date(),
  mtime: z.date(),
  ctime: z.date(),
  birthtime: z.date(),
});

/**
 * Directory contents schema for fs.readdir results
 */
export const directoryContentsSchema = z.array(z.string());

/**
 * Exec result schema for child_process.exec results
 */
export const execResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
});

/**
 * Type definitions for runtime schemas
 */
export type BunRuntime = z.infer<typeof bunRuntimeSchema>;
export type ProcessEnv = z.infer<typeof processSchema>;
export type FileStats = z.infer<typeof fileStatsSchema>;
export type DirectoryContents = z.infer<typeof directoryContentsSchema>;
export type ExecResult = z.infer<typeof execResultSchema>;

/**
 * Utility function to safely validate Bun runtime
 */
export function validateBunRuntime(runtime: unknown): BunRuntime {
  const result = bunRuntimeSchema.safeParse(runtime);
  
  if (result.success) {
    return result.data;
  }
  
  // Fallback for minimal Bun runtime
  return {
    argv: typeof runtime === "object" && runtime && "argv" in runtime && Array.isArray(runtime.argv) 
      ? runtime.argv as string[]
      : [],
    version: typeof runtime === "object" && runtime && "version" in runtime 
      ? String(runtime.version)
      : "unknown",
    revision: typeof runtime === "object" && runtime && "revision" in runtime 
      ? String(runtime.revision)
      : "unknown",
    env: typeof runtime === "object" && runtime && "env" in runtime 
      ? runtime.env as Record<string, string | undefined>
      : {},
  };
}

/**
 * Utility function to safely validate process environment
 */
export function validateProcess(proc: unknown): ProcessEnv {
  const result = processSchema.safeParse(proc);
  
  if (result.success) {
    return result.data;
  }
  
  // Fallback for minimal process object
  return {
    argv: typeof proc === "object" && proc && "argv" in proc && Array.isArray(proc.argv) 
      ? proc.argv as string[]
      : [],
    env: typeof proc === "object" && proc && "env" in proc 
      ? proc.env as Record<string, string | undefined>
      : {},
    cwd: typeof proc === "object" && proc && "cwd" in proc && typeof proc.cwd === "function"
      ? proc.cwd as () => string
      : () => "/",
    pid: typeof proc === "object" && proc && "pid" in proc && typeof proc.pid === "number"
      ? proc.pid
      : 0,
    platform: typeof proc === "object" && proc && "platform" in proc 
      ? String(proc.platform)
      : "unknown",
    version: typeof proc === "object" && proc && "version" in proc 
      ? String(proc.version)
      : "unknown",
    versions: typeof proc === "object" && proc && "versions" in proc 
      ? proc.versions as Record<string, string>
      : {},
  };
}

/**
 * Utility function to safely validate file stats
 */
export function validateFileStats(stats: unknown): FileStats {
  const result = fileStatsSchema.safeParse(stats);
  
  if (result.success) {
    return result.data;
  }
  
  // This is a complex fallback - in practice, fs.statSync should return valid stats
  // We'll throw if validation fails since this indicates a serious runtime issue
  throw new Error("Invalid file stats object received from fs.statSync");
}

/**
 * Utility function to safely validate directory contents
 */
export function validateDirectoryContents(contents: unknown): DirectoryContents {
  const result = directoryContentsSchema.safeParse(contents);
  
  if (result.success) {
    return result.data;
  }
  
  // Fallback for non-array contents
  if (Array.isArray(contents)) {
    return contents.map(item => String(item));
  }
  
  return [];
}

/**
 * Utility function to safely validate exec results
 */
export function validateExecResult(result: unknown): ExecResult {
  const parsed = execResultSchema.safeParse(result);
  
  if (parsed.success) {
    return parsed.data;
  }
  
  // Fallback for minimal exec result
  return {
    stdout: typeof result === "object" && result && "stdout" in result 
      ? String(result.stdout)
      : "",
    stderr: typeof result === "object" && result && "stderr" in result 
      ? String(result.stderr)
      : "",
  };
} 
