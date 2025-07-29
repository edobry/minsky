/**
 * File Domain Schemas
 *
 * Interface-agnostic schemas for file-related operations that can be used
 * across CLI, MCP, and API interfaces.
 */
import { z } from "zod";
import {
  SessionIdSchema,
  BaseSuccessResponseSchema,
  BaseErrorResponseSchema,
} from "./common-schemas";

// ========================
// FILE PATH SCHEMAS
// ========================

/**
 * File path schema - used across all interfaces
 */
export const FilePathSchema = z.string().min(1, "File path cannot be empty");

/**
 * Directory path schema - used across all interfaces
 */
export const DirectoryPathSchema = z.string().min(1, "Directory path cannot be empty");

/**
 * Optional directory path schema with default
 */
export const OptionalDirectoryPathSchema = z.string().default(".");

/**
 * Source path schema for move/copy operations
 */
export const SourcePathSchema = z.string().min(1, "Source path cannot be empty");

/**
 * Target path schema for move/copy operations
 */
export const TargetPathSchema = z.string().min(1, "Target path cannot be empty");

/**
 * New filename schema for rename operations
 */
export const NewFilenameSchema = z.string().min(1, "New filename cannot be empty");

// ========================
// FILE CONTENT SCHEMAS
// ========================

/**
 * File content schema - used across all interfaces
 */
export const FileContentSchema = z.string();

/**
 * Search pattern schema for grep operations
 */
export const SearchPatternSchema = z.string().min(1, "Search pattern cannot be empty");

/**
 * Search text schema for search/replace operations
 */
export const SearchTextSchema = z.string().min(1, "Search text cannot be empty");

/**
 * Replacement text schema for search/replace operations
 */
export const ReplacementTextSchema = z.string();

/**
 * Edit instructions schema for file editing
 */
export const EditInstructionsSchema = z.string().min(1, "Edit instructions cannot be empty");

/**
 * Edit content schema with markers
 */
export const EditContentSchema = z.string().min(1, "Edit content cannot be empty");

// ========================
// FILE OPTIONS SCHEMAS
// ========================

/**
 * Create directories flag schema
 */
export const CreateDirectoriesSchema = z.boolean().default(true);

/**
 * Overwrite flag schema
 */
export const OverwriteSchema = z.boolean().default(false);

/**
 * Recursive flag schema for directory operations
 */
export const RecursiveSchema = z.boolean().default(true);

/**
 * Show hidden files flag schema
 */
export const ShowHiddenSchema = z.boolean().default(false);

/**
 * Case sensitive search flag schema
 */
export const CaseSensitiveSchema = z.boolean().default(false);

/**
 * Include pattern schema for file filtering
 */
export const IncludePatternSchema = z.string().optional();

/**
 * Exclude pattern schema for file filtering
 */
export const ExcludePatternSchema = z.string().optional();

/**
 * Explanation schema for debugging/logging
 */
export const ExplanationSchema = z.string().optional();

// ========================
// LINE RANGE SCHEMAS
// ========================

/**
 * Start line schema (1-indexed)
 */
export const StartLineSchema = z.number().min(1).optional();

/**
 * End line schema (1-indexed, inclusive)
 */
export const EndLineSchema = z.number().min(1).optional();

/**
 * Read entire file flag schema
 */
export const ShouldReadEntireFileSchema = z.boolean().default(false);

/**
 * Line range schema for file reading operations
 */
export const LineRangeSchema = z.object({
  start_line_one_indexed: StartLineSchema,
  end_line_one_indexed_inclusive: EndLineSchema,
  should_read_entire_file: ShouldReadEntireFileSchema,
});

// ========================
// BASE FILE OPERATION SCHEMAS
// ========================

/**
 * Base file operation schema (session + path)
 */
export const BaseFileOperationSchema = z.object({
  sessionName: SessionIdSchema,
  path: FilePathSchema,
});

/**
 * Base directory operation schema (session + directory path)
 */
