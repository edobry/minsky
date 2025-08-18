/**
 * Shared Zod schemas for MCP tools to eliminate parameter duplication
 *
 * This module provides reusable schema components that can be composed
 * to create consistent parameter validation across all MCP tools.
 */
import { z } from "zod";

/**
 * Base session identifier parameter
 * Used across all session-scoped operations
 */
export const SessionIdentifierSchema = z.object({
  sessionName: z.string().describe("Session identifier (name or task ID)"),
});

/**
 * Task identifier schema - cross-domain pattern
 */
export const TaskIdSchema = z.string().min(1, "Task ID cannot be empty");

/**
 * Backend identifier schema - cross-domain pattern
 */
export const BackendSchema = z.string().optional();

/**
 * Repository identifier schema - cross-domain pattern
 */
export const RepoSchema = z.string().optional();

/**
 * Workspace path schema - cross-domain pattern
 */
export const WorkspaceSchema = z.string().optional();

/**
 * Session identifier schema (optional) - cross-domain pattern
 */
export const SessionSchema = z.string().optional();

/**
 * Force flag schema - cross-domain pattern
 */
export const ForceSchema = z.boolean().default(false);

/**
 * All flag schema - cross-domain pattern
 */
export const AllSchema = z.boolean().default(false);

/**
 * Debug flag schema - cross-domain pattern
 */
export const DebugSchema = z.boolean().default(false);

/**
 * Filter string schema - cross-domain pattern
 */
export const FilterSchema = z.string().optional();

/**
 * Limit number schema - cross-domain pattern
 */
export const LimitSchema = z.number().positive().optional();

/**
 * Format schema - cross-domain pattern for output formatting
 */
export const FormatSchema = z.enum(["json", "yaml", "table"]).default("json");

/**
 * Base backend parameters that are common across domain operations
 */
export const BaseBackendParametersSchema = z.object({
  backend: BackendSchema,
  repo: RepoSchema,
  workspace: WorkspaceSchema,
  session: SessionSchema,
});

/**
 * Base context parameters for command execution
 */
export const BaseExecutionContextSchema = z.object({
  debug: DebugSchema,
  format: FormatSchema,
});

/**
 * Base file path parameter for session workspace operations
 * Used in all file-related operations
 */
export const FilePathSchema = z.object({
  path: z.string().describe("Path to the file within the session workspace"),
});

/**
 * Optional directory path parameter for session workspace operations
 * Used in directory listing operations
 */
export const OptionalDirectoryPathSchema = z.object({
  path: z
    .string()
    .optional()
    .default(".")
    .describe("Path to the directory within the session workspace"),
});

/**
 * Line range parameters for file reading operations
 * Used in read_file operations with line range support
 */
export const LineRangeSchema = z.object({
  start_line_one_indexed: z
    .number()
    .min(1)
    .optional()
    .describe("The one-indexed line number to start reading from (inclusive)"),
  end_line_one_indexed_inclusive: z
    .number()
    .min(1)
    .optional()
    .describe("The one-indexed line number to end reading at (inclusive)"),
  should_read_entire_file: z
    .boolean()
    .optional()
    .default(false)
    .describe("Whether to read the entire file"),
});

/**
 * Content parameter for file write operations
 */
export const FileContentSchema = z.object({
  content: z.string().describe("Content to write to the file"),
});

/**
 * Create directories option parameter
 * Used in file write and edit operations
 */
export const CreateDirectoriesSchema = z.object({
  createDirs: z
    .boolean()
    .optional()
    .default(true)
    .describe("Create parent directories if they don't exist"),
});

/**
 * Show hidden files option parameter
 * Used in directory listing operations
 */
export const ShowHiddenFilesSchema = z.object({
  showHidden: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include hidden files (starting with .)"),
});

/**
 * Search and replace parameters
 * Used in search_replace operations
 */
export const SearchReplaceSchema = z.object({
  search: z.string().describe("Text to search for (must be unique in the file)"),
  replace: z.string().describe("Text to replace with"),
});

