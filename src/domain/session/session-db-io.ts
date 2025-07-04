/**
 * I/O operations for the SessionDB
 * This module contains all file system operations separated from pure functions
 */

import { join, dirname } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { normalizeRepoName } from "../repository-uri";
import type { SessionDbState } from "./session-db";
import { initializeSessionDbState } from "./session-db";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";

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
export function readSessionDbFile(options: SessionDbFileOptions = {}): SessionDbState {
  const xdgStateHome = (process.env as any).XDGSTATE_HOME || join((process.env as any).HOME || "", ".local/state");
  const dbPath = (options as any).dbPath || join(xdgStateHome, "minsky", "session-db.json");
  const baseDir = (options as any).baseDir || join(xdgStateHome, "minsky");

  try {
    if (!existsSync(dbPath)) {
      return initializeSessionDbState({ baseDir });
    }

    const data = readFileSync(dbPath, "utf8") as string;
    const sessions = JSON.parse(data as any);

    return {
      sessions,
      baseDir,
    };
  } catch (error) {
    log.error(`Error reading session database: ${getErrorMessage(error as any)}`);
    return initializeSessionDbState({ baseDir });
  }
}

/**
 * Write sessions to the database file
 */
export function writeSessionDbFile(
  state: SessionDbState,
  options: SessionDbFileOptions = {}
): boolean {
  const xdgStateHome = (process.env as any).XDGSTATE_HOME || join((process.env as any).HOME || "", ".local/state");
  const dbPath = (options as any).dbPath || join(xdgStateHome, "minsky", "session-db.json");

  try {
    // Ensure directory exists
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    writeFileSync(dbPath, JSON.stringify((state as any).sessions, undefined, 2));
    return true;
  } catch (error) {
    log.error(`Error writing session database: ${getErrorMessage(error as any)}`);
    return false;
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
