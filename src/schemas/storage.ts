/**
 * Schema definitions for storage operations and data structures
 * These schemas validate data that's commonly parsed from JSON files or database operations
 */
import { z } from "zod";
import { taskStatusSchema } from "./tasks";

/**
 * Schema for task state stored in JSON files
 */
export const taskStateSchema = z.object({
  tasks: z.array(z.object({
    id: z.string(),
    title: z.string(),
    status: taskStatusSchema,
    specPath: z.string().optional(),
    description: z.string().optional(),
  })),
  lastUpdated: z.string(),
  metadata: z.object({
    storageLocation: z.string(),
    backendType: z.string(),
    workspacePath: z.string(),
  }),
});

/**
 * Schema for database read operation results
 */
export const databaseReadResultSchema = z.object({
  success: z.boolean(),
  data: z.any().optional(),
  error: z.instanceof(Error).optional(),
});

/**
 * Schema for database write operation results
 */
export const databaseWriteResultSchema = z.object({
  success: z.boolean(),
  error: z.instanceof(Error).optional(),
  bytesWritten: z.number().optional(),
});

/**
 * Schema for task read operation results
 */
export const taskReadOperationResultSchema = z.object({
  success: z.boolean(),
  content: z.string().optional(),
  error: z.instanceof(Error).optional(),
  filePath: z.string(),
});

/**
 * Schema for task write operation results
 */
export const taskWriteOperationResultSchema = z.object({
  success: z.boolean(),
  error: z.instanceof(Error).optional(),
  bytesWritten: z.number().optional(),
  filePath: z.string(),
});

/**
 * Schema for GitHub issue data
 */
export const githubIssueSchema = z.object({
  id: z.number(),
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  labels: z.array(z.object({
    name: z.string(),
    color: z.string(),
  })),
  created_at: z.string(),
  updated_at: z.string(),
  assignees: z.array(z.object({
    login: z.string(),
  })),
});

/**
 * Schema for session database state
 */
export const sessionDbStateSchema = z.object({
  sessions: z.array(z.object({
    id: z.string(),
    name: z.string(),
    repoUrl: z.string(),
    repoPath: z.string().optional(),
    createdAt: z.string(),
    taskId: z.string().optional(),
    branch: z.string().optional(),
  })),
  lastUpdated: z.string(),
});

// Export type definitions
export type TaskState = z.infer<typeof taskStateSchema>;
export type DatabaseReadResult<T = any> = z.infer<typeof databaseReadResultSchema> & { data?: T };
export type DatabaseWriteResult = z.infer<typeof databaseWriteResultSchema>;
export type TaskReadOperationResult = z.infer<typeof taskReadOperationResultSchema>;
export type TaskWriteOperationResult = z.infer<typeof taskWriteOperationResultSchema>;
export type GitHubIssue = z.infer<typeof githubIssueSchema>;
export type SessionDbState = z.infer<typeof sessionDbStateSchema>;

// Validation functions
export function validateTaskState(data: unknown): TaskState {
  return taskStateSchema.parse(data);
}

export function validateDatabaseReadResult<T = any>(data: unknown): DatabaseReadResult<T> {
  return databaseReadResultSchema.parse(data) as DatabaseReadResult<T>;
}

export function validateDatabaseWriteResult(data: unknown): DatabaseWriteResult {
  return databaseWriteResultSchema.parse(data);
}

export function validateTaskReadOperationResult(data: unknown): TaskReadOperationResult {
  return taskReadOperationResultSchema.parse(data);
}

export function validateTaskWriteOperationResult(data: unknown): TaskWriteOperationResult {
  return taskWriteOperationResultSchema.parse(data);
}

export function validateGitHubIssue(data: unknown): GitHubIssue {
  return githubIssueSchema.parse(data);
}

export function validateGitHubIssues(data: unknown): GitHubIssue[] {
  return z.array(githubIssueSchema).parse(data);
}

export function validateSessionDbState(data: unknown): SessionDbState {
  return sessionDbStateSchema.parse(data);
} 
