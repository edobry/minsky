/**
 * CLI Parameter Schemas
 * 
 * CLI-specific parameter schemas that extend domain schemas to provide
 * standardized parameter validation patterns for CLI commands.
 * This applies the type composition patterns from Tasks #322 and #329.
 */
import { z } from "zod";
import {
  TaskIdSchema,
  SessionIdSchema,
  RepoIdSchema,
  BackendIdSchema,
  WorkspacePathSchema,
  OutputFormatSchema,
  VerbositySchema,
  ForceSchema,
  DebugSchema,
  AllSchema,
  QuietSchema,
  DryRunSchema,
  FilterSchema,
  LimitSchema,
  BaseExecutionContextSchema,
  BaseBackendParametersSchema,
  BaseListingParametersSchema,
} from "../../../domain/schemas/common-schemas";
import {
  TaskCreateParametersSchema,
  TaskUpdateParametersSchema,
  TaskListParametersSchema,
  TaskGetParametersSchema,
  TaskDeleteParametersSchema,
  TaskStatusSchema,
} from "../../../domain/schemas/task-schemas";
import {
  SessionStartParametersSchema,
  SessionGetParametersSchema,
  SessionListParametersSchema,
  SessionDeleteParametersSchema,
  SessionUpdateParametersSchema,
} from "../../../domain/schemas/session-schemas";

// ========================
// CLI-SPECIFIC PARAMETER SCHEMAS
// ========================

/**
 * CLI output control parameters for all commands
 */
export const CliOutputParametersSchema = z.object({
  json: z.boolean().default(false).describe("Output in JSON format"),
  quiet: QuietSchema.describe("Suppress non-essential output"),
  verbose: z.boolean().default(false).describe("Show verbose output"),
  debug: DebugSchema.describe("Show debug output"),
});

/**
 * CLI global parameters that are available to all commands
 */
export const CliGlobalParametersSchema = z.object({
  format: OutputFormatSchema.describe("Output format"),
  verbosity: VerbositySchema.describe("Verbosity level"),
  config: z.string().optional().describe("Path to configuration file"),
  workspaceDir: WorkspacePathSchema.optional().describe("Workspace directory"),
});

/**
 * CLI help and version parameters
 */
export const CliMetaParametersSchema = z.object({
  help: z.boolean().default(false).describe("Show help information"),
  version: z.boolean().default(false).describe("Show version information"),
});

// ========================
// COMPOSED CLI PARAMETER SCHEMAS
// ========================

/**
 * Base CLI parameters that all commands inherit
 */
export const CliBaseParametersSchema = CliOutputParametersSchema
  .merge(CliGlobalParametersSchema)
  .merge(CliMetaParametersSchema);

/**
 * CLI task list parameters with CLI-specific extensions
 */
export const CliTaskListParametersSchema = TaskListParametersSchema
  .merge(CliBaseParametersSchema)
  .extend({
    status: z.array(TaskStatusSchema).optional().describe("Filter by task status"),
    completed: AllSchema.describe("Include completed tasks"),
  });

/**
 * CLI task get parameters with CLI-specific extensions
 */
export const CliTaskGetParametersSchema = TaskGetParametersSchema
  .merge(CliBaseParametersSchema)
  .extend({
    section: z.string().optional().describe("Specific section to retrieve"),
  });

/**
 * CLI task create parameters with CLI-specific extensions
 */
export const CliTaskCreateParametersSchema = TaskCreateParametersSchema
  .merge(CliBaseParametersSchema)
  .extend({
    descriptionPath: z.string().optional().describe("Path to file containing task description"),
    interactive: z.boolean().default(false).describe("Interactive task creation"),
  });

/**
 * CLI task update parameters with CLI-specific extensions
 */
export const CliTaskUpdateParametersSchema = TaskUpdateParametersSchema
  .merge(CliBaseParametersSchema);

/**
 * CLI task delete parameters with CLI-specific extensions
 */
export const CliTaskDeleteParametersSchema = TaskDeleteParametersSchema
  .merge(CliBaseParametersSchema)
  .extend({
    confirm: z.boolean().default(false).describe("Skip confirmation prompt"),
  });

/**
 * CLI session list parameters with CLI-specific extensions
 */
