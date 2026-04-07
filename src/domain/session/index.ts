/**
 * Session Domain Module Index
 * Exports all components for the Session domain module
 */

// Export the adapter and its interface
export { SessionDbAdapter, createSessionProvider } from "./session-db-adapter";

import type { SessionProviderInterface } from "./session-db-adapter";
export type { SessionProviderInterface };

// Export core session types
export type { Session, SessionRecord } from "./types";

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

// Export canonical session directory resolution utility
export { resolveSessionDirectory, _resetCachedProvider } from "./resolve-session-directory";

// Export shared session provider cache
export { getSharedSessionProvider } from "./session-provider-cache";

// Export I/O functions and types from session-db-io
export {
  readSessionDbFile,
  writeSessionsToFile,
  ensureDbDir,
  type SessionDbFileOptions,
} from "./session-db-io";
