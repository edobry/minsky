/**
 * Session Domain Module Index
 * Exports all components for the Session domain module
 */

// Export the session provider factory (DrizzleSessionRepository + auto-repair)
export { createSessionProvider } from "./drizzle-session-repository";

import type { SessionProviderInterface } from "./types";
export type { SessionProviderInterface };

// Export core session types
export type { Session, SessionRecord, SessionLiveness } from "./types";
export { SessionStatus, deriveSessionLiveness } from "./types";

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
export { resolveSessionDirectory } from "./resolve-session-directory";

// Export read-only interfaces for ADR-004 validate() phase
export type { ReadonlySessionProvider } from "./readonly-interfaces";
