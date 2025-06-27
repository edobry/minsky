/**
 * Session Domain Module Index
 * Exports all components for the Session domain module
 */

// Export the adapter and its interface
export {
  SessionAdapter,
  createSessionProvider,
  type LocalSessionProviderInterface,
} from "./session-adapter";

// Export core types from session-db
export type {SessionDbState } from "./session-db";

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
  writeSessionDbFile,
  ensureDbDir,
  type SessionDbFileOptions,
} from "./session-db-io";

// Create and export a default session provider instance for convenience
import { createSessionProvider as createSessionProviderInternal } from "./session-adapter";
export const SessionDB = createSessionProviderInternal();
