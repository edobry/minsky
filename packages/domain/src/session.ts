/**
 * Session domain facade
 *
 * This module aggregates session sub-modules and exposes a stable public API.
 * All session logic lives in the sub-modules under ./session/.
 * Callers should use SessionService directly for all session operations.
 */

import type { SessionReviewParams, SessionReviewResult } from "./session/session-review-operations";
import { sessionCommit } from "./session/session-commands";

import { SessionService, type SessionDeps } from "./session/session-service";

// Re-export canonical types from sub-modules
export type { Session, SessionProviderInterface, SessionRecord } from "./session/types";
export type { SessionDbState } from "./session/session-db";

// Re-export factory and adapter
export { createSessionProvider } from "./session/session-db-adapter";
export { SessionDbAdapter } from "./session/session-db-adapter";

// Re-export review types
export type { SessionReviewParams, SessionReviewResult };

// Re-export PR state cache helpers
export {
  checkPrBranchExists,
  checkPrBranchExistsOptimized,
  updatePrStateOnCreation,
  updatePrStateOnMerge,
} from "./session/session-update-operations";

// Re-export new session-scoped git commands
export { sessionCommit };

// Re-export SessionService and related types for consumers
export { SessionService };
export type { SessionDeps };
