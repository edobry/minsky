/**
 * Session Domain Schemas
 *
 * Interface-agnostic schemas for session-related operations that can be used
 * across CLI, MCP, and API interfaces.
 */
import { z } from "zod";
import {
  SessionIdSchema,
  TaskIdSchema,
  BackendIdSchema,
  RepoIdSchema,
  BaseBackendParametersSchema,
  BaseExecutionContextSchema,
  BaseSuccessResponseSchema,
  BaseErrorResponseSchema,
  ForceSchema,
  QuietSchema,
  DryRunSchema,
} from "./common-schemas";

// ========================
// SESSION METADATA SCHEMAS
// ========================

/**
 * Session description schema - used across all interfaces
 */
export const SessionDescriptionSchema = z.string().min(1, "Session description cannot be empty");

/**
 * Git branch schema - used across all interfaces
 */
export const GitBranchSchema = z.string().optional();

/**
 * Package manager schema - used across all interfaces
 */
export const PackageManagerSchema = z.enum(["bun", "npm", "yarn", "pnpm"]).optional();

/**
 * Session status schema - used across all interfaces
 */
export const SessionStatusSchema = z.enum([
  "active",
  "inactive",
  "in-review",
  "completed",
  "archived",
]);

// ========================
// SESSION OPERATION PARAMETERS
// ========================

/**
 * Session creation parameters.
 *
 * `sessionId` and `description` are OPTIONAL because the operation genuinely
 * runs without them: `session start --task mt#1234` supplies neither, and
 * `validatePreconditions` derives the session id from the task
 * (`start-session-operations.ts`, `let sessionId = inputSessionId`) and treats
 * `description` as a truthy auto-create trigger (`if (description && !taskId)`).
 *
 * They used to be required, which was not a stricter contract — it was a FALSE
 * one, and it cost two defects (mt#3212). Nothing could satisfy it on the
 * `--task` path, so `SessionService.start` bridged the gap with an `as` cast,
 * and a cast makes a MISSING optional field a non-error: `recover` was dropped
 * silently on this exact call chain twice (mt#2742 adapter → service, mt#3955
 * service → domain), both times with every typecheck and test green.
 */
export const SessionStartParametersSchema = z
  .object({
    sessionId: SessionIdSchema.optional(),
    description: SessionDescriptionSchema.optional(),
    task: TaskIdSchema.optional(),
    branch: GitBranchSchema,
    packageManager: PackageManagerSchema,
    skipInstall: z.boolean().default(false),
    noStatusUpdate: z.boolean().default(false),
    quiet: QuietSchema,
    recover: z
      .boolean()
      .optional()
      .describe(
        "Delete existing stale/orphaned session for this task and create fresh (use with caution)"
      ),
  })
  .extend(BaseBackendParametersSchema.shape)
  .extend(BaseExecutionContextSchema.shape);

// mt#3212: `SessionGetParametersSchema`, `SessionListParametersSchema` and
// `SessionDeleteParametersSchema` were DELETED here. Each was a parallel,
// independently-maintained description of an operation whose live contract is
// the `*Params` schema in `./session.ts` — `SessionService.get/list/delete` and
// the `*Impl` functions they call BOTH take the `*Params` type, so these three
// had no consumer beyond their own declaration and the barrel re-export.
//
// Two definitions of one contract is the defect, not an inconvenience: the one
// you find first is not necessarily the one production uses. The
// `SessionDeleteParametersSchema` copy still carried a `force` flag that
// mt#3105 SC5 REMOVED from the live schema, so reading it would have told you
// a destructive guard could be lifted by a bare boolean — which is exactly the
// design mt#3021 rejected.

/**
 * Session update parameters
 */
export const SessionUpdateParametersSchema = z
  .object({
    sessionId: SessionIdSchema.optional(),
    task: TaskIdSchema.optional(),
    branch: GitBranchSchema,
    remote: z.string().optional(),
    dryRun: DryRunSchema,
    force: ForceSchema,
    noPush: z.boolean().default(false),
    noStash: z.boolean().default(false),
    autoResolveDeleteConflicts: z.boolean().default(false),
    skipConflictCheck: z.boolean().default(false),
    skipIfAlreadyMerged: z.boolean().default(false),
    // mt#3205: override the push-phase wall-clock bound (see
    // pushWithConfirmation/DEFAULT_PUSH_CONFIRM_TIMEOUT_MS in
    // push-operations.ts). Same rationale as session.commit's
    // pushTimeoutMs (mt#3049/mt#3177 review R1) — operator-configurable,
    // not just a test-injection seam.
    pushTimeoutMs: z.number().int().positive().optional(),
  })
  .extend(BaseBackendParametersSchema.shape);

// mt#3212: `SessionDirectoryParametersSchema` was DELETED here, for the same
// reason as its three siblings above — `SessionService.getDir` and
// `getSessionDirImpl` both take `SessionDirParams` from `./session.ts`.

/**
 * Session PR creation parameters
 */
