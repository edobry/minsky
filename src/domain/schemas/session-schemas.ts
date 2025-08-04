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
  WorkspacePathSchema,
  BaseBackendParametersSchema,
  BaseExecutionContextSchema,
  BaseListingParametersSchema,
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
 * Session name schema - used across all interfaces
 */
export const SessionNameSchema = z.string().min(1, "Session name cannot be empty");

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
 * Session creation parameters
 */
export const SessionStartParametersSchema = z
  .object({
    name: SessionNameSchema,
    description: SessionDescriptionSchema,
    task: TaskIdSchema.optional(),
    branch: GitBranchSchema,
    packageManager: PackageManagerSchema,
    skipInstall: z.boolean().default(false),
    noStatusUpdate: z.boolean().default(false),
    quiet: QuietSchema,
  })
  .merge(BaseBackendParametersSchema)
  .merge(BaseExecutionContextSchema);

/**
 * Session retrieval parameters
 */
export const SessionGetParametersSchema = z
  .object({
    sessionName: SessionNameSchema.optional(),
    name: SessionNameSchema.optional(),
    task: TaskIdSchema.optional(),
  })
  .merge(BaseBackendParametersSchema);

/**
 * Session listing parameters
 */
export const SessionListParametersSchema = BaseBackendParametersSchema.merge(
  BaseExecutionContextSchema
).merge(BaseListingParametersSchema);

/**
 * Session deletion parameters
 */
export const SessionDeleteParametersSchema = z
  .object({
    sessionName: SessionNameSchema.optional(),
    name: SessionNameSchema.optional(),
    task: TaskIdSchema.optional(),
    force: ForceSchema,
  })
  .merge(BaseBackendParametersSchema);

/**
 * Session update parameters
 */
export const SessionUpdateParametersSchema = z
  .object({
    sessionName: SessionNameSchema.optional(),
    name: SessionNameSchema.optional(),
    session: SessionIdSchema.optional(),
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
  })
  .merge(BaseBackendParametersSchema);

/**
 * Session directory parameters
 */
export const SessionDirectoryParametersSchema = z
  .object({
    sessionName: SessionNameSchema.optional(),
    name: SessionNameSchema.optional(),
    task: TaskIdSchema.optional(),
  })
  .merge(BaseBackendParametersSchema);

/**
 * Session PR creation parameters
 */
export const SessionPRParametersSchema = z
  .object({
    sessionName: SessionNameSchema.optional(),
    name: SessionNameSchema.optional(),
    session: SessionIdSchema.optional(),
    task: TaskIdSchema.optional(),
    title: z.string().min(1),
    body: z.string().optional(),
    bodyPath: z.string().optional(),
    baseBranch: z.string().optional(),
    debug: z.boolean().default(false),
    noStatusUpdate: z.boolean().default(false),
    skipConflictCheck: z.boolean().default(false),

    autoResolveDeleteConflicts: z.boolean().default(false),
  })
  .merge(BaseBackendParametersSchema);

/**
 * Session approval parameters
 */
export const SessionApproveParametersSchema = z
  .object({
    sessionName: SessionNameSchema.optional(),
    name: SessionNameSchema.optional(),
    session: SessionIdSchema.optional(),
    task: TaskIdSchema.optional(),
    noStash: z.boolean().default(false),
  })
  .merge(BaseBackendParametersSchema);

/**
 * Session commit parameters
 */
export const SessionCommitParametersSchema = z.object({
  sessionName: SessionNameSchema,
  message: z.string().min(1),
  all: z.boolean().default(false),
  amend: z.boolean().default(false),
  noStage: z.boolean().default(false),
});

// ========================
// SESSION RESPONSE SCHEMAS
// ========================

/**
 * Base session data schema
 */
export const BaseSessionDataSchema = z.object({
  name: SessionNameSchema,
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
    sessionName: SessionNameSchema.optional(),
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
    sessionName: SessionNameSchema,
    directory: z.string(),
  }),
  BaseErrorResponseSchema.extend({
    sessionName: SessionNameSchema.optional(),
  }),
]);

/**
 * Session PR response schema
 */
export const SessionPRResponseSchema = z.union([
  BaseSuccessResponseSchema.extend({
    sessionName: SessionNameSchema,
    pullRequestUrl: z.string(),
    pullRequestNumber: z.number().optional(),
    title: z.string(),
    body: z.string().optional(),
  }),
  BaseErrorResponseSchema.extend({
    sessionName: SessionNameSchema.optional(),
  }),
]);

/**
 * Session commit response schema
 */
export const SessionCommitResponseSchema = z.union([
  BaseSuccessResponseSchema.extend({
    sessionName: SessionNameSchema,
    commitHash: z.string(),
    message: z.string(),
    filesChanged: z.number().optional(),
  }),
  BaseErrorResponseSchema.extend({
    sessionName: SessionNameSchema.optional(),
  }),
]);

// ========================
// TYPE EXPORTS
// ========================

export type SessionName = z.infer<typeof SessionNameSchema>;
export type SessionDescription = z.infer<typeof SessionDescriptionSchema>;
export type GitBranch = z.infer<typeof GitBranchSchema>;
export type PackageManager = z.infer<typeof PackageManagerSchema>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type SessionStartParameters = z.infer<typeof SessionStartParametersSchema>;
export type SessionGetParameters = z.infer<typeof SessionGetParametersSchema>;
export type SessionListParameters = z.infer<typeof SessionListParametersSchema>;
export type SessionDeleteParameters = z.infer<typeof SessionDeleteParametersSchema>;
export type SessionUpdateParameters = z.infer<typeof SessionUpdateParametersSchema>;
export type SessionDirectoryParameters = z.infer<typeof SessionDirectoryParametersSchema>;
export type SessionPRParameters = z.infer<typeof SessionPRParametersSchema>;
export type SessionApproveParameters = z.infer<typeof SessionApproveParametersSchema>;
export type SessionCommitParameters = z.infer<typeof SessionCommitParametersSchema>;
export type BaseSessionData = z.infer<typeof BaseSessionDataSchema>;
export type SessionOperationResponse = z.infer<typeof SessionOperationResponseSchema>;
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;
export type SessionDirectoryResponse = z.infer<typeof SessionDirectoryResponseSchema>;
export type SessionPRResponse = z.infer<typeof SessionPRResponseSchema>;
export type SessionCommitResponse = z.infer<typeof SessionCommitResponseSchema>;
