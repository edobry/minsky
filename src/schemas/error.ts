/**
 * Error Schema Definitions for Type-Safe Error Handling
 * 
 * This module provides Zod schemas for validating error objects throughout the codebase,
 * replacing unsafe `(err as unknown).message` patterns with proper validation.
 */

import { z } from "zod";

/**
 * Base error schema for standard JavaScript Error objects
 */
export const baseErrorSchema = z.object({
  message: z.string(),
  name: z.string().optional(),
  stack: z.string().optional(),
});

/**
 * Extended error schema for system errors (file system, network, etc.)
 */
export const systemErrorSchema = baseErrorSchema.extend({
  code: z.string().optional(),
  errno: z.number().optional(),
  syscall: z.string().optional(),
  path: z.string().optional(),
});

/**
 * Git command error schema for git operation failures
 */
export const gitErrorSchema = baseErrorSchema.extend({
  stderr: z.string().optional(),
  stdout: z.string().optional(),
  code: z.number().optional(),
  signal: z.string().optional(),
});

/**
 * Validation error schema for schema validation failures
 */
export const validationErrorSchema = baseErrorSchema.extend({
  errors: z.array(z.object({
    path: z.array(z.union([z.string(), z.number()])),
    message: z.string(),
    code: z.string(),
  })).optional(),
});

/**
 * Generic error schema that can handle various error types
 */
export const genericErrorSchema = z.union([
  baseErrorSchema,
  systemErrorSchema,
  gitErrorSchema,
  validationErrorSchema,
]);

/**
 * Type definitions for error schemas
 */
export type BaseError = z.infer<typeof baseErrorSchema>;
export type SystemError = z.infer<typeof systemErrorSchema>;
export type GitError = z.infer<typeof gitErrorSchema>;
export type ValidationError = z.infer<typeof validationErrorSchema>;
export type GenericError = z.infer<typeof genericErrorSchema>;

/**
 * Utility function to safely validate and extract error information
 */
export function validateError(error: unknown): BaseError {
  const result = baseErrorSchema.safeParse(error);
  
  if (result.success) {
    return result.data;
  }
  
  // Fallback for non-standard error objects
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  
  // Ultimate fallback
  return {
    message: String(error),
    name: "Unknown",
  };
}

/**
 * Utility function to safely validate system errors
 */
export function validateSystemError(error: unknown): SystemError {
  const result = systemErrorSchema.safeParse(error);
  
  if (result.success) {
    return result.data;
  }
  
  // Fallback to base error validation
  return validateError(error);
}

/**
 * Utility function to safely validate git errors
 */
export function validateGitError(error: unknown): GitError {
  const result = gitErrorSchema.safeParse(error);
  
  if (result.success) {
    return result.data;
  }
  
  // Fallback to base error validation
  return validateError(error);
}

/**
 * Utility function to get error message safely
 */
export function getErrorMessage(error: unknown): string {
  const validatedError = validateError(error);
  return validatedError.message;
}

/**
 * Utility function to get error stack safely
 */
export function getErrorStack(error: unknown): string | undefined {
  const validatedError = validateError(error);
  return validatedError.stack;
} 
