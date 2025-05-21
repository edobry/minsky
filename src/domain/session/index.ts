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
