/**
 * Error Schema Definitions for Type-Safe Error Handling
 *
 * This module provides Zod schemas for validating error objects throughout the codebase,
 * replacing unsafe `err.message` patterns with proper validation.
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
  errors: z
    .array(
      z.object({
        path: z.array(z.union([z.string(), z.number()])),
        message: z.string(),
        code: z.string(),
      })
    )
    .optional(),
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
  if (error instanceof Error) {
    return error.message;
  }
  if (error !== null && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * Utility function to get error stack safely
 */
export function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.stack;
  }
  if (error !== null && typeof error === "object" && "stack" in error) {
    const stack = (error as { stack: unknown }).stack;
    return typeof stack === "string" ? stack : undefined;
  }
  return undefined;
}

/**
 * Utility function to get error code safely (for system/Node.js errors)
 */
export function getErrorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * Type guard to check if a value looks like an error with a message
 */
export function isErrorLike(error: unknown): error is { message: string } {
  return (
    error !== null &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  );
}

/**
 * Wraps any value in an Error object (or returns the original if already an Error)
 */
export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (isErrorLike(error)) {
    return new Error(error.message);
  }
  return new Error(String(error));
}