export const CliSessionListParametersSchema = SessionListParametersSchema
  .merge(CliBaseParametersSchema)
  .extend({
    current: z.boolean().default(false).describe("Show only current session"),
    showPaths: z.boolean().default(false).describe("Show session workspace paths"),
  });

/**
 * CLI session get parameters with CLI-specific extensions
 */
export const CliSessionGetParametersSchema = SessionGetParametersSchema
  .merge(CliBaseParametersSchema)
  .extend({
    showPath: z.boolean().default(false).describe("Show session workspace path"),
  });

/**
 * CLI session create parameters with CLI-specific extensions
 */
export const CliSessionCreateParametersSchema = SessionStartParametersSchema
  .merge(CliBaseParametersSchema)
  .extend({
    autoStart: z.boolean().default(true).describe("Automatically start the session"),
    clone: z.boolean().default(true).describe("Clone repository into session workspace"),
  });

/**
 * CLI session delete parameters with CLI-specific extensions
 */
export const CliSessionDeleteParametersSchema = SessionDeleteParametersSchema
  .merge(CliBaseParametersSchema)
  .extend({
    deleteWorkspace: z.boolean().default(false).describe("Also delete session workspace"),
  });

/**
 * CLI session update parameters with CLI-specific extensions
 */
export const CliSessionUpdateParametersSchema = SessionUpdateParametersSchema
  .merge(CliBaseParametersSchema)
  .extend({
    pull: z.boolean().default(true).describe("Pull latest changes from main branch"),
  });

// ========================
// CLI COMMAND COMPOSITION PATTERNS
// ========================

/**
 * Creates a CLI command schema by combining domain schema with CLI extensions
 */
export function createCliCommandSchema(
  domainSchema: z.ZodObject<any>,
  cliExtensions?: z.ZodRawShape,
  includeBase: boolean = true
): z.ZodObject<any> {
  let schema = domainSchema;
  
  if (cliExtensions) {
    schema = schema.extend(cliExtensions);
  }
  
  if (includeBase) {
    schema = schema.merge(CliBaseParametersSchema);
  }
  
  return schema;
}

/**
 * Creates a CLI listing command schema with standard pagination and filtering
 */
export function createCliListingCommandSchema(
  domainListingSchema: z.ZodObject<any>,
  cliExtensions?: z.ZodRawShape
): z.ZodObject<any> {
  return createCliCommandSchema(domainListingSchema, cliExtensions);
}

/**
 * Creates a CLI CRUD command schema with standard parameters
 */
export function createCliCrudCommandSchema(
  domainCrudSchema: z.ZodObject<any>,
  cliExtensions?: z.ZodRawShape,
  includeForce: boolean = false
): z.ZodObject<any> {
  const extensions = includeForce 
    ? { ...cliExtensions, force: ForceSchema }
    : cliExtensions;
    
  return createCliCommandSchema(domainCrudSchema, extensions);
}

// ========================
// TYPE EXPORTS
// ========================

export type CliOutputParameters = z.infer<typeof CliOutputParametersSchema>;
export type CliGlobalParameters = z.infer<typeof CliGlobalParametersSchema>;
export type CliMetaParameters = z.infer<typeof CliMetaParametersSchema>;
export type CliBaseParameters = z.infer<typeof CliBaseParametersSchema>;
export type CliTaskListParameters = z.infer<typeof CliTaskListParametersSchema>;
export type CliTaskGetParameters = z.infer<typeof CliTaskGetParametersSchema>;
export type CliTaskCreateParameters = z.infer<typeof CliTaskCreateParametersSchema>;
export type CliTaskUpdateParameters = z.infer<typeof CliTaskUpdateParametersSchema>;
export type CliTaskDeleteParameters = z.infer<typeof CliTaskDeleteParametersSchema>;
export type CliSessionListParameters = z.infer<typeof CliSessionListParametersSchema>;
export type CliSessionGetParameters = z.infer<typeof CliSessionGetParametersSchema>;
export type CliSessionCreateParameters = z.infer<typeof CliSessionCreateParametersSchema>;
export type CliSessionDeleteParameters = z.infer<typeof CliSessionDeleteParametersSchema>;
export type CliSessionUpdateParameters = z.infer<typeof CliSessionUpdateParametersSchema>; 