/**
 * Edit file specific parameters
 * Used in edit_file operations
 */
export const EditInstructionsSchema = z.object({
  instructions: z
    .string()
    .optional()
    .describe(
      "Optional high-level instruction to guide how to apply the edit (e.g., placement/order)"
    ),
  content: z.string().describe("The edit content with '// ... existing code ...' markers"),
});

/**
 * Dry-run option parameter
 * Used in edit operations to preview changes without writing to disk
 */
export const DryRunSchema = z.object({
  dryRun: z
    .boolean()
    .optional()
    .default(false)
    .describe("Return proposed content and diff without writing to disk"),
});

/**
 * Optional explanation parameter
 * Used across tools for debugging/logging purposes
 */
export const ExplanationSchema = z.object({
  explanation: z
    .string()
    .optional()
    .describe("One sentence explanation of why this tool is being used"),
});

/**
 * Grep search parameters
 * Used in grep_search operations
 */
export const GrepSearchSchema = z.object({
  query: z.string().describe("Regex pattern to search for"),
  case_sensitive: z
    .boolean()
    .optional()
    .default(false)
    .describe("Whether the search should be case sensitive"),
  include_pattern: z
    .string()
    .optional()
    .describe("Glob pattern for files to include (e.g. '*.ts' for TypeScript files)"),
  exclude_pattern: z.string().optional().describe("Glob pattern for files to exclude"),
});

// ========================
// COMPOSED SCHEMAS
// ========================

/**
 * Base schema for all session file operations
 * Combines session identifier and file path
 */
export const SessionFileOperationSchema = SessionIdentifierSchema.merge(FilePathSchema);

/**
 * Schema for session file read operations
 * Includes line range support and explanation
 */
export const SessionFileReadSchema =
  SessionFileOperationSchema.merge(LineRangeSchema).merge(ExplanationSchema);

/**
 * Schema for session file write operations
 * Includes content and directory creation options
 */
export const SessionFileWriteSchema =
  SessionFileOperationSchema.merge(FileContentSchema).merge(CreateDirectoriesSchema);

/**
 * Schema for session file edit operations
 * Includes edit instructions, directory creation options, and dry-run support
 */
export const SessionFileEditSchema = SessionFileOperationSchema.merge(EditInstructionsSchema)
  .merge(CreateDirectoriesSchema)
  .merge(DryRunSchema);

/**
 * Schema for session search and replace operations
 * Includes search/replace parameters
 */
export const SessionSearchReplaceSchema = SessionFileOperationSchema.merge(SearchReplaceSchema);

/**
 * Schema for session directory listing operations
 * Includes optional directory path and hidden files option
 */
export const SessionDirectoryListSchema = SessionIdentifierSchema.merge(
  OptionalDirectoryPathSchema
).merge(ShowHiddenFilesSchema);

/**
 * Schema for session grep search operations
 * Includes session identifier and grep parameters
 */
export const SessionGrepSearchSchema = SessionIdentifierSchema.merge(GrepSearchSchema);

/**
 * Schema for session file existence check
 * Simple session + path combination
 */
export const SessionFileExistsSchema = SessionFileOperationSchema;

/**
 * Schema for session file deletion
 * Simple session + path combination
 */
export const SessionFileDeleteSchema = SessionFileOperationSchema;

/**
 * Schema for session file movement/rename operations
 */
export const SessionFileMoveSchema = SessionIdentifierSchema.merge(
  z.object({
    sourcePath: z.string().describe("Current file path within the session workspace"),
    targetPath: z.string().describe("New file path within the session workspace"),
    overwrite: z.boolean().optional().default(false).describe("Overwrite target if it exists"),
  })
).merge(CreateDirectoriesSchema);

/**
 * Schema for session file rename operations
 */
export const SessionFileRenameSchema = SessionFileOperationSchema.merge(
  z.object({
    newName: z.string().describe("New filename (not full path)"),
    overwrite: z.boolean().optional().default(false).describe("Overwrite target if it exists"),
  })
);

/**
 * Schema for session directory creation
 */
