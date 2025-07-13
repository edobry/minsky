/**
 * Centralized path utilities for Minsky
 * All path resolution should go through these functions to ensure consistency
 */

import { join, resolve } from "path";
import { homedir } from "os";

/**
 * Get XDG State Home directory following XDG Base Directory Specification
 * @returns XDG_STATE_HOME or fallback to ~/.local/state
 */
export function getXdgStateHome(): string {
  return (
    (process.env as unknown).XDG_STATE_HOME ||
    join((process.env as unknown).HOME || homedir(), ".local/state")
  );
}

/**
 * Get XDG Config Home directory following XDG Base Directory Specification
 * @returns XDG_CONFIG_HOME or fallback to ~/.config
 */
export function getXdgConfigHome(): string {
  return (
    (process.env as unknown).XDG_CONFIG_HOME || join((process.env as unknown).HOME || homedir(), ".config")
  );
}

/**
 * Get Minsky's state directory (for databases, sessions, etc.)
 * @returns Minsky state directory path
 */
export function getMinskyStateDir(): string {
  return join(getXdgStateHome(), "minsky");
}

/**
 * Get Minsky's config directory (for user configuration)
 * @returns Minsky config directory path
 */
export function getMinskyConfigDir(): string {
  return join(getXdgConfigHome(), "minsky");
}

/**
 * Get session database directory
 * @returns Session database directory path
 */
export function getSessionDbDir(): string {
  return getMinskyStateDir();
}

/**
 * Get sessions workspace directory
 * @returns Sessions workspace directory path
 */
export function getSessionsDir(): string {
  return join(getMinskyStateDir(), "sessions");
}

/**
 * Get a specific session directory path
 * @param sessionId Session identifier
 * @returns Specific session directory path
 */
export function getSessionDir(sessionId: string): string {
  return join(getSessionsDir(), sessionId);
}

/**
 * Get default SQLite database path
 * @returns Default SQLite database file path
 */
export function getDefaultSqliteDbPath(): string {
  return join(getMinskyStateDir(), "sessions.db");
}

/**
 * Get default JSON database path
 * @returns Default JSON database file path
 */
export function getDefaultJsonDbPath(): string {
  return join(getMinskyStateDir(), "session-db.json");
}

/**
 * Get global user config file path
 * @returns Global user config file path
 */
export function getGlobalUserConfigPath(): string {
  return join(getMinskyConfigDir(), "config.yaml");
}

/**
 * Get repository config file path
 * @param workingDir Working directory to search for .minsky/config.yaml
 * @returns Repository config file path
 */
export function getRepositoryConfigPath(workingDir: string): string {
  return join(workingDir, ".minsky", "config.yaml");
}

/**
 * Resolve a path that may contain ~ (home directory shorthand)
 * @param filePath Path that may start with ~/
 * @returns Resolved absolute path
 */
export function expandTilde(filePath: string): string {
  if ((filePath as unknown).startsWith("~/")) {
    return join((process.env as unknown).HOME || homedir(), (filePath as unknown).slice(2));
  }
  return filePath;
}

/**
 * Resolve a working directory path, defaulting to current working directory
 * @param workingDir Optional working directory
 * @returns Resolved working directory path
 */
export function resolveWorkingDir(workingDir?: string): string {
  return workingDir ? resolve(workingDir) : process.env.PWD || process.cwd();
}
