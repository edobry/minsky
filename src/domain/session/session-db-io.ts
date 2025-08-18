/**
 * I/O operations for the SessionDB
 * This module contains all file system operations separated from pure functions
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { SessionRecord, SessionDbState } from "./session-db";
import { getErrorMessage } from "../../errors";
import { log } from "../../utils/logger";
import { getMinskyStateDir, getDefaultJsonDbPath } from "../../utils/paths";

/**
 * Options for the SessionDB file operations
 */
export interface SessionDbFileOptions {
  dbPath?: string;
  baseDir?: string;
}

/**
 * Read sessions from the database file
 */
export function readSessionDbFile(
  optionsOrPath: SessionDbFileOptions | string | undefined | null = {}
): SessionDbState | SessionRecord[] {
  // Backwards compatibility: allow string path to return array of sessions (used by tests)
  const isStringPath = typeof optionsOrPath === "string";
  const safeOptions = (isStringPath ? { dbPath: optionsOrPath } : optionsOrPath) || {};
  const stateDir = getMinskyStateDir();
  const dbPath = (safeOptions as SessionDbFileOptions).dbPath || getDefaultJsonDbPath();
  const baseDir = (safeOptions as SessionDbFileOptions).baseDir || stateDir;

  try {
    if (!existsSync(dbPath)) {
      return isStringPath
        ? []
        : {
            sessions: [],
            baseDir: baseDir,
          };
    }

    const data = readFileSync(dbPath, "utf8") as string;
    if (!data || data.trim().length === 0) {
      return isStringPath
        ? []
        : {
            sessions: [],
            baseDir: baseDir,
          };
    }
    const parsed = JSON.parse(data);

    // Handle both legacy format (array) and new format (SessionDbState object)
    if (Array.isArray(parsed)) {
      // Legacy format: file contains just the sessions array
      return isStringPath
        ? (parsed as SessionRecord[])
        : {
            sessions: parsed,
            baseDir: baseDir,
          };
    } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.sessions)) {
      // New format: file contains SessionDbState object
      if (isStringPath) {
        return (parsed.sessions as SessionRecord[]) || [];
      }
      return {
        sessions: parsed.sessions,
        baseDir: parsed.baseDir || baseDir,
      };
    } else {
      // Invalid or corrupted data, return empty state
      log.warn(`Invalid session database format in ${dbPath}, initializing empty state`);
      return isStringPath
        ? []
        : {
            sessions: [],
            baseDir: baseDir,
          };
    }
  } catch (error) {
    log.error(`Error reading session database: ${getErrorMessage(error as any)}`);
    return isStringPath
      ? []
      : {
          sessions: [],
          baseDir: baseDir,
        };
  }
}

/**
 * Write sessions to the database file
 */
export async function writeSessionsToFile(
  sessions: SessionRecord[],
  options: SessionDbFileOptions | undefined | null = {}
): Promise<void> {
  const safeOptions = options || {};
  const stateDir = getMinskyStateDir();
  const dbPath = safeOptions.dbPath || getDefaultJsonDbPath();

  try {
    // Ensure directory exists
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    writeFileSync(dbPath, JSON.stringify(sessions, undefined, 2));
  } catch (error) {
    log.error(`Error writing session database: ${getErrorMessage(error as any)}`);
  }
}

// Backward-compatibility API expected by tests
export function writeSessionDbFile(dbPath: string, sessions: SessionRecord[]): void {
  try {
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }
    writeFileSync(dbPath, JSON.stringify(sessions, undefined, 2));
  } catch (error) {
    log.error(`Error writing session database: ${getErrorMessage(error as any)}`);
  }
}

/**
 * Ensure the database directory exists
 */
export function ensureDbDir(dbPath: string): boolean {
  try {
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }
    return true;
  } catch (error) {
    log.error(`Error creating database directory: ${getErrorMessage(error as any)}`);
    return false;
  }
}