export const SessionDirectoryCreateSchema = SessionFileOperationSchema.merge(
  z.object({
    recursive: z
      .boolean()
      .optional()
      .default(true)
      .describe("Create parent directories if they don't exist"),
  })
);

// ========================
// RESPONSE TYPE SCHEMAS
// ========================

/**
 * Base response schema for successful operations
 */
export const BaseSuccessResponseSchema = z.object({
  success: z.literal(true),
});

/**
 * Base response schema for failed operations
 */
export const BaseErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string(),
});

/**
 * Response schema for file operations
 */
export const FileOperationResponseSchema = z.union([
  BaseSuccessResponseSchema.extend({
    path: z.string().optional(),
    session: z.string(),
    resolvedPath: z.string().optional(),
    // Additional properties for move operations
    sourcePath: z.string().optional(),
    targetPath: z.string().optional(),
    sourceResolvedPath: z.string().optional(),
    targetResolvedPath: z.string().optional(),
    moved: z.boolean().optional(),
    overwritten: z.boolean().optional(),
    // Additional properties for rename operations
    originalPath: z.string().optional(),
    newPath: z.string().optional(),
    newName: z.string().optional(),
    originalResolvedPath: z.string().optional(),
    newResolvedPath: z.string().optional(),
    renamed: z.boolean().optional(),
    // Additional properties for delete/create operations
    deleted: z.boolean().optional(),
    created: z.boolean().optional(),
    bytesWritten: z.number().optional(),
    recursive: z.boolean().optional(),
    // Additional properties for dry-run operations
    dryRun: z.boolean().optional(),
    proposedContent: z.string().optional(),
    diff: z.string().optional(),
    diffSummary: z
      .object({
        linesAdded: z.number(),
        linesRemoved: z.number(),
        linesChanged: z.number(),
        totalLines: z.number(),
      })
      .optional(),
  }),
  BaseErrorResponseSchema.extend({
    path: z.string().optional(),
    session: z.string().optional(),
  }),
]);

/**
 * Response schema for file read operations
 */
export const FileReadResponseSchema = z.union([
  BaseSuccessResponseSchema.extend({
    content: z.string(),
    path: z.string(),
    session: z.string(),
    resolvedPath: z.string().optional(),
    totalLines: z.number().optional(),
    linesRead: z
      .object({
        start: z.number(),
        end: z.number(),
      })
      .optional(),
    omittedContent: z
      .object({
        summary: z.string(),
      })
      .optional(),
  }),
  BaseErrorResponseSchema.extend({
    path: z.string().optional(),
    session: z.string().optional(),
  }),
]);

/**
 * Response schema for directory listing operations
 */
export const DirectoryListResponseSchema = z.union([
  BaseSuccessResponseSchema.extend({
    path: z.string(),
    session: z.string(),
    resolvedPath: z.string(),
    files: z.array(z.string()),
    directories: z.array(z.string()),
    totalEntries: z.number(),
  }),
  BaseErrorResponseSchema.extend({
    path: z.string().optional(),
    session: z.string().optional(),
  }),
]);

// Export type definitions for TypeScript usage
export type SessionIdentifier = z.infer<typeof SessionIdentifierSchema>;
export type SessionFileOperation = z.infer<typeof SessionFileOperationSchema>;
export type SessionFileRead = z.infer<typeof SessionFileReadSchema>;
export type SessionFileWrite = z.infer<typeof SessionFileWriteSchema>;
export type SessionFileEdit = z.infer<typeof SessionFileEditSchema>;
export type SessionSearchReplace = z.infer<typeof SessionSearchReplaceSchema>;
export type SessionDirectoryList = z.infer<typeof SessionDirectoryListSchema>;
export type SessionGrepSearch = z.infer<typeof SessionGrepSearchSchema>;
export type FileOperationResponse = z.infer<typeof FileOperationResponseSchema>;
export type FileReadResponse = z.infer<typeof FileReadResponseSchema>;
export type DirectoryListResponse = z.infer<typeof DirectoryListResponseSchema>;
