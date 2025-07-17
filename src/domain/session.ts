// Domain Session - Lightweight Orchestration Layer
// Delegates to extracted command and operation modules

// Re-export all types from the extracted types module
export * from "./session/types";

// Import command implementations from extracted modules
import { sessionList } from "./session/commands/list-command";
import { sessionGet } from "./session/commands/get-command";
import { sessionStart } from "./session/commands/start-command";
import { sessionDelete } from "./session/commands/delete-command";
import { getSessionDirFromParams } from "./session/commands/dir-command";
import { sessionUpdate } from "./session/commands/update-command";
import { sessionPr } from "./session/commands/pr-command";
import { sessionApprove } from "./session/commands/approve-command";
import { sessionReview } from "./session/commands/review-command";
import { sessionInspect } from "./session/commands/inspect-command";

// Import operation implementations from extracted modules
import { createSessionProvider } from "./session/session-db-adapter";

// Import types for function signatures
import type {
  SessionListParams,
  SessionGetParams,
  SessionStartParams,
  SessionDeleteParams,
  SessionDirParams,
  SessionUpdateParams,
  SessionPrParams,
} from "../schemas/session";

// Re-export command functions (delegating to extracted implementations)
export { sessionList };
export { sessionGet };
export { sessionStart };
export { sessionDelete };
export { getSessionDirFromParams as sessionDir };
export { sessionUpdate };
export { sessionPr };
export { sessionApprove };
export { sessionReview };
export { sessionInspect };

// Re-export provider factory
export { createSessionProvider };

// Re-export utility functions and classes from their extracted modules
export { SessionDbAdapter } from "./session/session-db-adapter";
export { resolveSessionContextWithFeedback } from "./session/session-context-resolver";

// Legacy compatibility - ensure all existing imports continue to work
export type { Session, SessionRecord } from "./session/types";

// Legacy exports with FromParams naming convention for backward compatibility
export { sessionApprove as approveSessionFromParams };
export { sessionDelete as deleteSessionFromParams };
export { sessionUpdate as updateSessionFromParams };
export { getSessionDirFromParams };
