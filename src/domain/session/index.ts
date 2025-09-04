/**
 * Session Domain Module Index
 * Exports all components for the Session domain module
 */

// Export the adapter and its interface
export {
  SessionDbAdapter,
  createSessionProvider,
  type SessionProviderInterface,
} from "./session-db-adapter";

// Export core types from session-db
export type { SessionDbState } from "./session-db";

// Export pure functions from session-db
export {
  initializeSessionDbState,
  listSessionsFn,
  getSessionFn,
  getSessionByTaskIdFn,
  addSessionFn,
  updateSessionFn,
  deleteSessionFn,
  getRepoPathFn,
  getSessionWorkdirFn,
} from "./session-db";

// Export I/O functions and types from session-db-io
export {
  readSessionDbFile,
  writeSessionsToFile,
  ensureDbDir,
  type SessionDbFileOptions,
} from "./session-db-io";

// Create factory function for dependency injection instead of singleton
import { createSessionProvider as createSessionProviderInternal } from "./session-db-adapter";

/**
 * Creates a new SessionDB instance for dependency injection
 * Use this instead of a global singleton to ensure test isolation
 */
export function createSessionDB() {
  return createSessionProviderInternal();
}

// For backward compatibility and convenience, export a lazily-initialized default instance
// However, tests should use createSessionDB() for isolation
let _lazySessionDB: SessionProviderInterface | null = null;
export const _SessionDB = {
  get instance() {
    if (!_lazySessionDB) {
      _lazySessionDB = createSessionProviderInternal();
    }
    return _lazySessionDB;
  }
};
