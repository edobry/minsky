/**
 * I/O operations for SessionDB
 * This module contains functions that handle side effects (file system operations)
 * for the SessionDB. These functions are separated from the pure functions to isolate
 * side effects.
 */

import { readFile, writeFile, mkdir, access, rename } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import type { SessionRecord } from "./session-db.js";
import { normalizeRepoName } from "../repository-uri.js";

/**
 * Reads the session database file from disk
 * @param dbPath Path to the session database file
 * @returns Array of session records
 */
export async function readSessionDbFile(dbPath: string): Promise<SessionRecord[]> {
  try {
    if (!existsSync(dbPath)) {
      return [];
    }
    const data = await readFile(dbPath, "utf8");
    const sessions = JSON.parse(data);

    // Migrate existing sessions to include repoName
    return sessions.map((session: SessionRecord) => {
      if (!session.repoName && session.repoUrl) {
        session.repoName = normalizeRepoName(session.repoUrl);
      }
      return session;
    });
  } catch (e) {
    return [];
  }
}

/**
 * Ensures the database directory exists
 * @param dbPath Path to the database file
 */
export async function ensureDbDir(dbPath: string): Promise<void> {
  const dbDir = dirname(dbPath);
  await mkdir(dbDir, { recursive: true });
}

/**
 * Writes the session database to disk
 * @param dbPath Path to the session database file
 * @param sessions Session records to write
 */
export async function writeSessionDbFile(dbPath: string, sessions: SessionRecord[]): Promise<void> {
  try {
    await ensureDbDir(dbPath);
    await writeFile(dbPath, JSON.stringify(sessions, null, 2));
  } catch (error) {
    console.error(
      `Error writing session database: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Checks if a repository exists at the given path
 * @param path Path to check
 * @returns True if the repository exists
 */
export async function repoExistsFn(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Calculates the default session database path
 * @returns Default path to the session database file
 */
export function getDefaultDbPath(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
  return join(xdgStateHome, "minsky", "session-db.json");
}

/**
 * Calculates the default base directory path for git repositories
 * @returns Default path to the git repositories base directory
 */
export function getDefaultBaseDir(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
  return join(xdgStateHome, "minsky", "git");
}

/**
 * Creates the base directory structure if it doesn't exist
 * @param baseDir Base directory path
 */
export async function ensureBaseDir(baseDir: string): Promise<void> {
  await mkdir(baseDir, { recursive: true });
}

/**
 * Migrates sessions to the new directory structure
 * @param baseDir Base directory for git repositories
 * @param sessions Session records to migrate
 * @returns Updated session records after migration
 */
export async function migrateSessionsToSubdirectoryFn(
  baseDir: string,
  sessions: SessionRecord[]
): Promise<{ sessions: SessionRecord[]; modified: boolean }> {
  let modified = false;
  const updatedSessions = [...sessions];

  for (let i = 0; i < updatedSessions.length; i++) {
    const session = updatedSessions[i];

    // Skip sessions without required properties or those already in new structure
    if (!session || !session.repoName || !session.session) {
      continue;
    }

    if (session.repoPath && session.repoPath.includes("/sessions/")) {
      continue;
    }

    const legacyPath = join(baseDir, session.repoName, session.session);
    const newPath = join(baseDir, session.repoName, "sessions", session.session);

    // Check if legacy path exists
    if (await repoExistsFn(legacyPath)) {
      // Create new path directory structure
      await mkdir(join(baseDir, session.repoName, "sessions"), { recursive: true });

      // Move repository to new location
      try {
        await rename(legacyPath, newPath);
        // Update session record
        updatedSessions[i] = { ...session, repoPath: newPath };
        modified = true;
      } catch (err) {
        console.error(`Failed to migrate session ${session.session}:`, err);
      }
    }
  }

  return { sessions: updatedSessions, modified };
}
