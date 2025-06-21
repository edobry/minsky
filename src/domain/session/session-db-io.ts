/**
 * I/O operations for the SessionDB
 * This module contains all file system operations separated from pure functions
 */

import { join, dirname } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { normalizeRepoName } from "../repository-uri";
import type { SessionDbState, SessionRecord } from "./session-db";
import { initializeSessionDbState } from "./session-db";
import { log } from "../../utils/logger";

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
export function readSessionDbFile(_options: SessionDbFileOptions = {}): SessionDbState {
  const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
  const dbPath = options.dbPath || join(xdgStateHome, "minsky", "session-db.json");
  const baseDir = options.baseDir || join(xdgStateHome, "minsky", "git");

  try {
    if (!existsSync(dbPath)) {
      return initializeSessionDbState({ baseDir });
    }

    const data = readFileSync(dbPath, "utf8") as string;
    const sessions = JSON.parse(data);

    // Migrate existing sessions to include repoName
    const migratedSessions = sessions.map((_session: unknown) => {
      if (!session.repoName && session.repoUrl) {
        session.repoName = normalizeRepoName(session.repoUrl);
      }
      return session;
    });

    return {
      sessions: migratedSessions,
      baseDir,
    };
  } catch (___e) {
    log.error(`Error reading session database: ${e instanceof Error ? e.message : String(e)}`);
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
  const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
  const dbPath = options.dbPath || join(xdgStateHome, "minsky", "session-db.json");

  try {
    // Ensure directory exists
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    writeFileSync(dbPath, JSON.stringify(state.sessions, null, 2));
    return true;
  } catch (___error) {
    log.error(
      `Error writing session database: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * Ensure the database directory exists
 */
export function ensureDbDir(_dbPath: string): boolean {
  try {
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }
    return true;
  } catch (___error) {
    log.error(
      `Error creating database directory: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}