export const SessionPRParametersSchema = z
  .object({
    sessionId: SessionIdSchema.optional(),
    session: SessionIdSchema.optional(),
    task: TaskIdSchema.optional(),
    title: z.string().min(1),
    body: z.string().optional(),
    bodyPath: z.string().optional(),
    baseBranch: z.string().optional(),
    debug: z.boolean().default(false),
    noStatusUpdate: z.boolean().default(false),
    skipConflictCheck: z.boolean().default(false),
    skipUpdate: z.boolean().optional(),
    autoResolveDeleteConflicts: z.boolean().default(false),
    draft: z.boolean().default(false),
    // mt#3480 — forwarded to the pre-PR session update's push. Optional with no
    // default so `undefined` falls through to DEFAULT_PUSH_CONFIRM_TIMEOUT_MS,
    // leaving existing callers unchanged.
    pushTimeoutMs: z.number().int().positive().optional(),
  })
  .extend(BaseBackendParametersSchema.shape);

// mt#3212: `SessionApproveParametersSchema` was DELETED here — declaration-only,
// like the four above. Approve's live parameter type is the hand-written
// `SessionApproveParams` interface in `../session/session-commands.ts`, which
// `pureSessionApprove` actually takes.

/**
 * Session commit parameters
 */
export const SessionCommitParametersSchema = z.object({
  sessionId: SessionIdSchema,
  message: z.string().min(1),
  all: z.boolean().default(false),
  amend: z.boolean().default(false),
  noStage: z.boolean().default(false),
  oneline: z.boolean().default(false).optional(),
  noFiles: z.boolean().default(false).optional(),
});

// ========================
// SESSION RESPONSE SCHEMAS
// ========================

/**
 * Base session data schema
 */
export const BaseSessionDataSchema = z.object({
  sessionId: SessionIdSchema,
  description: SessionDescriptionSchema,
  taskId: TaskIdSchema.optional(),
  branch: GitBranchSchema,
  status: SessionStatusSchema.optional(),
  directory: z.string().optional(),
  repository: RepoIdSchema.optional(),
  backend: BackendIdSchema.optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  lastCommit: z.string().optional(),
  pullRequestUrl: z.string().optional(),
});

/**
 * Session operation response schema
 */
export const SessionOperationResponseSchema = z.union([
  BaseSuccessResponseSchema.extend({
    session: BaseSessionDataSchema,
    message: z.string().optional(),
    directory: z.string().optional(),
  }),
  BaseErrorResponseSchema.extend({
    sessionId: SessionIdSchema.optional(),
  }),
]);

/**
 * Session list response schema
 */
export const SessionListResponseSchema = z.union([
  BaseSuccessResponseSchema.extend({
    sessions: z.array(BaseSessionDataSchema),
    totalCount: z.number().optional(),
    hasMore: z.boolean().optional(),
  }),
  BaseErrorResponseSchema,
]);

/**
 * Session directory response schema
 */
export const SessionDirectoryResponseSchema = z.union([
  BaseSuccessResponseSchema.extend({
    sessionId: SessionIdSchema,
    directory: z.string(),
  }),
  BaseErrorResponseSchema.extend({
    sessionId: SessionIdSchema.optional(),
  }),
]);

/**
 * Session PR response schema
 */
export const SessionPRResponseSchema = z.union([
  BaseSuccessResponseSchema.extend({
    sessionId: SessionIdSchema,
    pullRequestUrl: z.string(),
    pullRequestNumber: z.number().optional(),
    title: z.string(),
    body: z.string().optional(),
  }),
  BaseErrorResponseSchema.extend({
    sessionId: SessionIdSchema.optional(),
  }),
]);

/**
 * Session commit response schema
 */
export const SessionCommitResponseSchema = z.union([
  BaseSuccessResponseSchema.extend({
    sessionId: SessionIdSchema,
    commitHash: z.string(),
    shortHash: z.string().optional(),
    subject: z.string().optional(),
    branch: z.string().optional(),
    authorName: z.string().optional(),
    authorEmail: z.string().optional(),
    timestamp: z.string().optional(),
    message: z.string(),
    filesChanged: z.number().optional(),
    insertions: z.number().optional(),
    deletions: z.number().optional(),
    files: z
      .array(
        z.object({
          path: z.string(),
          status: z.string(),
        })
      )
      .optional(),
  }),
  BaseErrorResponseSchema.extend({
    sessionId: SessionIdSchema.optional(),
  }),
]);

// ========================
// TYPE EXPORTS
// ========================

// SessionId type is already exported from common-schemas.ts
export type SessionDescription = z.infer<typeof SessionDescriptionSchema>;
export type GitBranch = z.infer<typeof GitBranchSchema>;
export type PackageManager = z.infer<typeof PackageManagerSchema>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type SessionStartParameters = z.infer<typeof SessionStartParametersSchema>;
export type SessionUpdateParameters = z.infer<typeof SessionUpdateParametersSchema>;
export type SessionPRParameters = z.infer<typeof SessionPRParametersSchema>;
export type SessionCommitParameters = z.infer<typeof SessionCommitParametersSchema>;
// mt#3212: the `SessionGet/List/Delete/Directory/ApproveParameters` types were
// deleted with the schemas they inferred from — see the comments above each
// deletion site. The surviving four are the ones with live consumers.
export type BaseSessionData = z.infer<typeof BaseSessionDataSchema>;
export type SessionOperationResponse = z.infer<typeof SessionOperationResponseSchema>;
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;
export type SessionDirectoryResponse = z.infer<typeof SessionDirectoryResponseSchema>;
export type SessionPRResponse = z.infer<typeof SessionPRResponseSchema>;
export type SessionCommitResponse = z.infer<typeof SessionCommitResponseSchema>;
