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
// Legacy-compatible reader: accepts a file path string and returns sessions array
export function readSessionDbFile(
  optionsOrPath: SessionDbFileOptions | string | undefined | null = {}
): any {
  const isStringPath = typeof optionsOrPath === "string";
  const safeOptions: SessionDbFileOptions = isStringPath
    ? { dbPath: optionsOrPath as string }
    : optionsOrPath || {};
  const state = readSessionDbState(safeOptions);
  return isStringPath ? state.sessions : state;
}

// Structured state reader used internally and by newer code
export function readSessionDbState(
  options: SessionDbFileOptions | undefined | null = {}
): SessionDbState {
  const safeOptions = options || {};
  const stateDir = getMinskyStateDir();
  const dbPath = safeOptions.dbPath || getDefaultJsonDbPath();
  const baseDir = safeOptions.baseDir || stateDir;

  try {
    if (!existsSync(dbPath)) {
      return {
        sessions: [],
        baseDir: baseDir,
      };
    }

    const data = readFileSync(dbPath, "utf8") as string;
    const parsed = JSON.parse(data);

    // Handle both legacy format (array) and new format (SessionDbState object)
    if (Array.isArray(parsed)) {
      // Legacy format: file contains just the sessions array
      return {
        sessions: parsed,
        baseDir: baseDir,
      };
    } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.sessions)) {
      // New format: file contains SessionDbState object
      return {
        sessions: parsed.sessions,
        baseDir: parsed.baseDir || baseDir,
      };
    } else {
      // Invalid or corrupted data, return empty state
      log.warn(`Invalid session database format in ${dbPath}, initializing empty state`);
      return {
        sessions: [],
        baseDir: baseDir,
      };
    }
  } catch (error) {
    log.error(`Error reading session database: ${getErrorMessage(error as any)}`);
    return {
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

/**
 * Backward-compatibility: write session DB to explicit file path
 */
export function writeSessionDbFile(filePath: string, sessions: SessionRecord[]): void {
  try {
    const dbDir = dirname(filePath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }
    writeFileSync(filePath, JSON.stringify(sessions, undefined, 2), "utf8");
  } catch (error) {
    log.error(`Error writing session database to ${filePath}: ${getErrorMessage(error as any)}`);
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
