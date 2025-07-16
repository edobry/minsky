import { existsSync, rmSync } from "fs";
import { readFile, writeFile, mkdir, access, rename } from "fs/promises";
import { join } from "path";
import { getMinskyStateDir, getSessionDir } from "../utils/paths";
import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
  createCommandFailureMessage,
  createErrorContext
} from "../errors/index";
import { taskIdSchema } from "../schemas/common";
import type {
  SessionListParams,
  SessionGetParams,
  SessionStartParams,
  SessionDeleteParams,
  SessionDirParams,
  SessionUpdateParams,
  SessionPrParams,
} from "../schemas/session";
import { log } from "../utils/logger";
import { installDependencies } from "../utils/package-manager";
import { type GitServiceInterface, preparePrFromParams } from "./git";
import { createGitService } from "./git";
import { ConflictDetectionService } from "./git/conflict-detection";
import { normalizeRepoName, resolveRepoPath } from "./repo-utils";
import { TaskService, TASK_STATUS, type TaskServiceInterface } from "./tasks";
import { execAsync } from "../utils/exec";
import {
  type WorkspaceUtilsInterface,
  getCurrentSession,
  getCurrentSessionContext,
} from "./workspace";
import * as WorkspaceUtils from "./workspace";
import { SessionDbAdapter } from "./session/session-db-adapter";
import { createTaskFromDescription } from "./templates/session-templates";
import { resolveSessionContextWithFeedback } from "./session/session-context-resolver";

// Domain Session - Lightweight Orchestration Layer
// Delegates to extracted command and operation modules

// Re-export all types from the extracted types module
export * from "./session/types";

// Import command implementations from extracted modules
import { listSessionsFromParams } from "./session/commands/list-command";
import { getSessionFromParams } from "./session/commands/get-command";
import { startSessionFromParams } from "./session/commands/start-command";
import { deleteSessionFromParams } from "./session/commands/delete-command";
import { getSessionDirFromParams } from "./session/commands/dir-command";
import { updateSessionFromParams } from "./session/commands/update-command";
import { sessionPrFromParams } from "./session/commands/pr-command";
import { approveSessionFromParams } from "./session/commands/approve-command";
import { sessionReviewFromParams } from "./session/commands/review-command";
import { inspectSessionFromParams } from "./session/commands/inspect-command";

// Import operation implementations from extracted modules
import { createSessionProvider } from "./session/session-db-adapter";

// Re-export command functions (delegating to extracted implementations)
export { listSessionsFromParams as sessionList };
export { getSessionFromParams as sessionGet };
export { startSessionFromParams as sessionStart };
export { deleteSessionFromParams as sessionDelete };
export { getSessionDirFromParams as sessionDir };
export { updateSessionFromParams as sessionUpdate };
export { sessionPrFromParams as sessionPr };
export { approveSessionFromParams as sessionApprove };
export { sessionReviewFromParams as sessionReview };
export { inspectSessionFromParams as sessionInspect };

// Re-export provider factory
export { createSessionProvider };

// Re-export utility functions and classes from their extracted modules
export { SessionDbAdapter } from "./session/session-db-adapter";
export { resolveSessionContextWithFeedback } from "./session/session-context-resolver";

// Legacy compatibility - ensure all existing imports continue to work
export type { Session, SessionRecord } from "./session/types";
