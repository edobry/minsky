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
    const sessions = JSON.parse(data);

    return {
      sessions: sessions,
      baseDir: baseDir,
    };
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
