/**
 * Session Domain Module Index
 * Exports all components for the Session domain module
 */

// Import SessionProviderInterface
import type { SessionProviderInterface } from "../session.js";
import { SessionDbAdapter } from "./session-adapter.js";

// Export core types and interfaces
export type { SessionRecord, SessionDbState, SessionDbConfig } from "./session-db.js";

// Export pure functions
export {
  listSessionsFn,
  getSessionFn,
  getSessionByTaskIdFn,
  addSessionFn,
  updateSessionFn,
  deleteSessionFn,
  getRepoPathFn,
  getSessionWorkdirFn,
  getNewSessionRepoPathFn,
  initializeSessionDbState,
} from "./session-db.js";

// Export I/O operations
export {
  readSessionDbFile,
  writeSessionDbFile,
  ensureDbDir,
  repoExistsFn,
  getDefaultDbPath,
  getDefaultBaseDir,
  ensureBaseDir,
  migrateSessionsToSubdirectoryFn,
} from "./session-db-io.js";

// Export adapter for backward compatibility
export { SessionDbAdapter } from "./session-adapter.js";

// Factory function for creating a session provider
export function createSessionProvider(options?: { dbPath?: string }): SessionProviderInterface {
  return new SessionDbAdapter(options?.dbPath);
}

/**
 * Session module exports
 */

// Export the adapter as the default session provider
export { 
  SessionAdapter,
  createSessionProvider,
  type SessionProviderInterface 
} from "./session-adapter";

// Export session record type
export type { SessionRecord, SessionDbState } from "./session-db";

// Export I/O functions
export {
  readSessionDbFile,
  writeSessionDbFile,
  ensureDbDir,
  type SessionDbFileOptions
} from "./session-db-io";

// Create and export default session provider instance
import { createSessionProvider } from "./session-adapter";
export const SessionDB = createSessionProvider();
