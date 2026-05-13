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

// Cap on how many `.cause` levels are walked. The chain typically maxes out at
// 3–4 (e.g., drizzle → postgres-js → undici → socket-net), so 8 is generous
// while preventing pathological deep chains from blowing the message size.
const MAX_CAUSE_DEPTH = 8;

/**
 * Walk an error's `.cause` chain and return each level's coerced message as a
 * string array, head to tail. Includes the input error itself at index 0.
 *
 * Why this exists: `DrizzleQueryError` (and similar third-party wrappers) set
 * a generic `.message` ("Failed query: …") and stash the real driver error on
 * `.cause`. At the MCP wire boundary, only `.message` survives — operators
 * see `"Failed query:"` with no underlying ECONNRESET / 42P01 / etc., making
 * stale-connection failures indistinguishable from real schema errors. This
 * helper unwraps the chain so the boundary can surface the deepest signal.
 *
 * Cycle protection: tracks visited entries by reference. A `.cause` that
 * loops back to a visited error terminates the walk at the cycle point.
 *
 * Depth cap: stops after `MAX_CAUSE_DEPTH` levels regardless of cycle state,
 * as a defense against pathological deep chains.
 *
 * Non-Error causes (string, object literal, etc.) are coerced via the same
 * rules as `getErrorMessage` and included in the chain.
 */
export function getCauseChain(error: unknown): string[] {
  const messages: string[] = [];
  const visited = new Set<unknown>();
  let current: unknown = error;
  let depth = 0;
  while (current !== undefined && current !== null && depth < MAX_CAUSE_DEPTH) {
    if (typeof current === "object" && visited.has(current)) {
      break;
    }
    if (typeof current === "object") {
      visited.add(current);
    }
    messages.push(getErrorMessage(current));
    if (current instanceof Error || (typeof current === "object" && current !== null)) {
      const next = (current as { cause?: unknown }).cause;
      current = next;
    } else {
      break;
    }
    depth += 1;
  }
  return messages;
}

/**
 * Like `getErrorMessage`, but walks the `.cause` chain and joins each level
 * with ` — caused by: ` so the deepest signal survives to the wire boundary.
 *
 * Used at the MCP tool-response error wrapper (mt#1831) so operators can
 * discriminate stale-connection failures (ECONNRESET, Connection terminated)
 * from real DB errors (schema mismatch, constraint violation) without having
 * to reconnect speculatively.
 *
 * When the error has no `.cause`, the output is identical to `getErrorMessage`.
 * For non-Error top-level values (`undefined`, `null`, primitives, plain
 * objects without `.message`), falls back to `getErrorMessage`'s semantics —
 * `String(undefined)` / `String(null)` rather than an empty string — so
 * call sites that previously logged `"undefined"` / `"null"` don't suddenly
 * surface blank lines (mt#1831 PR #1113 R1 alignment).
 *
 * Cycles and depth >MAX_CAUSE_DEPTH terminate the walk gracefully.
 */
export function getErrorMessageWithCause(error: unknown): string {
  const chain = getCauseChain(error);
  if (chain.length === 0) return getErrorMessage(error);
  return chain.join(" — caused by: ");
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