export const BaseDirectoryOperationSchema = z.object({
  sessionName: SessionIdSchema,
  path: OptionalDirectoryPathSchema,
});

// ========================
// COMPOSED FILE OPERATION SCHEMAS
// ========================

/**
 * File read operation schema
 */
export const FileReadSchema = BaseFileOperationSchema
  .merge(LineRangeSchema)
  .merge(z.object({ explanation: ExplanationSchema }));

/**
 * File write operation schema
 */
export const FileWriteSchema = BaseFileOperationSchema.merge(z.object({
  content: FileContentSchema,
  createDirs: CreateDirectoriesSchema,
}));

/**
 * File edit operation schema
 */
export const FileEditSchema = BaseFileOperationSchema.merge(z.object({
  instructions: EditInstructionsSchema,
  content: EditContentSchema,
  createDirs: CreateDirectoriesSchema,
}));

/**
 * File search/replace operation schema
 */
export const FileSearchReplaceSchema = BaseFileOperationSchema.merge(z.object({
  search: SearchTextSchema,
  replace: ReplacementTextSchema,
}));

/**
 * File existence check schema
 */
export const FileExistsSchema = BaseFileOperationSchema;

/**
 * File deletion schema
 */
export const FileDeleteSchema = BaseFileOperationSchema;

/**
 * File move operation schema
 */
export const FileMoveSchema = z.object({
  sessionName: SessionIdSchema,
  sourcePath: SourcePathSchema,
  targetPath: TargetPathSchema,
  overwrite: OverwriteSchema,
  createDirs: CreateDirectoriesSchema,
});

/**
 * File rename operation schema
 */
export const FileRenameSchema = BaseFileOperationSchema.merge(z.object({
  newName: NewFilenameSchema,
  overwrite: OverwriteSchema,
}));

/**
 * Directory listing schema
 */
export const DirectoryListSchema = BaseDirectoryOperationSchema.merge(z.object({
  showHidden: ShowHiddenSchema,
}));

/**
 * Directory creation schema
 */
export const DirectoryCreateSchema = z.object({
  sessionName: SessionIdSchema,
  path: DirectoryPathSchema,
  recursive: RecursiveSchema,
});

/**
 * Grep search operation schema
 */
export const GrepSearchSchema = z.object({
  sessionName: SessionIdSchema,
  query: SearchPatternSchema,
  case_sensitive: CaseSensitiveSchema,
  include_pattern: IncludePatternSchema,
  exclude_pattern: ExcludePatternSchema,
});

// ========================
// FILE RESPONSE SCHEMAS
// ========================

/**
 * Base file response schema
 */
export const BaseFileResponseSchema = z.object({
  session: SessionIdSchema,
  path: FilePathSchema,
  resolvedPath: z.string().optional(),
});

/**
 * File operation response schema
 */
export const FileOperationResponseSchema = z.union([
  BaseSuccessResponseSchema.merge(BaseFileResponseSchema).extend({
    bytesWritten: z.number().optional(),
    created: z.boolean().optional(),
    edited: z.boolean().optional(),
    deleted: z.boolean().optional(),
    moved: z.boolean().optional(),
    renamed: z.boolean().optional(),
    overwritten: z.boolean().optional(),
    recursive: z.boolean().optional(),
    replaced: z.boolean().optional(),
    // For move operations
    sourcePath: z.string().optional(),
    targetPath: z.string().optional(),
    sourceResolvedPath: z.string().optional(),
    targetResolvedPath: z.string().optional(),
    // For rename operations
    originalPath: z.string().optional(),
    newPath: z.string().optional(),
    newName: z.string().optional(),
    originalResolvedPath: z.string().optional(),
    newResolvedPath: z.string().optional(),
    // For search/replace operations
    searchText: z.string().optional(),
    replaceText: z.string().optional(),
  }),
  BaseErrorResponseSchema.extend({
    session: SessionIdSchema.optional(),
    path: FilePathSchema.optional(),
  }),
]);

