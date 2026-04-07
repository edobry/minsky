/**
 * Session Commands Module
 *
 * Re-exports factory functions and the `SessionCommandDependencies` type
 * for the session command factories. Command registration is performed
 * by `registerSessionCommands` in `../session.ts`.
 */

export type { SessionCommandDependencies } from "./types";

export * from "./session-parameters";

export {
  createSessionListCommand,
  createSessionGetCommand,
  createSessionStartCommand,
  createSessionDirCommand,
  createSessionSearchCommand,
} from "./basic-commands";

export {
  createSessionDeleteCommand,
  createSessionUpdateCommand,
  createSessionMigrateBackendCommand,
} from "./management-commands";

export {
  createSessionCommitCommand,
  createSessionApproveCommand,
  createSessionInspectCommand,
  createSessionReviewCommand,
  createSessionPrApproveCommand,
  createSessionPrMergeCommand,
  createSessionPrCreateCommand,
  createSessionPrEditCommand,
  createSessionPrListCommand,
  createSessionPrGetCommand,
  createSessionPrOpenCommand,
} from "./workflow-commands";

export { createSessionConflictsCommand } from "./conflicts-command";
export { createSessionRepairCommand } from "./repair-command";
export { createSessionEditFileCommand } from "./file-commands";
export { registerSessionChangesetCommands } from "./changeset-aliases";