/**
 * File read response schema
 */
export const FileReadResponseSchema = z.union([
  BaseSuccessResponseSchema.merge(BaseFileResponseSchema).extend({
    content: FileContentSchema,
    totalLines: z.number().optional(),
    linesRead: z.object({
      start: z.number(),
      end: z.number(),
    }).optional(),
    linesShown: z.string().optional(),
    omittedContent: z.object({
      summary: z.string(),
    }).optional(),
  }),
  BaseErrorResponseSchema.extend({
    session: SessionIdSchema.optional(),
    path: FilePathSchema.optional(),
  }),
]);

/**
 * Directory listing response schema
 */
export const DirectoryListResponseSchema = z.union([
  BaseSuccessResponseSchema.extend({
    session: SessionIdSchema,
    path: z.string(),
    resolvedPath: z.string(),
    files: z.array(z.string()),
    directories: z.array(z.string()),
    totalEntries: z.number(),
  }),
  BaseErrorResponseSchema.extend({
    session: SessionIdSchema.optional(),
    path: z.string().optional(),
  }),
]);

/**
 * File existence response schema
 */
export const FileExistsResponseSchema = z.union([
  BaseSuccessResponseSchema.merge(BaseFileResponseSchema).extend({
    exists: z.boolean(),
    isFile: z.boolean().optional(),
    isDirectory: z.boolean().optional(),
    size: z.number().optional(),
  }),
  BaseErrorResponseSchema.extend({
    session: SessionIdSchema.optional(),
    path: FilePathSchema.optional(),
  }),
]);

/**
 * Grep search response schema
 */
export const GrepSearchResponseSchema = z.union([
  BaseSuccessResponseSchema.extend({
    session: SessionIdSchema,
    query: SearchPatternSchema,
    results: z.array(z.object({
      file: z.string(),
      line: z.number(),
      column: z.number().optional(),
      content: z.string(),
      match: z.string(),
    })),
    matchCount: z.number(),
    fileCount: z.number(),
  }),
  BaseErrorResponseSchema.extend({
    session: SessionIdSchema.optional(),
    query: SearchPatternSchema.optional(),
  }),
]);

// ========================
// TYPE EXPORTS
// ========================

export type FilePath = z.infer<typeof FilePathSchema>;
export type DirectoryPath = z.infer<typeof DirectoryPathSchema>;
export type FileContent = z.infer<typeof FileContentSchema>;
export type SearchPattern = z.infer<typeof SearchPatternSchema>;
export type LineRange = z.infer<typeof LineRangeSchema>;
export type FileReadParameters = z.infer<typeof FileReadSchema>;
export type FileWriteParameters = z.infer<typeof FileWriteSchema>;
export type FileEditParameters = z.infer<typeof FileEditSchema>;
export type FileSearchReplaceParameters = z.infer<typeof FileSearchReplaceSchema>;
export type FileExistsParameters = z.infer<typeof FileExistsSchema>;
export type FileDeleteParameters = z.infer<typeof FileDeleteSchema>;
export type FileMoveParameters = z.infer<typeof FileMoveSchema>;
export type FileRenameParameters = z.infer<typeof FileRenameSchema>;
export type DirectoryListParameters = z.infer<typeof DirectoryListSchema>;
export type DirectoryCreateParameters = z.infer<typeof DirectoryCreateSchema>;
export type GrepSearchParameters = z.infer<typeof GrepSearchSchema>;
export type FileOperationResponse = z.infer<typeof FileOperationResponseSchema>;
export type FileReadResponse = z.infer<typeof FileReadResponseSchema>;
export type DirectoryListResponse = z.infer<typeof DirectoryListResponseSchema>;
export type FileExistsResponse = z.infer<typeof FileExistsResponseSchema>;
export type GrepSearchResponse = z.infer<typeof GrepSearchResponseSchema>; 
